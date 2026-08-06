import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetClientQueryControllerForTests } from "../../lib/clientQueryController";
import { resetClientSummaryStoreForTests } from "../../lib/clientSummaryStore";
import {
  resetProcessesForTests,
  type ProcessInfo,
  useProcesses,
} from "../useProcesses";

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    fetchJSON: vi.fn(),
    isRemoteClient: vi.fn(() => false),
    remoteState: {
      connection: null as { connection: object | null } | null,
    },
    activityBus: {
      on: vi.fn((event: string, handler: (data: unknown) => void) => {
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
  fetchJSON: mocks.fetchJSON,
}));

vi.mock("../../lib/activityBus", () => ({
  activityBus: { on: mocks.activityBus.on },
}));

vi.mock("../../lib/connection", () => ({
  isRemoteClient: mocks.isRemoteClient,
}));

vi.mock("../../contexts/RemoteConnectionContext", () => ({
  useOptionalRemoteConnection: () => mocks.remoteState.connection,
}));

const STARTED_AT = "2026-06-29T00:00:00.000Z";

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
}

function processInfo(
  sessionId: string,
  overrides: Partial<ProcessInfo> = {},
): ProcessInfo {
  return {
    id: `process-${sessionId}`,
    sessionId,
    projectId: "project-1" as ProcessInfo["projectId"],
    projectPath: "/tmp/project",
    projectName: "Project",
    state: "idle",
    startedAt: STARTED_AT,
    queueDepth: 0,
    sessionTitle: `Session ${sessionId}`,
    provider: "claude",
    ...overrides,
  };
}

function processesResponse(processes: ProcessInfo[] = []) {
  return {
    processes,
    terminatedProcesses: [],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  resetClientSummaryStoreForTests();
  resetClientQueryControllerForTests();
  resetProcessesForTests();
  mocks.fetchJSON.mockReset();
  mocks.fetchJSON.mockResolvedValue(processesResponse());
  mocks.isRemoteClient.mockReset();
  mocks.isRemoteClient.mockReturnValue(false);
  mocks.remoteState.connection = null;
  mocks.activityBus.reset();
  mocks.activityBus.on.mockClear();
});

afterEach(() => {
  cleanup();
  resetProcessesForTests();
  resetClientQueryControllerForTests();
  resetClientSummaryStoreForTests();
  vi.useRealTimers();
});

describe("useProcesses", () => {
  it("fetches the process list once on mount and does not poll", async () => {
    mocks.fetchJSON.mockResolvedValue(
      processesResponse([processInfo("session-1")]),
    );

    const hook = renderHook(() => useProcesses());

    await settle();
    expect(hook.result.current.loading).toBe(false);
    expect(mocks.fetchJSON).toHaveBeenCalledTimes(1);
    expect(mocks.fetchJSON).toHaveBeenCalledWith(
      "/processes?includeTerminated=true",
    );
    expect(hook.result.current.processes).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(mocks.fetchJSON).toHaveBeenCalledTimes(1);
  });

  it("coalesces wake and reconnect refreshes", async () => {
    mocks.fetchJSON.mockResolvedValue(processesResponse());
    const hook = renderHook(() => useProcesses());
    await settle();
    expect(hook.result.current.loading).toBe(false);

    await act(async () => {
      mocks.activityBus.emit("refresh");
      mocks.activityBus.emit("reconnect");
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(mocks.fetchJSON).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await settle();
    expect(mocks.fetchJSON).toHaveBeenCalledTimes(2);
  });

  it("refreshes when a provider child session is created", async () => {
    const hook = renderHook(() => useProcesses());
    await settle();
    expect(hook.result.current.loading).toBe(false);

    await act(async () => {
      mocks.activityBus.emit("file-change", {
        type: "file-change",
        provider: "claude",
        relativePath: "project/parent/subagents/agent-child.meta.json",
        path: "/tmp/agent-child.meta.json",
        fileType: "agent-session",
        changeType: "create",
        timestamp: "2026-06-29T00:00:01.000Z",
      });
      await vi.advanceTimersByTimeAsync(500);
    });
    await settle();

    expect(mocks.fetchJSON).toHaveBeenCalledTimes(2);
  });

  it("patches custom titles from metadata events before refetching", async () => {
    mocks.fetchJSON.mockResolvedValue(
      processesResponse([
        processInfo("session-1", { sessionTitle: "Old title" }),
      ]),
    );

    const hook = renderHook(() => useProcesses());
    await settle();
    expect(hook.result.current.loading).toBe(false);

    act(() => {
      mocks.activityBus.emit("session-metadata-changed", {
        type: "session-metadata-changed",
        sessionId: "session-1",
        title: "Custom title",
        timestamp: "2026-06-29T00:00:01.000Z",
      });
    });

    expect(hook.result.current.processes[0]?.sessionTitle).toBe("Custom title");
    expect(mocks.fetchJSON).toHaveBeenCalledTimes(1);
  });

  it("waits for remote connection readiness before fetching", async () => {
    mocks.isRemoteClient.mockReturnValue(true);
    mocks.remoteState.connection = null;

    const hook = renderHook(() => useProcesses());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.fetchJSON).not.toHaveBeenCalled();
    expect(hook.result.current.loading).toBe(true);

    mocks.remoteState.connection = { connection: {} };
    hook.rerender();

    await settle();
    expect(mocks.fetchJSON).toHaveBeenCalledTimes(1);
  });
});
