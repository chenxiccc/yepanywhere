import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import type * as fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  GitWorkingTreeFile,
  GitWorkingTreePathKind,
  GitWorktreeCoverage,
  GitWorktreeDeltaEvent,
  GitWorktreeSubscriptionEvent,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectWorktreeSubscriptionManager } from "../../src/projects/projectWorktreeSubscriptionManager.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

class FakeWatcher extends EventEmitter {
  closed = false;

  close(): void {
    this.closed = true;
  }
}

function file(path: string, kind: GitWorkingTreePathKind): GitWorkingTreeFile {
  return { path, kind, tracked: kind === "tracked" };
}

function mapFiles(
  files: GitWorkingTreeFile[],
): Map<string, GitWorkingTreeFile> {
  return new Map(files.map((entry) => [entry.path, entry]));
}

describe("ProjectWorktreeSubscriptionManager", () => {
  let projectPath: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    projectPath = await mkdtemp(join(tmpdir(), "ya-worktree-watch-"));
    await mkdir(join(projectPath, ".git", "objects"), { recursive: true });
    await mkdir(join(projectPath, "src", "nested"), { recursive: true });
    await writeFile(join(projectPath, "src", "a.ts"), "a\n");
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(projectPath, { recursive: true });
  });

  it("shares one dot-git-free watch set and loads ignored paths only on demand", async () => {
    const projectId = "project-a" as UrlProjectId;
    const watchedPaths: string[] = [];
    const watchOptions = new Map<string, { recursive: boolean }>();
    const watchListeners = new Map<
      string,
      (eventType: string, filename: Buffer | string | null) => void
    >();
    const watchers: FakeWatcher[] = [];
    const coverages: GitWorktreeCoverage[] = [];
    let currentFiles = [
      file("src/a.ts", "tracked"),
      file("notes.txt", "untracked"),
    ];
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-a",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      debounceMs: 25,
      maxEventAgeMs: 100,
      watchDirectory: (path, listener, options) => {
        watchedPaths.push(path);
        watchOptions.set(path, options);
        watchListeners.set(path, listener);
        const watcher = new FakeWatcher();
        watchers.push(watcher);
        return watcher as unknown as fs.FSWatcher;
      },
      scanWorktree: vi.fn(async (_path, coverage) => {
        coverages.push({ ...coverage });
        return {
          headSha: "head-a",
          baseSha: "base-a",
          files: mapFiles(
            currentFiles.filter((entry) => coverage[entry.kind ?? "untracked"]),
          ),
        };
      }),
    });

    const ordinaryEvents: GitWorktreeSubscriptionEvent[] = [];
    const ordinary = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: false },
      (event) => ordinaryEvents.push(event),
    );
    await ordinary.ready;

    expect(ordinaryEvents[0]).toMatchObject({
      type: "git-worktree-snapshot",
      files: [file("notes.txt", "untracked"), file("src/a.ts", "tracked")],
    });
    expect(watchedPaths).toEqual([projectPath]);
    await vi.waitFor(() => {
      expect(watchedPaths).toContain(projectPath);
      expect(watchedPaths).toContain(join(projectPath, "src"));
      expect(watchedPaths).toContain(join(projectPath, "src", "nested"));
    });
    const initialWatchCount = watchedPaths.length;
    expect(watchOptions.get(projectPath)).toEqual({ recursive: false });
    expect(watchOptions.get(join(projectPath, "src"))).toEqual({
      recursive: false,
    });
    expect(
      watchedPaths.some((path) =>
        path.includes(`${join(projectPath, ".git")}`),
      ),
    ).toBe(false);
    expect(coverages.at(-1)?.ignored).toBe(false);

    currentFiles = [...currentFiles, file("build/output.js", "ignored")];
    const ignoredEvents: GitWorktreeSubscriptionEvent[] = [];
    const ignored = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: true },
      (event) => ignoredEvents.push(event),
    );
    await ignored.ready;

    expect(coverages.at(-1)?.ignored).toBe(true);
    expect(ignoredEvents[0]).toMatchObject({
      type: "git-worktree-snapshot",
      files: [
        file("build/output.js", "ignored"),
        file("notes.txt", "untracked"),
        file("src/a.ts", "tracked"),
      ],
    });

    currentFiles = currentFiles.map((entry) => ({ ...entry }));
    watchListeners.get(join(projectPath, "src"))?.("change", "a.ts");
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() => {
      expect(ordinaryEvents.at(-1)).toMatchObject({
        type: "git-worktree-delta",
        changes: [{ changeType: "modify", path: "src/a.ts" }],
      });
    });
    expect(watchedPaths).toHaveLength(initialWatchCount);

    watchListeners.get(projectPath)?.("change", null);
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() => {
      expect(ordinaryEvents.at(-1)).toMatchObject({
        type: "git-worktree-delta",
        changes: [
          { changeType: "modify", path: "notes.txt" },
          { changeType: "modify", path: "src/a.ts" },
        ],
      });
    });

    ignored.release();
    ordinary.release();
    expect(manager.diagnostics()).toMatchObject({
      activeProjects: 0,
      subscribers: 0,
      watchedDirectories: 0,
    });
    expect(watchers.every((watcher) => watcher.closed)).toBe(true);
    manager.dispose();
  });

  it("shares one scan for identical subscribers and preserves global sequence", async () => {
    const projectId = "project-a" as UrlProjectId;
    const watchListeners = new Map<
      string,
      (eventType: string, filename: Buffer | string | null) => void
    >();
    let currentFiles = [
      file("src/a.ts", "tracked"),
      file("build/output.js", "ignored"),
    ];
    const scanWorktree = vi.fn(
      async (_path, coverage: GitWorktreeCoverage) => ({
        headSha: "head-a",
        baseSha: "base-a",
        files: mapFiles(
          currentFiles.filter((entry) => coverage[entry.kind ?? "untracked"]),
        ),
      }),
    );
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-a",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      debounceMs: 25,
      maxEventAgeMs: 100,
      watchDirectory: (path, listener) => {
        watchListeners.set(path, listener);
        return new FakeWatcher() as unknown as fs.FSWatcher;
      },
      scanWorktree,
    });
    const coverage = { tracked: true, untracked: true, ignored: false };
    const firstEvents: GitWorktreeSubscriptionEvent[] = [];
    const secondEvents: GitWorktreeSubscriptionEvent[] = [];
    const first = manager.subscribe(projectId, coverage, (event) =>
      firstEvents.push(event),
    );
    await first.ready;
    await vi.waitFor(() => expect(scanWorktree).toHaveBeenCalledTimes(2));
    const initialScanCount = scanWorktree.mock.calls.length;
    const second = manager.subscribe(projectId, coverage, (event) =>
      secondEvents.push(event),
    );
    await second.ready;
    expect(scanWorktree).toHaveBeenCalledTimes(initialScanCount);

    const ignoredEvents: GitWorktreeSubscriptionEvent[] = [];
    const ignored = manager.subscribe(
      projectId,
      { ...coverage, ignored: true },
      (event) => ignoredEvents.push(event),
    );
    await ignored.ready;
    expect(scanWorktree).toHaveBeenCalledTimes(initialScanCount + 1);
    expect(firstEvents.at(-1)).toMatchObject({
      type: "git-worktree-delta",
      generation: expect.any(Object),
      changes: [],
    });
    expect(secondEvents.at(-1)).toMatchObject({
      type: "git-worktree-delta",
      generation: expect.any(Object),
      changes: [],
    });
    const expansionSequence = firstEvents.at(-1)?.generation.sequence;
    expect(secondEvents.at(-1)?.generation.sequence).toBe(expansionSequence);
    expect(ignoredEvents[0]?.generation.sequence).toBe(expansionSequence);

    currentFiles = currentFiles.map((entry) =>
      entry.kind === "ignored" ? { ...entry } : entry,
    );
    watchListeners.get(projectPath)?.("change", "build/output.js");
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() =>
      expect(scanWorktree).toHaveBeenCalledTimes(initialScanCount + 2),
    );
    expect(firstEvents.at(-1)).toMatchObject({
      type: "git-worktree-delta",
      generation: expect.any(Object),
      changes: [],
    });
    expect(ignoredEvents.at(-1)).toMatchObject({
      type: "git-worktree-delta",
      generation: expect.any(Object),
      changes: [{ changeType: "modify", path: "build/output.js" }],
    });
    const changedSequence = firstEvents.at(-1)?.generation.sequence;
    expect(ignoredEvents.at(-1)?.generation.sequence).toBe(changedSequence);
    expect(changedSequence).toBe((expansionSequence ?? -1) + 1);

    ignored.release();
    second.release();
    first.release();
    manager.dispose();
  });

  it("rescans when subscription coverage widens during an active expansion", async () => {
    const projectId = "project-a" as UrlProjectId;
    const currentFiles = [
      file("src/a.ts", "tracked"),
      file("notes.txt", "untracked"),
      file("build/output.js", "ignored"),
    ];
    let releaseExpansion: () => void = () => {};
    const expansionGate = new Promise<void>((resolve) => {
      releaseExpansion = resolve;
    });
    let expansionStarted = false;
    const coverages: GitWorktreeCoverage[] = [];
    const scanWorktree = vi.fn(
      async (_path: string, coverage: GitWorktreeCoverage) => {
        coverages.push({ ...coverage });
        if (coverage.untracked && !coverage.ignored) {
          expansionStarted = true;
          await expansionGate;
        }
        return {
          headSha: "head-a",
          baseSha: "base-a",
          files: mapFiles(
            currentFiles.filter((entry) => coverage[entry.kind ?? "untracked"]),
          ),
        };
      },
    );
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-a",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      watchDirectory: () => new FakeWatcher() as unknown as fs.FSWatcher,
      scanWorktree,
    });
    const tracked = manager.subscribe(
      projectId,
      { tracked: true, untracked: false, ignored: false },
      vi.fn(),
    );
    await tracked.ready;
    await vi.waitFor(() =>
      expect(scanWorktree.mock.calls.length).toBeGreaterThan(1),
    );

    const untracked = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: false },
      vi.fn(),
    );
    await vi.waitFor(() => expect(expansionStarted).toBe(true));
    const ignoredEvents: GitWorktreeSubscriptionEvent[] = [];
    const ignored = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: true },
      (event) => ignoredEvents.push(event),
    );
    releaseExpansion();

    await Promise.all([untracked.ready, ignored.ready]);
    expect(coverages.at(-1)?.ignored).toBe(true);
    expect(ignoredEvents[0]).toMatchObject({
      type: "git-worktree-snapshot",
      files: expect.arrayContaining([
        expect.objectContaining({ path: "build/output.js", kind: "ignored" }),
      ]),
    });

    ignored.release();
    untracked.release();
    tracked.release();
    manager.dispose();
  });

  it("pins the reconciliation deadline to the first unprocessed event", async () => {
    const projectId = "project-a" as UrlProjectId;
    const watchListeners = new Map<
      string,
      (eventType: string, filename: Buffer | string | null) => void
    >();
    const scanWorktree = vi.fn(async () => ({
      headSha: "head-a",
      baseSha: "base-a",
      files: mapFiles([file("src/a.ts", "tracked")]),
    }));
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-a",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      debounceMs: 25,
      maxEventAgeMs: 100,
      watchDirectory: (path, listener) => {
        watchListeners.set(path, listener);
        return new FakeWatcher() as unknown as fs.FSWatcher;
      },
      scanWorktree,
    });
    const subscription = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: false },
      vi.fn(),
    );
    await subscription.ready;
    await vi.waitFor(() => expect(scanWorktree).toHaveBeenCalledTimes(2));
    const initialScanCount = scanWorktree.mock.calls.length;

    for (let index = 0; index < 5; index += 1) {
      watchListeners.get(projectPath)?.("change", `event-${index}`);
      await vi.advanceTimersByTimeAsync(20);
    }
    await vi.waitFor(() =>
      expect(scanWorktree).toHaveBeenCalledTimes(initialScanCount + 1),
    );

    subscription.release();
    manager.dispose();
  });

  it("keeps bounded reconciliation after filesystem watches are complete", async () => {
    const projectId = "project-a" as UrlProjectId;
    const watchListeners = new Map<
      string,
      (eventType: string, filename: Buffer | string | null) => void
    >();
    let failSrcWatch = true;
    const scanWorktree = vi.fn(async () => ({
      headSha: "head-a",
      baseSha: "base-a",
      files: mapFiles([file("src/a.ts", "tracked")]),
    }));
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-a",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      debounceMs: 25,
      maxEventAgeMs: 100,
      fallbackPollMs: 1_000,
      watchDirectory: (path, listener) => {
        if (failSrcWatch && path === join(projectPath, "src")) {
          throw new Error("watch unavailable");
        }
        watchListeners.set(path, listener);
        return new FakeWatcher() as unknown as fs.FSWatcher;
      },
      scanWorktree,
    });
    const subscription = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: false },
      vi.fn(),
    );
    await subscription.ready;
    await vi.waitFor(() => expect(scanWorktree).toHaveBeenCalledTimes(2));
    const initialScanCount = scanWorktree.mock.calls.length;

    failSrcWatch = false;
    watchListeners.get(projectPath)?.("rename", "src");
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() =>
      expect(scanWorktree).toHaveBeenCalledTimes(initialScanCount + 2),
    );
    const recoveredScanCount = scanWorktree.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() =>
      expect(scanWorktree).toHaveBeenCalledTimes(recoveredScanCount + 1),
    );
    const reconciledScanCount = scanWorktree.mock.calls.length;

    subscription.release();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(scanWorktree).toHaveBeenCalledTimes(reconciledScanCount);
    manager.dispose();
  });

  it("reconciles index staging and commits without dot-git watches", async () => {
    await rm(projectPath, { recursive: true });
    await mkdir(projectPath);
    await runGit(projectPath, ["init"]);
    await runGit(projectPath, ["config", "user.email", "ya-test@example.com"]);
    await runGit(projectPath, ["config", "user.name", "YA Test"]);
    await writeFile(join(projectPath, "base.txt"), "base\n");
    await runGit(projectPath, ["add", "base.txt"]);
    await runGit(projectPath, ["commit", "-m", "Base"]);
    await writeFile(join(projectPath, "pending.txt"), "pending\n");

    const projectId = "project-git-metadata" as UrlProjectId;
    const events: GitWorktreeSubscriptionEvent[] = [];
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-git-metadata",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      fallbackPollMs: 1_000,
      watchDirectory: () => new FakeWatcher() as unknown as fs.FSWatcher,
    });
    const subscription = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: false },
      (event) => events.push(event),
    );

    await subscription.ready;
    expect(events[0]).toMatchObject({
      type: "git-worktree-snapshot",
      files: expect.arrayContaining([
        expect.objectContaining({ path: "pending.txt", kind: "untracked" }),
      ]),
    });

    await runGit(projectPath, ["add", "pending.txt"]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "git-worktree-delta",
          changes: expect.arrayContaining([
            expect.objectContaining({
              path: "pending.txt",
              file: expect.objectContaining({
                kind: "tracked",
                worktreeChanges: expect.arrayContaining([
                  expect.objectContaining({ staged: true }),
                ]),
              }),
            }),
          ]),
        }),
      ),
    );
    const stagedSequence = events.at(-1)?.generation.sequence ?? 0;

    await runGit(projectPath, ["commit", "-m", "Add pending"]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({
        type: "git-worktree-delta",
        changes: [
          expect.objectContaining({
            path: "pending.txt",
            file: expect.not.objectContaining({
              worktreeChanges: expect.anything(),
            }),
          }),
        ],
      }),
    );
    expect(events.at(-1)?.generation.sequence).toBeGreaterThan(stagedSequence);

    subscription.release();
    manager.dispose();
  });

  it("streams create, modify, and delete deltas from a real repository", async () => {
    vi.useRealTimers();
    await rm(projectPath, { recursive: true });
    await mkdir(projectPath);
    await runGit(projectPath, ["init"]);
    await runGit(projectPath, ["config", "user.email", "ya-test@example.com"]);
    await runGit(projectPath, ["config", "user.name", "YA Test"]);
    await writeFile(join(projectPath, "tracked.txt"), "initial\n");
    await runGit(projectPath, ["add", "tracked.txt"]);
    await runGit(projectPath, ["commit", "-m", "Initial file"]);

    const projectId = "project-live" as UrlProjectId;
    let waiter:
      | {
          afterSequence: number;
          changeType: GitWorktreeDeltaEvent["changes"][number]["changeType"];
          resolve: (event: GitWorktreeDeltaEvent) => void;
        }
      | undefined;
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-live",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      debounceMs: 25,
      maxEventAgeMs: 1_000,
    });
    let sequence = 0;
    const subscription = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: false },
      (event) => {
        sequence = event.generation.sequence;
        if (
          event.type === "git-worktree-delta" &&
          waiter &&
          event.generation.sequence > waiter.afterSequence &&
          event.changes.some(
            (change) =>
              change.path === "probe.txt" &&
              change.changeType === waiter?.changeType,
          )
        ) {
          waiter.resolve(event);
        }
      },
    );
    const waitForDelta = async (
      changeType: GitWorktreeDeltaEvent["changes"][number]["changeType"],
      action: () => Promise<void>,
    ): Promise<GitWorktreeDeltaEvent> => {
      const afterSequence = sequence;
      const event = new Promise<GitWorktreeDeltaEvent>((resolve) => {
        waiter = { afterSequence, changeType, resolve };
      });
      await action();
      try {
        return await Promise.race([
          event,
          new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error(`${changeType} delta timeout`)),
              5_000,
            );
          }),
        ]);
      } finally {
        waiter = undefined;
      }
    };

    try {
      await subscription.ready;
      const probePath = join(projectPath, "probe.txt");
      await waitForDelta("create", () => writeFile(probePath, "created\n"));
      await waitForDelta("modify", () => writeFile(probePath, "modified\n"));
      await waitForDelta("delete", () => rm(probePath));
    } finally {
      subscription.release();
      manager.dispose();
    }
  }, 20_000);
});
