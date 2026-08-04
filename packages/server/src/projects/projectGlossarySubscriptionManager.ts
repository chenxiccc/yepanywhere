import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
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

interface ProjectGlossaryState {
  projectId: UrlProjectId;
  projectPath: string;
  epoch: string;
  generation: number;
  initialized: boolean;
  paths: Map<string, GlossaryPathIdentity>;
  subscribers: Map<number, GlossarySubscriber>;
  watcher: fs.FSWatcher | null;
  pollTimer: NodeJS.Timeout | null;
  debounceTimer: NodeJS.Timeout | null;
  refreshPromise: Promise<void> | null;
  refreshQueued: boolean;
  lastUsedAt: number;
}

export interface ProjectGlossarySubscriptionManagerOptions {
  scanner: Pick<ProjectScanner, "getProject">;
  glossaryIndexService: GlossaryIndexService;
  debounceMs?: number;
  pollMs?: number;
  maxRetainedProjects?: number;
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
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
 * One native watcher and fallback poll are reference-counted across every tab
 * subscribed to the same project. Inactive projects retain only a bounded
 * path/fingerprint snapshot so reconnect can detect edits missed while no
 * watcher was live.
 */
export class ProjectGlossarySubscriptionManager {
  private readonly scanner: ProjectGlossarySubscriptionManagerOptions["scanner"];
  private readonly glossaryIndexService: GlossaryIndexService;
  private readonly debounceMs: number;
  private readonly pollMs: number;
  private readonly maxRetainedProjects: number;
  private readonly projects = new Map<string, ProjectGlossaryState>();
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
  } {
    let activeProjects = 0;
    let subscribers = 0;
    for (const state of this.projects.values()) {
      if (state.subscribers.size > 0) activeProjects += 1;
      subscribers += state.subscribers.size;
    }
    return {
      activeProjects,
      retainedProjects: this.projects.size,
      subscribers,
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
      paths: new Map(),
      subscribers: new Map(),
      watcher: null,
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
    this.attachWatcher(state);
    state.pollTimer = setInterval(() => {
      void this.refresh(state, true);
    }, this.pollMs);
    state.pollTimer.unref();
    await this.refresh(state, false);
  }

  private attachWatcher(state: ProjectGlossaryState): void {
    try {
      state.watcher = fs.watch(
        state.projectPath,
        { recursive: true },
        (_eventType, filename) => {
          if (!filename || basename(filename.toString()) === "GLOSSARY.md") {
            this.scheduleRefresh(state);
          }
        },
      );
      state.watcher.on("error", (error) => {
        getLogger().warn(
          { error, projectId: state.projectId },
          "GLOSSARY_WATCH: native watcher error; polling remains active",
        );
        this.scheduleRefresh(state);
      });
    } catch (error) {
      getLogger().warn(
        { error, projectId: state.projectId },
        "GLOSSARY_WATCH: native watcher unavailable; using polling",
      );
      state.watcher = null;
    }
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
      const nextPaths = await this.scanProject(state.projectPath);
      if (!state.initialized) {
        state.paths = nextPaths;
        state.initialized = true;
        continue;
      }

      const changes = this.diffPaths(state.paths, nextPaths);
      state.paths = nextPaths;
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

  private async scanProject(
    projectPath: string,
  ): Promise<Map<string, GlossaryPathIdentity>> {
    const result = new Map<string, GlossaryPathIdentity>();
    const pending = [projectPath];

    while (pending.length > 0) {
      const directory = pending.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (directory === projectPath) throw error;
        continue;
      }
      for (const entry of entries) {
        const fullPath = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== ".git") pending.push(fullPath);
          continue;
        }
        if (entry.name !== "GLOSSARY.md") continue;
        try {
          const [canonicalPath, fileStats] = await Promise.all([
            realpath(fullPath),
            stat(fullPath),
          ]);
          if (!fileStats.isFile() || !isContained(projectPath, canonicalPath)) {
            continue;
          }
          const projectRelativePath = relative(projectPath, fullPath)
            .split(sep)
            .join("/");
          result.set(projectRelativePath, {
            ctimeMs: fileStats.ctimeMs,
            dev: fileStats.dev,
            ino: fileStats.ino,
            mtimeMs: fileStats.mtimeMs,
            size: fileStats.size,
          });
        } catch {
          // The candidate disappeared or became unreadable during the scan.
        }
      }
    }
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
    state.watcher?.close();
    state.watcher = null;
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
    state.refreshQueued = false;
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
