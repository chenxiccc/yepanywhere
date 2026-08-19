import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type {
  GitFileChange,
  GitWorkingTreeChange,
  GitWorkingTreeFile,
  GitWorkingTreePathKind,
  GitWorktreeCoverage,
  GitWorktreePathChange,
  GitWorktreeSubscriptionEvent,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { readGitDiffFileChanges } from "../git/fileChanges.js";
import { GIT_DECODE_PATHS_ARGS, runGit } from "../git/gitExec.js";
import { getLogger } from "../logging/logger.js";
import { getGitStatus } from "../routes/git-status.js";
import type { ProjectScanner } from "./scanner.js";

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_MAX_EVENT_AGE_MS = 5_000;
const DEFAULT_FALLBACK_POLL_MS = 30_000;
const DEFAULT_MAX_RETAINED_PROJECTS = 32;
const DEFAULT_FILE_LIMIT = 100_000;
const MAX_BUFFER = 64 * 1024 * 1024;

interface Subscriber {
  coverage: GitWorktreeCoverage;
  listener: (event: GitWorktreeSubscriptionEvent) => void;
  ready: boolean;
}

interface WatchedDirectory {
  watcher: fs.FSWatcher;
}

export interface ProjectWorktreeScan {
  headSha: string | null;
  baseSha: string | null;
  files: Map<string, GitWorkingTreeFile>;
}

interface ProjectState {
  projectId: UrlProjectId;
  projectPath: string;
  epoch: string;
  sequence: number;
  headSha: string | null;
  baseSha: string | null;
  files: Map<string, GitWorkingTreeFile>;
  subscribers: Map<number, Subscriber>;
  watchers: Map<string, WatchedDirectory>;
  watchComplete: boolean;
  watchersNeedFullSync: boolean;
  initialized: boolean;
  activationPromise: Promise<void> | null;
  refreshPromise: Promise<void> | null;
  refreshQueued: boolean;
  watchSyncPromise: Promise<void> | null;
  watchSyncQueued: boolean;
  watchSyncNeedsRefresh: boolean;
  watchSyncFull: boolean;
  pendingPaths: Set<string>;
  pendingWatchPaths: Set<string>;
  debounceTimer: NodeJS.Timeout | null;
  deadlineTimer: NodeJS.Timeout | null;
  pollTimer: NodeJS.Timeout | null;
  lastUsedAt: number;
}

interface PendingSubscription {
  cancelled: boolean;
  detach: (() => void) | null;
}

export interface ProjectWorktreeSubscription {
  ready: Promise<void>;
  release(): void;
}

export interface ProjectWorktreeSubscriptionManagerOptions {
  scanner: Pick<ProjectScanner, "getProject">;
  debounceMs?: number;
  maxEventAgeMs?: number;
  fallbackPollMs?: number;
  maxRetainedProjects?: number;
  fileLimit?: number;
  watchDirectory?: (
    path: string,
    listener: (eventType: string, filename: Buffer | string | null) => void,
    options: { recursive: boolean },
  ) => fs.FSWatcher;
  scanWorktree?: (
    projectPath: string,
    coverage: GitWorktreeCoverage,
  ) => Promise<ProjectWorktreeScan>;
}

const ALL_COVERAGE: GitWorktreeCoverage = {
  tracked: true,
  untracked: true,
  ignored: true,
};

function isDotGitPath(path: string): boolean {
  return path.split("/").includes(".git");
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pathIsAtOrBelow(path: string, parent: string): boolean {
  return path === parent || (parent !== "" && path.startsWith(`${parent}/`));
}

function includesKind(
  coverage: GitWorktreeCoverage,
  kind: GitWorkingTreePathKind,
): boolean {
  return coverage[kind];
}

function unionCoverage(subscribers: Iterable<Subscriber>): GitWorktreeCoverage {
  const result = { tracked: false, untracked: false, ignored: false };
  for (const subscriber of subscribers) {
    result.tracked ||= subscriber.coverage.tracked;
    result.untracked ||= subscriber.coverage.untracked;
    result.ignored ||= subscriber.coverage.ignored;
  }
  return result;
}

function sameCoverage(
  left: GitWorktreeCoverage,
  right: GitWorktreeCoverage,
): boolean {
  return (
    left.tracked === right.tracked &&
    left.untracked === right.untracked &&
    left.ignored === right.ignored
  );
}

export class ProjectWorktreeSubscriptionManager {
  private readonly scanner: ProjectWorktreeSubscriptionManagerOptions["scanner"];
  private readonly debounceMs: number;
  private readonly maxEventAgeMs: number;
  private readonly fallbackPollMs: number;
  private readonly maxRetainedProjects: number;
  private readonly fileLimit: number;
  private readonly watchDirectory: NonNullable<
    ProjectWorktreeSubscriptionManagerOptions["watchDirectory"]
  >;
  private readonly scanWorktree: NonNullable<
    ProjectWorktreeSubscriptionManagerOptions["scanWorktree"]
  >;
  private readonly projects = new Map<string, ProjectState>();
  private nextSubscriberId = 1;
  private disposed = false;

  constructor(options: ProjectWorktreeSubscriptionManagerOptions) {
    this.scanner = options.scanner;
    this.debounceMs = Math.max(25, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.maxEventAgeMs = Math.max(
      this.debounceMs,
      options.maxEventAgeMs ?? DEFAULT_MAX_EVENT_AGE_MS,
    );
    this.fallbackPollMs = Math.max(
      1_000,
      options.fallbackPollMs ?? DEFAULT_FALLBACK_POLL_MS,
    );
    this.maxRetainedProjects = Math.max(
      1,
      options.maxRetainedProjects ?? DEFAULT_MAX_RETAINED_PROJECTS,
    );
    this.fileLimit = Math.max(1, options.fileLimit ?? DEFAULT_FILE_LIMIT);
    this.watchDirectory =
      options.watchDirectory ??
      ((path, listener, watchOptions) =>
        fs.watch(
          path,
          { persistent: false, recursive: watchOptions.recursive },
          listener,
        ));
    this.scanWorktree = options.scanWorktree ?? scanGitWorktree;
  }

  subscribe(
    projectId: UrlProjectId,
    coverage: GitWorktreeCoverage,
    listener: (event: GitWorktreeSubscriptionEvent) => void,
  ): ProjectWorktreeSubscription {
    const pending: PendingSubscription = { cancelled: false, detach: null };
    const release = () => {
      if (pending.cancelled) return;
      pending.cancelled = true;
      pending.detach?.();
    };
    return {
      ready: this.startSubscription(projectId, coverage, listener, pending),
      release,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const state of this.projects.values()) this.deactivate(state);
    this.projects.clear();
  }

  diagnostics(): {
    activeProjects: number;
    retainedProjects: number;
    subscribers: number;
    watchedDirectories: number;
  } {
    let activeProjects = 0;
    let subscribers = 0;
    let watchedDirectories = 0;
    for (const state of this.projects.values()) {
      if (state.subscribers.size > 0) activeProjects += 1;
      subscribers += state.subscribers.size;
      watchedDirectories += state.watchers.size;
    }
    return {
      activeProjects,
      retainedProjects: this.projects.size,
      subscribers,
      watchedDirectories,
    };
  }

  private async startSubscription(
    projectId: UrlProjectId,
    coverage: GitWorktreeCoverage,
    listener: (event: GitWorktreeSubscriptionEvent) => void,
    pending: PendingSubscription,
  ): Promise<void> {
    if (this.disposed) {
      throw new Error("Worktree subscription manager disposed");
    }
    const project = await this.scanner.getProject(projectId, {
      allowStaleSnapshot: true,
    });
    if (pending.cancelled) return;
    if (!project) throw new Error("Project not found");
    const projectPath = await realpath(project.path);
    if (pending.cancelled) return;

    const state = this.getOrCreateState(projectId, projectPath);
    const subscriberId = this.nextSubscriberId++;
    const subscriber: Subscriber = { coverage, listener, ready: false };
    const previousCoverage = unionCoverage(state.subscribers.values());
    state.subscribers.set(subscriberId, subscriber);
    state.lastUsedAt = Date.now();

    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      const current = this.projects.get(projectId);
      if (current !== state) return;
      const before = unionCoverage(current.subscribers.values());
      current.subscribers.delete(subscriberId);
      current.lastUsedAt = Date.now();
      if (current.subscribers.size === 0) {
        this.deactivate(current);
        this.evictInactiveProjects();
        return;
      }
      const after = unionCoverage(current.subscribers.values());
      if (!sameCoverage(before, after)) {
        void this.refresh(current, true).catch((error) => {
          getLogger().warn(
            { error, projectId: current.projectId },
            "WORKTREE_WATCH: failed to reduce released coverage",
          );
        });
      }
    };
    pending.detach = detach;
    if (pending.cancelled) return detach();

    try {
      await this.ensureActive(state, previousCoverage);
      if (
        pending.cancelled ||
        state.subscribers.get(subscriberId) !== subscriber
      ) {
        return;
      }
      subscriber.ready = true;
      listener(this.snapshot(state, subscriber.coverage));
    } catch (error) {
      detach();
      throw error;
    }
  }

  private getOrCreateState(
    projectId: UrlProjectId,
    projectPath: string,
  ): ProjectState {
    const existing = this.projects.get(projectId);
    if (existing?.projectPath === projectPath) return existing;
    if (existing) this.deactivate(existing);
    const state: ProjectState = {
      projectId,
      projectPath,
      epoch: randomUUID(),
      sequence: 0,
      headSha: null,
      baseSha: null,
      files: new Map(),
      subscribers: new Map(),
      watchers: new Map(),
      watchComplete: false,
      watchersNeedFullSync: true,
      initialized: false,
      activationPromise: null,
      refreshPromise: null,
      refreshQueued: false,
      watchSyncPromise: null,
      watchSyncQueued: false,
      watchSyncNeedsRefresh: false,
      watchSyncFull: false,
      pendingPaths: new Set(),
      pendingWatchPaths: new Set(),
      debounceTimer: null,
      deadlineTimer: null,
      pollTimer: null,
      lastUsedAt: Date.now(),
    };
    this.projects.set(projectId, state);
    return state;
  }

  private ensureActive(
    state: ProjectState,
    previousCoverage: GitWorktreeCoverage,
  ): Promise<void> {
    const wanted = unionCoverage(state.subscribers.values());
    if (state.activationPromise) return state.activationPromise;
    if (state.initialized && sameCoverage(previousCoverage, wanted)) {
      return Promise.resolve();
    }
    state.activationPromise = this.activate(state).finally(() => {
      state.activationPromise = null;
    });
    return state.activationPromise;
  }

  private async activate(state: ProjectState): Promise<void> {
    await this.refresh(state, state.initialized);
    this.syncReconciliationPoll(state);
    if (state.watchersNeedFullSync) {
      state.watchersNeedFullSync = false;
      this.scheduleWatcherSync(state, true, true);
    }
  }

  private scheduleWatcherSync(
    state: ProjectState,
    refreshAfter: boolean,
    full: boolean,
  ): void {
    if (state.subscribers.size === 0) return;
    state.watchSyncQueued = true;
    state.watchSyncNeedsRefresh ||= refreshAfter;
    state.watchSyncFull ||= full;
    if (state.watchSyncPromise) return;
    state.watchSyncPromise = this.runWatcherSyncLoop(state)
      .catch((error) => {
        getLogger().warn(
          { error, projectId: state.projectId },
          "WORKTREE_WATCH: watcher reconciliation failed",
        );
      })
      .finally(() => {
        state.watchSyncPromise = null;
        if (state.watchSyncQueued && state.subscribers.size > 0) {
          this.scheduleWatcherSync(state, false, false);
        }
      });
  }

  private async runWatcherSyncLoop(state: ProjectState): Promise<void> {
    do {
      state.watchSyncQueued = false;
      const refreshAfter = state.watchSyncNeedsRefresh;
      const full = state.watchSyncFull;
      const paths = [...state.pendingWatchPaths];
      state.watchSyncNeedsRefresh = false;
      state.watchSyncFull = false;
      state.pendingWatchPaths.clear();
      let watchersChanged = false;
      if (full || paths.includes("")) {
        await this.syncWatchers(state);
        watchersChanged = true;
      } else {
        for (const path of paths) {
          watchersChanged =
            (await this.reconcileWatcherPath(state, path)) || watchersChanged;
        }
        if (!state.watchComplete) {
          await this.syncWatchers(state);
          watchersChanged = true;
        }
      }
      if (state.subscribers.size === 0) return;
      this.syncReconciliationPoll(state);
      if (refreshAfter || watchersChanged) await this.refresh(state, true);
    } while (state.watchSyncQueued && state.subscribers.size > 0);
  }

  private async syncWatchers(state: ProjectState): Promise<void> {
    let complete = true;
    if (!state.watchers.has("")) complete = this.attachWatcher(state, "");
    const listed = await this.listDirectories(state.projectPath);
    const wanted = listed.directories;
    complete &&= listed.complete;
    if (state.subscribers.size === 0) return;
    for (const [path, watched] of state.watchers) {
      if (wanted.has(path)) continue;
      watched.watcher.close();
      state.watchers.delete(path);
    }
    for (const directory of wanted) {
      if (state.watchers.has(directory)) continue;
      if (!this.attachWatcher(state, directory)) complete = false;
    }
    state.watchComplete = complete && state.watchers.size === wanted.size;
  }

  private attachWatcher(state: ProjectState, directory: string): boolean {
    const absolute = directory
      ? join(state.projectPath, directory)
      : state.projectPath;
    try {
      const watcher = this.watchDirectory(
        absolute,
        (eventType, filename) => {
          this.onFilesystemEvent(state, directory, eventType, filename);
        },
        { recursive: false },
      );
      watcher.on("error", (error) => {
        getLogger().warn(
          { directory, error, projectId: state.projectId },
          "WORKTREE_WATCH: directory watch failed; using bounded reconciliation",
        );
        watcher.close();
        state.watchers.delete(directory);
        state.watchComplete = false;
        state.pendingWatchPaths.add(directory);
        this.syncReconciliationPoll(state);
        this.scheduleRefresh(state);
      });
      state.watchers.set(directory, { watcher });
      return true;
    } catch (error) {
      state.watchComplete = false;
      getLogger().debug(
        { directory, error, projectId: state.projectId },
        "WORKTREE_WATCH: directory not watchable; polling covers it",
      );
      return false;
    }
  }

  private async reconcileWatcherPath(
    state: ProjectState,
    path: string,
  ): Promise<boolean> {
    if (!path || isDotGitPath(path)) return false;
    const absolute = join(state.projectPath, path);
    let directoryExists = false;
    try {
      directoryExists = (await lstat(absolute)).isDirectory();
    } catch {
      // A removed directory only needs its watchers detached.
    }

    if (!directoryExists) {
      let changed = false;
      for (const [watchedPath, watched] of state.watchers) {
        if (!pathIsAtOrBelow(watchedPath, path)) continue;
        watched.watcher.close();
        state.watchers.delete(watchedPath);
        changed = true;
      }
      return changed;
    }

    const listed = await this.listDirectories(absolute, path);
    if (!listed.complete) state.watchComplete = false;
    let changed = false;
    for (const [watchedPath, watched] of state.watchers) {
      if (
        pathIsAtOrBelow(watchedPath, path) &&
        !listed.directories.has(watchedPath)
      ) {
        watched.watcher.close();
        state.watchers.delete(watchedPath);
        changed = true;
      }
    }
    for (const directory of listed.directories) {
      if (state.watchers.has(directory)) continue;
      this.attachWatcher(state, directory);
      changed = true;
    }
    return changed;
  }

  private async listDirectories(
    projectPath: string,
    initialRelative = "",
  ): Promise<{ directories: Set<string>; complete: boolean }> {
    const directories = new Set<string>([initialRelative]);
    const pending = [{ absolute: projectPath, relative: initialRelative }];
    let complete = true;
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) break;
      let entries: Awaited<ReturnType<typeof opendir>>;
      try {
        entries = await opendir(current.absolute);
      } catch {
        complete = false;
        continue;
      }
      for await (const entry of entries) {
        if (!entry.isDirectory() || entry.name === ".git") continue;
        const childRelative = current.relative
          ? `${current.relative}/${entry.name}`
          : entry.name;
        if (isDotGitPath(childRelative)) continue;
        directories.add(childRelative);
        pending.push({
          absolute: join(current.absolute, entry.name),
          relative: childRelative,
        });
      }
    }
    return { directories, complete };
  }

  private onFilesystemEvent(
    state: ProjectState,
    directory: string,
    eventType: string,
    filename: Buffer | string | null,
  ): void {
    if (state.subscribers.size === 0) return;
    const relativeName = filename?.toString().replaceAll("\\", "/") ?? "";
    const path = [directory, relativeName].filter(Boolean).join("/");
    if (path && isDotGitPath(path)) return;
    state.pendingPaths.add(path);
    if (eventType === "rename" && path) {
      state.pendingWatchPaths.add(path);
    }
    this.scheduleRefresh(state);
  }

  private scheduleRefresh(state: ProjectState): void {
    if (state.subscribers.size === 0) return;
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(
      () => this.flushRefresh(state),
      this.debounceMs,
    );
    state.debounceTimer.unref();
    if (!state.deadlineTimer) {
      state.deadlineTimer = setTimeout(
        () => this.flushRefresh(state),
        this.maxEventAgeMs,
      );
      state.deadlineTimer.unref();
    }
  }

  private flushRefresh(state: ProjectState): void {
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    if (state.deadlineTimer) clearTimeout(state.deadlineTimer);
    state.debounceTimer = null;
    state.deadlineTimer = null;
    void this.refresh(state, true)
      .then(() => this.scheduleWatcherSync(state, false, false))
      .catch((error) => {
        getLogger().warn(
          { error, projectId: state.projectId },
          "WORKTREE_WATCH: reconciliation failed",
        );
      });
  }

  private async refresh(state: ProjectState, emit: boolean): Promise<void> {
    if (state.refreshPromise) {
      state.refreshQueued = true;
      await state.refreshPromise;
      return;
    }
    state.refreshPromise = this.runRefreshLoop(state, emit).finally(() => {
      state.refreshPromise = null;
    });
    await state.refreshPromise;
  }

  private async runRefreshLoop(
    state: ProjectState,
    emit: boolean,
  ): Promise<void> {
    do {
      state.refreshQueued = false;
      const coverage = unionCoverage(state.subscribers.values());
      const pendingPaths = new Set(state.pendingPaths);
      state.pendingPaths.clear();
      let scan: ProjectWorktreeScan;
      try {
        scan = await this.scanWorktree(state.projectPath, coverage);
      } catch (error) {
        for (const path of pendingPaths) state.pendingPaths.add(path);
        throw error;
      }
      if (state.subscribers.size === 0) return;
      const { files, changes } = diffFiles(
        state.files,
        scan.files,
        pendingPaths,
      );
      const endpointsChanged =
        scan.headSha !== state.headSha || scan.baseSha !== state.baseSha;
      state.files = files;
      state.headSha = scan.headSha;
      state.baseSha = scan.baseSha;
      state.initialized = true;
      if (changes.length > 0 || endpointsChanged) {
        state.sequence += 1;
        if (emit) this.emit(state, changes);
      }
      if (!sameCoverage(coverage, unionCoverage(state.subscribers.values()))) {
        state.refreshQueued = true;
      }
    } while (state.refreshQueued && state.subscribers.size > 0);
  }

  private snapshot(
    state: ProjectState,
    coverage: GitWorktreeCoverage,
  ): GitWorktreeSubscriptionEvent {
    const files = [...state.files.values()]
      .filter((file) =>
        includesKind(
          coverage,
          file.kind ?? (file.tracked ? "tracked" : "untracked"),
        ),
      )
      .sort((left, right) => comparePaths(left.path, right.path));
    return {
      type: "git-worktree-snapshot",
      generation: { epoch: state.epoch, sequence: state.sequence },
      coverage,
      headSha: state.headSha,
      baseSha: state.baseSha,
      files: files.slice(0, this.fileLimit),
      truncated: files.length > this.fileLimit,
      timestamp: new Date().toISOString(),
    };
  }

  private emit(state: ProjectState, changes: GitWorktreePathChange[]): void {
    for (const subscriber of state.subscribers.values()) {
      if (!subscriber.ready) continue;
      const filtered = changes.filter((change) => {
        const kind = change.file?.kind ?? state.files.get(change.path)?.kind;
        return kind === undefined || includesKind(subscriber.coverage, kind);
      });
      try {
        subscriber.listener({
          type: "git-worktree-delta",
          generation: { epoch: state.epoch, sequence: state.sequence },
          headSha: state.headSha,
          baseSha: state.baseSha,
          changes: filtered,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        getLogger().warn(
          { error, projectId: state.projectId },
          "WORKTREE_WATCH: subscriber failed",
        );
      }
    }
  }

  private syncReconciliationPoll(state: ProjectState): void {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(() => {
      void this.refresh(state, true).catch((error) => {
        getLogger().warn(
          { error, projectId: state.projectId },
          "WORKTREE_WATCH: periodic reconciliation failed",
        );
      });
    }, this.fallbackPollMs);
    state.pollTimer.unref();
  }

  private deactivate(state: ProjectState): void {
    for (const watched of state.watchers.values()) watched.watcher.close();
    state.watchers.clear();
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    if (state.deadlineTimer) clearTimeout(state.deadlineTimer);
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.debounceTimer = null;
    state.deadlineTimer = null;
    state.pollTimer = null;
    state.pendingPaths.clear();
    state.pendingWatchPaths.clear();
    state.watchSyncQueued = false;
    state.watchSyncNeedsRefresh = false;
    state.watchSyncFull = false;
    state.watchComplete = false;
    state.watchersNeedFullSync = true;
  }

  private evictInactiveProjects(): void {
    if (this.projects.size <= this.maxRetainedProjects) return;
    const inactive = [...this.projects.entries()]
      .filter(([, state]) => state.subscribers.size === 0)
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
    while (
      this.projects.size > this.maxRetainedProjects &&
      inactive.length > 0
    ) {
      const candidate = inactive.shift();
      if (!candidate) break;
      const [projectId, state] = candidate;
      this.deactivate(state);
      this.projects.delete(projectId);
    }
  }
}

function diffFiles(
  previous: Map<string, GitWorkingTreeFile>,
  current: Map<string, GitWorkingTreeFile>,
  pendingPaths: ReadonlySet<string>,
): {
  files: Map<string, GitWorkingTreeFile>;
  changes: GitWorktreePathChange[];
} {
  const files = new Map<string, GitWorkingTreeFile>();
  const changes: GitWorktreePathChange[] = [];
  for (const [path, next] of current) {
    const prior = previous.get(path);
    if (!prior) {
      files.set(path, next);
      changes.push({ changeType: "create", path, file: next });
      continue;
    }
    if (sameFile(prior, next) && !pathWasObserved(path, pendingPaths)) {
      files.set(path, prior);
      continue;
    }
    files.set(path, next);
    changes.push({ changeType: "modify", path, file: next });
  }
  for (const [path, file] of previous) {
    if (!current.has(path)) {
      changes.push({ changeType: "delete", path, file });
    }
  }
  changes.sort((left, right) => comparePaths(left.path, right.path));
  return { files, changes };
}

function pathWasObserved(
  path: string,
  pendingPaths: ReadonlySet<string>,
): boolean {
  for (const pending of pendingPaths) {
    if (pending === "" || path === pending || path.startsWith(`${pending}/`)) {
      return true;
    }
  }
  return false;
}

function sameFile(
  left: GitWorkingTreeFile,
  right: GitWorkingTreeFile,
): boolean {
  return (
    left.path === right.path &&
    left.tracked === right.tracked &&
    left.kind === right.kind &&
    left.present === right.present &&
    sameChanges(left.worktreeChanges, right.worktreeChanges) &&
    sameChange(left.cumulativeChange, right.cumulativeChange)
  );
}

function sameChanges(
  left: readonly GitWorkingTreeChange[] | undefined,
  right: readonly GitWorkingTreeChange[] | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((change, index) => sameChange(change, right[index]));
}

function sameChange(
  left: GitWorkingTreeChange | undefined,
  right: GitWorkingTreeChange | undefined,
): boolean {
  if (left === right) return true;
  return Boolean(
    left &&
      right &&
      left.status === right.status &&
      left.staged === right.staged &&
      left.linesAdded === right.linesAdded &&
      left.linesDeleted === right.linesDeleted &&
      left.origPath === right.origPath &&
      left.lastEditor?.sessionId === right.lastEditor?.sessionId &&
      left.lastEditor?.observedAt === right.lastEditor?.observedAt,
  );
}

async function scanGitWorktree(
  projectPath: string,
  coverage: GitWorktreeCoverage,
): Promise<ProjectWorktreeScan> {
  const [headSha, cached, deleted, untracked, ignored] = await Promise.all([
    resolveCommit(projectPath, "HEAD"),
    coverage.tracked ? listGitPaths(projectPath, ["--cached"]) : [],
    coverage.tracked ? listGitPaths(projectPath, ["--deleted"]) : [],
    coverage.untracked
      ? listGitPaths(projectPath, ["--others", "--exclude-standard"])
      : [],
    coverage.ignored
      ? listGitPaths(projectPath, [
          "--others",
          "--ignored",
          "--exclude-standard",
        ])
      : [],
  ]);
  const baseSha = headSha ? await resolveCommit(projectPath, "HEAD^1") : null;
  const [status, cumulativeFiles] = await Promise.all([
    headSha ? getGitStatus(projectPath, null, false) : null,
    baseSha
      ? readGitDiffFileChanges(projectPath, [baseSha], {
          maxBuffer: MAX_BUFFER,
        })
      : [],
  ]);

  const worktreeByPath = groupChanges(status?.files ?? []);
  const cumulativeByPath = new Map(
    cumulativeFiles.map((change) => [change.path, withoutPath(change)]),
  );
  const deletedPaths = new Set(deleted);
  const files = new Map<string, GitWorkingTreeFile>();

  for (const path of cached) {
    if (!path || deletedPaths.has(path) || !validPath(projectPath, path))
      continue;
    files.set(
      path,
      createFile(path, "tracked", true, worktreeByPath, cumulativeByPath),
    );
  }
  for (const path of deletedPaths) {
    if (!path || !validPath(projectPath, path)) continue;
    const worktreeChanges = worktreeByPath.get(path);
    const cumulativeChange = cumulativeByPath.get(path);
    if (!worktreeChanges && !cumulativeChange) continue;
    files.set(path, {
      path,
      tracked: true,
      kind: "tracked",
      present: false,
      ...(worktreeChanges ? { worktreeChanges } : {}),
      ...(cumulativeChange ? { cumulativeChange } : {}),
    });
  }
  for (const path of untracked) {
    if (!path || files.has(path) || !validPath(projectPath, path)) continue;
    const untrackedChange: GitWorkingTreeChange = {
      status: "?",
      staged: false,
      linesAdded: null,
      linesDeleted: null,
    };
    files.set(path, {
      path,
      tracked: false,
      kind: "untracked",
      present: true,
      worktreeChanges: [untrackedChange],
      cumulativeChange: untrackedChange,
    });
  }
  for (const path of ignored) {
    if (!path || files.has(path) || !validPath(projectPath, path)) continue;
    files.set(path, {
      path,
      tracked: false,
      kind: "ignored",
      present: true,
    });
  }
  for (const [path, worktreeChanges] of worktreeByPath) {
    if (files.has(path) || !validPath(projectPath, path)) continue;
    files.set(path, {
      path,
      tracked: true,
      kind: "tracked",
      present: false,
      worktreeChanges,
      ...(cumulativeByPath.has(path)
        ? { cumulativeChange: cumulativeByPath.get(path) }
        : {}),
    });
  }

  return { headSha, baseSha, files };
}

function createFile(
  path: string,
  kind: GitWorkingTreePathKind,
  present: boolean,
  worktreeByPath: ReadonlyMap<string, GitWorkingTreeChange[]>,
  cumulativeByPath: ReadonlyMap<string, GitWorkingTreeChange>,
): GitWorkingTreeFile {
  const worktreeChanges = worktreeByPath.get(path);
  const cumulativeChange = cumulativeByPath.get(path);
  return {
    path,
    tracked: kind === "tracked",
    kind,
    present,
    ...(worktreeChanges ? { worktreeChanges } : {}),
    ...(cumulativeChange ? { cumulativeChange } : {}),
  };
}

function groupChanges(
  changes: readonly GitFileChange[],
): Map<string, GitWorkingTreeChange[]> {
  const result = new Map<string, GitWorkingTreeChange[]>();
  for (const change of changes) {
    const existing = result.get(change.path);
    const value = withoutPath(change);
    if (existing) existing.push(value);
    else result.set(change.path, [value]);
  }
  return result;
}

function withoutPath(change: GitFileChange): GitWorkingTreeChange {
  const { path: _path, ...value } = change;
  return value;
}

function validPath(projectPath: string, path: string): boolean {
  if (isDotGitPath(path)) return false;
  return isContained(projectPath, join(projectPath, path));
}

async function listGitPaths(
  projectPath: string,
  flags: string[],
): Promise<string[]> {
  const { stdout } = await runGit(
    projectPath,
    [...GIT_DECODE_PATHS_ARGS, "ls-files", "-z", ...flags],
    { maxBuffer: MAX_BUFFER },
  );
  const paths = stdout.split("\0");
  if (paths.at(-1) === "") paths.pop();
  return paths;
}

async function resolveCommit(
  projectPath: string,
  revision: string,
): Promise<string | null> {
  try {
    const { stdout } = await runGit(projectPath, [
      "rev-parse",
      "--verify",
      `${revision}^{commit}`,
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export { ALL_COVERAGE, diffFiles, scanGitWorktree };
