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
      return (map.get(key) as unknown) ?? null;
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
    // Second load: incremental delta (no totalMessageCount change => no discard).
    // 第二次加载：增量 delta（totalMessageCount 未变 => 不丢弃）。
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
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
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

  it("discards the warm cache and does a full tail reload when totalMessageCount changes", async () => {
    // First load writes a cache snapshot with totalMessageCount=1.
    // 首次加载写入 totalMessageCount=1 的缓存快照。
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
    // Reopen: incremental response reports totalMessageCount=3 (compacted /
    // advanced elsewhere) => discard + full tail reload.
    // 重开：增量响应报告 totalMessageCount=3（别处 compact / 推进）=> 丢弃 + 全量重拉。
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:02:00.000Z",
      },
      messages: [],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 3,
        returnedMessageCount: 0,
        totalCompactions: 0,
      },
    });
    // Full tail reload (no afterMessageId) returns the fresh tail.
    // 全量尾部重拉（无 afterMessageId）返回新鲜尾部。
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

    // Warm hydration paints the cached msg-1, then the count mismatch triggers
    // a full tail reload that replaces it with msg-3. Assert the calls and the
    // final state; the transient msg-1 view is not polled (it can be too brief
    // when the full reload lands quickly).
    // warm hydration 先绘制缓存的 msg-1，随后 count 不一致触发全量尾部重拉将其替换为 msg-3。
    // 此处断言调用次数与最终状态；瞬时 msg-1 视图不做轮询（全量重拉快速到达时可能过短）。

    // Incremental call (with afterMessageId) happens first; the count mismatch
    // then triggers a full tail reload (no afterMessageId). Wait for both.
    // 先发增量调用（带 afterMessageId）；随后 count 不一致触发全量尾部重拉（无 afterMessageId）。等待两者完成。
    await waitFor(() =>
      expect(apiMocks.getSession.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    expect(apiMocks.getSession).toHaveBeenNthCalledWith(
      2,
      "proj-1",
      "sess-1",
      "msg-1",
      { tailCompactions: 2 },
    );
    // Then a full tail reload (no afterMessageId) due to count mismatch.
    // 随后因 count 不一致发起全量尾部重拉（无 afterMessageId）。
    await waitFor(() => expect(apiMocks.getSession).toHaveBeenCalledTimes(3));
    expect(apiMocks.getSession).toHaveBeenNthCalledWith(
      3,
      "proj-1",
      "sess-1",
      undefined,
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

  it("does not discard the warm cache when only updatedAt changes (count equal)", async () => {
    // Heartbeat/appends advance updatedAt but totalMessageCount stays equal =>
    // the incremental delta merges; no full reload.
    // 心跳/追加会让 updatedAt 前移但 totalMessageCount 相等 => 增量 delta 合并，无全量重拉。
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
    // Reopen: updatedAt advanced, count unchanged, delta present.
    // 重开：updatedAt 前移、count 不变、有 delta。
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
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
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

    await waitFor(() => expect(apiMocks.getSession).toHaveBeenCalledTimes(2));
    // No third call: count equal => no discard, no full reload.
    // 无第三次调用：count 相等 => 不丢弃、无全量重拉。
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
