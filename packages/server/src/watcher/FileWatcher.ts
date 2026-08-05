import * as fs from "node:fs";
import * as path from "node:path";
import { getLogger } from "../logging/logger.js";
import { isCodexRolloutFileName } from "../utils/codexRolloutFiles.js";
import type {
  EventBus,
  FileChangeEvent,
  FileChangeType,
  WatchProvider,
} from "./EventBus.js";

export interface FileWatcherOptions {
  /** Directory to watch (e.g., ~/.claude) */
  watchDir: string;
  /** Provider that owns this directory */
  provider: WatchProvider;
  /** EventBus to emit events to */
  eventBus: EventBus;
  /** Debounce delay in ms (default: 200) */
  debounceMs?: number;
  /**
   * Optional periodic full-tree rescan interval (ms).
   * Useful on platforms where fs.watch may miss deep file writes.
   */
  periodicRescanMs?: number;
  /** Maximum adaptive periodic rescan delay in ms. */
  periodicRescanMaxBackoffMs?: number;
  /** Slow rescan log threshold in ms (default: 250). */
  rescanSlowLogThresholdMs?: number;
}

export type FileWatcherRescanReason = "fallback" | "periodic";
export type FileWatcherBackoffReason =
  | "disabled"
  | "overlap"
  | "recovered"
  | "slow"
  | "unchanged";

export interface FileWatcherRescanMetrics {
  provider: WatchProvider;
  watchDir: string;
  reason: FileWatcherRescanReason;
  periodicRescanMs: number;
  periodicRescanCurrentMs: number;
  periodicRescanNextMs: number;
  periodicRescanMaxMs: number;
  periodicRescanBackoffReason: FileWatcherBackoffReason;
  durationMs: number;
  directoriesVisited: number;
  filesScanned: number;
  directoryReadErrors: number;
  statFailures: number;
  knownFilesBefore: number;
  currentFiles: number;
  knownFilesAfter: number;
  createEvents: number;
  modifyEvents: number;
  deleteEvents: number;
  emittedEvents: number;
  sessionEvents: number;
  agentSessionEvents: number;
  otherEvents: number;
  overlapSkipsSinceLast: number;
  overlapSkipsTotal: number;
}

export interface FileWatcherBaselineMetrics {
  provider: WatchProvider;
  watchDir: string;
  durationMs: number;
  directoriesVisited: number;
  filesScanned: number;
  filesIndexed: number;
  directoryReadErrors: number;
  statFailures: number;
  touchedPathsPreserved: number;
}

export type FileWatcherBaselineState =
  | "idle"
  | "scheduled"
  | "running"
  | "complete"
  | "failed"
  | "stopped";

const DEFAULT_RESCAN_SLOW_LOG_THRESHOLD_MS = 250;
const PERIODIC_RESCAN_BACKOFF_RATIO = 0.5;
const PERIODIC_RESCAN_RECOVERY_RATIO = 0.1;
const PERIODIC_RESCAN_DEFAULT_MAX_BACKOFF_MS = 60 * 60 * 1000;

export class FileWatcher {
  private watchDir: string;
  private provider: WatchProvider;
  private eventBus: EventBus;
  private debounceMs: number;
  private periodicRescanMs: number;
  private periodicRescanCurrentMs: number;
  private periodicRescanMaxBackoffMs: number;
  private rescanSlowLogThresholdMs: number;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private rescanTimer: NodeJS.Timeout | null = null;
  private rescanInProgress = false;
  private periodicRescanTimer: NodeJS.Timeout | null = null;
  private knownFileMtimes: Map<string, number> = new Map();
  private lastRescanMetrics: FileWatcherRescanMetrics | null = null;
  private rescanOverlapSkipsSinceLast = 0;
  private rescanOverlapSkipsTotal = 0;
  private lifecycleGeneration = 0;
  private initialBaselineState: FileWatcherBaselineState = "idle";
  private initialBaselinePromise: Promise<FileWatcherBaselineMetrics | null> | null =
    null;
  private initialBaselineMetrics: FileWatcherBaselineMetrics | null = null;
  private initialBaselineTouchedPaths = new Set<string>();
  private rescanRequestedDuringBaseline = false;

  constructor(options: FileWatcherOptions) {
    this.watchDir = options.watchDir;
    this.provider = options.provider;
    this.eventBus = options.eventBus;
    this.debounceMs = options.debounceMs ?? 200;
    this.periodicRescanMs = options.periodicRescanMs ?? 0;
    this.periodicRescanCurrentMs = this.periodicRescanMs;
    this.periodicRescanMaxBackoffMs = Math.max(
      this.periodicRescanMs,
      options.periodicRescanMaxBackoffMs ??
        Math.max(
          PERIODIC_RESCAN_DEFAULT_MAX_BACKOFF_MS,
          this.periodicRescanMs * 12,
        ),
    );
    this.rescanSlowLogThresholdMs = Math.max(
      0,
      options.rescanSlowLogThresholdMs ?? DEFAULT_RESCAN_SLOW_LOG_THRESHOLD_MS,
    );
  }

  /**
   * Start watching for file changes.
   */
  start(): void {
    if (this.watcher) {
      return; // Already watching
    }

    try {
      const lifecycleGeneration = ++this.lifecycleGeneration;
      this.watcher = fs.watch(
        this.watchDir,
        { recursive: true },
        (eventType, filename) => {
          if (!filename) {
            getLogger().debug(
              `[FileWatcher] Raw event provider=${this.provider} type=${eventType} file=<null> path=${this.watchDir}`,
            );
            this.scheduleRescan();
            return;
          }
          this.handleFileEvent(eventType, filename);
        },
      );

      this.watcher.on("error", (error) => {
        console.error("[FileWatcher] Error:", error);
      });

      getLogger().info(`[FileWatcher] Watching ${this.watchDir}`);
      this.scheduleInitialBaseline(lifecycleGeneration);

      if (this.periodicRescanMs > 0) {
        this.periodicRescanCurrentMs = this.periodicRescanMs;
        this.scheduleNextPeriodicRescan();
        getLogger().info(
          `[FileWatcher] Periodic rescan enabled (base=${this.periodicRescanMs}ms, max=${this.periodicRescanMaxBackoffMs}ms) for ${this.watchDir}`,
        );
      }
    } catch (error) {
      console.error("[FileWatcher] Failed to start:", error);
    }
  }

  /**
   * Stop watching for file changes.
   */
  stop(): void {
    this.lifecycleGeneration += 1;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
      this.rescanTimer = null;
    }
    if (this.periodicRescanTimer) {
      clearTimeout(this.periodicRescanTimer);
      this.periodicRescanTimer = null;
    }
    this.knownFileMtimes.clear();
    this.initialBaselineTouchedPaths.clear();
    this.rescanRequestedDuringBaseline = false;
    this.initialBaselineState = "stopped";

    getLogger().info("[FileWatcher] Stopped");
  }

  /**
   * Check if watcher is active.
   */
  get isWatching(): boolean {
    return this.watcher !== null;
  }

  getLastRescanMetrics(): FileWatcherRescanMetrics | null {
    return this.lastRescanMetrics ? { ...this.lastRescanMetrics } : null;
  }

  getPeriodicRescanDelayMs(): number {
    return this.periodicRescanCurrentMs;
  }

  getInitialBaselineState(): FileWatcherBaselineState {
    return this.initialBaselineState;
  }

  getInitialBaselineMetrics(): FileWatcherBaselineMetrics | null {
    return this.initialBaselineMetrics
      ? { ...this.initialBaselineMetrics }
      : null;
  }

  async waitForInitialBaseline(): Promise<FileWatcherBaselineMetrics | null> {
    return this.initialBaselinePromise
      ? await this.initialBaselinePromise
      : this.getInitialBaselineMetrics();
  }

  private scheduleInitialBaseline(lifecycleGeneration: number): void {
    this.initialBaselineState = "scheduled";
    this.initialBaselineMetrics = null;
    this.initialBaselineTouchedPaths.clear();
    this.initialBaselinePromise = new Promise<void>((resolve) => {
      setImmediate(resolve);
    }).then(() => this.buildInitialBaseline(lifecycleGeneration));
  }

  private async buildInitialBaseline(
    lifecycleGeneration: number,
  ): Promise<FileWatcherBaselineMetrics | null> {
    if (!this.isCurrentLifecycle(lifecycleGeneration)) return null;
    this.initialBaselineState = "running";
    const startedAt = Date.now();
    const metrics: FileWatcherBaselineMetrics = {
      provider: this.provider,
      watchDir: this.watchDir,
      durationMs: 0,
      directoriesVisited: 0,
      filesScanned: 0,
      filesIndexed: 0,
      directoryReadErrors: 0,
      statFailures: 0,
      touchedPathsPreserved: 0,
    };
    const baseline = new Map<string, number>();

    try {
      const completed = await this.scanDirAsync(
        this.watchDir,
        baseline,
        metrics,
        lifecycleGeneration,
      );
      if (!completed || !this.isCurrentLifecycle(lifecycleGeneration)) {
        return null;
      }

      for (const filePath of baseline.keys()) {
        if (this.wasTouchedDuringBaseline(filePath)) {
          metrics.touchedPathsPreserved += 1;
          baseline.delete(filePath);
        }
      }
      for (const [filePath, mtimeMs] of this.knownFileMtimes) {
        baseline.set(filePath, mtimeMs);
      }
      this.knownFileMtimes = baseline;
      metrics.filesIndexed = this.knownFileMtimes.size;
      metrics.durationMs = Date.now() - startedAt;
      this.initialBaselineMetrics = { ...metrics };
      this.initialBaselineState = "complete";
      getLogger().debug(
        { event: "file_watcher_initial_baseline", ...metrics },
        "FILE_WATCHER: initial baseline complete",
      );
      return { ...metrics };
    } catch (error) {
      if (this.isCurrentLifecycle(lifecycleGeneration)) {
        this.initialBaselineState = "failed";
        getLogger().warn(
          {
            event: "file_watcher_initial_baseline_failed",
            provider: this.provider,
            watchDir: this.watchDir,
            error: error instanceof Error ? error.message : String(error),
          },
          "FILE_WATCHER: initial baseline failed",
        );
      }
      return null;
    } finally {
      if (this.isCurrentLifecycle(lifecycleGeneration)) {
        this.initialBaselineTouchedPaths.clear();
        if (this.rescanRequestedDuringBaseline) {
          this.rescanRequestedDuringBaseline = false;
          setImmediate(() => {
            if (this.isCurrentLifecycle(lifecycleGeneration)) {
              this.rescanAndEmit("fallback");
            }
          });
        }
      }
    }
  }

  private async scanDirAsync(
    root: string,
    index: Map<string, number>,
    metrics: FileWatcherBaselineMetrics,
    lifecycleGeneration: number,
  ): Promise<boolean> {
    const pendingDirectories = [root];
    const statBatchSize = 64;
    while (pendingDirectories.length > 0) {
      if (!this.isCurrentLifecycle(lifecycleGeneration)) return false;
      const dir = pendingDirectories.pop();
      if (!dir) break;
      metrics.directoriesVisited += 1;

      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        metrics.directoryReadErrors += 1;
        continue;
      }

      const files: string[] = [];
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) pendingDirectories.push(fullPath);
        else files.push(fullPath);
      }

      for (let offset = 0; offset < files.length; offset += statBatchSize) {
        if (!this.isCurrentLifecycle(lifecycleGeneration)) return false;
        const batch = files.slice(offset, offset + statBatchSize);
        metrics.filesScanned += batch.length;
        await Promise.all(
          batch.map(async (filePath) => {
            try {
              index.set(filePath, (await fs.promises.stat(filePath)).mtimeMs);
            } catch {
              metrics.statFailures += 1;
            }
          }),
        );
      }
    }
    return true;
  }

  private isCurrentLifecycle(lifecycleGeneration: number): boolean {
    return (
      lifecycleGeneration === this.lifecycleGeneration && this.watcher !== null
    );
  }

  private wasTouchedDuringBaseline(filePath: string): boolean {
    for (const touchedPath of this.initialBaselineTouchedPaths) {
      if (
        filePath === touchedPath ||
        filePath.startsWith(`${touchedPath}${path.sep}`)
      ) {
        return true;
      }
    }
    return false;
  }

  private scanDir(
    dir: string,
    index: Map<string, number>,
    metrics?: FileWatcherRescanMetrics,
  ): void {
    try {
      if (metrics) metrics.directoriesVisited += 1;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          this.scanDir(fullPath, index, metrics);
        } else {
          if (metrics) metrics.filesScanned += 1;
          try {
            const stats = fs.statSync(fullPath);
            index.set(fullPath, stats.mtimeMs);
          } catch {
            if (metrics) metrics.statFailures += 1;
            // File may have disappeared between readdir/stat
          }
        }
      }
    } catch {
      if (metrics) metrics.directoryReadErrors += 1;
      // Ignore errors (e.g., permission denied)
    }
  }

  private handleFileEvent(eventType: string, filename: string): void {
    const fullPath = path.join(this.watchDir, filename);
    const duringInitialBaseline =
      this.initialBaselineState === "scheduled" ||
      this.initialBaselineState === "running";
    if (duringInitialBaseline) {
      this.initialBaselineTouchedPaths.add(fullPath);
    }

    getLogger().debug(
      `[FileWatcher] Raw event provider=${this.provider} type=${eventType} file=${filename} path=${fullPath}`,
    );

    // Debounce per-file
    const existingTimer = this.debounceTimers.get(fullPath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(fullPath);
      this.emitEvent(fullPath, eventType, duringInitialBaseline);
    }, this.debounceMs);

    this.debounceTimers.set(fullPath, timer);
  }

  private emitEvent(
    fullPath: string,
    eventType: string,
    duringInitialBaseline = false,
  ): void {
    // Determine change type
    let changeType: FileChangeType;
    const fileExists = fs.existsSync(fullPath);

    if (!fileExists) {
      if (this.knownFileMtimes.has(fullPath)) {
        changeType = "delete";
        this.knownFileMtimes.delete(fullPath);
      } else if (duringInitialBaseline) {
        changeType = "delete";
      } else {
        // File never existed from our POV, skip
        return;
      }
    } else {
      let mtimeMs = Date.now();
      try {
        mtimeMs = fs.statSync(fullPath).mtimeMs;
      } catch {
        // File disappeared between existsSync and statSync
        return;
      }

      if (this.knownFileMtimes.has(fullPath)) {
        const previousMtime = this.knownFileMtimes.get(fullPath);
        if (previousMtime === mtimeMs) {
          // No meaningful change; skip duplicate callback.
          return;
        }
        changeType = "modify";
      } else if (duringInitialBaseline) {
        // The baseline has not published yet, so an unknown path is more
        // likely pre-existing than new. Trust the raw event: only a rename
        // can have introduced the file within this window.
        changeType = eventType === "change" ? "modify" : "create";
      } else {
        changeType = "create";
      }
      this.knownFileMtimes.set(fullPath, mtimeMs);
    }

    this.emitFileChangeEvent(fullPath, changeType);
  }

  private emitFileChangeEvent(
    fullPath: string,
    changeType: FileChangeType,
    metrics?: FileWatcherRescanMetrics,
  ): void {
    const relativePath = path.relative(this.watchDir, fullPath);

    const event: FileChangeEvent = {
      type: "file-change",
      provider: this.provider,
      path: fullPath,
      relativePath,
      changeType,
      timestamp: new Date().toISOString(),
      fileType: this.parseFileType(relativePath),
    };

    if (metrics) {
      metrics.emittedEvents += 1;
      if (changeType === "create") metrics.createEvents += 1;
      if (changeType === "modify") metrics.modifyEvents += 1;
      if (changeType === "delete") metrics.deleteEvents += 1;
      if (event.fileType === "session") {
        metrics.sessionEvents += 1;
      } else if (event.fileType === "agent-session") {
        metrics.agentSessionEvents += 1;
      } else {
        metrics.otherEvents += 1;
      }
    }

    getLogger().debug(
      `[FileWatcher] Emitting file-change provider=${event.provider} changeType=${event.changeType} fileType=${event.fileType} relativePath=${event.relativePath}`,
    );

    this.eventBus.emit(event);
  }

  /**
   * When fs.watch provides no filename (common on macOS under load),
   * rescan the tree and synthesize events from mtime/delete deltas.
   */
  private scheduleRescan(): void {
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
    }

    getLogger().debug(
      `[FileWatcher] Scheduling fallback rescan provider=${this.provider}`,
    );

    this.rescanTimer = setTimeout(
      () => {
        this.rescanTimer = null;
        this.rescanAndEmit("fallback");
      },
      Math.max(this.debounceMs * 2, 400),
    );
  }

  private scheduleNextPeriodicRescan(): void {
    if (this.periodicRescanMs <= 0 || !this.watcher) return;
    if (this.periodicRescanTimer) {
      clearTimeout(this.periodicRescanTimer);
    }

    this.periodicRescanTimer = setTimeout(() => {
      this.periodicRescanTimer = null;
      try {
        this.rescanAndEmit("periodic");
      } finally {
        this.scheduleNextPeriodicRescan();
      }
    }, this.periodicRescanCurrentMs);
  }

  private rescanAndEmit(reason: FileWatcherRescanReason): void {
    if (
      this.initialBaselineState === "scheduled" ||
      this.initialBaselineState === "running"
    ) {
      this.rescanRequestedDuringBaseline = true;
      this.rescanOverlapSkipsSinceLast += 1;
      this.rescanOverlapSkipsTotal += 1;
      return;
    }
    if (this.rescanInProgress) {
      this.rescanOverlapSkipsSinceLast += 1;
      this.rescanOverlapSkipsTotal += 1;
      getLogger().debug(
        {
          event: "file_watcher_rescan_skipped",
          provider: this.provider,
          watchDir: this.watchDir,
          reason,
          periodicRescanMs: this.periodicRescanMs,
          periodicRescanCurrentMs: this.periodicRescanCurrentMs,
          periodicRescanNextMs: this.periodicRescanCurrentMs,
          periodicRescanMaxMs: this.periodicRescanMaxBackoffMs,
          periodicRescanBackoffReason:
            this.periodicRescanMs > 0 ? "overlap" : "disabled",
          overlapSkipsSinceLast: this.rescanOverlapSkipsSinceLast,
          overlapSkipsTotal: this.rescanOverlapSkipsTotal,
        },
        "FILE_WATCHER: rescan skipped; already in progress",
      );
      return;
    }
    this.rescanInProgress = true;
    const metrics = this.createRescanMetrics(reason);
    const startedAt = Date.now();

    try {
      getLogger().debug(
        `[FileWatcher] Running ${reason} rescan provider=${this.provider}`,
      );
      const current = new Map<string, number>();
      metrics.knownFilesBefore = this.knownFileMtimes.size;
      this.scanDir(this.watchDir, current, metrics);
      metrics.currentFiles = current.size;

      // Create/modify events
      for (const [fullPath, mtimeMs] of current.entries()) {
        const prevMtime = this.knownFileMtimes.get(fullPath);
        if (prevMtime === undefined || prevMtime !== mtimeMs) {
          this.emitFileChangeEvent(
            fullPath,
            prevMtime === undefined ? "create" : "modify",
            metrics,
          );
        }
      }

      // Delete events
      for (const fullPath of this.knownFileMtimes.keys()) {
        if (!current.has(fullPath)) {
          this.emitFileChangeEvent(fullPath, "delete", metrics);
        }
      }

      this.knownFileMtimes = current;
      metrics.knownFilesAfter = this.knownFileMtimes.size;
    } finally {
      metrics.durationMs = Date.now() - startedAt;
      this.updatePeriodicRescanBackoff(metrics);
      this.lastRescanMetrics = { ...metrics };
      this.logRescanMetrics(metrics);
      this.rescanOverlapSkipsSinceLast = 0;
      this.rescanInProgress = false;
    }
  }

  private createRescanMetrics(
    reason: FileWatcherRescanReason,
  ): FileWatcherRescanMetrics {
    return {
      provider: this.provider,
      watchDir: this.watchDir,
      reason,
      periodicRescanMs: this.periodicRescanMs,
      periodicRescanCurrentMs: this.periodicRescanCurrentMs,
      periodicRescanNextMs: this.periodicRescanCurrentMs,
      periodicRescanMaxMs: this.periodicRescanMaxBackoffMs,
      periodicRescanBackoffReason:
        this.periodicRescanMs > 0 ? "unchanged" : "disabled",
      durationMs: 0,
      directoriesVisited: 0,
      filesScanned: 0,
      directoryReadErrors: 0,
      statFailures: 0,
      knownFilesBefore: this.knownFileMtimes.size,
      currentFiles: 0,
      knownFilesAfter: this.knownFileMtimes.size,
      createEvents: 0,
      modifyEvents: 0,
      deleteEvents: 0,
      emittedEvents: 0,
      sessionEvents: 0,
      agentSessionEvents: 0,
      otherEvents: 0,
      overlapSkipsSinceLast: this.rescanOverlapSkipsSinceLast,
      overlapSkipsTotal: this.rescanOverlapSkipsTotal,
    };
  }

  private updatePeriodicRescanBackoff(metrics: FileWatcherRescanMetrics): void {
    if (metrics.reason !== "periodic" || this.periodicRescanMs <= 0) {
      metrics.periodicRescanBackoffReason =
        this.periodicRescanMs > 0 ? "unchanged" : "disabled";
      metrics.periodicRescanCurrentMs = this.periodicRescanCurrentMs;
      metrics.periodicRescanNextMs = this.periodicRescanCurrentMs;
      return;
    }

    const currentDelayMs = this.periodicRescanCurrentMs;
    const slowThresholdMs = Math.max(
      1,
      Math.floor(currentDelayMs * PERIODIC_RESCAN_BACKOFF_RATIO),
    );
    const recoveryThresholdMs = Math.max(
      1,
      Math.floor(currentDelayMs * PERIODIC_RESCAN_RECOVERY_RATIO),
    );
    let nextDelayMs = currentDelayMs;
    let reason: FileWatcherBackoffReason = "unchanged";

    if (
      metrics.overlapSkipsSinceLast > 0 ||
      metrics.durationMs >= slowThresholdMs
    ) {
      nextDelayMs = Math.max(
        this.periodicRescanMs,
        currentDelayMs * 2,
        Math.ceil(metrics.durationMs * 2),
      );
      reason = metrics.overlapSkipsSinceLast > 0 ? "overlap" : "slow";
    } else if (
      currentDelayMs > this.periodicRescanMs &&
      metrics.durationMs <= recoveryThresholdMs
    ) {
      nextDelayMs = Math.max(
        this.periodicRescanMs,
        Math.ceil(currentDelayMs / 2),
      );
      reason = nextDelayMs < currentDelayMs ? "recovered" : "unchanged";
    }

    nextDelayMs = Math.min(this.periodicRescanMaxBackoffMs, nextDelayMs);
    this.periodicRescanCurrentMs = nextDelayMs;
    metrics.periodicRescanCurrentMs = currentDelayMs;
    metrics.periodicRescanNextMs = nextDelayMs;
    metrics.periodicRescanBackoffReason = reason;
  }

  private logRescanMetrics(metrics: FileWatcherRescanMetrics): void {
    const payload = {
      event: "file_watcher_rescan",
      ...metrics,
    };
    if (metrics.durationMs >= this.rescanSlowLogThresholdMs) {
      getLogger().warn(payload, "FILE_WATCHER: slow rescan");
      return;
    }
    getLogger().debug(payload, "FILE_WATCHER: rescan complete");
  }

  private parseFileType(relativePath: string): FileChangeEvent["fileType"] {
    switch (this.provider) {
      case "claude":
        return this.parseClaudeFileType(relativePath);
      case "gemini":
        return this.parseGeminiFileType(relativePath);
      case "codex":
        return this.parseCodexFileType(relativePath);
      case "pi":
        return this.parsePiFileType(relativePath);
    }
  }

  private parseClaudeFileType(
    relativePath: string,
  ): FileChangeEvent["fileType"] {
    // Watching ~/.claude/projects - relativePath is {hash}/{session}.jsonl
    const basename = path.basename(relativePath);
    if (
      basename.startsWith("agent-") &&
      (basename.endsWith(".jsonl") || basename.endsWith(".meta.json"))
    ) {
      return "agent-session";
    }
    if (relativePath.endsWith(".jsonl")) {
      return "session";
    }
    return "other";
  }

  private parseGeminiFileType(
    relativePath: string,
  ): FileChangeEvent["fileType"] {
    // Watching ~/.gemini/tmp - relativePath is {hash}/chats/session-*.json
    // On Windows, path.relative() returns backslashes
    if (
      (relativePath.includes("/chats/") ||
        relativePath.includes("\\chats\\")) &&
      relativePath.endsWith(".json")
    ) {
      return "session";
    }
    return "other";
  }

  private parseCodexFileType(
    relativePath: string,
  ): FileChangeEvent["fileType"] {
    // Watching ~/.codex/sessions - relativePath is {year}/{month}/{day}/rollout-*.jsonl[.zst]
    if (isCodexRolloutFileName(path.basename(relativePath))) {
      return "session";
    }
    return "other";
  }

  private parsePiFileType(relativePath: string): FileChangeEvent["fileType"] {
    // Watching ~/.pi/agent/sessions - relativePath is {encoded-cwd}/{ts}_{uuid}.jsonl.
    if (relativePath.endsWith(".jsonl")) {
      return "session";
    }
    return "other";
  }
}
