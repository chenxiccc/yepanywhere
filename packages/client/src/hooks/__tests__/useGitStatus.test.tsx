import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GitStatusInfo,
  GitUntrackedFileListResult,
} from "@yep-anywhere/shared";
import { resetClientQueryControllerForTests } from "../../lib/clientQueryController";
import { resetClientSummaryStoreForTests } from "../../lib/clientSummaryStore";
import {
  clearRouteRetention,
  resetRouteRetentionForTests,
} from "../../lib/routeRetention";
import { useGitStatus } from "../useGitStatus";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

const mocks = vi.hoisted(() => ({
  getGitStatus: vi.fn(),
  listGitUntrackedFiles: vi.fn(),
  isRemoteClient: vi.fn(() => false),
  onActivitySource: vi.fn(),
  activityListeners: new Map<string, Set<(data: unknown) => void>>(),
  visibilityState: "visible" as DocumentVisibilityState,
  hasFocus: true,
  remoteState: {
    connection: null as { connection: object | null } | null,
  },
}));

vi.mock("../../api/client", () => ({
  api: {
    getGitStatus: mocks.getGitStatus,
    listGitUntrackedFiles: mocks.listGitUntrackedFiles,
  },
}));

vi.mock("../../lib/activityBus", () => ({
  activityBus: {
    onSource: mocks.onActivitySource,
  },
}));

vi.mock("../../lib/connection", () => ({
  isRemoteClient: mocks.isRemoteClient,
}));

vi.mock("../../contexts/RemoteConnectionContext", () => ({
  useOptionalRemoteConnection: () => mocks.remoteState.connection,
}));

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function gitStatus(files: GitStatusInfo["files"]): GitStatusInfo {
  return {
    isGitRepo: true,
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    isClean: files.length === 0,
    files,
    recentCommits: [],
    checkedRemoteAt: null,
  };
}

function emitActivity(eventType: string, data: unknown) {
  for (const listener of mocks.activityListeners.get(eventType) ?? []) {
    listener(data);
  }
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  resetClientQueryControllerForTests();
  resetClientSummaryStoreForTests();
  resetRouteRetentionForTests();
  mocks.getGitStatus.mockReset();
  mocks.listGitUntrackedFiles.mockReset();
  mocks.isRemoteClient.mockReset();
  mocks.isRemoteClient.mockReturnValue(false);
  mocks.onActivitySource.mockReset();
  mocks.activityListeners.clear();
  mocks.onActivitySource.mockImplementation(
    (
      _sourceKey: string,
      eventType: string,
      listener: (data: unknown) => void,
    ) => {
      let listeners = mocks.activityListeners.get(eventType);
      if (!listeners) {
        listeners = new Set();
        mocks.activityListeners.set(eventType, listeners);
      }
      listeners.add(listener);
      return () => listeners?.delete(listener);
    },
  );
  mocks.visibilityState = "visible";
  mocks.hasFocus = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => mocks.visibilityState,
  );
  vi.spyOn(document, "hasFocus").mockImplementation(() => mocks.hasFocus);
  mocks.remoteState.connection = null;
});

afterEach(() => {
  cleanup();
  resetClientQueryControllerForTests();
  resetClientSummaryStoreForTests();
  resetRouteRetentionForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useGitStatus", () => {
  it("restores a retained status snapshot without an initial loading state", async () => {
    const firstStatus = gitStatus([
      {
        path: "a.ts",
        status: "M",
        staged: false,
        linesAdded: 1,
        linesDeleted: 0,
      },
    ]);
    mocks.getGitStatus.mockResolvedValueOnce(firstStatus);

    const first = renderHook(() => useGitStatus("project-a"));
    await settle();
    expect(first.result.current.gitStatus).toEqual(firstStatus);
    expect(first.result.current.loading).toBe(false);
    first.unmount();

    const second = renderHook(() => useGitStatus("project-a"));

    expect(second.result.current.gitStatus).toEqual(firstStatus);
    expect(second.result.current.loading).toBe(false);
    expect(mocks.getGitStatus).toHaveBeenCalledTimes(1);
  });

  it("does not requery a retained status merely because five seconds passed", async () => {
    const firstStatus = gitStatus([
      {
        path: "a.ts",
        status: "M",
        staged: false,
        linesAdded: 1,
        linesDeleted: 0,
      },
    ]);
    mocks.getGitStatus.mockResolvedValueOnce(firstStatus);

    const first = renderHook(() => useGitStatus("project-a"));
    await settle();
    expect(first.result.current.loading).toBe(false);
    first.unmount();

    vi.setSystemTime(6000);
    const second = renderHook(() => useGitStatus("project-a"));
    await settle();

    expect(second.result.current.gitStatus).toEqual(firstStatus);
    expect(second.result.current.loading).toBe(false);
    expect(mocks.getGitStatus).toHaveBeenCalledTimes(1);
  });

  it("refetches when query metadata is fresh but the retained payload is absent", async () => {
    const firstStatus = gitStatus([
      {
        path: "a.ts",
        status: "M",
        staged: false,
        linesAdded: 1,
        linesDeleted: 0,
      },
    ]);
    const recoveredStatus = gitStatus([
      {
        path: "b.ts",
        status: "A",
        staged: true,
        linesAdded: 3,
        linesDeleted: 0,
      },
    ]);
    mocks.getGitStatus
      .mockResolvedValueOnce(firstStatus)
      .mockResolvedValueOnce(recoveredStatus);

    const first = renderHook(() => useGitStatus("project-a"));
    await settle();
    first.unmount();
    resetRouteRetentionForTests();

    const second = renderHook(() => useGitStatus("project-a"));
    expect(second.result.current.loading).toBe(true);
    await settle();

    expect(mocks.getGitStatus).toHaveBeenCalledTimes(2);
    expect(second.result.current.gitStatus).toEqual(recoveredStatus);
    expect(second.result.current.loading).toBe(false);
  });

  it("recovers when a mounted status payload is evicted", async () => {
    const firstStatus = gitStatus([
      {
        path: "a.ts",
        status: "M",
        staged: false,
        linesAdded: 1,
        linesDeleted: 0,
      },
    ]);
    const recoveredStatus = gitStatus([
      {
        path: "b.ts",
        status: "A",
        staged: true,
        linesAdded: 3,
        linesDeleted: 0,
      },
    ]);
    const recovery = deferred<GitStatusInfo>();
    mocks.getGitStatus
      .mockResolvedValueOnce(firstStatus)
      .mockReturnValueOnce(recovery.promise);

    const rendered = renderHook(() => useGitStatus("project-a"));
    await settle();
    expect(rendered.result.current.gitStatus).toEqual(firstStatus);

    act(() => clearRouteRetention());
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.getGitStatus).toHaveBeenCalledTimes(2);
    expect(rendered.result.current.gitStatus).toBeNull();
    expect(rendered.result.current.loading).toBe(true);

    recovery.resolve(recoveredStatus);
    await settle();
    expect(rendered.result.current.gitStatus).toEqual(recoveredStatus);
    expect(rendered.result.current.loading).toBe(false);
  });

  it("can retain status without installing a polling interval", async () => {
    mocks.getGitStatus.mockResolvedValue(gitStatus([]));

    renderHook(() => useGitStatus("project-a", { poll: false }));
    await settle();

    expect(mocks.getGitStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(mocks.getGitStatus).toHaveBeenCalledTimes(1);
  });

  it("uses a focused 30-second safety refresh", async () => {
    mocks.getGitStatus.mockResolvedValue(gitStatus([]));

    renderHook(() => useGitStatus("project-a"));
    await settle();
    expect(mocks.getGitStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999);
    });
    expect(mocks.getGitStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.getGitStatus).toHaveBeenCalledTimes(2);
  });

  it("stops refreshes while hidden or unfocused and refreshes on return", async () => {
    mocks.getGitStatus.mockResolvedValue(gitStatus([]));
    const rendered = renderHook(() => useGitStatus("project-a"));
    await settle();
    expect(mocks.getGitStatus).toHaveBeenCalledTimes(1);

    mocks.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.getGitStatus).toHaveBeenCalledTimes(1);

    mocks.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(mocks.getGitStatus).toHaveBeenCalledTimes(2);

    mocks.hasFocus = false;
    window.dispatchEvent(new Event("blur"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.getGitStatus).toHaveBeenCalledTimes(2);

    mocks.hasFocus = true;
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(mocks.getGitStatus).toHaveBeenCalledTimes(3);

    rendered.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.getGitStatus).toHaveBeenCalledTimes(3);
  });

  it("coalesces project completion events into an early refresh", async () => {
    mocks.getGitStatus.mockResolvedValue(gitStatus([]));

    renderHook(() => useGitStatus("project-a"));
    await settle();
    expect(mocks.getGitStatus).toHaveBeenCalledTimes(1);

    emitActivity("process-state-changed", {
      type: "process-state-changed",
      sessionId: "session-a",
      projectId: "project-a",
      activity: "in-turn",
      timestamp: "2026-08-18T00:00:00.000Z",
    });
    emitActivity("process-state-changed", {
      type: "process-state-changed",
      sessionId: "session-b",
      projectId: "project-b",
      activity: "idle",
      timestamp: "2026-08-18T00:00:00.000Z",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(mocks.getGitStatus).toHaveBeenCalledTimes(1);

    for (const activity of ["waiting-input", "idle"] as const) {
      emitActivity("process-state-changed", {
        type: "process-state-changed",
        sessionId: "session-a",
        projectId: "project-a",
        activity,
        timestamp: "2026-08-18T00:00:01.000Z",
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(749);
    });
    expect(mocks.getGitStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.getGitStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999);
    });
    expect(mocks.getGitStatus).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.getGitStatus).toHaveBeenCalledTimes(3);
  });

  it("merges the capability-gated untracked cache into tracked-only status", async () => {
    const tracked = gitStatus([
      {
        path: "src/tracked.ts",
        status: "M",
        staged: false,
        linesAdded: 1,
        linesDeleted: 0,
      },
    ]);
    mocks.getGitStatus.mockResolvedValue(tracked);
    mocks.listGitUntrackedFiles.mockResolvedValue({
      files: ["root.txt"],
      folders: [{ path: "generated/", count: 20 }],
      total: 21,
      refreshedAt: "2026-08-18T00:00:00.000Z",
      truncated: false,
      limit: 500,
    });

    const rendered = renderHook(() =>
      useGitStatus("project-a", {
        poll: false,
        useUntrackedCache: true,
      }),
    );
    await settle();

    expect(mocks.getGitStatus).toHaveBeenCalledWith("project-a", {
      useUntrackedCache: true,
    });
    expect(mocks.listGitUntrackedFiles).toHaveBeenCalledWith("project-a");
    expect(rendered.result.current.loading).toBe(false);
    expect(rendered.result.current.gitStatus?.files).toEqual([
      tracked.files[0],
      {
        path: "root.txt",
        status: "?",
        staged: false,
        linesAdded: null,
        linesDeleted: null,
      },
      {
        path: "generated/",
        status: "?",
        staged: false,
        linesAdded: null,
        linesDeleted: null,
      },
    ]);
  });

  it("omits untracked rows without launching the legacy inventory request", async () => {
    const tracked = gitStatus([
      {
        path: "src/tracked.ts",
        status: "M",
        staged: false,
        linesAdded: 1,
        linesDeleted: 0,
      },
    ]);
    mocks.getGitStatus.mockResolvedValue(tracked);

    const rendered = renderHook(() =>
      useGitStatus("project-a", { omitUntracked: true, poll: false }),
    );
    await settle();

    expect(mocks.getGitStatus).toHaveBeenCalledWith("project-a", {
      omitUntracked: true,
    });
    expect(mocks.listGitUntrackedFiles).not.toHaveBeenCalled();
    expect(rendered.result.current.loading).toBe(false);
    expect(rendered.result.current.gitStatus?.files).toEqual(tracked.files);
  });

  it("shares an in-flight untracked cache request across polling ticks", async () => {
    mocks.getGitStatus.mockResolvedValue(gitStatus([]));
    const untracked = deferred<GitUntrackedFileListResult>();
    mocks.listGitUntrackedFiles.mockReturnValue(untracked.promise);

    const rendered = renderHook(() =>
      useGitStatus("project-a", { useUntrackedCache: true }),
    );
    await settle();
    expect(mocks.listGitUntrackedFiles).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.listGitUntrackedFiles).toHaveBeenCalledTimes(1);

    untracked.resolve({
      files: ["root.txt"],
      folders: [],
      total: 1,
      refreshedAt: "2026-08-18T00:00:00.000Z",
      truncated: false,
      limit: 500,
    });
    await settle();

    expect(rendered.result.current.gitStatus?.files).toEqual([
      {
        path: "root.txt",
        status: "?",
        staged: false,
        linesAdded: null,
        linesDeleted: null,
      },
    ]);
  });

  it("does not request the untracked cache for a non-Git project", async () => {
    mocks.getGitStatus.mockResolvedValue({
      ...gitStatus([]),
      isGitRepo: false,
    });

    const rendered = renderHook(() =>
      useGitStatus("project-a", {
        poll: false,
        useUntrackedCache: true,
      }),
    );
    await settle();

    expect(rendered.result.current.gitStatus?.isGitRepo).toBe(false);
    expect(rendered.result.current.loading).toBe(false);
    expect(mocks.listGitUntrackedFiles).not.toHaveBeenCalled();
  });
});
