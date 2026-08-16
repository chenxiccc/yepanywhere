import {
  DEFAULT_PROJECT_QUEUE_QUIET_SECONDS,
  type PermissionMode,
  type ProjectQueueItem,
  type ProjectQueueProjectStatus,
  type ProjectQueuePromoteNowResult,
  type ProviderName,
  type UploadedFile,
  type UrlProjectId,
  thinkingOptionToConfig,
} from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import type { UserMessage } from "../sdk/types.js";
import type { BusEvent, EventBus } from "../watcher/EventBus.js";
import {
  RetryableSessionLaunchError,
  type ModelSettings,
  type SessionLaunchOptions,
} from "../supervisor/Supervisor.js";
import type { AttachmentStagingService } from "../uploads/AttachmentStagingService.js";
import type { ProjectQueueService } from "./ProjectQueueService.js";
import type {
  PersistedSessionQueuedMessage,
  SessionQueuePersistenceService,
} from "./SessionQueuePersistenceService.js";
import {
  getProjectWorkIdleStatus,
  type ProjectWorkExternalTracker,
  type ProjectWorkIdleStatus,
  type ProjectWorkProcessSnapshot,
  type ProjectWorkSupervisor,
} from "./projectWorkIdle.js";

const DEFAULT_IDLE_GRACE_MS = DEFAULT_PROJECT_QUEUE_QUIET_SECONDS * 1000;
const BLOCKED_RETRY_MS = 30_000;

type ProjectQueueTimerReason = "quiet" | "blocked-retry";

interface ProjectQueueTimerState {
  timer: ReturnType<typeof setTimeout>;
  reason: ProjectQueueTimerReason;
  scheduledAtMs: number;
  eligibleAtMs: number;
}

export interface ProjectQueueProcessSnapshot
  extends ProjectWorkProcessSnapshot {
  id: string;
  sessionId: string;
  projectId: UrlProjectId;
  projectPath: string;
  provider: ProviderName;
  promptSuggestionMode?: ModelSettings["promptSuggestionMode"];
  recapAfterSeconds?: number;
}

export type ProjectQueueDispatchResult =
  | ProjectQueueProcessSnapshot
  | { queued: true; queueId: string; position: number }
  | { error: "queue_full"; maxQueueSize: number };

export interface ProjectQueueSupervisor extends ProjectWorkSupervisor {
  getAllProcesses(): ProjectQueueProcessSnapshot[];
  startSession(
    projectPath: string,
    message: UserMessage,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
    launchOptions?: SessionLaunchOptions,
  ): Promise<ProjectQueueDispatchResult>;
  createSession(
    projectPath: string,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
    launchOptions?: SessionLaunchOptions,
  ): Promise<ProjectQueueDispatchResult>;
  resumeSession(
    sessionId: string,
    projectPath: string,
    message: UserMessage,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
    launchOptions?: SessionLaunchOptions,
  ): Promise<ProjectQueueDispatchResult>;
}

export type ProjectQueueExternalTracker = ProjectWorkExternalTracker;

export type ProjectIdleStatus = ProjectWorkIdleStatus;

type RunProjectResult =
  | {
      reason: "promoted";
      itemId: string;
      sessionId?: string;
      promoted: true;
    }
  | {
      reason:
        | "empty"
        | "paused"
        | "blocked"
        | "in-flight"
        | "not-found"
        | "not-queued"
        | "failed";
      itemId?: string;
      error?: string;
      promoted: false;
    };

interface PromoteNowOptions {
  itemId?: string;
  force?: boolean;
  deliveryIntent?: "steer";
  automatic?: boolean;
}

export interface ProjectQueueSchedulerOptions {
  projectQueueService: ProjectQueueService;
  supervisor: ProjectQueueSupervisor;
  eventBus: EventBus;
  attachmentStagingService?: AttachmentStagingService;
  sessionQueuePersistenceService?: SessionQueuePersistenceService;
  externalTracker?: ProjectQueueExternalTracker;
  idleGraceMs?: number;
  blockedRetryMs?: number;
  getIdleGraceMs?: () => number;
  getGlobalInstructions?: () => string | undefined;
  isSessionAutomationPaused?: (sessionId: string) => boolean;
  onSessionStarted?: (args: {
    item: ProjectQueueItem;
    process: ProjectQueueProcessSnapshot;
  }) => void | Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isQueueFullResult(
  result: ProjectQueueDispatchResult,
): result is { error: "queue_full"; maxQueueSize: number } {
  return "error" in result && result.error === "queue_full";
}

function isQueuedResult(
  result: ProjectQueueDispatchResult,
): result is { queued: true; queueId: string; position: number } {
  return "queued" in result && result.queued === true;
}

function isRecoveredPatientQueueItem(
  item: PersistedSessionQueuedMessage,
): boolean {
  return item.kind === "patient" && item.status === "paused-after-restart";
}

export class ProjectQueueScheduler {
  private readonly projectQueueService: ProjectQueueService;
  private readonly supervisor: ProjectQueueSupervisor;
  private readonly eventBus: EventBus;
  private readonly externalTracker?: ProjectQueueExternalTracker;
  private readonly fixedIdleGraceMs?: number;
  private readonly getConfiguredIdleGraceMs?: () => number;
  private readonly timers = new Map<UrlProjectId, ProjectQueueTimerState>();
  private readonly userSessionStartReservations = new Map<
    UrlProjectId,
    Map<string, number>
  >();
  private readonly inFlight = new Set<UrlProjectId>();
  private readonly inFlightRuns = new Set<Promise<RunProjectResult>>();
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(private readonly options: ProjectQueueSchedulerOptions) {
    this.projectQueueService = options.projectQueueService;
    this.supervisor = options.supervisor;
    this.eventBus = options.eventBus;
    this.externalTracker = options.externalTracker;
    this.fixedIdleGraceMs = options.idleGraceMs;
    this.getConfiguredIdleGraceMs = options.getIdleGraceMs;
    this.unsubscribe = this.eventBus.subscribe(this.handleEvent);
    this.scheduleAllDispatchableProjects();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribe();
    for (const state of this.timers.values()) {
      clearTimeout(state.timer);
    }
    this.timers.clear();
    this.userSessionStartReservations.clear();
    await Promise.allSettled(this.inFlightRuns);
    this.inFlight.clear();
  }

  /**
   * Reserve a project's idle predicate while an admitted user request is
   * starting a session but has not yet registered a live provider process.
   */
  reserveUserSessionStart(
    projectId: UrlProjectId,
    sessionId: string,
  ): () => void {
    if (this.disposed) return () => {};

    const reservations =
      this.userSessionStartReservations.get(projectId) ?? new Map();
    reservations.set(sessionId, (reservations.get(sessionId) ?? 0) + 1);
    this.userSessionStartReservations.set(projectId, reservations);
    this.clearProjectTimer(projectId);

    let released = false;
    return () => {
      if (released) return;
      released = true;

      const current = this.userSessionStartReservations.get(projectId);
      const count = current?.get(sessionId);
      if (current && count !== undefined) {
        if (count > 1) {
          current.set(sessionId, count - 1);
        } else {
          current.delete(sessionId);
          if (current.size === 0) {
            this.userSessionStartReservations.delete(projectId);
          }
        }
      }
      this.scheduleProjectIfDispatchable(projectId);
    };
  }

  async getProjectIdleStatus(
    projectId: UrlProjectId,
  ): Promise<ProjectIdleStatus> {
    // Project Queue ordering and UI semantics are documented in
    // topics/project-queue.md. In particular, per-session queues must drain
    // before a project-level queue item can promote.
    const status = await getProjectWorkIdleStatus(projectId, {
      supervisor: this.supervisor,
      externalTracker: this.externalTracker,
      getRecoveredPatientQueueCount: (candidateProjectId) =>
        this.getRecoveredPatientQueueCount(candidateProjectId),
    });
    const reservations = this.userSessionStartReservations.get(projectId);
    if (reservations) {
      for (const sessionId of reservations.keys()) {
        status.blockers.push(`${sessionId}:user-starting`);
      }
    }
    return { idle: status.blockers.length === 0, blockers: status.blockers };
  }

  async getProjectStatus(
    projectId: UrlProjectId,
  ): Promise<ProjectQueueProjectStatus> {
    const items = this.projectQueueService.listProject(projectId).items;
    const first = items[0];
    const dispatchState = this.projectQueueService.getDispatchState();
    const dispatchPaused = dispatchState.status === "paused";
    const inFlight = this.inFlight.has(projectId);
    const quietWindowMs = this.getIdleGraceMs();
    const timer = this.timers.get(projectId);

    if (!first) {
      return {
        projectId,
        state: "empty",
        idle: true,
        blockers: [],
        dispatchPaused,
        inFlight,
        quietWindowMs,
        itemCount: 0,
      };
    }

    const idle = await this.getProjectIdleStatus(projectId);
    const blockers = [...idle.blockers];
    if (first.status === "failed") {
      blockers.push("project-queue:first-failed");
    }
    if (
      first.target.type === "existing-session" &&
      this.options.isSessionAutomationPaused?.(first.target.sessionId)
    ) {
      blockers.push(`${first.target.sessionId}:automation-paused`);
    }

    const now = Date.now();
    const timerFields: Pick<
      ProjectQueueProjectStatus,
      "nextAttemptAt" | "quietStartedAt" | "quietEligibleAt"
    > = {};
    if (timer && timer.eligibleAtMs > now) {
      timerFields.nextAttemptAt = new Date(timer.eligibleAtMs).toISOString();
      if (timer.reason === "quiet" && idle.idle) {
        timerFields.quietStartedAt = new Date(
          timer.scheduledAtMs,
        ).toISOString();
        timerFields.quietEligibleAt = new Date(
          timer.eligibleAtMs,
        ).toISOString();
      }
    }

    const state: ProjectQueueProjectStatus["state"] = dispatchPaused
      ? "paused"
      : inFlight || first.status === "dispatching"
        ? "dispatching"
        : blockers.length > 0
          ? "blocked"
          : timerFields.quietEligibleAt
            ? "waiting-quiet"
            : "ready";

    return {
      projectId,
      state,
      idle: idle.idle && blockers.length === 0,
      blockers,
      dispatchPaused,
      inFlight,
      quietWindowMs,
      itemCount: items.length,
      nextItemId: first.id,
      ...timerFields,
    };
  }

  async promoteNow(
    projectId: UrlProjectId,
    options: PromoteNowOptions = {},
  ): Promise<ProjectQueuePromoteNowResult> {
    if (this.projectQueueService.isDispatchPaused()) {
      const projectItems =
        this.projectQueueService.listProject(projectId).items;
      const requestedItem = options.itemId
        ? projectItems.find((item) => item.id === options.itemId)
        : projectItems[0];
      if (requestedItem?.status === "queued") {
        await this.projectQueueService.resumeDispatch();
      }
    }
    this.clearProjectTimer(projectId);
    const result = await this.runProject(projectId, options);
    return {
      ...result,
      status: await this.getProjectStatus(projectId),
    };
  }

  private readonly handleEvent = (event: BusEvent): void => {
    if (this.disposed) {
      return;
    }
    switch (event.type) {
      case "project-queue-changed":
        if (
          event.reason === "created" ||
          event.reason === "updated" ||
          event.reason === "deleted" ||
          event.reason === "retry" ||
          event.reason === "resumed" ||
          event.reason === "released"
        ) {
          this.scheduleProjectIfDispatchable(event.projectId);
        } else if (
          !this.projectQueueService.hasDispatchableItem(event.projectId)
        ) {
          this.clearProjectTimer(event.projectId);
        }
        break;
      case "process-state-changed":
      case "session-status-changed":
      case "session-updated":
      case "queue-request-added":
        this.scheduleProjectIfDispatchable(event.projectId);
        break;
      case "session-created":
        this.scheduleProjectIfDispatchable(event.session.projectId);
        break;
      case "worker-activity-changed":
      case "queue-position-changed":
      case "queue-request-removed":
      case "session-queue-persistence-changed":
        this.scheduleAllDispatchableProjects();
        break;
    }
  };

  private getRecoveredPatientQueueCount(projectId: UrlProjectId): number {
    const service = this.options.sessionQueuePersistenceService;
    if (!service) return 0;
    return service
      .list()
      .filter(
        (item) =>
          item.projectId === projectId && isRecoveredPatientQueueItem(item),
      ).length;
  }

  private getIdleGraceMs(): number {
    const raw =
      this.fixedIdleGraceMs ??
      this.getConfiguredIdleGraceMs?.() ??
      DEFAULT_IDLE_GRACE_MS;
    return Number.isFinite(raw)
      ? Math.max(0, Math.round(raw))
      : DEFAULT_IDLE_GRACE_MS;
  }

  private scheduleAllDispatchableProjects(
    delayMs = this.getIdleGraceMs(),
    reason: ProjectQueueTimerReason = "quiet",
  ): void {
    if (this.disposed) {
      return;
    }
    const projectIds =
      this.projectQueueService.getProjectIdsWithDispatchableItems();
    for (const projectId of projectIds) {
      this.scheduleProject(projectId, delayMs, reason);
    }
  }

  private scheduleProjectIfDispatchable(
    projectId: UrlProjectId,
    delayMs = this.getIdleGraceMs(),
    reason: ProjectQueueTimerReason = "quiet",
  ): void {
    if (this.disposed) {
      return;
    }
    if (!this.projectQueueService.hasDispatchableItem(projectId)) {
      this.clearProjectTimer(projectId);
      return;
    }
    this.scheduleProject(projectId, delayMs, reason);
  }

  private scheduleProject(
    projectId: UrlProjectId,
    delayMs: number,
    reason: ProjectQueueTimerReason,
  ): void {
    if (this.disposed) {
      return;
    }
    if (this.inFlight.has(projectId)) return;
    this.clearProjectTimer(projectId);
    const scheduledAtMs = Date.now();
    const eligibleAtMs = scheduledAtMs + Math.max(0, Math.round(delayMs));
    const timer = setTimeout(
      () => {
        this.timers.delete(projectId);
        void this.runProject(projectId, { automatic: true });
      },
      Math.max(0, Math.round(delayMs)),
    );
    timer.unref?.();
    this.timers.set(projectId, {
      timer,
      reason,
      scheduledAtMs,
      eligibleAtMs,
    });
  }

  private clearProjectTimer(projectId: UrlProjectId): void {
    const state = this.timers.get(projectId);
    if (!state) return;
    clearTimeout(state.timer);
    this.timers.delete(projectId);
  }

  private scheduleBlockedProjectRetry(projectId: UrlProjectId): void {
    if (!this.projectQueueService.hasDispatchableItem(projectId)) return;
    const retryMs = Math.max(
      0,
      Math.round(
        this.options.blockedRetryMs ??
          Math.max(
            1_000,
            Math.min(
              BLOCKED_RETRY_MS,
              this.getIdleGraceMs() || BLOCKED_RETRY_MS,
            ),
          ),
      ),
    );
    this.scheduleProject(projectId, retryMs, "blocked-retry");
  }

  private hasRunnableQueuedItem(
    projectId: UrlProjectId,
    itemId: string | undefined,
  ): boolean {
    if (!itemId) return this.projectQueueService.hasDispatchableItem(projectId);
    const item = this.projectQueueService
      .listProject(projectId)
      .items.find((candidate) => candidate.id === itemId);
    return item?.status === "queued";
  }

  private async runProject(
    projectId: UrlProjectId,
    options: PromoteNowOptions = {},
  ): Promise<RunProjectResult> {
    const run = this.runProjectNow(projectId, options);
    this.inFlightRuns.add(run);
    run.then(
      () => this.inFlightRuns.delete(run),
      () => this.inFlightRuns.delete(run),
    );
    return run;
  }

  private async runProjectNow(
    projectId: UrlProjectId,
    options: PromoteNowOptions = {},
  ): Promise<RunProjectResult> {
    if (this.inFlight.has(projectId)) {
      return { promoted: false, reason: "in-flight" };
    }
    if (this.projectQueueService.getDispatchState().status === "paused") {
      this.clearProjectTimer(projectId);
      return { promoted: false, reason: "paused" };
    }
    const projectItems = this.projectQueueService.listProject(projectId).items;
    if (
      options.itemId &&
      !projectItems.some((item) => item.id === options.itemId)
    ) {
      return { promoted: false, reason: "not-found", itemId: options.itemId };
    }
    if (!this.hasRunnableQueuedItem(projectId, options.itemId)) {
      return {
        promoted: false,
        reason: projectItems.length === 0 ? "empty" : "not-queued",
        ...(options.itemId ? { itemId: options.itemId } : {}),
      };
    }

    const nextItem = options.itemId
      ? projectItems.find((item) => item.id === options.itemId)
      : projectItems.find((item) => item.status === "queued");
    if (
      options.automatic === true &&
      nextItem?.target.type === "existing-session" &&
      this.options.isSessionAutomationPaused?.(nextItem.target.sessionId)
    ) {
      return {
        promoted: false,
        reason: "blocked",
        itemId: nextItem.id,
      };
    }

    this.inFlight.add(projectId);
    let item: ProjectQueueItem | null = null;
    let retryBlockedProject = false;

    try {
      if (!options.force) {
        const idle = await this.getProjectIdleStatus(projectId);
        if (!idle.idle) {
          retryBlockedProject = true;
          return {
            promoted: false,
            reason: "blocked",
            ...(options.itemId ? { itemId: options.itemId } : {}),
          };
        }
      }

      item = await this.projectQueueService.claimDispatchableItem(
        projectId,
        options.itemId,
      );
      if (!item) return { promoted: false, reason: "empty" };

      if (!options.force) {
        const stillIdle = await this.getProjectIdleStatus(projectId);
        if (!stillIdle.idle) {
          await this.projectQueueService.releaseDispatchingItem(
            projectId,
            item.id,
          );
          retryBlockedProject = true;
          return { promoted: false, reason: "blocked", itemId: item.id };
        }
      }

      const result = await this.dispatchItem(item, options);
      if (!isQueuedResult(result) || item.target.type === "existing-session") {
        await this.projectQueueService.completeDispatch(projectId, item.id);
      }
      const sessionId =
        item.target.type === "existing-session"
          ? item.target.sessionId
          : isQueuedResult(result) || isQueueFullResult(result)
            ? undefined
            : result.sessionId;
      return {
        promoted: true,
        reason: "promoted",
        itemId: item.id,
        ...(sessionId ? { sessionId } : {}),
      };
    } catch (error) {
      const message = errorMessage(error);
      const retryable = error instanceof RetryableSessionLaunchError;
      let retryScheduled = false;
      if (item && retryable) {
        const updated =
          await this.projectQueueService.recordRetryableStartupFailure(
            projectId,
            item.id,
            message,
          );
        retryScheduled = updated?.status === "queued";
        retryBlockedProject = retryScheduled;
      } else if (item) {
        await this.projectQueueService.failDispatch(
          projectId,
          item.id,
          message,
        );
      }
      if (retryScheduled) {
        getLogger().info(
          { event: "project_queue_dispatch_retry", projectId, error: message },
          "Project queue provider startup will retry",
        );
      } else if (retryable) {
        getLogger().warn(
          {
            event: "project_queue_dispatch_retry_exhausted",
            projectId,
            error: message,
          },
          "Project queue item paused after repeated provider startup failures",
        );
      } else {
        getLogger().warn(
          { event: "project_queue_dispatch_failed", projectId, error: message },
          "Project queue dispatch failed",
        );
      }
      return {
        promoted: false,
        reason: retryScheduled ? "blocked" : "failed",
        ...(item ? { itemId: item.id } : {}),
        error: message,
      };
    } finally {
      this.inFlight.delete(projectId);
      if (retryBlockedProject && !this.disposed) {
        this.scheduleBlockedProjectRetry(projectId);
      }
    }
  }

  private async dispatchItem(
    item: ProjectQueueItem,
    options: PromoteNowOptions,
  ): Promise<ProjectQueueDispatchResult> {
    const permissionMode = item.message.mode ?? item.target.mode;
    const modelSettings = this.toModelSettings(item);
    const result =
      item.target.type === "existing-session"
        ? await this.dispatchExistingSessionItem(
            item,
            permissionMode,
            modelSettings,
            options.deliveryIntent,
          )
        : await this.dispatchNewSessionItem(
            item,
            permissionMode,
            modelSettings,
          );

    if (isQueueFullResult(result)) {
      throw new Error(`Worker queue is full (${result.maxQueueSize})`);
    }

    if (!isQueuedResult(result)) {
      await this.options.onSessionStarted?.({ item, process: result });
    }
    return result;
  }

  private async dispatchExistingSessionItem(
    item: ProjectQueueItem,
    permissionMode: PermissionMode | undefined,
    modelSettings: ModelSettings,
    deliveryIntent: PromoteNowOptions["deliveryIntent"],
  ): Promise<ProjectQueueDispatchResult> {
    if (item.target.type !== "existing-session") {
      throw new Error("Project queue item target changed during dispatch");
    }
    const stagedAttachments = await this.materializeStagedAttachments(
      item,
      item.target.sessionId,
    );
    return this.supervisor.resumeSession(
      item.target.sessionId,
      item.projectPath,
      this.toUserMessage(item, stagedAttachments, deliveryIntent),
      permissionMode,
      modelSettings,
    );
  }

  private async dispatchNewSessionItem(
    item: ProjectQueueItem,
    permissionMode: PermissionMode | undefined,
    modelSettings: ModelSettings,
  ): Promise<ProjectQueueDispatchResult> {
    if (!item.message.stagedAttachments) {
      let deferred = false;
      const result = await this.supervisor.startSession(
        item.projectPath,
        this.toUserMessage(item),
        permissionMode,
        modelSettings,
        {
          onStarted: async (sessionId) => {
            if (!deferred) return;
            await this.completeDeferredNewSessionDispatch(item, sessionId);
          },
          onFailed: async (reason) => {
            if (!deferred) return;
            await this.projectQueueService.failDispatch(
              item.projectId,
              item.id,
              reason,
            );
          },
          onRetryableFailure: async (reason) => {
            if (!deferred) return;
            await this.projectQueueService.recordRetryableStartupFailure(
              item.projectId,
              item.id,
              reason,
            );
          },
          retryProviderStartupFailure: true,
          requireProviderSessionId: true,
        },
      );
      deferred = isQueuedResult(result);
      return result;
    }

    const created = await this.supervisor.createSession(
      item.projectPath,
      permissionMode,
      modelSettings,
      { retryProviderStartupFailure: true },
    );
    if (isQueueFullResult(created)) {
      return created;
    }
    if (isQueuedResult(created)) {
      throw new Error(
        "Worker queue deferred a create-only session before staged attachments could be materialized",
      );
    }

    const stagedAttachments = await this.materializeStagedAttachments(
      item,
      created.sessionId,
    );
    return this.supervisor.resumeSession(
      created.sessionId,
      item.projectPath,
      this.toUserMessage(item, stagedAttachments),
      permissionMode,
      modelSettings,
      { requireProviderSessionId: true },
    );
  }

  private async completeDeferredNewSessionDispatch(
    item: ProjectQueueItem,
    sessionId: string,
  ): Promise<void> {
    const process = this.supervisor
      .getAllProcesses()
      .find((candidate) => candidate.sessionId === sessionId);
    if (process) {
      try {
        await this.options.onSessionStarted?.({ item, process });
      } catch (error) {
        getLogger().warn(
          {
            event: "project_queue_deferred_session_callback_failed",
            projectId: item.projectId,
            itemId: item.id,
            sessionId,
            error: errorMessage(error),
          },
          "Deferred Project Queue session started but its association callback failed",
        );
      }
    } else {
      getLogger().warn(
        {
          event: "project_queue_deferred_session_missing",
          projectId: item.projectId,
          itemId: item.id,
          sessionId,
        },
        "Deferred Project Queue session started without a registered process",
      );
    }
    await this.projectQueueService.completeDispatch(item.projectId, item.id);
  }

  private async materializeStagedAttachments(
    item: ProjectQueueItem,
    sessionId: string,
  ): Promise<UploadedFile[]> {
    const stagedAttachments = item.message.stagedAttachments;
    if (!stagedAttachments) {
      return [];
    }
    if (!this.options.attachmentStagingService) {
      throw new Error("Attachment staging service is unavailable");
    }
    return this.options.attachmentStagingService.materializeQueueAttachmentsForSession(
      {
        queueItemId: item.id,
        refs: stagedAttachments.refs,
        projectPath: item.projectPath,
        sessionId,
      },
    );
  }

  private toUserMessage(
    item: ProjectQueueItem,
    stagedAttachments: readonly UploadedFile[] = [],
    deliveryIntent?: PromoteNowOptions["deliveryIntent"],
  ): UserMessage {
    const attachments =
      item.message.attachments || stagedAttachments.length > 0
        ? [...(item.message.attachments ?? []), ...stagedAttachments]
        : undefined;
    return {
      text: item.message.text,
      automaticSource: "project-queue",
      ...(attachments ? { attachments } : {}),
      ...(item.message.mode ? { mode: item.message.mode } : {}),
      ...(item.message.metadata || deliveryIntent
        ? {
            metadata: {
              ...item.message.metadata,
              ...(deliveryIntent === "steer"
                ? { deliveryIntent: "steer" as const, steerNow: true }
                : {}),
            },
          }
        : {}),
    };
  }

  private toModelSettings(item: ProjectQueueItem): ModelSettings {
    const target = item.target;
    const thinkingConfig = target.thinking
      ? thinkingOptionToConfig(target.thinking, target.showThinking)
      : { thinking: undefined, effort: undefined };
    const globalInstructions = this.options.getGlobalInstructions?.();
    return {
      ...(target.model && target.model !== "default"
        ? { model: target.model }
        : {}),
      ...(target.model ? { requestedModel: target.model } : {}),
      ...(target.serviceTier ? { serviceTier: target.serviceTier } : {}),
      ...(thinkingConfig.thinking ? { thinking: thinkingConfig.thinking } : {}),
      ...(thinkingConfig.effort ? { effort: thinkingConfig.effort } : {}),
      ...(target.provider ? { providerName: target.provider } : {}),
      ...(target.executor ? { executor: target.executor } : {}),
      ...(target.type === "new-session" && target.sandboxLevel
        ? { sandboxLevel: target.sandboxLevel }
        : {}),
      ...(globalInstructions ? { globalInstructions } : {}),
    };
  }
}
