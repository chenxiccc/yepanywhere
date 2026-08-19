import type {
  GitWorkingTreeFile,
  GitWorktreeCoverage,
  GitWorktreeDirectory,
  GitWorktreeSnapshotEvent,
} from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asClientSummarySourceKey } from "./clientSummaryStore";
import { getProjectWorktreeStore } from "./projectWorktreeStore";
import { FakeSourceTransport } from "./transport";

const COVERAGE: GitWorktreeCoverage = {
  tracked: true,
  untracked: true,
  ignored: false,
};

function snapshot(
  files: GitWorkingTreeFile[],
  sequence = 0,
  directories?: GitWorktreeDirectory[],
): GitWorktreeSnapshotEvent {
  return {
    type: "git-worktree-snapshot",
    generation: { epoch: "epoch-a", sequence },
    coverage: COVERAGE,
    headSha: "head-a",
    baseSha: "base-a",
    files,
    ...(directories ? { directories } : {}),
    truncated: false,
    timestamp: "2026-08-19T00:00:00.000Z",
  };
}

function onlyWorktreeSubscription(transport: FakeSourceTransport) {
  const subscriptions = transport.getSubscriptions("worktree");
  const subscription = subscriptions.at(-1);
  if (!subscription) throw new Error("Expected worktree subscription");
  return subscription;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ProjectWorktreeStore", () => {
  it("shares leases, unions coverage, and closes the final subscription", () => {
    const transport = new FakeSourceTransport();
    const store = getProjectWorktreeStore(
      asClientSummarySourceKey("test:worktree-leases"),
      "project-a",
      transport,
    );

    const releaseDefault = store.retain(COVERAGE);
    const initial = onlyWorktreeSubscription(transport);
    expect(initial).toMatchObject({
      projectId: "project-a",
      coverage: COVERAGE,
      closed: false,
    });

    const releaseIgnored = store.retain({
      tracked: false,
      untracked: false,
      ignored: true,
    });
    const expanded = onlyWorktreeSubscription(transport);
    expect(initial.closed).toBe(false);
    expect(transport.getSubscriptions("worktree")[0]).toMatchObject({
      closed: true,
      closeCalls: 1,
    });
    expect(expanded).toMatchObject({
      coverage: { tracked: true, untracked: true, ignored: true },
      closed: false,
    });

    releaseIgnored();
    const reduced = onlyWorktreeSubscription(transport);
    expect(reduced).toMatchObject({ coverage: COVERAGE, closed: false });

    releaseDefault();
    expect(onlyWorktreeSubscription(transport)).toMatchObject({
      closed: true,
      closeCalls: 1,
    });
  });

  it("unions and narrows expanded-prefix leases", () => {
    const transport = new FakeSourceTransport();
    const store = getProjectWorktreeStore(
      asClientSummarySourceKey("test:worktree-prefix-leases"),
      "project-a",
      transport,
    );

    const releaseRoot = store.retain({ ...COVERAGE, expandedPrefixes: [] });
    const root = onlyWorktreeSubscription(transport);
    expect(root.coverage).toEqual({ ...COVERAGE, expandedPrefixes: [] });

    const releaseNested = store.retain({
      ...COVERAGE,
      expandedPrefixes: ["src", "src/nested"],
    });
    expect(transport.getSubscriptions("worktree")[0]).toMatchObject({
      closed: true,
      closeCalls: 1,
    });
    expect(onlyWorktreeSubscription(transport).coverage).toEqual({
      ...COVERAGE,
      expandedPrefixes: ["src", "src/nested"],
    });

    releaseNested();
    expect(onlyWorktreeSubscription(transport).coverage).toEqual({
      ...COVERAGE,
      expandedPrefixes: [],
    });
    releaseRoot();
    expect(onlyWorktreeSubscription(transport).closed).toBe(true);
  });

  it("settles from a snapshot and preserves untouched row identity across deltas", () => {
    const transport = new FakeSourceTransport();
    const store = getProjectWorktreeStore(
      asClientSummarySourceKey("test:worktree-deltas"),
      "project-a",
      transport,
    );
    const release = store.retain(COVERAGE);
    const subscription = onlyWorktreeSubscription(transport);
    const first: GitWorkingTreeFile = {
      path: "src/first.ts",
      tracked: true,
      kind: "tracked",
    };
    const second: GitWorkingTreeFile = {
      path: "src/second.ts",
      tracked: true,
      kind: "tracked",
    };

    transport.emitSubscriptionEvent(
      subscription.id,
      "git-worktree-snapshot",
      snapshot([first, second]),
    );
    expect(store.getSnapshot()).toMatchObject({
      loading: false,
      error: null,
      generation: { epoch: "epoch-a", sequence: 0 },
      files: [first, second],
    });

    const changedSecond: GitWorkingTreeFile = {
      ...second,
      worktreeChanges: [
        {
          status: "M",
          staged: false,
          linesAdded: 1,
          linesDeleted: 0,
        },
      ],
    };
    transport.emitSubscriptionEvent(subscription.id, "git-worktree-delta", {
      type: "git-worktree-delta",
      generation: { epoch: "epoch-a", sequence: 1 },
      headSha: "head-a",
      baseSha: "base-a",
      changes: [
        {
          changeType: "modify",
          path: changedSecond.path,
          file: changedSecond,
        },
      ],
      timestamp: "2026-08-19T00:00:01.000Z",
    });

    const updated = store.getSnapshot();
    expect(updated.files[0]).toBe(first);
    expect(updated.files[1]).toBe(changedSecond);
    release();
  });

  it("applies optional directory snapshots and deltas", () => {
    const transport = new FakeSourceTransport();
    const store = getProjectWorktreeStore(
      asClientSummarySourceKey("test:worktree-directory-deltas"),
      "project-a",
      transport,
    );
    const release = store.retain({ ...COVERAGE, expandedPrefixes: ["src"] });
    const subscription = onlyWorktreeSubscription(transport);
    const src: GitWorktreeDirectory = {
      path: "src",
      pending: true,
      truncated: false,
    };
    const notes: GitWorktreeDirectory = {
      path: "notes",
      pending: true,
      truncated: false,
    };

    transport.emitSubscriptionEvent(
      subscription.id,
      "git-worktree-snapshot",
      snapshot([], 0, [notes, src]),
    );
    expect(store.getSnapshot().directories).toEqual([notes, src]);

    const openedSrc: GitWorktreeDirectory = {
      path: "src",
      pending: false,
      truncated: true,
    };
    const nested: GitWorktreeDirectory = {
      path: "src/nested",
      pending: true,
      truncated: false,
    };
    transport.emitSubscriptionEvent(subscription.id, "git-worktree-delta", {
      type: "git-worktree-delta",
      generation: { epoch: "epoch-a", sequence: 1 },
      headSha: null,
      baseSha: null,
      changes: [],
      directoryChanges: [
        { changeType: "delete", path: "notes" },
        {
          changeType: "modify",
          path: "src",
          directory: openedSrc,
        },
        {
          changeType: "create",
          path: "src/nested",
          directory: nested,
        },
      ],
      truncated: true,
      timestamp: "2026-08-19T00:00:01.000Z",
    });

    expect(store.getSnapshot()).toMatchObject({
      directories: [openedSrc, nested],
      truncated: true,
    });
    release();
  });

  it("ignores stale deltas and resubscribes once after a generation gap", () => {
    const transport = new FakeSourceTransport();
    const store = getProjectWorktreeStore(
      asClientSummarySourceKey("test:worktree-gap"),
      "project-a",
      transport,
    );
    const release = store.retain(COVERAGE);
    const initial = onlyWorktreeSubscription(transport);
    transport.emitSubscriptionEvent(
      initial.id,
      "git-worktree-snapshot",
      snapshot([], 4),
    );

    transport.emitSubscriptionEvent(initial.id, "git-worktree-delta", {
      type: "git-worktree-delta",
      generation: { epoch: "epoch-a", sequence: 4 },
      headSha: "head-a",
      baseSha: "base-a",
      changes: [],
      timestamp: "2026-08-19T00:00:01.000Z",
    });
    expect(transport.getSubscriptions("worktree")).toHaveLength(1);

    transport.emitSubscriptionEvent(initial.id, "git-worktree-delta", {
      type: "git-worktree-delta",
      generation: { epoch: "epoch-a", sequence: 6 },
      headSha: "head-a",
      baseSha: "base-a",
      changes: [],
      timestamp: "2026-08-19T00:00:02.000Z",
    });
    expect(transport.getSubscriptions("worktree")).toHaveLength(2);
    expect(transport.getSubscriptions("worktree")[0]).toMatchObject({
      closed: true,
      closeCalls: 1,
    });
    expect(onlyWorktreeSubscription(transport)).toMatchObject({
      coverage: COVERAGE,
      closed: false,
    });
    release();
  });

  it("accepts an initial snapshot delivered synchronously by the transport", () => {
    const transport = new FakeSourceTransport();
    const event = snapshot([
      { path: "README.md", tracked: true, kind: "tracked" },
    ]);
    vi.spyOn(transport, "subscribeWorktree").mockImplementation(
      (_projectId, _coverage, handlers) => {
        handlers.onEvent("git-worktree-snapshot", undefined, event);
        return { close: vi.fn() };
      },
    );
    const store = getProjectWorktreeStore(
      asClientSummarySourceKey("test:worktree-synchronous"),
      "project-a",
      transport,
    );

    const release = store.retain(COVERAGE);
    expect(store.getSnapshot()).toMatchObject({
      loading: false,
      generation: { epoch: "epoch-a", sequence: 0 },
      files: [{ path: "README.md" }],
    });
    release();
  });
});
