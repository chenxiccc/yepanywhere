import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GitStatusInfo,
  GitUntrackedFileListResult,
} from "@yep-anywhere/shared";
import { resetClientQueryControllerForTests } from "../../lib/clientQueryController";
import { resetClientSummaryStoreForTests } from "../../lib/clientSummaryStore";
import { resetRouteRetentionForTests } from "../../lib/routeRetention";
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
  mocks.remoteState.connection = null;
});

afterEach(() => {
  cleanup();
  resetClientQueryControllerForTests();
  resetClientSummaryStoreForTests();
  resetRouteRetentionForTests();
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

  it("revalidates a stale retained status in the background", async () => {
    const firstStatus = gitStatus([
      {
        path: "a.ts",
        status: "M",
        staged: false,
        linesAdded: 1,
        linesDeleted: 0,
      },
    ]);
    const updatedStatus = gitStatus([
      {
        path: "b.ts",
        status: "A",
        staged: true,
        linesAdded: 3,
        linesDeleted: 0,
      },
    ]);
    mocks.getGitStatus.mockResolvedValueOnce(firstStatus);

    const first = renderHook(() => useGitStatus("project-a"));
    await settle();
    expect(first.result.current.loading).toBe(false);
    first.unmount();

    vi.setSystemTime(6000);
    const revalidation = deferred<GitStatusInfo>();
    mocks.getGitStatus.mockReturnValueOnce(revalidation.promise);

    const second = renderHook(() => useGitStatus("project-a"));
    expect(second.result.current.gitStatus).toEqual(firstStatus);
    expect(second.result.current.loading).toBe(false);

    await settle();
    expect(mocks.getGitStatus).toHaveBeenCalledTimes(2);
    expect(second.result.current.loading).toBe(false);

    revalidation.resolve(updatedStatus);
    await settle();

    expect(second.result.current.gitStatus).toEqual(updatedStatus);
    expect(second.result.current.loading).toBe(false);
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
      await vi.advanceTimersByTimeAsync(5000);
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
