import { act, renderHook, waitFor } from "@testing-library/react";
import {
  type Mock,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// In-memory adapter injected into useSessionMessages. jsdom has no IndexedDB,
// so tests pass a SessionCacheAdapter backed by a Map; microtask flushes drive it.
// 注入 useSessionMessages 的内存适配器。jsdom 无 IndexedDB，故测试传入一个由 Map
// 支撑的 SessionCacheAdapter；通过微任务刷新驱动。
const cacheAdapter = vi.hoisted(() => {
  const map = new Map<string, unknown>();
  const read = vi.fn(
    async (
      projectId: string,
      sessionId: string,
      _tailTurns?: number,
      _tailFrom?: string,
    ) => {
      const key = `${projectId}:${sessionId}`;
      const v = (map.get(key) as unknown) ?? null;
      return v;
    },
  );
  const write = vi.fn(
    async (
      projectId: string,
      sessionId: string,
      entry: unknown,
      _tailTurns?: number,
      _tailFrom?: string,
    ) => {
      const key = `${projectId}:${sessionId}`;
      // Mirror the real store: snapshot totalMessageCount onto the entry so
      // the staleness check (cachedTotalMessageCount mismatch) works on reopen.
      // 镜像真实 store：将 totalMessageCount 快照到 entry，使重开时的过期校验
      // （cachedTotalMessageCount 不一致）生效。
      const payload = entry as {
        pagination?: { totalMessageCount?: number };
        session?: { updatedAt?: string };
      };
      const enriched = {
        ...(entry as object),
        cachedTotalMessageCount: payload?.pagination?.totalMessageCount,
        cachedUpdatedAt: payload?.session?.updatedAt,
      };
      map.set(key, enriched);
    },
  );
  const adapter = { read, write };
  return { map, adapter, __reset: () => map.clear() };
});


const apiMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: apiMocks,
}));

vi.mock("../useStreamingEnabled", () => ({
  getStreamingEnabled: vi.fn(() => true),
}));

import {
  isSessionLoadCacheEnabled,
  useSessionMessages,
} from "../useSessionMessages";
import {
  createSessionCacheAdapter,
  type SessionCacheAdapter,
} from "../../lib/sessionCache/sessionCacheStore";
import { getStreamingEnabled } from "../useStreamingEnabled";

describe("useSessionMessages cache", () => {
  beforeEach(() => {
    (getStreamingEnabled as Mock).mockReturnValue(true);
    cacheAdapter.__reset();
    cacheAdapter.adapter.read.mockClear();
    cacheAdapter.adapter.write.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps the session load cache dev-only and explicit opt-in", () => {
    // Legacy env gate retained as a dev override; production uses the server setting.
    // 旧环境开关保留为 dev 覆盖；生产环境用服务端设置。
    expect(
      isSessionLoadCacheEnabled({
        DEV: false,
        VITE_SESSION_LOAD_CACHE: "true",
      }),
    ).toBe(false);
    expect(
      isSessionLoadCacheEnabled({
        DEV: true,
        VITE_SESSION_LOAD_CACHE: undefined,
      }),
    ).toBe(false);
    expect(
      isSessionLoadCacheEnabled({
        DEV: true,
        VITE_SESSION_LOAD_CACHE: "true",
      }),
    ).toBe(true);
  });

  it("does not retain session messages across remounts when cache is disabled", async () => {
    // sessionLoadCacheEnabled defaults to false => no cache read/write.
    // sessionLoadCacheEnabled 默认 false => 不读写缓存。
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:01:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
        {
          uuid: "msg-2",
          type: "assistant",
          timestamp: "2026-05-04T00:01:00.000Z",
          message: { role: "assistant", content: "hi" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 2,
        returnedMessageCount: 2,
        totalCompactions: 0,
      },
    });

    const first = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();

    const second = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    expect(second.result.current.loading).toBe(true);
    expect(second.result.current.messages).toEqual([]);
    // Disabled => no cache read attempted.
    // 禁用 => 不尝试读缓存。
    expect(cacheAdapter.adapter.read).not.toHaveBeenCalled();
    await waitFor(() => expect(apiMocks.getSession).toHaveBeenCalledTimes(2));
    expect(apiMocks.getSession).toHaveBeenNthCalledWith(
      2,
      "proj-1",
      "sess-1",
      undefined,
      { tailCompactions: 2 },
    );
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(
      second.result.current.messages.map((message) => message.uuid),
    ).toEqual(["msg-1", "msg-2"]);
  });

  it("reuses the warm session cache on remount and fetches only deltas", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });
    // Second load: incremental delta. Anchor hit => server returns only the
    // new message with NO pagination field (the incremental branch skips it).
    // 第二次加载：增量 delta。锚点命中 => 服务端只返回新消息，无 pagination 字段
    // （增量分支不设 pagination）。
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:01:00.000Z",
      },
      messages: [
        {
          uuid: "msg-2",
          type: "assistant",
          timestamp: "2026-05-04T00:01:00.000Z",
          message: { role: "assistant", content: "hi" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
    });

    const first = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
        cacheAdapter: cacheAdapter.adapter as SessionCacheAdapter,
      }),
    );

    await waitFor(() => expect(apiMocks.getSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    // Cache must have been written on the first load.
    // 首次加载必须已写入缓存。
    await waitFor(() => expect(cacheAdapter.adapter.write).toHaveBeenCalled());
    expect(cacheAdapter.adapter.write).toHaveBeenNthCalledWith(
      1,
      "proj-1",
      "sess-1",
      expect.objectContaining({ lastMessageId: "msg-1" }),
      undefined,
      undefined,
    );

    first.unmount();

    const second = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
        cacheAdapter: cacheAdapter.adapter as SessionCacheAdapter,
      }),
    );

    // Warm hydration paints the cached msg-1 before REST lands.
    // warm hydration 在 REST 返回前先绘制缓存的 msg-1。
    await waitFor(() =>
      expect(second.result.current.messages.map((m) => m.uuid)).toContain(
        "msg-1",
      ),
    );

    await waitFor(() => expect(apiMocks.getSession).toHaveBeenCalledTimes(2));
    // Second call is incremental, anchored on the cached lastMessageId.
    // 第二次调用为增量，锚定缓存的 lastMessageId。
    expect(apiMocks.getSession).toHaveBeenNthCalledWith(
      2,
      "proj-1",
      "sess-1",
      "msg-1",
      { tailCompactions: 2 },
    );
    await waitFor(() =>
      expect(
        second.result.current.messages.map((message) => message.uuid),
      ).toEqual(["msg-1", "msg-2"]),
    );
  });

  it("discards the warm cache when the anchor was compacted away (anchor miss)", async () => {
    // First load writes a cache snapshot with lastMessageId=msg-1.
    // 首次加载写入 lastMessageId=msg-1 的缓存快照。
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });
    // Reopen: the cached anchor (msg-1) was compacted away, so the server's
    // anchor-miss fallback returns the fresh full tail WITH a `pagination`
    // field. The client detects the miss via pagination presence, discards the
    // warm cache, and applies this response directly — no second full fetch.
    // 重开：缓存锚点（msg-1）被 compact 删除，服务端锚点未中回退返回新鲜全量尾部，
    // 携带 `pagination` 字段。客户端凭 pagination 存在检测到未中，丢弃 warm 缓存，
    // 直接应用此响应，不再发起第二次全量拉取。
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:02:00.000Z",
      },
      messages: [
        {
          uuid: "msg-3",
          type: "assistant",
          timestamp: "2026-05-04T00:02:00.000Z",
          message: { role: "assistant", content: "fresh tail" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 3,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });

    const first = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
        cacheAdapter: cacheAdapter.adapter as SessionCacheAdapter,
      }),
    );
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await waitFor(() => expect(cacheAdapter.adapter.write).toHaveBeenCalled());
    first.unmount();

    const second = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
        cacheAdapter: cacheAdapter.adapter as SessionCacheAdapter,
      }),
    );

    // Warm hydration paints the cached msg-1, then the anchor-miss response
    // (with pagination) replaces it with the fresh tail msg-3. Only ONE
    // incremental call is made — the miss response is reused, no second fetch.
    // warm hydration 先绘制缓存的 msg-1，随后锚点未中响应（含 pagination）将其
    // 替换为新鲜尾部 msg-3。只发一次增量调用 —— 未中响应被复用，无第二次拉取。
    await waitFor(() =>
      expect(apiMocks.getSession).toHaveBeenCalledTimes(2),
    );
    expect(apiMocks.getSession).toHaveBeenNthCalledWith(
      2,
      "proj-1",
      "sess-1",
      "msg-1",
      { tailCompactions: 2 },
    );
    // Final state is the fresh tail, not the stale cached msg-1.
    // 最终状态为新鲜尾部，而非过期的缓存 msg-1。
    await waitFor(() =>
      expect(
        second.result.current.messages.map((message) => message.uuid),
      ).toEqual(["msg-3"]),
    );
  });

  it("merges the incremental delta when the anchor still hits (no pagination)", async () => {
    // A running session appends new messages; the cached anchor is still
    // present, so the server's incremental branch returns only the new message
    // with NO pagination field. The client merges it onto the warm cache.
    // 运行中会话追加新消息；缓存锚点仍存在，服务端增量分支只返回新消息，
    // 无 pagination 字段。客户端将其合并到 warm 缓存。
    // First load: cold load writes a cache snapshot with lastMessageId=msg-1.
    // 首次加载：冷加载写入 lastMessageId=msg-1 的缓存快照。
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });
    // Reopen: anchor hit => server returns only the new message with NO
    // pagination field. The client merges it onto the warm cache.
    // 重开：锚点命中 => 服务端只返回新消息，无 pagination 字段。客户端合并到 warm 缓存。
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:05:00.000Z",
      },
      messages: [
        {
          uuid: "msg-2",
          type: "assistant",
          timestamp: "2026-05-04T00:05:00.000Z",
          message: { role: "assistant", content: "hi" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
    });

    const first = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
        cacheAdapter: cacheAdapter.adapter as SessionCacheAdapter,
      }),
    );
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await waitFor(() => expect(cacheAdapter.adapter.write).toHaveBeenCalled());
    first.unmount();

    const second = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
        cacheAdapter: cacheAdapter.adapter as SessionCacheAdapter,
      }),
    );

    await waitFor(() => expect(apiMocks.getSession).toHaveBeenCalledTimes(2));
    // No third call: anchor hit (no pagination) => merge, no full reload.
    // 无第三次调用：锚点命中（无 pagination）=> 合并，无全量重拉。
    expect(apiMocks.getSession).toHaveBeenCalledTimes(2);
    // Merged result keeps cached msg-1 and appends msg-2.
    // 合并结果保留缓存 msg-1 并追加 msg-2。
    await waitFor(() =>
      expect(
        second.result.current.messages.map((message) => message.uuid),
      ).toEqual(["msg-1", "msg-2"]),
    );
  });

  it("coalesces concurrent incremental refreshes", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    apiMocks.getSession.mockClear();
    let resolveRefresh!: (value: unknown) => void;
    const refreshPromise = new Promise((resolve) => {
      resolveRefresh = resolve;
    });
    apiMocks.getSession.mockReturnValueOnce(refreshPromise);

    const first = result.current.fetchNewMessages();
    const second = result.current.fetchNewMessages();

    expect(second).toBe(first);
    expect(apiMocks.getSession).toHaveBeenCalledTimes(1);
    expect(apiMocks.getSession).toHaveBeenCalledWith(
      "proj-1",
      "sess-1",
      "msg-1",
    );

    await act(async () => {
      resolveRefresh({
        session: {
          provider: "claude",
          updatedAt: "2026-05-04T00:01:00.000Z",
        },
        messages: [],
        ownership: { owner: "self" },
        pendingInputRequest: null,
        slashCommands: null,
      });
      await Promise.all([first, second]);
    });

    expect(apiMocks.getSession).toHaveBeenCalledTimes(1);
  });

  it("suppresses Codex live streaming messages when response streaming is disabled", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "codex",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 0,
        returnedMessageCount: 0,
        totalCompactions: 0,
      },
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.handleStreamMessageEvent({
        uuid: "codex-item-1",
        type: "assistant",
        _isStreaming: true,
        message: { role: "assistant", content: "Hel" },
      });
    });
    expect(result.current.messages).toHaveLength(1);

    (getStreamingEnabled as Mock).mockReturnValue(false);

    act(() => {
      result.current.handleStreamMessageEvent({
        uuid: "codex-item-1",
        type: "assistant",
        _isStreaming: true,
        message: { role: "assistant", content: "Hello" },
      });
    });
    expect(result.current.messages).toEqual([]);

    act(() => {
      result.current.handleStreamMessageEvent({
        uuid: "codex-item-1",
        type: "assistant",
        message: { role: "assistant", content: "Hello" },
      });
    });

    expect(result.current.messages).toMatchObject([
      {
        uuid: "codex-item-1",
        type: "assistant",
        message: { content: "Hello" },
      },
    ]);
  });

  it("suppresses buffered Codex live streaming messages when response streaming is disabled", async () => {
    (getStreamingEnabled as Mock).mockReturnValue(false);

    let resolveLoad!: (value: unknown) => void;
    apiMocks.getSession.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    act(() => {
      result.current.handleStreamMessageEvent({
        uuid: "codex-buffered-1",
        type: "assistant",
        _isStreaming: true,
        message: { role: "assistant", content: "partial" },
      });
    });

    await act(async () => {
      resolveLoad({
        session: {
          provider: "codex",
          updatedAt: "2026-05-04T00:00:00.000Z",
        },
        messages: [],
        ownership: { owner: "self" },
        pendingInputRequest: null,
        slashCommands: null,
        pagination: {
          hasOlderMessages: false,
          totalMessageCount: 0,
          returnedMessageCount: 0,
          totalCompactions: 0,
        },
      });
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.messages).toEqual([]);
  });

  it("suppresses Codex subagent live streaming messages when response streaming is disabled", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "codex",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 0,
        returnedMessageCount: 0,
        totalCompactions: 0,
      },
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.handleStreamSubagentMessage(
        {
          uuid: "codex-subagent-1",
          type: "assistant",
          _isStreaming: true,
          message: { role: "assistant", content: "partial" },
        },
        "task-1",
      );
    });
    expect(result.current.agentContent["task-1"]?.messages).toHaveLength(1);

    (getStreamingEnabled as Mock).mockReturnValue(false);

    act(() => {
      result.current.handleStreamSubagentMessage(
        {
          uuid: "codex-subagent-1",
          type: "assistant",
          _isStreaming: true,
          message: { role: "assistant", content: "partial done" },
        },
        "task-1",
      );
    });

    expect(result.current.agentContent).toEqual({});

    act(() => {
      result.current.handleStreamSubagentMessage(
        {
          uuid: "codex-subagent-1",
          type: "assistant",
          message: { role: "assistant", content: "done" },
        },
        "task-1",
      );
    });

    expect(result.current.agentContent["task-1"]?.messages).toMatchObject([
      {
        uuid: "codex-subagent-1",
        message: { content: "done" },
      },
    ]);
  });

  it("does not re-fetch when the adapter reference is stable across re-renders", async () => {
    // createSessionCacheAdapter returns a module-level singleton per enabled
    // state, so SessionPage re-rendering (same enabled) passes the same
    // reference and the effect must NOT re-run / re-fetch.
    // createSessionCacheAdapter 按 enabled 状态返回模块级单例，故 SessionPage
    // 重渲染（相同 enabled）传入相同引用，effect 不应重跑/重新拉取。
    apiMocks.getSession.mockResolvedValue({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });

    // Same enabled => same singleton reference across calls.
    // 相同 enabled => 多次调用返回同一单例引用。
    const adapter = createSessionCacheAdapter(true);
    expect(createSessionCacheAdapter(true)).toBe(adapter);

    const { rerender, result } = renderHook(
      ({ ad }: { ad: SessionCacheAdapter }) =>
        useSessionMessages({
          projectId: "proj-1",
          sessionId: "sess-1",
          cacheAdapter: ad,
        }),
      { initialProps: { ad: adapter } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(apiMocks.getSession).toHaveBeenCalledTimes(1);

    // Re-render passing the same singleton reference (what SessionPage does on
    // every render when enabled is stable). No second fetch.
    // 传入相同单例引用重渲染（enabled 稳定时 SessionPage 每次渲染都如此）。
    // 不应发第二次请求。
    rerender({ ad: createSessionCacheAdapter(true) });
    await new Promise((r) => setTimeout(r, 50));
    expect(apiMocks.getSession).toHaveBeenCalledTimes(1);
  });

  it("re-runs the effect (once) when the adapter flips disabled -> enabled", async () => {
    // Simulates useServerSettings resolving null -> { enabled: true }: the
    // adapter reference changes from NOOP to REAL, and the effect re-runs so it
    // can start using the cache. This is the intended behavior -- without it,
    // a session opened before settings resolve would never use the cache.
    // 模拟 useServerSettings 从 null 解析为 { enabled: true }：adapter 引用从
    // NOOP 变为 REAL，effect 重跑以启用缓存。这是预期行为——否则在设置解析前
    // 打开的会话将永远用不上缓存。
    apiMocks.getSession.mockResolvedValue({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });

    const { rerender, result } = renderHook(
      ({ ad }: { ad: SessionCacheAdapter }) =>
        useSessionMessages({
          projectId: "proj-1",
          sessionId: "sess-1",
          cacheAdapter: ad,
        }),
      { initialProps: { ad: createSessionCacheAdapter(false) } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(apiMocks.getSession).toHaveBeenCalledTimes(1);

    // Settings resolve: adapter flips NOOP -> REAL. Effect re-runs once.
    // 设置解析：adapter 从 NOOP 翻转为 REAL。effect 重跑一次。
    rerender({ ad: createSessionCacheAdapter(true) });
    await waitFor(() => expect(apiMocks.getSession).toHaveBeenCalledTimes(2));
    // No further fetches from identity churn (singleton is stable now).
    // 单例已稳定，不再因引用抖动产生后续拉取。
    await new Promise((r) => setTimeout(r, 50));
    expect(apiMocks.getSession).toHaveBeenCalledTimes(2);
  });
});
