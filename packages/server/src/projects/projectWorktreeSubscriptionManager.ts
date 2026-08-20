import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  GitWorkingTreeFile,
  GitWorktreeCoverage,
  GitWorktreeDirectory,
  GitWorktreeSnapshotEvent,
  GitWorktreeSubscriptionEvent,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { runGit } from "../git/gitExec.js";
import { getLogger } from "../logging/logger.js";
import {
  compareWorktreePaths,
  sameWorktreeCoverage,
  unionExpandedWorktreeCoverage,
  unionWorktreeCoverage,
} from "./projectWorktreeCoverage.js";
import {
  createProjectWorktreeInventory,
  diffDirectories,
  diffFiles,
  hasExpandedProjectWorktreeCorpus,
  type ProjectWorktreeInventory,
  projectWorktreeEndpoints,
  projectWorktreeProjection,
  projectWorktreeWatchScope,
  reconcileProjectWorktreeInventory,
} from "./projectWorktreeProjection.js";
import {
  type ProjectWorktreeScan,
  scanFilesystemWorktree,
  scanGitWorktree,
} from "./projectWorktreeScan.js";
import type { ProjectScanner } from "./scanner.js";

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_MAX_EVENT_AGE_MS = 5_000;
const DEFAULT_FALLBACK_POLL_MS = 30_000;
const DEFAULT_MAX_RETAINED_PROJECTS = 32;
const DEFAULT_FILE_LIMIT = 100_000;
/**
 * A project outside Git has no ignore rules to thin its tree, so its inventory
 * is bounded far below the Git limit: enough for a real working set, small
 * enough that a phone renders it and the walk stays cheap.
 */
const FILESYSTEM_INVENTORY_FILE_LIMIT = 5_000;
const GIT_METADATA_PLATFORM: NodeJS.Platform = "linux";

const GIT_ROOT_METADATA_NAMES = new Set([
  "HEAD",
  "index",
  "packed-refs",
  "config",
  "config.worktree",
  "FETCH_HEAD",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "refs",
  "info",
  "rebase-merge",
  "rebase-apply",
  "reftable",
]);

interface Subscriber {
  coverage: GitWorktreeCoverage;
  listener: (event: GitWorktreeSubscriptionEvent) => void;
  ready: boolean;
  projectedFiles: Map<string, GitWorkingTreeFile>;
  projectedDirectories: Map<string, GitWorktreeDirectory> | null;
}

interface WatchedDirectory {
  watcher: fs.FSWatcher;
}

export interface GitMetadataPaths {
  gitDir: string;
  commonDir: string;
  headRefPath: string | null;
}

type GitMetadataWatchScope =
  | "root"
  | "refs"
  | "info"
  | "operation"
  | "reftable";

interface GitMetadataWatchSpec {
  path: string;
  recursive: boolean;
  scope: GitMetadataWatchScope;
}

interface WatchedGitMetadata extends WatchedDirectory {
  spec: GitMetadataWatchSpec;
}

type ReconciliationMode = "full" | "fingerprint";

interface ProjectState {
  projectId: UrlProjectId;
  projectPath: string;
  epoch: string;
  sequence: number;
  inventory: ProjectWorktreeInventory;
  subscribers: Map<number, Subscriber>;
  watchers: Map<string, WatchedDirectory>;
  watchComplete: boolean;
  watchersNeedFullSync: boolean;
  gitMetadata: GitMetadataPaths | null;
  gitMetadataWatchers: Map<string, WatchedGitMetadata>;
  gitMetadataWatchComplete: boolean;
  gitMetadataProbeNeeded: boolean;
  gitMetadataWatchSyncNeeded: boolean;
  gitMetadataFingerprint: string | null;
  fingerprintPromise: Promise<void> | null;
  initialized: boolean;
  activationPromise: Promise<void> | null;
  refreshPromise: Promise<void> | null;
  refreshQueued: boolean;
  /** A scan failed; reconcile on the clock until one succeeds again. */
  reconciliationRecoveryNeeded: boolean;
  watchSyncPromise: Promise<void> | null;
  watchSyncQueued: boolean;
  watchSyncNeedsRefresh: boolean;
  watchSyncFull: boolean;
  pendingPaths: Set<string>;
  pendingWatchPaths: Set<string>;
  debounceTimer: NodeJS.Timeout | null;
  deadlineTimer: NodeJS.Timeout | null;
  pollTimer: NodeJS.Timeout | null;
  pollMode: ReconciliationMode | null;
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
  platform?: NodeJS.Platform;
  watchDirectory?: (
    path: string,
    listener: (eventType: string, filename: Buffer | string | null) => void,
    options: { recursive: boolean },
  ) => fs.FSWatcher;
  resolveGitMetadata?: (
    projectPath: string,
  ) => Promise<GitMetadataPaths | null>;
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

function pathIsAtOrBelow(path: string, parent: string): boolean {
  return path === parent || (parent !== "" && path.startsWith(`${parent}/`));
}

export class ProjectWorktreeSubscriptionManager {
  private readonly scanner: ProjectWorktreeSubscriptionManagerOptions["scanner"];
  private readonly debounceMs: number;
  private readonly maxEventAgeMs: number;
  private readonly fallbackPollMs: number;
  private readonly maxRetainedProjects: number;
  private readonly fileLimit: number;
  private readonly filesystemFileLimit: number;
  private readonly platform: NodeJS.Platform;
  private readonly watchDirectory: NonNullable<
    ProjectWorktreeSubscriptionManagerOptions["watchDirectory"]
  >;
  private readonly resolveGitMetadata: NonNullable<
    ProjectWorktreeSubscriptionManagerOptions["resolveGitMetadata"]
  >;
  private readonly scanWorktree: (
    projectPath: string,
    coverage: GitWorktreeCoverage,
    isGitRepository: boolean,
  ) => Promise<ProjectWorktreeScan>;
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
    this.filesystemFileLimit = Math.min(
      this.fileLimit,
      FILESYSTEM_INVENTORY_FILE_LIMIT,
    );
    this.platform = options.platform ?? process.platform;
    this.watchDirectory =
      options.watchDirectory ??
      ((path, listener, watchOptions) =>
        fs.watch(
          path,
          { persistent: false, recursive: watchOptions.recursive },
          listener,
        ));
    this.resolveGitMetadata = options.resolveGitMetadata ?? resolveGitMetadata;
    const scanWorktree = options.scanWorktree;
    this.scanWorktree = scanWorktree
      ? (projectPath, coverage) => scanWorktree(projectPath, coverage)
      : (projectPath, coverage, isGitRepository) =>
          isGitRepository
            ? scanGitWorktree(projectPath, coverage)
            : scanFilesystemWorktree(
                projectPath,
                coverage,
                this.filesystemFileLimit,
              );
  }

  subscribe(
    projectId: UrlProjectId,
    coverage: GitWorktreeCoverage,
    listener: (event: GitWorktreeSubscriptionEvent) => void,
  ): ProjectWorktreeSubscription {
    const normalizedCoverage: GitWorktreeCoverage = {
      tracked: coverage.tracked,
      untracked: coverage.untracked,
      ignored: coverage.ignored,
      ...(coverage.expandedPrefixes === undefined
        ? {}
        : {
            expandedPrefixes: [...new Set(coverage.expandedPrefixes)].sort(
              compareWorktreePaths,
            ),
          }),
      ...(coverage.filesystemScan === "complete"
        ? { filesystemScan: "complete" as const }
        : {}),
    };
    const pending: PendingSubscription = { cancelled: false, detach: null };
    const release = () => {
      if (pending.cancelled) return;
      pending.cancelled = true;
      pending.detach?.();
    };
    return {
      ready: this.startSubscription(
        projectId,
        normalizedCoverage,
        listener,
        pending,
      ),
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
      watchedDirectories +=
        state.watchers.size + state.gitMetadataWatchers.size;
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
    const subscriber: Subscriber = {
      coverage,
      listener,
      ready: false,
      projectedFiles: new Map(),
      projectedDirectories: null,
    };
    const previousCoverage = unionWorktreeCoverage(state.subscribers.values());
    const previousDirectoryCoverage = unionExpandedWorktreeCoverage(
      state.subscribers.values(),
    );
    state.subscribers.set(subscriberId, subscriber);
    state.lastUsedAt = Date.now();

    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      const current = this.projects.get(projectId);
      if (current !== state) return;
      const before = unionWorktreeCoverage(current.subscribers.values());
      const beforeDirectories = unionExpandedWorktreeCoverage(
        current.subscribers.values(),
      );
      current.subscribers.delete(subscriberId);
      current.lastUsedAt = Date.now();
      if (current.subscribers.size === 0) {
        this.deactivate(current);
        this.evictInactiveProjects();
        return;
      }
      const after = unionWorktreeCoverage(current.subscribers.values());
      const afterDirectories = unionExpandedWorktreeCoverage(
        current.subscribers.values(),
      );
      if (
        !sameWorktreeCoverage(before, after) ||
        !sameOptionalWorktreeCoverage(beforeDirectories, afterDirectories)
      ) {
        void this.refresh(current, true)
          .then(async () => {
            await this.syncWatchers(current);
            this.syncReconciliationPoll(current);
          })
          .catch((error) => {
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
      await this.ensureActive(
        state,
        previousCoverage,
        previousDirectoryCoverage,
      );
      if (
        pending.cancelled ||
        state.subscribers.get(subscriberId) !== subscriber
      ) {
        return;
      }
      subscriber.ready = true;
      const snapshot = this.snapshot(state, subscriber.coverage);
      subscriber.projectedFiles = new Map(
        snapshot.files.map((file) => [file.path, file]),
      );
      subscriber.projectedDirectories = snapshot.directories
        ? new Map(
            snapshot.directories.map((directory) => [
              directory.path,
              directory,
            ]),
          )
        : null;
      listener(snapshot);
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
      inventory: createProjectWorktreeInventory(),
      subscribers: new Map(),
      watchers: new Map(),
      watchComplete: false,
      watchersNeedFullSync: true,
      gitMetadata: null,
      gitMetadataWatchers: new Map(),
      gitMetadataWatchComplete: false,
      gitMetadataProbeNeeded: true,
      gitMetadataWatchSyncNeeded: true,
      gitMetadataFingerprint: null,
      fingerprintPromise: null,
      initialized: false,
      activationPromise: null,
      refreshPromise: null,
      refreshQueued: false,
      reconciliationRecoveryNeeded: false,
      watchSyncPromise: null,
      watchSyncQueued: false,
      watchSyncNeedsRefresh: false,
      watchSyncFull: false,
      pendingPaths: new Set(),
      pendingWatchPaths: new Set(),
      debounceTimer: null,
      deadlineTimer: null,
      pollTimer: null,
      pollMode: null,
      lastUsedAt: Date.now(),
    };
    this.projects.set(projectId, state);
    return state;
  }

  private ensureActive(
    state: ProjectState,
    previousCoverage: GitWorktreeCoverage,
    previousDirectoryCoverage: GitWorktreeCoverage | null,
  ): Promise<void> {
    const wanted = unionWorktreeCoverage(state.subscribers.values());
    const wantedDirectories = unionExpandedWorktreeCoverage(
      state.subscribers.values(),
    );
    if (state.activationPromise) return state.activationPromise;
    if (
      state.initialized &&
      sameWorktreeCoverage(previousCoverage, wanted) &&
      sameOptionalWorktreeCoverage(previousDirectoryCoverage, wantedDirectories)
    ) {
      return Promise.resolve();
    }
    state.activationPromise = this.activate(state).finally(() => {
      state.activationPromise = null;
    });
    return state.activationPromise;
  }

  private async activate(state: ProjectState): Promise<void> {
    await this.refresh(state, state.initialized);
    if (hasExpandedProjectWorktreeCorpus(state.inventory)) {
      await this.syncWatchers(state);
      state.watchersNeedFullSync = false;
      this.syncReconciliationPoll(state);
      return;
    }
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
    // A bounded filesystem-only inventory watches exactly what it enumerated.
    // Walking the rest to watch it would spend the traversal the bound avoids,
    // and its files are not published, so their events would say nothing.
    const listed =
      projectWorktreeWatchScope(state.inventory) ??
      (await this.listDirectories(state.projectPath));
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
        watcher.close();
        if (state.subscribers.size === 0) return;
        getLogger().warn(
          { directory, error, projectId: state.projectId },
          "WORKTREE_WATCH: directory watch failed; using bounded reconciliation",
        );
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

    if (projectWorktreeWatchScope(state.inventory)) {
      // A bounded inventory already names every directory worth watching, and
      // the scan that follows this sync updates that set.
      await this.syncWatchers(state);
      return true;
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

  private async syncGitMetadataWatchers(state: ProjectState): Promise<void> {
    if (state.gitMetadataProbeNeeded) {
      const next = await this.resolveGitMetadata(state.projectPath);
      state.gitMetadataProbeNeeded = false;
      if (!sameGitMetadata(state.gitMetadata, next)) {
        this.closeGitMetadataWatchers(state);
        state.gitMetadata = next;
        state.gitMetadataFingerprint = null;
      }
    }

    state.gitMetadataWatchSyncNeeded = false;
    if (this.platform !== GIT_METADATA_PLATFORM) {
      this.closeGitMetadataWatchers(state);
      state.gitMetadataWatchComplete = false;
      return;
    }
    if (!state.gitMetadata) {
      this.closeGitMetadataWatchers(state);
      state.gitMetadataWatchComplete = true;
      return;
    }

    const specs = await gitMetadataWatchSpecs(state.gitMetadata);
    if (state.subscribers.size === 0) return;
    const wanted = new Map(specs.map((spec) => [spec.path, spec]));
    for (const [path, watched] of state.gitMetadataWatchers) {
      const spec = wanted.get(path);
      if (
        spec &&
        spec.recursive === watched.spec.recursive &&
        spec.scope === watched.spec.scope
      ) {
        continue;
      }
      watched.watcher.close();
      state.gitMetadataWatchers.delete(path);
    }

    let complete = true;
    for (const spec of specs) {
      if (state.gitMetadataWatchers.has(spec.path)) continue;
      if (!this.attachGitMetadataWatcher(state, spec)) complete = false;
    }
    state.gitMetadataWatchComplete =
      complete && state.gitMetadataWatchers.size === wanted.size;
  }

  private attachGitMetadataWatcher(
    state: ProjectState,
    spec: GitMetadataWatchSpec,
  ): boolean {
    try {
      const watcher = this.watchDirectory(
        spec.path,
        (_eventType, filename) => {
          this.onGitMetadataEvent(state, spec, filename);
        },
        { recursive: spec.recursive },
      );
      watcher.on("error", (error) => {
        watcher.close();
        if (state.subscribers.size === 0) return;
        getLogger().warn(
          { error, path: spec.path, projectId: state.projectId },
          "WORKTREE_WATCH: Git metadata watch failed; using bounded reconciliation",
        );
        state.gitMetadataWatchers.delete(spec.path);
        state.gitMetadataWatchComplete = false;
        state.gitMetadataWatchSyncNeeded = true;
        this.syncReconciliationPoll(state);
        this.scheduleRefresh(state);
      });
      state.gitMetadataWatchers.set(spec.path, { watcher, spec });
      return true;
    } catch (error) {
      state.gitMetadataWatchComplete = false;
      getLogger().debug(
        { error, path: spec.path, projectId: state.projectId },
        "WORKTREE_WATCH: Git metadata directory not watchable; polling covers it",
      );
      return false;
    }
  }

  private onGitMetadataEvent(
    state: ProjectState,
    spec: GitMetadataWatchSpec,
    filename: Buffer | string | null,
  ): void {
    if (state.subscribers.size === 0) return;
    const name = filename?.toString().replaceAll("\\", "/") ?? "";
    if (name && ignoreGitMetadataEvent(name)) return;
    if (spec.scope === "root" && name && !rootGitMetadataChanged(name)) return;
    if (
      spec.scope === "root" &&
      (!name || gitMetadataWatchSetMayHaveChanged(name))
    ) {
      state.gitMetadataWatchComplete = false;
      state.gitMetadataWatchSyncNeeded = true;
      this.syncReconciliationPoll(state);
    }
    if (spec.scope === "root" && (!name || name === "HEAD")) {
      state.gitMetadataProbeNeeded = true;
    }
    this.scheduleRefresh(state);
  }

  private closeGitMetadataWatchers(state: ProjectState): void {
    for (const watched of state.gitMetadataWatchers.values()) {
      watched.watcher.close();
    }
    state.gitMetadataWatchers.clear();
  }

  private reconcileGitMetadataFingerprint(state: ProjectState): void {
    if (state.fingerprintPromise || !state.gitMetadata) return;
    state.fingerprintPromise = readGitMetadataFingerprint(state.gitMetadata)
      .then(async (fingerprint) => {
        if (
          state.subscribers.size > 0 &&
          fingerprint !== state.gitMetadataFingerprint
        ) {
          state.gitMetadataProbeNeeded = true;
          state.gitMetadataWatchSyncNeeded = true;
          await this.refresh(state, true);
        }
      })
      .catch((error) => {
        state.gitMetadataWatchComplete = false;
        this.syncReconciliationPoll(state);
        getLogger().warn(
          { error, projectId: state.projectId },
          "WORKTREE_WATCH: Git metadata fingerprint failed; using bounded reconciliation",
        );
      })
      .finally(() => {
        state.fingerprintPromise = null;
      });
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
    if (path === ".git") {
      state.gitMetadataProbeNeeded = true;
      state.gitMetadataWatchSyncNeeded = true;
      this.scheduleRefresh(state);
      return;
    }
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
    state.refreshPromise = this.runRefreshLoop(state, emit)
      .then(() => {
        if (!state.reconciliationRecoveryNeeded) return;
        state.reconciliationRecoveryNeeded = false;
        this.syncReconciliationPoll(state);
      })
      .catch((error: unknown) => {
        // Watches are only a truth source while scans succeed. A failed scan
        // leaves the published snapshot behind the worktree with no event of
        // its own to retry on, so reconcile on the clock until one succeeds.
        state.reconciliationRecoveryNeeded = true;
        this.syncReconciliationPoll(state);
        throw error;
      })
      .finally(() => {
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
      if (state.gitMetadataProbeNeeded || state.gitMetadataWatchSyncNeeded) {
        await this.syncGitMetadataWatchers(state);
        this.syncReconciliationPoll(state);
      }
      const coverage = unionWorktreeCoverage(state.subscribers.values());
      const directoryCoverage = unionExpandedWorktreeCoverage(
        state.subscribers.values(),
      );
      const pendingPaths = new Set(state.pendingPaths);
      state.pendingPaths.clear();
      const fingerprintBefore = state.gitMetadata
        ? await readGitMetadataFingerprint(state.gitMetadata)
        : null;
      const isGitRepository = state.gitMetadata !== null;
      let scan: ProjectWorktreeScan;
      let expandedScan: ProjectWorktreeScan | null = null;
      try {
        scan = await this.scanWorktree(
          state.projectPath,
          coverage,
          isGitRepository,
        );
        if (
          !isGitRepository &&
          coverage.expandedPrefixes === undefined &&
          directoryCoverage
        ) {
          expandedScan = await this.scanWorktree(
            state.projectPath,
            directoryCoverage,
            false,
          );
        }
      } catch (error) {
        for (const path of pendingPaths) state.pendingPaths.add(path);
        throw error;
      }
      const fingerprintAfter = state.gitMetadata
        ? await readGitMetadataFingerprint(state.gitMetadata)
        : null;
      if (fingerprintBefore !== fingerprintAfter) {
        state.gitMetadataProbeNeeded = true;
        state.gitMetadataWatchSyncNeeded = true;
        state.refreshQueued = true;
      }
      state.gitMetadataFingerprint = fingerprintAfter;
      if (state.subscribers.size === 0) return;
      const inventoryUpdate = reconcileProjectWorktreeInventory(
        state.inventory,
        scan,
        expandedScan,
        isGitRepository,
        pendingPaths,
      );
      state.inventory = inventoryUpdate.inventory;
      state.initialized = true;
      if (inventoryUpdate.changed) {
        state.sequence += 1;
        if (emit) this.emit(state, pendingPaths);
      }
      if (
        !sameWorktreeCoverage(
          coverage,
          unionWorktreeCoverage(state.subscribers.values()),
        ) ||
        !sameOptionalWorktreeCoverage(
          directoryCoverage,
          unionExpandedWorktreeCoverage(state.subscribers.values()),
        )
      ) {
        state.refreshQueued = true;
      }
    } while (state.refreshQueued && state.subscribers.size > 0);
  }

  private snapshot(
    state: ProjectState,
    coverage: GitWorktreeCoverage,
  ): GitWorktreeSnapshotEvent {
    const projection = this.project(state, coverage);
    const endpoints = projectWorktreeEndpoints(state.inventory);
    return {
      type: "git-worktree-snapshot",
      generation: { epoch: state.epoch, sequence: state.sequence },
      coverage,
      ...endpoints,
      files: [...projection.files.values()],
      ...(projection.directories
        ? { directories: [...projection.directories.values()] }
        : {}),
      truncated: projection.truncated,
      ...(projection.totalFiles === null
        ? {}
        : { totalFiles: projection.totalFiles }),
      timestamp: new Date().toISOString(),
    };
  }

  private project(state: ProjectState, coverage: GitWorktreeCoverage) {
    return projectWorktreeProjection(state.inventory, coverage, {
      fileLimit: this.fileLimit,
      filesystemFileLimit: this.filesystemFileLimit,
    });
  }

  private emit(state: ProjectState, pendingPaths: ReadonlySet<string>): void {
    const endpoints = projectWorktreeEndpoints(state.inventory);
    for (const subscriber of state.subscribers.values()) {
      if (!subscriber.ready) continue;
      const projection = this.project(state, subscriber.coverage);
      const { changes } = diffFiles(
        subscriber.projectedFiles,
        projection.files,
        pendingPaths,
      );
      const { directoryChanges } = diffDirectories(
        subscriber.projectedDirectories,
        projection.directories ?? undefined,
      );
      subscriber.projectedFiles = projection.files;
      subscriber.projectedDirectories = projection.directories;
      try {
        subscriber.listener({
          type: "git-worktree-delta",
          generation: { epoch: state.epoch, sequence: state.sequence },
          ...endpoints,
          changes,
          ...(projection.directories || directoryChanges.length > 0
            ? { directoryChanges }
            : {}),
          truncated: projection.truncated,
          totalFiles: projection.totalFiles,
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
    const watchesAreTruth =
      this.platform === GIT_METADATA_PLATFORM &&
      state.watchComplete &&
      state.gitMetadataWatchComplete &&
      !state.reconciliationRecoveryNeeded;
    const mode: ReconciliationMode | null = watchesAreTruth
      ? state.gitMetadata
        ? "fingerprint"
        : null
      : "full";
    if (state.pollMode === mode) return;
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
    state.pollMode = mode;
    if (!mode) return;

    state.pollTimer = setInterval(() => {
      if (state.pollMode === "fingerprint") {
        this.reconcileGitMetadataFingerprint(state);
        return;
      }
      state.gitMetadataProbeNeeded = true;
      state.gitMetadataWatchSyncNeeded = true;
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
    this.closeGitMetadataWatchers(state);
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    if (state.deadlineTimer) clearTimeout(state.deadlineTimer);
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.debounceTimer = null;
    state.deadlineTimer = null;
    state.pollTimer = null;
    state.pollMode = null;
    state.pendingPaths.clear();
    state.pendingWatchPaths.clear();
    state.watchSyncQueued = false;
    state.watchSyncNeedsRefresh = false;
    state.watchSyncFull = false;
    state.watchComplete = false;
    state.watchersNeedFullSync = true;
    state.gitMetadataWatchComplete = false;
    state.gitMetadataProbeNeeded = true;
    state.gitMetadataWatchSyncNeeded = true;
    state.gitMetadataFingerprint = null;
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

function sameOptionalWorktreeCoverage(
  left: GitWorktreeCoverage | null,
  right: GitWorktreeCoverage | null,
): boolean {
  return (
    left === right ||
    (left !== null && right !== null && sameWorktreeCoverage(left, right))
  );
}

function sameGitMetadata(
  left: GitMetadataPaths | null,
  right: GitMetadataPaths | null,
): boolean {
  return (
    left === right ||
    Boolean(
      left &&
        right &&
        left.gitDir === right.gitDir &&
        left.commonDir === right.commonDir &&
        left.headRefPath === right.headRefPath,
    )
  );
}

async function resolveGitMetadata(
  projectPath: string,
): Promise<GitMetadataPaths | null> {
  let gitDirOutput: string;
  try {
    ({ stdout: gitDirOutput } = await runGit(projectPath, [
      "rev-parse",
      "--absolute-git-dir",
    ]));
  } catch (error) {
    if (isNotGitRepositoryError(error)) return null;
    throw error;
  }

  const gitDir = gitDirOutput.trim();
  if (!gitDir) throw new Error("Git returned an empty administrative path");
  const { stdout: commonDirOutput } = await runGit(projectPath, [
    "rev-parse",
    "--git-common-dir",
  ]);
  const commonDir = resolve(projectPath, commonDirOutput.trim());
  const headRefPath = await resolveHeadRefPath(projectPath);
  return { gitDir, commonDir, headRefPath };
}

async function resolveHeadRefPath(projectPath: string): Promise<string | null> {
  let headRef: string;
  try {
    const { stdout } = await runGit(projectPath, [
      "symbolic-ref",
      "--quiet",
      "HEAD",
    ]);
    headRef = stdout.trim();
  } catch (error) {
    if (gitExitCode(error) === 1) return null;
    throw error;
  }
  if (!headRef) return null;
  const { stdout } = await runGit(projectPath, [
    "rev-parse",
    "--git-path",
    headRef,
  ]);
  return resolve(projectPath, stdout.trim());
}

function gitExitCode(error: unknown): string | number | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" || typeof code === "string"
    ? code
    : undefined;
}

function isNotGitRepositoryError(error: unknown): boolean {
  if (
    !error ||
    typeof error !== "object" ||
    gitExitCode(error) !== 128 ||
    !("stderr" in error)
  ) {
    return false;
  }
  return String(error.stderr).toLowerCase().includes("not a git repository");
}

async function gitMetadataWatchSpecs(
  metadata: GitMetadataPaths,
): Promise<GitMetadataWatchSpec[]> {
  const specs = new Map<string, GitMetadataWatchSpec>();
  const add = (spec: GitMetadataWatchSpec) => {
    if (!specs.has(spec.path)) specs.set(spec.path, spec);
  };
  add({ path: metadata.gitDir, recursive: false, scope: "root" });
  add({ path: metadata.commonDir, recursive: false, scope: "root" });

  const candidates: GitMetadataWatchSpec[] = [];
  for (const root of new Set([metadata.gitDir, metadata.commonDir])) {
    candidates.push(
      { path: join(root, "refs"), recursive: true, scope: "refs" },
      { path: join(root, "info"), recursive: false, scope: "info" },
      { path: join(root, "reftable"), recursive: true, scope: "reftable" },
    );
  }
  candidates.push(
    {
      path: join(metadata.gitDir, "rebase-merge"),
      recursive: true,
      scope: "operation",
    },
    {
      path: join(metadata.gitDir, "rebase-apply"),
      recursive: true,
      scope: "operation",
    },
  );
  for (const candidate of candidates) {
    if (await isDirectory(candidate.path)) add(candidate);
  }
  return [...specs.values()];
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function ignoreGitMetadataEvent(name: string): boolean {
  const base = name.split("/").at(-1) ?? name;
  return base.endsWith(".lock") || base.startsWith(".watchman-cookie-");
}

function rootGitMetadataChanged(name: string): boolean {
  const rootName = name.split("/")[0] ?? name;
  return (
    GIT_ROOT_METADATA_NAMES.has(rootName) || rootName.startsWith("sharedindex.")
  );
}

function gitMetadataWatchSetMayHaveChanged(name: string): boolean {
  const rootName = name.split("/")[0] ?? name;
  return (
    rootName === "refs" ||
    rootName === "info" ||
    rootName === "rebase-merge" ||
    rootName === "rebase-apply" ||
    rootName === "reftable"
  );
}

async function readGitMetadataFingerprint(
  metadata: GitMetadataPaths,
): Promise<string> {
  const paths = new Set<string>([
    metadata.gitDir,
    metadata.commonDir,
    join(metadata.gitDir, "HEAD"),
    join(metadata.gitDir, "index"),
    join(metadata.gitDir, "FETCH_HEAD"),
    join(metadata.gitDir, "MERGE_HEAD"),
    join(metadata.gitDir, "CHERRY_PICK_HEAD"),
    join(metadata.gitDir, "REVERT_HEAD"),
    join(metadata.gitDir, "BISECT_LOG"),
    join(metadata.gitDir, "config.worktree"),
    join(metadata.commonDir, "packed-refs"),
    join(metadata.commonDir, "config"),
    join(metadata.commonDir, "info", "exclude"),
    join(metadata.commonDir, "reftable"),
  ]);
  if (metadata.headRefPath) {
    paths.add(metadata.headRefPath);
    paths.add(dirname(metadata.headRefPath));
  }
  return (
    await Promise.all(
      [...paths].sort(compareWorktreePaths).map(pathFingerprint),
    )
  ).join("\n");
}

async function pathFingerprint(path: string): Promise<string> {
  try {
    const value = await lstat(path);
    return `${path}\0${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
  } catch (error) {
    if (isMissingPathError(error)) return `${path}\0missing`;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export { ALL_COVERAGE, diffFiles, resolveGitMetadata };
