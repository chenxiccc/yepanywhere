import { stat } from "node:fs/promises";
import * as path from "node:path";
import {
  type DirProjectId,
  type UrlProjectId,
  asDirProjectId,
} from "@yep-anywhere/shared";
import {
  decodeProjectId,
  encodeProjectId,
  getProjectName,
} from "../projects/paths.js";
import type { SessionListSummary } from "../sessions/types.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { getCodexRolloutActivityTimeMs } from "../utils/codexRolloutFiles.js";
import { readFirstLine } from "../utils/jsonl.js";
import {
  BatchProcessor,
  type BatchProcessorDiagnostics,
} from "../watcher/BatchProcessor.js";
import type {
  BusEvent,
  EventBus,
  FileChangeEvent,
  SessionAbortedEvent,
  SessionCreatedEvent,
  SessionStatusEvent,
  SessionUpdatedEvent,
} from "../watcher/EventBus.js";
import type { Supervisor } from "./Supervisor.js";
import type {
  ContextUsage,
  SessionOwnership,
  SessionSummary,
} from "./types.js";

interface ExternalSessionInfo {
  detectedAt: Date;
  lastActivity: Date;
  /** Directory-format projectId (from file path, NOT base64url) */
  dirProjectId?: DirProjectId;
  /** URL-format projectId (base64url) */
  projectId?: UrlProjectId;
  /** Session provider */
  provider: FileChangeEvent["provider"];
  timeoutId: ReturnType<typeof setTimeout>;
}

/** Default grace period after abort before external detection resumes (30 seconds) */
const DEFAULT_ABORT_GRACE_MS = 30000;

function getProjectNameForProjectId(projectId: UrlProjectId): string {
  return getProjectName(decodeProjectId(projectId));
}

type TrackedSessionSummary =
  | { fidelity: "complete"; summary: SessionSummary }
  | { fidelity: "list"; summary: SessionListSummary };

export interface ExternalSessionTrackerOptions {
  eventBus: EventBus;
  supervisor: Supervisor;
  scanner: ProjectScanner;
  /** Time in ms before external status decays to idle (default: 30000) */
  decayMs?: number;
  /** Grace period in ms after abort before external detection resumes (default: 30000) */
  abortGraceMs?: number;
  /** Optional callback to get session summary for new external sessions */
  getSessionSummary?: (
    sessionId: string,
    projectId: UrlProjectId,
  ) => Promise<SessionSummary | null>;
  /** Optional bounded callback for Codex title/recency observations. */
  getSessionListSummary?: (
    sessionId: string,
    projectId: UrlProjectId,
  ) => Promise<SessionListSummary | null>;
}

export interface ExternalSessionTrackerDiagnostics {
  sessionSummaryBatch: BatchProcessorDiagnostics;
}

/**
 * Tracks sessions that are being modified by external programs (not owned by this app).
 *
 * Uses file change events to detect when a session file is modified, then checks
 * if we own that session via Supervisor. If not owned, marks as "external" until
 * the decay timeout passes with no activity.
 */
export class ExternalSessionTracker {
  private externalSessions: Map<string, ExternalSessionInfo> = new Map();
  /** Sessions recently aborted by this server - grace period before external detection */
  private recentlyAborted: Map<string, number> = new Map(); // sessionId -> timestamp
  private eventBus: EventBus;
  private supervisor: Supervisor;
  private scanner: ProjectScanner;
  private decayMs: number;
  private abortGraceMs: number;
  private unsubscribe: (() => void) | null = null;
  private getSessionSummary?: (
    sessionId: string,
    projectId: UrlProjectId,
  ) => Promise<SessionSummary | null>;
  private getSessionListSummary?: (
    sessionId: string,
    projectId: UrlProjectId,
  ) => Promise<SessionListSummary | null>;
  /** Batches session parsing to prevent OOM from concurrent file reads */
  private sessionParser: BatchProcessor<TrackedSessionSummary | null>;
  /** Tracks sessions that have already emitted session-created */
  private createdSessions: Set<string> = new Set();
  /** Cache of last known session state for change detection */
  private sessionStateCache: Map<
    string,
    {
      title: string | null;
      updatedAt: string;
      messageCount?: number;
      projectId: UrlProjectId;
      contextUsage?: ContextUsage;
      model?: string;
    }
  > = new Map();

  constructor(options: ExternalSessionTrackerOptions) {
    this.eventBus = options.eventBus;
    this.supervisor = options.supervisor;
    this.scanner = options.scanner;
    this.decayMs = options.decayMs ?? 30000;
    this.abortGraceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
    this.getSessionSummary = options.getSessionSummary;
    this.getSessionListSummary = options.getSessionListSummary;

    // Initialize batch processor for session parsing
    // Limits concurrent JSONL parsing to prevent OOM during bulk file operations
    this.sessionParser = new BatchProcessor<TrackedSessionSummary | null>({
      concurrency: 5,
      batchMs: 300,
      onResult: (sessionId, observed) => {
        if (!observed) return;

        const summary = observed.summary;
        const isComplete = observed.fidelity === "complete";
        const projectId = summary.projectId as UrlProjectId;
        const now = new Date().toISOString();
        const cached = this.sessionStateCache.get(sessionId);
        const nextState = {
          ...cached,
          title: summary.title,
          updatedAt: summary.updatedAt,
          projectId,
          ...(isComplete
            ? {
                messageCount: observed.summary.messageCount,
                contextUsage: observed.summary.contextUsage,
                model: observed.summary.model,
              }
            : {}),
        };

        // Check if supervisor owns this session
        const isOwned = !!this.supervisor.getProcessForSession(sessionId);

        // Clean up external tracking if owned
        if (isOwned) {
          this.removeExternal(sessionId);
        }

        // For owned sessions, we only emit session-updated (supervisor handles session-created)
        // For external sessions, we emit both session-created (first time) and session-updated
        if (!this.createdSessions.has(sessionId)) {
          if (isOwned) {
            // Owned session - supervisor already emitted session-created with title: null
            // Cache state and emit only fields observed at this fidelity.
            this.sessionStateCache.set(sessionId, nextState);
            this.createdSessions.add(sessionId);

            // Supervisor emits session-created before this observation.
            const event: SessionUpdatedEvent = {
              type: "session-updated",
              sessionId,
              projectId,
              title: summary.title,
              updatedAt: summary.updatedAt,
              ...(isComplete
                ? {
                    messageCount: observed.summary.messageCount,
                    contextUsage: observed.summary.contextUsage,
                    model: observed.summary.model,
                    lastAgentText: observed.summary.lastAgentText,
                  }
                : {}),
              timestamp: now,
            };
            this.eventBus.emit(event);
          } else if (isComplete) {
            // New external session - emit session-created
            const event: SessionCreatedEvent = {
              type: "session-created",
              session: {
                ...observed.summary,
                ownership: { owner: "external" },
                projectName:
                  observed.summary.projectName ??
                  getProjectNameForProjectId(projectId),
              },
              timestamp: now,
            };
            this.eventBus.emit(event);
            this.createdSessions.add(sessionId);

            // Cache initial state for future change detection
            this.sessionStateCache.set(sessionId, nextState);
          } else {
            // Codex normally emits its synthetic session-created before the
            // batched list read completes. If header creation failed or raced,
            // fall back to a complete read rather than inventing required
            // SessionSummary fields from a partial projection.
            this.enqueueTrackedSummary(sessionId, projectId, "complete");
          }
        } else {
          // Existing session - check for changes and emit session-updated
          const titleChanged = cached?.title !== summary.title;
          const updatedAtChanged = cached?.updatedAt !== summary.updatedAt;
          const messageCountChanged =
            isComplete &&
            cached?.messageCount !== observed.summary.messageCount;
          // Compare context usage by input tokens (percentage can be derived)
          const contextUsageChanged =
            isComplete &&
            cached?.contextUsage?.inputTokens !==
              observed.summary.contextUsage?.inputTokens;
          const modelChanged =
            isComplete && cached?.model !== observed.summary.model;

          if (
            titleChanged ||
            updatedAtChanged ||
            messageCountChanged ||
            contextUsageChanged ||
            modelChanged
          ) {
            const event: SessionUpdatedEvent = {
              type: "session-updated",
              sessionId,
              projectId,
              title: summary.title,
              updatedAt: summary.updatedAt,
              ...(isComplete
                ? {
                    messageCount: observed.summary.messageCount,
                    contextUsage: observed.summary.contextUsage,
                    model: observed.summary.model,
                    lastAgentText: observed.summary.lastAgentText,
                  }
                : {}),
              timestamp: now,
            };
            this.eventBus.emit(event);

            // Update cache
            this.sessionStateCache.set(sessionId, nextState);
          }
        }
      },
      onError: (sessionId, error) => {
        // Log but don't fail - session may not be readable yet
        console.warn(
          `[ExternalSessionTracker] Failed to read session ${sessionId}:`,
          error.message,
        );
      },
    });

    // Subscribe to bus events
    this.unsubscribe = options.eventBus.subscribe((event: BusEvent) => {
      if (event.type === "file-change") {
        void this.handleFileChange(event);
      } else if (event.type === "session-aborted") {
        this.handleSessionAborted(event);
      }
    });
  }

  private handleSessionAborted(event: SessionAbortedEvent): void {
    this.markAborted(event.sessionId);
  }

  /**
   * Check if a session is currently marked as external.
   */
  isExternal(sessionId: string): boolean {
    return this.externalSessions.has(sessionId);
  }

  /**
   * Get info about an external session, or null if not external.
   * Returns the directory-format projectId (for internal use only).
   */
  getExternalSessionInfo(
    sessionId: string,
  ): { lastActivity: Date; dirProjectId: DirProjectId } | null {
    const info = this.externalSessions.get(sessionId);
    if (!info) return null;
    if (!info.dirProjectId) return null;
    return { lastActivity: info.lastActivity, dirProjectId: info.dirProjectId };
  }

  /**
   * Get info about an external session with URL-format projectId.
   * Use this for API responses and events.
   */
  async getExternalSessionInfoWithUrlId(
    sessionId: string,
  ): Promise<{ lastActivity: Date; projectId: UrlProjectId } | null> {
    const info = this.externalSessions.get(sessionId);
    if (!info) return null;

    if (info.projectId) {
      return {
        lastActivity: info.lastActivity,
        projectId: info.projectId,
      };
    }

    if (!info.dirProjectId) return null;

    const project = await this.scanner.getProjectBySessionDirSuffix(
      info.dirProjectId,
    );
    if (!project) return null;

    return {
      lastActivity: info.lastActivity,
      projectId: project.id as UrlProjectId,
    };
  }

  /**
   * Mark a session as recently aborted. During the grace period, file changes
   * won't trigger external session detection (they're from our own cleanup).
   * Called by Supervisor when a process is aborted.
   */
  markAborted(sessionId: string): void {
    this.recentlyAborted.set(sessionId, Date.now());
    // Also remove from external tracking if present (abort takes precedence)
    this.removeExternal(sessionId);
  }

  /**
   * Check if a session is within the abort grace period.
   */
  private isInAbortGracePeriod(sessionId: string): boolean {
    const abortedAt = this.recentlyAborted.get(sessionId);
    if (!abortedAt) return false;

    const elapsed = Date.now() - abortedAt;
    if (elapsed >= this.abortGraceMs) {
      // Grace period expired - clean up
      this.recentlyAborted.delete(sessionId);
      return false;
    }
    return true;
  }

  /**
   * Get all currently external session IDs.
   */
  getExternalSessions(): string[] {
    return Array.from(this.externalSessions.keys());
  }

  getDiagnostics(): ExternalSessionTrackerDiagnostics {
    return {
      sessionSummaryBatch: this.sessionParser.getDiagnostics(),
    };
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    // Clear batch processor
    this.sessionParser.dispose();

    // Clear all timeouts
    for (const info of this.externalSessions.values()) {
      clearTimeout(info.timeoutId);
    }
    this.externalSessions.clear();
    this.recentlyAborted.clear();
  }

  private async loadTrackedSummary(
    sessionId: string,
    projectId: UrlProjectId,
    fidelity: "complete" | "list",
  ): Promise<TrackedSessionSummary | null> {
    if (fidelity === "list" && this.getSessionListSummary) {
      const summary = await this.getSessionListSummary(sessionId, projectId);
      return summary ? { fidelity: "list", summary } : null;
    }
    if (!this.getSessionSummary) {
      return null;
    }
    const summary = await this.getSessionSummary(sessionId, projectId);
    return summary ? { fidelity: "complete", summary } : null;
  }

  private enqueueTrackedSummary(
    sessionId: string,
    projectId: UrlProjectId,
    fidelity: "complete" | "list",
  ): void {
    if (!this.getSessionSummary && !this.getSessionListSummary) {
      return;
    }
    this.sessionParser.enqueue(sessionId, () =>
      this.loadTrackedSummary(sessionId, projectId, fidelity),
    );
  }

  private async handleFileChange(event: FileChangeEvent): Promise<void> {
    // Only care about session files
    if (event.fileType !== "session" && event.fileType !== "agent-session") {
      return;
    }

    if (event.provider === "codex") {
      await this.handleCodexFileChange(event);
      return;
    }

    if (event.provider === "pi") {
      await this.handlePiFileChange(event);
      return;
    }

    // Parse sessionId and projectId from path
    // Format: projects/<projectId>/<sessionId>.jsonl
    const parsed = this.parseSessionPath(event.relativePath);
    if (!parsed) return;

    const { sessionId, dirProjectId } = parsed;

    // Check if we own this session
    const process = this.supervisor.getProcessForSession(sessionId);
    if (process) {
      // We own it - remove from external tracking if present
      this.removeExternal(sessionId);
      // Claude summaries are complete; preserve their exact event fields.
      this.enqueueTrackedSummary(sessionId, process.projectId, "complete");
      return;
    }

    // Check if this session was recently aborted by us - ignore file changes
    // during grace period (they're from our own process cleanup, not external)
    if (this.isInAbortGracePeriod(sessionId)) {
      return;
    }

    // We don't own it and it's not in grace period - mark as external
    this.markExternal(sessionId, { provider: event.provider, dirProjectId });
  }

  private parseSessionPath(
    relativePath: string,
  ): { sessionId: string; dirProjectId: DirProjectId } | null {
    // Expected formats:
    // - projects/<projectId>/<sessionId>.jsonl
    // - projects/<hostname>/<projectId>/<sessionId>.jsonl
    // - <projectId>/<sessionId>.jsonl (when watchDir is already ~/.claude/projects)
    // - <hostname>/<projectId>/<sessionId>.jsonl (same case with hostname)
    const parts = relativePath.split(path.sep).filter(Boolean);
    if (parts.length < 2) return null;

    const startIdx = parts[0] === "projects" ? 1 : 0;
    if (parts.length - startIdx < 2) return null;

    // Find the .jsonl file
    const filename = parts[parts.length - 1];
    if (!filename?.endsWith(".jsonl")) return null;

    // Extract sessionId (filename without .jsonl)
    const sessionId = filename.slice(0, -6); // Remove '.jsonl'

    // Skip agent sessions (they start with 'agent-')
    if (sessionId.startsWith("agent-")) return null;

    // ProjectId is everything between 'projects/' and the filename
    // For: projects/aG9tZS.../.../session.jsonl
    // ProjectId could be single part or multiple parts (hostname + encoded path)
    const projectParts = parts.slice(startIdx, -1);
    if (projectParts.length === 0) return null;

    // Use the first part as projectId (encoded project path)
    // In the hostname case, use hostname/encodedPath format
    const dirProjectId = asDirProjectId(projectParts.join("/"));

    return { sessionId, dirProjectId };
  }

  private async handleCodexFileChange(event: FileChangeEvent): Promise<void> {
    const sessionId = this.extractCodexSessionId(event.relativePath);
    if (!sessionId) return;

    const process = this.supervisor.getProcessForSession(sessionId);
    if (process) {
      this.removeExternal(sessionId);
      // Codex title/recency is bounded; the owned SDK remains authoritative
      // for message count, model, context usage, and recent output.
      this.enqueueTrackedSummary(sessionId, process.projectId, "list");
      return;
    }

    if (this.isInAbortGracePeriod(sessionId)) {
      return;
    }

    const projectId = await this.readCodexProjectIdFromFile(event.path);
    if (!projectId) return;

    this.markExternal(sessionId, { provider: event.provider, projectId });
    await this.ensureCodexSessionCreated(sessionId, event.path, projectId);
  }

  private extractCodexSessionId(relativePath: string): string | null {
    const filename = relativePath.split(path.sep).pop();
    if (!filename?.endsWith(".jsonl")) return null;
    const base = filename.slice(0, -6);
    const match = base.match(/([0-9a-fA-F-]{36})$/);
    return match?.[1] ?? null;
  }

  private async readCodexProjectIdFromFile(
    filePath: string,
  ): Promise<UrlProjectId | null> {
    const meta = await this.readCodexSessionMeta(filePath);
    if (!meta) return null;
    return encodeProjectId(meta.cwd);
  }

  private async readCodexSessionMeta(
    filePath: string,
  ): Promise<{ cwd: string; timestamp: string; model?: string } | null> {
    try {
      const firstLine = await readFirstLine(filePath);
      if (!firstLine) return null;

      const parsed = JSON.parse(firstLine) as {
        type?: string;
        payload?: { cwd?: string; timestamp?: string; model?: string };
      };
      if (
        parsed.type !== "session_meta" ||
        !parsed.payload?.cwd ||
        !parsed.payload?.timestamp
      ) {
        return null;
      }

      return {
        cwd: parsed.payload.cwd,
        timestamp: parsed.payload.timestamp,
        model: parsed.payload.model,
      };
    } catch {
      return null;
    }
  }

  private async ensureCodexSessionCreated(
    sessionId: string,
    filePath: string,
    projectId: UrlProjectId,
  ): Promise<void> {
    if (this.createdSessions.has(sessionId)) return;

    const meta = await this.readCodexSessionMeta(filePath);
    if (!meta) return;

    try {
      const stats = await stat(filePath);
      const summary: SessionSummary = {
        id: sessionId,
        projectId,
        projectName: getProjectNameForProjectId(projectId),
        title: null,
        fullTitle: null,
        createdAt: meta.timestamp,
        updatedAt: new Date(
          getCodexRolloutActivityTimeMs(filePath, stats),
        ).toISOString(),
        messageCount: 0,
        ownership: { owner: "external" },
        provider: "codex",
        model: meta.model,
      };

      const event: SessionCreatedEvent = {
        type: "session-created",
        session: summary,
        timestamp: new Date().toISOString(),
      };
      this.eventBus.emit(event);
      this.createdSessions.add(sessionId);
    } catch {
      // Ignore failures until next file change
    }
  }

  private async handlePiFileChange(event: FileChangeEvent): Promise<void> {
    const meta = await this.readPiSessionHeader(event.path);
    if (!meta) return;

    const process = this.supervisor.getProcessForSession(meta.id);
    if (process) {
      this.removeExternal(meta.id);
      this.enqueueTrackedSummary(meta.id, process.projectId, "complete");
      return;
    }

    if (this.isInAbortGracePeriod(meta.id)) {
      return;
    }

    const projectId = encodeProjectId(meta.cwd);
    this.markExternal(meta.id, { provider: event.provider, projectId });
    await this.ensurePiSessionCreated(meta, event.path, projectId);
  }

  private async readPiSessionHeader(filePath: string): Promise<{
    id: string;
    cwd: string;
    timestamp: string;
    model?: string;
  } | null> {
    try {
      const firstLine = await readFirstLine(filePath);
      if (!firstLine) return null;

      const parsed = JSON.parse(firstLine) as {
        type?: string;
        id?: string;
        cwd?: string;
        timestamp?: string;
      };
      if (
        parsed.type !== "session" ||
        !parsed.id ||
        !parsed.cwd ||
        !parsed.timestamp
      ) {
        return null;
      }

      return {
        id: parsed.id,
        cwd: parsed.cwd,
        timestamp: parsed.timestamp,
      };
    } catch {
      return null;
    }
  }

  private async ensurePiSessionCreated(
    meta: { id: string; cwd: string; timestamp: string; model?: string },
    filePath: string,
    projectId: UrlProjectId,
  ): Promise<void> {
    if (this.createdSessions.has(meta.id)) return;

    try {
      const stats = await stat(filePath);
      const summary: SessionSummary = {
        id: meta.id,
        projectId,
        projectName: getProjectName(meta.cwd),
        title: null,
        fullTitle: null,
        createdAt: meta.timestamp,
        updatedAt: stats.mtime.toISOString(),
        messageCount: 0,
        ownership: { owner: "external" },
        provider: "pi",
        model: meta.model,
      };

      const event: SessionCreatedEvent = {
        type: "session-created",
        session: summary,
        timestamp: new Date().toISOString(),
      };
      this.eventBus.emit(event);
      this.createdSessions.add(meta.id);
    } catch {
      // Ignore failures until the next file change.
    }
  }

  private markExternal(
    sessionId: string,
    info: {
      provider: FileChangeEvent["provider"];
      dirProjectId?: DirProjectId;
      projectId?: UrlProjectId;
    },
  ): void {
    const now = new Date();
    const existing = this.externalSessions.get(sessionId);

    if (existing) {
      // Update last activity and reset timer
      clearTimeout(existing.timeoutId);
      existing.lastActivity = now;
      existing.timeoutId = this.createDecayTimeout(sessionId);
      // Codex emits bounded title/recency patches. Other watched providers
      // retain complete summaries and exact event fields.
      if (this.getSessionSummary || this.getSessionListSummary) {
        this.sessionParser.enqueue(sessionId, async () => {
          const project = await this.resolveProjectForSession(info);
          if (!project) return null;
          return this.loadTrackedSummary(
            sessionId,
            project.id as UrlProjectId,
            info.provider === "codex" ? "list" : "complete",
          );
        });
      }
    } else {
      // New external session
      const externalInfo: ExternalSessionInfo = {
        detectedAt: now,
        lastActivity: now,
        dirProjectId: info.dirProjectId,
        projectId: info.projectId,
        provider: info.provider,
        timeoutId: this.createDecayTimeout(sessionId),
      };
      this.externalSessions.set(sessionId, externalInfo);

      // Queue session parsing - batched to prevent OOM from bulk file operations
      if (this.getSessionSummary || this.getSessionListSummary) {
        this.sessionParser.enqueue(sessionId, async () => {
          const project = await this.resolveProjectForSession(externalInfo);
          if (!project) return null;
          return this.loadTrackedSummary(
            sessionId,
            project.id as UrlProjectId,
            externalInfo.provider === "codex" ? "list" : "complete",
          );
        });
      }

      // Emit ownership change event
      void this.emitOwnershipChangeByInfo(sessionId, externalInfo, {
        owner: "external",
      });
    }
  }

  private removeExternal(sessionId: string): void {
    const existing = this.externalSessions.get(sessionId);
    if (existing) {
      clearTimeout(existing.timeoutId);
      this.externalSessions.delete(sessionId);

      // Emit ownership change event
      void this.emitOwnershipChangeByInfo(sessionId, existing, {
        owner: "none",
      });
    }
  }

  private createDecayTimeout(sessionId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const info = this.externalSessions.get(sessionId);
      if (info) {
        this.externalSessions.delete(sessionId);
        // Emit ownership change to none
        void this.emitOwnershipChangeByInfo(sessionId, info, { owner: "none" });
      }
    }, this.decayMs);
  }

  private async emitOwnershipChangeByInfo(
    sessionId: string,
    info: ExternalSessionInfo,
    ownership: SessionOwnership,
  ): Promise<void> {
    if (info.projectId) {
      const event: SessionStatusEvent = {
        type: "session-status-changed",
        sessionId,
        projectId: info.projectId,
        ownership,
        timestamp: new Date().toISOString(),
      };
      this.eventBus.emit(event);
      return;
    }

    if (!info.dirProjectId) return;

    // Convert directory format to URL format for events
    const project = await this.scanner.getProjectBySessionDirSuffix(
      info.dirProjectId,
    );
    if (!project) {
      console.warn(
        `[ExternalSessionTracker] Cannot emit ownership change - project not found: ${info.dirProjectId}`,
      );
      return;
    }

    const event: SessionStatusEvent = {
      type: "session-status-changed",
      sessionId,
      projectId: project.id,
      ownership,
      timestamp: new Date().toISOString(),
    };

    // Emit through EventBus so it gets broadcast via SSE
    this.eventBus.emit(event);
  }

  private async resolveProjectForSession(info: {
    provider: FileChangeEvent["provider"];
    dirProjectId?: DirProjectId;
    projectId?: UrlProjectId;
  }): Promise<{ id: UrlProjectId } | null> {
    if (info.projectId) {
      return { id: info.projectId };
    }
    if (!info.dirProjectId) return null;
    const project = await this.scanner.getProjectBySessionDirSuffix(
      info.dirProjectId,
    );
    if (!project) {
      console.warn(
        `[ExternalSessionTracker] Cannot emit session-created - project not found: ${info.dirProjectId}`,
      );
      return null;
    }
    return { id: project.id as UrlProjectId };
  }
}
