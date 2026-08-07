import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetClientQueryControllerForTests } from "../../lib/clientQueryController";
import {
  createClientSummaryHostSourceKey,
  resetClientSummaryStoreForTests,
  setCurrentClientSummarySourceKey,
} from "../../lib/clientSummaryStore";
import {
  InboxProvider,
  type InboxResponse,
  useInboxContext,
} from "../InboxContext";

const { activityBus, mockGetInbox, remoteState } = vi.hoisted(() => {
  const handlers = new Map<string, Set<(data?: unknown) => void>>();
  return {
    mockGetInbox: vi.fn<() => Promise<InboxResponse>>(),
    remoteState: {
      connection: null as { connection: object | null } | null,
    },
    activityBus: {
      on: vi.fn((event: string, handler: (data?: unknown) => void) => {
        let set = handlers.get(event);
        if (!set) {
          set = new Set();
          handlers.set(event, set);
        }
        set.add(handler);
        return () => handlers.get(event)?.delete(handler);
      }),
      emit(event: string, data?: unknown) {
        for (const handler of handlers.get(event) ?? []) {
          handler(data);
        }
      },
      reset() {
        handlers.clear();
      },
    },
  };
});

vi.mock("../../api/client", () => ({
  api: {
    getInbox: mockGetInbox,
  },
}));

vi.mock("../../lib/activityBus", () => ({
  activityBus: {
    on: activityBus.on,
    onSource: (
      _sourceKey: string,
      event: string,
      handler: (data?: unknown) => void,
    ) => activityBus.on(event, handler),
    retainSourceStream: vi.fn(() => () => {}),
  },
}));

vi.mock("../../lib/connection", () => ({
  isRemoteClient: () => true,
}));

vi.mock("../RemoteConnectionContext", () => ({
  useOptionalRemoteConnection: () => remoteState.connection,
}));

function InboxConsumer() {
  const {
    active,
    error,
    loading,
    needsAttention,
    recentActivity,
    refresh,
    totalItems,
  } = useInboxContext();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="error">{error?.message ?? ""}</span>
      <span data-testid="total">{String(totalItems)}</span>
      <span data-testid="needs">
        {needsAttention.map((item) => item.sessionTitle).join("|")}
      </span>
      <span data-testid="active">
        {active.map((item) => item.sessionTitle).join("|")}
      </span>
      <span data-testid="recent">
        {recentActivity.map((item) => item.sessionTitle).join("|")}
      </span>
      <button
        type="button"
        data-testid="refresh"
        onClick={() => void refresh()}
      >
        refresh
      </button>
    </div>
  );
}

function emptyInbox(overrides: Partial<InboxResponse> = {}): InboxResponse {
  return {
    needsAttention: [],
    active: [],
    recentActivity: [],
    unread8h: [],
    unread24h: [],
    ...overrides,
  };
}

describe("InboxProvider", () => {
  beforeEach(() => {
    resetClientSummaryStoreForTests();
    resetClientQueryControllerForTests();
    mockGetInbox.mockReset();
    mockGetInbox.mockResolvedValue({
      needsAttention: [],
      active: [],
      recentActivity: [],
      unread8h: [],
      unread24h: [],
    });
    remoteState.connection = null;
    activityBus.reset();
    activityBus.on.mockClear();
    window.history.replaceState({}, "", "/inbox");
  });

  afterEach(() => {
    cleanup();
    remoteState.connection = null;
    vi.clearAllMocks();
    activityBus.reset();
    resetClientQueryControllerForTests();
    resetClientSummaryStoreForTests();
  });

  it("does not fetch before remote connection is ready", async () => {
    render(
      <InboxProvider>
        <InboxConsumer />
      </InboxProvider>,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockGetInbox).not.toHaveBeenCalled();
  });

  it("does not fetch on a login child route", async () => {
    remoteState.connection = { connection: {} };
    window.history.replaceState({}, "", "/login/relay");

    render(
      <InboxProvider>
        <InboxConsumer />
      </InboxProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockGetInbox).not.toHaveBeenCalled();
  });

  it("fetches once the remote connection becomes available", async () => {
    mockGetInbox.mockResolvedValue(
      emptyInbox({
        active: [
          {
            sessionId: "session-1",
            projectId: "project-1",
            projectName: "Project",
            sessionTitle: "Session 1",
            updatedAt: "2026-06-28T00:00:00.000Z",
          },
        ],
      }),
    );

    const view = render(
      <InboxProvider>
        <InboxConsumer />
      </InboxProvider>,
    );

    expect(mockGetInbox).not.toHaveBeenCalled();

    remoteState.connection = { connection: {} };
    view.rerender(
      <InboxProvider>
        <InboxConsumer />
      </InboxProvider>,
    );

    await waitFor(() => {
      expect(mockGetInbox).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(view.getByTestId("total").textContent).toBe("1");
    });
  });

  it("resets stable inbox ordering when the summary source changes", async () => {
    const macbook = createClientSummaryHostSourceKey("macbook");
    const winnative = createClientSummaryHostSourceKey("winnative");
    remoteState.connection = { connection: {} };
    mockGetInbox
      .mockResolvedValueOnce(
        emptyInbox({
          needsAttention: [
            {
              sessionId: "shared-session",
              projectId: "project-1",
              projectName: "Project",
              sessionTitle: "Mac shared",
              updatedAt: "2026-06-28T00:00:00.000Z",
            },
            {
              sessionId: "mac-other",
              projectId: "project-1",
              projectName: "Project",
              sessionTitle: "Mac other",
              updatedAt: "2026-06-28T00:00:00.000Z",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        emptyInbox({
          needsAttention: [
            {
              sessionId: "win-new",
              projectId: "project-1",
              projectName: "Project",
              sessionTitle: "Win new",
              updatedAt: "2026-06-28T00:00:00.000Z",
            },
            {
              sessionId: "shared-session",
              projectId: "project-1",
              projectName: "Project",
              sessionTitle: "Win shared",
              updatedAt: "2026-06-28T00:00:00.000Z",
            },
          ],
        }),
      );

    act(() => {
      setCurrentClientSummarySourceKey(macbook);
    });

    const view = render(
      <InboxProvider>
        <InboxConsumer />
      </InboxProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId("needs").textContent).toBe(
        "Mac shared|Mac other",
      );
    });

    act(() => {
      setCurrentClientSummarySourceKey(winnative);
    });

    await waitFor(() => {
      expect(mockGetInbox).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(view.getByTestId("needs").textContent).toBe("Win new|Win shared");
    });
  });

  it("coalesces refresh and reconnect events through the retained query", async () => {
    vi.useFakeTimers();
    try {
      remoteState.connection = { connection: {} };
      mockGetInbox
        .mockResolvedValueOnce(
          emptyInbox({
            active: [
              {
                sessionId: "session-1",
                projectId: "project-1",
                projectName: "Project",
                sessionTitle: "Initial",
                updatedAt: "2026-06-28T00:00:00.000Z",
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          emptyInbox({
            active: [
              {
                sessionId: "session-1",
                projectId: "project-1",
                projectName: "Project",
                sessionTitle: "Initial",
                updatedAt: "2026-06-28T00:00:00.000Z",
              },
              {
                sessionId: "session-2",
                projectId: "project-1",
                projectName: "Project",
                sessionTitle: "After wake",
                updatedAt: "2026-06-28T00:01:00.000Z",
              },
            ],
          }),
        );

      const view = render(
        <InboxProvider>
          <InboxConsumer />
        </InboxProvider>,
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mockGetInbox).toHaveBeenCalledTimes(1);
      expect(view.getByTestId("total").textContent).toBe("1");

      await act(async () => {
        activityBus.emit("refresh");
        activityBus.emit("reconnect");
        await vi.advanceTimersByTimeAsync(499);
      });
      expect(mockGetInbox).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockGetInbox).toHaveBeenCalledTimes(2);
      expect(view.getByTestId("total").textContent).toBe("2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("patches known session-updated events without refetching the inbox", async () => {
    vi.useFakeTimers();
    try {
      remoteState.connection = { connection: {} };
      mockGetInbox.mockResolvedValueOnce(
        emptyInbox({
          needsAttention: [
            {
              sessionId: "session-1",
              projectId: "project-1",
              projectName: "Project",
              sessionTitle: "Initial",
              updatedAt: "2026-06-28T00:00:00.000Z",
              pendingInputType: "user-question",
            },
          ],
        }),
      );

      const view = render(
        <InboxProvider>
          <InboxConsumer />
        </InboxProvider>,
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mockGetInbox).toHaveBeenCalledTimes(1);
      expect(view.getByTestId("needs").textContent).toBe("Initial");

      await act(async () => {
        activityBus.emit("session-updated", {
          type: "session-updated",
          sessionId: "session-1",
          projectId: "project-1",
          title: "Patched title",
          updatedAt: "2026-06-28T00:01:00.000Z",
          timestamp: "2026-06-28T00:01:00.000Z",
        });
        await vi.advanceTimersByTimeAsync(500);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockGetInbox).toHaveBeenCalledTimes(1);
      expect(view.getByTestId("needs").textContent).toBe("Patched title");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refetches inbox when a session-updated event is not in known tiers", async () => {
    vi.useFakeTimers();
    try {
      remoteState.connection = { connection: {} };
      mockGetInbox.mockResolvedValueOnce(emptyInbox()).mockResolvedValueOnce(
        emptyInbox({
          recentActivity: [
            {
              sessionId: "session-2",
              projectId: "project-1",
              projectName: "Project",
              sessionTitle: "Discovered",
              updatedAt: "2026-06-28T00:01:00.000Z",
            },
          ],
        }),
      );

      const view = render(
        <InboxProvider>
          <InboxConsumer />
        </InboxProvider>,
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mockGetInbox).toHaveBeenCalledTimes(1);

      await act(async () => {
        activityBus.emit("session-updated", {
          type: "session-updated",
          sessionId: "session-2",
          projectId: "project-1",
          title: "Discovered",
          updatedAt: "2026-06-28T00:01:00.000Z",
          timestamp: "2026-06-28T00:01:00.000Z",
        });
        await vi.advanceTimersByTimeAsync(500);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockGetInbox).toHaveBeenCalledTimes(2);
      expect(view.getByTestId("total").textContent).toBe("1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refetches inbox for unread-tier session-updated promotions", async () => {
    vi.useFakeTimers();
    try {
      remoteState.connection = { connection: {} };
      mockGetInbox
        .mockResolvedValueOnce(
          emptyInbox({
            unread24h: [
              {
                sessionId: "session-3",
                projectId: "project-1",
                projectName: "Project",
                sessionTitle: "Unread",
                updatedAt: "2026-06-27T23:00:00.000Z",
                hasUnread: true,
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          emptyInbox({
            recentActivity: [
              {
                sessionId: "session-3",
                projectId: "project-1",
                projectName: "Project",
                sessionTitle: "Unread updated",
                updatedAt: "2026-06-28T00:01:00.000Z",
                hasUnread: true,
              },
            ],
          }),
        );

      const view = render(
        <InboxProvider>
          <InboxConsumer />
        </InboxProvider>,
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mockGetInbox).toHaveBeenCalledTimes(1);

      await act(async () => {
        activityBus.emit("session-updated", {
          type: "session-updated",
          sessionId: "session-3",
          projectId: "project-1",
          title: "Unread updated",
          updatedAt: "2026-06-28T00:01:00.000Z",
          timestamp: "2026-06-28T00:01:00.000Z",
        });
        await vi.advanceTimersByTimeAsync(500);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockGetInbox).toHaveBeenCalledTimes(2);
      expect(view.getByTestId("total").textContent).toBe("1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refetches inbox when project queue membership can change tiers", async () => {
    vi.useFakeTimers();
    try {
      remoteState.connection = { connection: {} };
      mockGetInbox
        .mockResolvedValueOnce(
          emptyInbox({
            recentActivity: [
              {
                sessionId: "session-4",
                projectId: "project-1",
                projectName: "Project",
                sessionTitle: "Queued later",
                updatedAt: "2026-06-28T00:00:00.000Z",
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          emptyInbox({
            active: [
              {
                sessionId: "session-4",
                projectId: "project-1",
                projectName: "Project",
                sessionTitle: "Queued later",
                updatedAt: "2026-06-28T00:00:00.000Z",
              },
            ],
          }),
        );

      const view = render(
        <InboxProvider>
          <InboxConsumer />
        </InboxProvider>,
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mockGetInbox).toHaveBeenCalledTimes(1);
      expect(view.getByTestId("recent").textContent).toBe("Queued later");
      expect(view.getByTestId("active").textContent).toBe("");

      await act(async () => {
        activityBus.emit("project-queue-changed", {
          type: "project-queue-changed",
          projectId: "project-1",
          items: [
            {
              id: "queue-1",
              projectId: "project-1",
              target: { type: "existing-session", sessionId: "session-4" },
              messagePreview: "Queued work",
              message: { text: "Queued work" },
              createdAt: "2026-06-28T00:01:00.000Z",
              updatedAt: "2026-06-28T00:01:00.000Z",
              status: "queued",
              attachmentCount: 0,
            },
          ],
          reason: "created",
          timestamp: "2026-06-28T00:01:00.000Z",
        });
        await vi.advanceTimersByTimeAsync(500);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockGetInbox).toHaveBeenCalledTimes(2);
      expect(view.getByTestId("recent").textContent).toBe("");
      expect(view.getByTestId("active").textContent).toBe("Queued later");
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves stable order on revalidation and server order on refresh", async () => {
    vi.useFakeTimers();
    try {
      remoteState.connection = { connection: {} };
      mockGetInbox
        .mockResolvedValueOnce(
          emptyInbox({
            needsAttention: [
              {
                sessionId: "session-a",
                projectId: "project-1",
                projectName: "Project",
                sessionTitle: "A",
                updatedAt: "2026-06-28T00:00:00.000Z",
              },
              {
                sessionId: "session-b",
                projectId: "project-1",
                projectName: "Project",
                sessionTitle: "B",
                updatedAt: "2026-06-28T00:00:00.000Z",
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          emptyInbox({
            needsAttention: [
              {
                sessionId: "session-b",
                projectId: "project-1",
                projectName: "Project",
                sessionTitle: "B",
                updatedAt: "2026-06-28T00:01:00.000Z",
              },
              {
                sessionId: "session-a",
                projectId: "project-1",
                projectName: "Project",
                sessionTitle: "A",
                updatedAt: "2026-06-28T00:01:00.000Z",
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          emptyInbox({
            needsAttention: [
              {
                sessionId: "session-b",
                projectId: "project-1",
                projectName: "Project",
                sessionTitle: "B",
                updatedAt: "2026-06-28T00:02:00.000Z",
              },
              {
                sessionId: "session-a",
                projectId: "project-1",
                projectName: "Project",
                sessionTitle: "A",
                updatedAt: "2026-06-28T00:02:00.000Z",
              },
            ],
          }),
        );

      const view = render(
        <InboxProvider>
          <InboxConsumer />
        </InboxProvider>,
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(view.getByTestId("needs").textContent).toBe("A|B");

      await act(async () => {
        activityBus.emit("refresh");
        await vi.advanceTimersByTimeAsync(500);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockGetInbox).toHaveBeenCalledTimes(2);
      expect(view.getByTestId("needs").textContent).toBe("A|B");

      await act(async () => {
        fireEvent.click(view.getByTestId("refresh"));
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mockGetInbox).toHaveBeenCalledTimes(3);
      expect(view.getByTestId("needs").textContent).toBe("B|A");
    } finally {
      vi.useRealTimers();
    }
  });
});
