import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type {
  GlossaryPathChangedEvent,
  GlossaryPathChangeType,
  GlossaryPathsSnapshotEvent,
  GlossaryProjectGeneration,
  GlossarySubscriptionEvent,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import type { ProjectScanner } from "./scanner.js";
import type { GlossaryIndexService } from "./glossaryIndexService.js";
import {
  getProjectPathIndex,
  type ProjectPathIndex,
} from "./projectPathIndex.js";

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_POLL_MS = 5 * 60_000;
const DEFAULT_MAX_RETAINED_PROJECTS = 32;

interface GlossaryPathIdentity {
  ctimeMs: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
}

interface GlossarySubscriber {
  listener: (event: GlossarySubscriptionEvent) => void;
  ready: boolean;
}

/** One observed directory's non-recursive watch and the names it answers for. */
interface WatchedDirectory {
  /** Observed candidate basenames in this directory. */
  names: Set<string>;
  /** Null while the directory could not be watched; the next sync retries. */
  watcher: fs.FSWatcher | null;
}

interface ProjectGlossaryState {
  projectId: UrlProjectId;
  projectPath: string;
  epoch: string;
  generation: number;
  initialized: boolean;
  observedPaths: Set<string>;
  paths: Map<string, GlossaryPathIdentity>;
  subscribers: Map<number, GlossarySubscriber>;
  directories: Map<string, WatchedDirectory>;
  /** Held while subscribed, so this project's cached paths survive pressure. */
  pathIndex: ProjectPathIndex | null;
  pollTimer: NodeJS.Timeout | null;
  debounceTimer: NodeJS.Timeout | null;
  refreshPromise: Promise<void> | null;
  refreshQueued: boolean;
  lastUsedAt: number;
}

export interface ProjectGlossarySubscriptionManagerOptions {
  scanner: Pick<ProjectScanner, "getProject">;
  glossaryIndexService: Pick<
    GlossaryIndexService,
    "getObservedGlossaryPaths" | "invalidateProject" | "onObservationsChanged"
  >;
  debounceMs?: number;
  pollMs?: number;
  maxRetainedProjects?: number;
  /** Claim the shared path cache; defaults to the process-wide registry. */
  getPathIndex?: (projectPath: string) => Promise<ProjectPathIndex>;
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

/** The project-relative directory holding a candidate; "" is the project root. */
function candidateDirectory(projectRelativePath: string): string {
  const directory = dirname(projectRelativePath).replaceAll("\\", "/");
  return directory === "." || directory === "/" ? "" : directory;
}

function identityEquals(
  left: GlossaryPathIdentity,
  right: GlossaryPathIdentity,
): boolean {
  return (
    left.ctimeMs === right.ctimeMs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size
  );
}

function sortedPaths(paths: Map<string, GlossaryPathIdentity>): string[] {
  return [...paths.keys()].sort((left, right) => left.localeCompare(right));
}

/**
 * Project-scoped glossary path subscriptions.
 *
 * One watch set and fallback poll are reference-counted across every tab
 * subscribed to the same project. Resolution and watching share the service's
 * observation set: each directory holding an observed candidate gets its own
 * non-recursive watch, and nothing else in the project is watched or read.
 */
export class ProjectGlossarySubscriptionManager {
  private readonly scanner: ProjectGlossarySubscriptionManagerOptions["scanner"];
  private readonly glossaryIndexService: ProjectGlossarySubscriptionManagerOptions["glossaryIndexService"];
  private readonly debounceMs: number;
  private readonly pollMs: number;
  private readonly maxRetainedProjects: number;
  private readonly getPathIndex: (
    projectPath: string,
  ) => Promise<ProjectPathIndex>;
  private readonly projects = new Map<string, ProjectGlossaryState>();
  private readonly releaseObservationListener: () => void;
  private nextSubscriberId = 1;

  constructor(options: ProjectGlossarySubscriptionManagerOptions) {
    this.scanner = options.scanner;
    this.glossaryIndexService = options.glossaryIndexService;
    this.debounceMs = Math.max(25, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.pollMs = Math.max(1_000, options.pollMs ?? DEFAULT_POLL_MS);
    this.maxRetainedProjects = Math.max(
      1,
      options.maxRetainedProjects ?? DEFAULT_MAX_RETAINED_PROJECTS,
    );
    this.getPathIndex = options.getPathIndex ?? getProjectPathIndex;
    this.releaseObservationListener =
      this.glossaryIndexService.onObservationsChanged((projectRoot) => {
        this.observationsChanged(projectRoot);
      });
  }

  async subscribe(
    projectId: UrlProjectId,
    listener: (event: GlossarySubscriptionEvent) => void,
  ): Promise<() => void> {
    const project = await this.scanner.getProject(projectId, {
      allowStaleSnapshot: true,
    });
    if (!project) {
      throw new Error("Project not found");
    }
    const projectPath = await realpath(project.path);
    const state = this.getOrCreateState(projectId, projectPath);
    const subscriberId = this.nextSubscriberId++;
    const subscriber: GlossarySubscriber = { listener, ready: false };
    state.subscribers.set(subscriberId, subscriber);
    state.lastUsedAt = Date.now();

    try {
      await this.ensureActive(state);
    } catch (error) {
      state.subscribers.delete(subscriberId);
      if (state.subscribers.size === 0) this.deactivate(state);
      throw error;
    }

    if (state.subscribers.get(subscriberId) === subscriber) {
      subscriber.ready = true;
      listener(this.createSnapshot(state));
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.projects.get(projectId);
      if (current !== state) return;
      current.subscribers.delete(subscriberId);
      current.lastUsedAt = Date.now();
      if (current.subscribers.size === 0) {
        this.deactivate(current);
        this.evictInactiveProjects();
      }
    };
  }

  dispose(): void {
    this.releaseObservationListener();
    for (const state of this.projects.values()) {
      this.deactivate(state);
      state.subscribers.clear();
    }
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
      for (const directory of state.directories.values()) {
        if (directory.watcher) watchedDirectories += 1;
      }
    }
    return {
      activeProjects,
      retainedProjects: this.projects.size,
      subscribers,
      watchedDirectories,
    };
  }

  private getOrCreateState(
    projectId: UrlProjectId,
    projectPath: string,
  ): ProjectGlossaryState {
    const existing = this.projects.get(projectId);
    if (existing?.projectPath === projectPath) {
      return existing;
    }
    if (existing) {
      this.deactivate(existing);
      this.projects.delete(projectId);
    }
    const state: ProjectGlossaryState = {
      projectId,
      projectPath,
      epoch: randomUUID(),
      generation: 0,
      initialized: false,
      observedPaths: new Set(),
      paths: new Map(),
      subscribers: new Map(),
      directories: new Map(),
      pathIndex: null,
      pollTimer: null,
      debounceTimer: null,
      refreshPromise: null,
      refreshQueued: false,
      lastUsedAt: Date.now(),
    };
    this.projects.set(projectId, state);
    return state;
  }

  private async ensureActive(state: ProjectGlossaryState): Promise<void> {
    if (state.pollTimer) {
      if (state.refreshPromise) await state.refreshPromise;
      return;
    }
    // Resolution probes this project's candidate paths through the shared path
    // cache, so a claim held for the subscription's life keeps the directories
    // it hydrated from being evicted between two artifact requests. The claim
    // exempts the project from the process byte budget, not from its own
    // per-project ceiling, so a subscribed project stays bounded.
    state.pathIndex = await this.getPathIndex(state.projectPath);
    state.pollTimer = setInterval(() => {
      void this.refresh(state, true);
    }, this.pollMs);
    state.pollTimer.unref();
    await this.refresh(state, false);
  }

  /**
   * Watch exactly the directories holding an observed candidate.
   *
   * Called on every refresh, so a directory learned since the last one is
   * watched as soon as the observation handoff schedules that refresh, and a
   * directory that could not be watched is retried rather than abandoned.
   */
  private syncWatchers(
    state: ProjectGlossaryState,
    observedPaths: readonly string[],
  ): void {
    const wanted = new Map<string, Set<string>>();
    for (const observedPath of observedPaths) {
      const directory = candidateDirectory(observedPath);
      const names = wanted.get(directory);
      if (names) names.add(basename(observedPath));
      else wanted.set(directory, new Set([basename(observedPath)]));
    }

    for (const [directory, watched] of state.directories) {
      if (wanted.has(directory)) continue;
      watched.watcher?.close();
      state.directories.delete(directory);
    }
    for (const [directory, names] of wanted) {
      const existing = state.directories.get(directory);
      if (existing) {
        existing.names = names;
        if (!existing.watcher) {
          existing.watcher = this.attachDirectoryWatcher(state, directory);
        }
        continue;
      }
      state.directories.set(directory, {
        names,
        watcher: this.attachDirectoryWatcher(state, directory),
      });
    }
  }

  private attachDirectoryWatcher(
    state: ProjectGlossaryState,
    directory: string,
  ): fs.FSWatcher | null {
    const absolute = directory
      ? join(state.projectPath, directory)
      : state.projectPath;
    try {
      const watcher = fs.watch(
        absolute,
        { persistent: false },
        (_eventType, filename) => {
          this.onDirectoryEvent(state, directory, filename);
        },
      );
      watcher.on("error", (error) => {
        getLogger().warn(
          { directory, error, projectId: state.projectId },
          "GLOSSARY_WATCH: directory watch failed; reconciling observed candidates",
        );
        this.dropDirectoryWatcher(state, directory);
        this.scheduleRefresh(state);
      });
      return watcher;
    } catch (error) {
      // A candidate whose directory does not exist yet is normal; the poll
      // remains the backstop and the next sync retries the attach.
      getLogger().debug(
        { directory, error, projectId: state.projectId },
        "GLOSSARY_WATCH: directory not watchable; polling covers it",
      );
      return null;
    }
  }

  private onDirectoryEvent(
    state: ProjectGlossaryState,
    directory: string,
    filename: Buffer | string | null,
  ): void {
    if (!filename) {
      // An unnamed event says only that something in this directory moved, so
      // re-stat the observed candidates rather than trusting current facts.
      this.scheduleRefresh(state);
      return;
    }
    const changed = basename(filename.toString().replaceAll("\\", "/"));
    if (!state.directories.get(directory)?.names.has(changed)) return;
    this.scheduleRefresh(state);
  }

  private dropDirectoryWatcher(
    state: ProjectGlossaryState,
    directory: string,
  ): void {
    const watched = state.directories.get(directory);
    if (!watched) return;
    watched.watcher?.close();
    watched.watcher = null;
  }

  private scheduleRefresh(state: ProjectGlossaryState): void {
    if (state.subscribers.size === 0) return;
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      void this.refresh(state, true);
    }, this.debounceMs);
  }

  private async refresh(
    state: ProjectGlossaryState,
    emitChanges: boolean,
  ): Promise<void> {
    if (state.refreshPromise) {
      state.refreshQueued = true;
      await state.refreshPromise;
      return;
    }

    state.refreshPromise = this.runRefreshLoop(state, emitChanges).finally(
      () => {
        state.refreshPromise = null;
      },
    );
    await state.refreshPromise;
  }

  private async runRefreshLoop(
    state: ProjectGlossaryState,
    emitChanges: boolean,
  ): Promise<void> {
    do {
      state.refreshQueued = false;
      const observations = this.glossaryIndexService.getObservedGlossaryPaths(
        state.projectPath,
      );
      const observedPaths = observations.map(({ path }) => path);
      this.syncWatchers(state, observedPaths);
      const nextPaths = await this.scanObservedPaths(
        state.projectPath,
        observedPaths,
      );
      if (!state.initialized) {
        state.paths = nextPaths;
        state.observedPaths = new Set(observedPaths);
        state.initialized = true;
        continue;
      }

      const previousPaths = new Map(state.paths);
      for (const observation of observations) {
        if (state.observedPaths.has(observation.path)) continue;
        // A candidate observed since the last refresh is newly *known*, not
        // newly created: seed it so discovery alone raises no change. The
        // resolver's identity wins when it has one, so an edit made since it
        // read the file still reports a modification.
        const discovered =
          observation.identity ?? nextPaths.get(observation.path);
        if (discovered) previousPaths.set(observation.path, discovered);
      }
      const changes = this.diffPaths(previousPaths, nextPaths);
      state.paths = nextPaths;
      state.observedPaths = new Set(observedPaths);
      if (changes.length === 0) continue;

      this.glossaryIndexService.invalidateProject(state.projectPath);
      for (const change of changes) {
        state.generation += 1;
        if (emitChanges) {
          this.emit(state, {
            type: "glossary-path-changed",
            changeType: change.changeType,
            generation: this.generation(state),
            path: change.path,
            timestamp: new Date().toISOString(),
          });
        }
      }
    } while (state.refreshQueued && state.subscribers.size > 0);
  }

  private diffPaths(
    previous: Map<string, GlossaryPathIdentity>,
    current: Map<string, GlossaryPathIdentity>,
  ): Array<{ changeType: GlossaryPathChangeType; path: string }> {
    const changes: Array<{
      changeType: GlossaryPathChangeType;
      path: string;
    }> = [];
    for (const path of sortedPaths(previous)) {
      if (!current.has(path)) changes.push({ changeType: "delete", path });
    }
    for (const path of sortedPaths(current)) {
      const prior = previous.get(path);
      if (!prior) {
        changes.push({ changeType: "create", path });
      } else if (!identityEquals(prior, current.get(path)!)) {
        changes.push({ changeType: "modify", path });
      }
    }
    return changes;
  }

  private async scanObservedPaths(
    projectPath: string,
    observedPaths: readonly string[],
  ): Promise<Map<string, GlossaryPathIdentity>> {
    const result = new Map<string, GlossaryPathIdentity>();
    await Promise.all(
      observedPaths.map(async (projectRelativePath) => {
        const fullPath = join(projectPath, projectRelativePath);
        try {
          const [canonicalPath, fileStats] = await Promise.all([
            realpath(fullPath),
            stat(fullPath),
          ]);
          if (!fileStats.isFile() || !isContained(projectPath, canonicalPath)) {
            return;
          }
          result.set(projectRelativePath, {
            ctimeMs: fileStats.ctimeMs,
            dev: fileStats.dev,
            ino: fileStats.ino,
            mtimeMs: fileStats.mtimeMs,
            size: fileStats.size,
          });
        } catch {
          // Missing candidates remain observed so their creation is detected.
        }
      }),
    );
    return result;
  }

  private createSnapshot(
    state: ProjectGlossaryState,
  ): GlossaryPathsSnapshotEvent {
    return {
      type: "glossary-paths-snapshot",
      generation: this.generation(state),
      paths: sortedPaths(state.paths),
      timestamp: new Date().toISOString(),
    };
  }

  private generation(state: ProjectGlossaryState): GlossaryProjectGeneration {
    return { epoch: state.epoch, sequence: state.generation };
  }

  private emit(
    state: ProjectGlossaryState,
    event: GlossaryPathChangedEvent,
  ): void {
    for (const subscriber of state.subscribers.values()) {
      if (!subscriber.ready) continue;
      try {
        subscriber.listener(event);
      } catch (error) {
        getLogger().warn(
          { error, projectId: state.projectId },
          "GLOSSARY_WATCH: subscriber failed",
        );
      }
    }
  }

  private deactivate(state: ProjectGlossaryState): void {
    for (const watched of state.directories.values()) watched.watcher?.close();
    state.directories.clear();
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
    state.refreshQueued = false;
    state.pathIndex?.release();
    state.pathIndex = null;
  }

  /** Attach watches for directories resolution learned about just now. */
  private observationsChanged(projectRoot: string): void {
    for (const state of this.projects.values()) {
      if (state.projectPath === projectRoot) this.scheduleRefresh(state);
    }
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
      const [projectId, state] = inactive.shift()!;
      this.deactivate(state);
      this.projects.delete(projectId);
    }
  }
}
