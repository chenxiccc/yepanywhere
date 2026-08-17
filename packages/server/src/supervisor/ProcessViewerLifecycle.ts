import type {
  SessionLivenessSnapshot,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import type { ProviderRetentionSnapshot } from "../sdk/types.js";
import { SessionViewerPresence } from "./SessionViewerPresence.js";
import type { ProcessState } from "./types.js";

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;
const IDLE_REAP_ELIGIBILITY_RECHECK_MS = 60_000;
const RUNTIME_VIEWER_PRESENCE_RETRY_INITIAL_MS = 100;
const RUNTIME_VIEWER_PRESENCE_RETRY_MAX_MS = 5_000;
const RUNTIME_VIEWER_PRESENCE_DETACH_GRACE_MS = 500;

type RuntimeViewerPresenceWaiter = {
  hasViewers: boolean;
  resolve: () => void;
};

export interface ProcessViewerLifecycleOptions {
  processId: string;
  projectId: UrlProjectId;
  getSessionId: () => string;
  startedAt: Date;
  initialState: ProcessState;
  idleTimeoutMs: number;
  shouldRetainIdleProcess?: (sessionId: string) => boolean;
  hasPromptCacheKeepaliveLease: () => boolean;
  getProviderRetention: () => ProviderRetentionSnapshot;
  getLivenessSnapshot: () => SessionLivenessSnapshot;
  getLiveDeltaSubscriberCount: () => number;
  getRuntimeUnviewedSince?: () => Date | undefined;
  setRuntimeViewerPresence?: (hasViewers: boolean) => void | Promise<void>;
  onIdleReap: () => void;
}

/**
 * Owns viewer retention, reload-safe viewer publication, idle eligibility,
 * and the transition into verified provider teardown for one Process.
 */
export class ProcessViewerLifecycle {
  private readonly viewerPresence: SessionViewerPresence;
  private releaseViewerPresenceSubscription: (() => void) | null = null;
  private state: ProcessState;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleDeadlineMs: number | null = null;
  private idleTimeoutMs: number;
  private unviewedSince: Date | null;
  private detachingForServerReload = false;
  private providerTeardownUnverified = false;
  private stopped = false;

  private desiredRuntimeViewerPresence: boolean | null = null;
  private acknowledgedRuntimeViewerPresence: boolean | null = null;
  private runtimeViewerPresenceInFlight: Promise<void> | null = null;
  private runtimeViewerPresenceRetryTimer: ReturnType<
    typeof setTimeout
  > | null = null;
  private runtimeViewerPresenceRetryAttempt = 0;
  private runtimeViewerPresencePublicationStopped = false;
  private runtimeViewerPresenceWaiters = new Set<RuntimeViewerPresenceWaiter>();

  constructor(private readonly options: ProcessViewerLifecycleOptions) {
    this.state = options.initialState;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.viewerPresence = new SessionViewerPresence();
    this.unviewedSince = this.viewerPresence.hasViewers()
      ? null
      : options.startedAt;
    this.releaseViewerPresenceSubscription = this.viewerPresence.subscribe(
      (hasViewers) => this.viewerPresenceChanged(hasViewers),
    );
    if (this.viewerPresence.hasViewers()) {
      this.recordRuntimeViewerPresence(true);
    }
    if (this.state.type === "idle") {
      this.restartIdleGrace();
    }
  }

  get hasUnverifiedProviderOwnership(): boolean {
    return this.providerTeardownUnverified;
  }

  get isDetachingForServerReload(): boolean {
    return this.detachingForServerReload;
  }

  hasViewers(): boolean {
    return this.viewerPresence.hasViewers();
  }

  registerViewer(): () => void {
    return this.viewerPresence.registerViewer();
  }

  observeProcessState(state: ProcessState): void {
    this.state = state;
    if (state.type === "idle") {
      this.restartIdleGrace();
    } else {
      this.clearIdleDeadline();
    }
  }

  suspendIdleDeadline(): void {
    this.clearIdleDeadline();
  }

  retentionChanged(): void {
    if (this.state.type === "idle") {
      this.restartIdleGrace();
    }
  }

  updateIdleTimeoutMs(idleTimeoutMs: number): void {
    this.idleTimeoutMs = idleTimeoutMs;
    if (this.state.type === "idle") {
      this.rescheduleCurrentIdlePeriod();
    }
  }

  beginTeardownVerification(): void {
    this.providerTeardownUnverified = true;
    this.clearIdleDeadline();
  }

  completeTeardownVerification(): void {
    this.providerTeardownUnverified = false;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearIdleDeadline();
    this.stopRuntimeViewerPresencePublication();
    this.releaseViewerPresence();
  }

  async prepareForServerReload(): Promise<void> {
    this.detachingForServerReload = true;
    this.clearIdleDeadline();
    this.releaseViewerPresence();
    this.unviewedSince = new Date();
    this.recordRuntimeViewerPresence(false);
    try {
      await withTimeout(
        this.waitForRuntimeViewerPresence(false),
        RUNTIME_VIEWER_PRESENCE_DETACH_GRACE_MS,
        "Timed out publishing no-viewer state before provider detach",
      );
    } catch (error) {
      getLogger().warn(
        {
          event: "runtime_viewer_presence_detach_unconfirmed",
          sessionId: this.options.getSessionId(),
          processId: this.options.processId,
          projectId: this.options.projectId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Proceeding with provider detach without confirmed viewer state",
      );
    } finally {
      this.stopped = true;
      this.stopRuntimeViewerPresencePublication();
    }
  }

  private restartIdleGrace(delayMs = this.idleTimeoutMs): void {
    this.clearIdleDeadline();
    if (!this.shouldScheduleIdleReapCheck()) return;
    this.idleDeadlineMs = Date.now() + Math.max(0, delayMs);
    this.armIdleTimer();
  }

  private armIdleTimer(): void {
    const deadlineMs = this.idleDeadlineMs;
    if (deadlineMs === null || !this.shouldScheduleIdleReapCheck()) {
      this.clearIdleDeadline();
      return;
    }
    const delayMs = Math.min(
      MAX_NODE_TIMER_DELAY_MS,
      Math.max(0, deadlineMs - Date.now()),
    );
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.idleDeadlineMs !== deadlineMs) return;
      if (Date.now() < deadlineMs) {
        this.armIdleTimer();
        return;
      }
      this.idleDeadlineMs = null;

      if (!this.isIdleReapEligible()) {
        const providerRetention = this.options.getProviderRetention();
        getLogger().debug(
          {
            event: "idle_cleanup_deferred",
            sessionId: this.options.getSessionId(),
            processId: this.options.processId,
            projectId: this.options.projectId,
            idleTimeoutMs: this.idleTimeoutMs,
            viewerCount: this.viewerPresence.getViewerCount(),
            liveDeltaSubscriberCount:
              this.options.getLiveDeltaSubscriberCount(),
            retainedByFeature:
              this.options.shouldRetainIdleProcess?.(
                this.options.getSessionId(),
              ) ?? false,
            retainedByPromptCacheKeepalive:
              this.options.hasPromptCacheKeepaliveLease(),
            retainedByProvider: providerRetention.retained,
            providerRetentionReasons: providerRetention.reasons,
            providerBackgroundTaskCount: providerRetention.backgroundTaskCount,
            providerSessionCronCount: providerRetention.sessionCronCount,
            providerLiveTaskCount: providerRetention.liveTaskCount,
          },
          `Idle cleanup deferred: ${this.options.getSessionId()} is not currently eligible`,
        );
        this.restartIdleGrace(IDLE_REAP_ELIGIBILITY_RECHECK_MS);
        return;
      }

      this.providerTeardownUnverified = true;
      this.options.onIdleReap();
    }, delayMs);
    this.idleTimer.unref?.();
  }

  private rescheduleCurrentIdlePeriod(): void {
    if (this.state.type !== "idle" || !this.shouldScheduleIdleReapCheck()) {
      this.clearIdleDeadline();
      return;
    }
    const runtimeUnviewedSinceMs = this.options
      .getRuntimeUnviewedSince?.()
      ?.getTime();
    const localUnviewedSinceMs = this.unviewedSince?.getTime();
    const effectiveUnviewedSinceMs =
      runtimeUnviewedSinceMs !== undefined &&
      Number.isFinite(runtimeUnviewedSinceMs) &&
      localUnviewedSinceMs !== undefined
        ? Math.min(runtimeUnviewedSinceMs, localUnviewedSinceMs)
        : (runtimeUnviewedSinceMs ?? localUnviewedSinceMs);
    const eligibleSinceMs = Math.max(
      this.state.since.getTime(),
      effectiveUnviewedSinceMs ?? this.state.since.getTime(),
    );
    this.restartIdleGrace(
      Math.max(0, this.idleTimeoutMs - (Date.now() - eligibleSinceMs)),
    );
  }

  private isIdleReapEligible(): boolean {
    if (
      !this.shouldScheduleIdleReapCheck() ||
      this.options.shouldRetainIdleProcess?.(this.options.getSessionId()) ===
        true ||
      this.options.hasPromptCacheKeepaliveLease() ||
      this.options.getProviderRetention().retained
    ) {
      return false;
    }
    return this.options.getLivenessSnapshot().derivedStatus === "verified-idle";
  }

  private shouldScheduleIdleReapCheck(): boolean {
    return (
      !this.stopped &&
      this.idleTimeoutMs >= 0 &&
      this.state.type === "idle" &&
      !this.hasViewers() &&
      !this.detachingForServerReload &&
      !this.providerTeardownUnverified
    );
  }

  private clearIdleDeadline(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.idleDeadlineMs = null;
  }

  private viewerPresenceChanged(hasViewers: boolean): void {
    this.unviewedSince = hasViewers ? null : new Date();
    this.recordRuntimeViewerPresence(hasViewers);
    if (hasViewers) {
      this.clearIdleDeadline();
    } else if (this.state.type === "idle") {
      this.restartIdleGrace();
    }
  }

  private releaseViewerPresence(): void {
    this.releaseViewerPresenceSubscription?.();
    this.releaseViewerPresenceSubscription = null;
  }

  private recordRuntimeViewerPresence(hasViewers: boolean): void {
    if (
      !this.options.setRuntimeViewerPresence ||
      this.runtimeViewerPresencePublicationStopped
    ) {
      return;
    }
    if (this.desiredRuntimeViewerPresence !== hasViewers) {
      this.desiredRuntimeViewerPresence = hasViewers;
      this.runtimeViewerPresenceRetryAttempt = 0;
      this.clearRuntimeViewerPresenceRetryTimer();
      this.settleRuntimeViewerPresenceWaiters();
    }
    this.reconcileRuntimeViewerPresence();
  }

  private reconcileRuntimeViewerPresence(): void {
    const update = this.options.setRuntimeViewerPresence;
    const desired = this.desiredRuntimeViewerPresence;
    if (
      !update ||
      desired === null ||
      this.runtimeViewerPresencePublicationStopped ||
      this.runtimeViewerPresenceInFlight
    ) {
      return;
    }
    if (this.acknowledgedRuntimeViewerPresence === desired) {
      this.settleRuntimeViewerPresenceWaiters();
      return;
    }

    const publication = Promise.resolve().then(() => update(desired));
    this.runtimeViewerPresenceInFlight = publication;
    void publication
      .then(
        () => {
          if (!this.runtimeViewerPresencePublicationStopped) {
            this.acknowledgedRuntimeViewerPresence = desired;
            this.runtimeViewerPresenceRetryAttempt = 0;
          }
        },
        (error: unknown) => {
          if (this.runtimeViewerPresencePublicationStopped) return;
          if (this.desiredRuntimeViewerPresence === desired) {
            this.runtimeViewerPresenceRetryAttempt += 1;
          }
          getLogger().warn(
            {
              event: "runtime_viewer_presence_update_failed",
              sessionId: this.options.getSessionId(),
              processId: this.options.processId,
              projectId: this.options.projectId,
              hasViewers: desired,
              error: error instanceof Error ? error.message : String(error),
            },
            "Failed to update reload-safe runtime viewer presence",
          );
        },
      )
      .finally(() => {
        if (this.runtimeViewerPresenceInFlight === publication) {
          this.runtimeViewerPresenceInFlight = null;
        }
        if (this.runtimeViewerPresencePublicationStopped) return;
        if (this.desiredRuntimeViewerPresence !== desired) {
          this.reconcileRuntimeViewerPresence();
        } else if (this.acknowledgedRuntimeViewerPresence !== desired) {
          this.scheduleRuntimeViewerPresenceRetry();
        } else {
          this.settleRuntimeViewerPresenceWaiters();
        }
      });
  }

  private scheduleRuntimeViewerPresenceRetry(): void {
    if (
      this.runtimeViewerPresencePublicationStopped ||
      this.runtimeViewerPresenceRetryTimer ||
      this.desiredRuntimeViewerPresence === null
    ) {
      return;
    }
    const exponent = Math.min(
      Math.max(0, this.runtimeViewerPresenceRetryAttempt - 1),
      30,
    );
    const delayMs = Math.min(
      RUNTIME_VIEWER_PRESENCE_RETRY_INITIAL_MS * 2 ** exponent,
      RUNTIME_VIEWER_PRESENCE_RETRY_MAX_MS,
    );
    this.runtimeViewerPresenceRetryTimer = setTimeout(() => {
      this.runtimeViewerPresenceRetryTimer = null;
      this.reconcileRuntimeViewerPresence();
    }, delayMs);
    this.runtimeViewerPresenceRetryTimer.unref?.();
  }

  private clearRuntimeViewerPresenceRetryTimer(): void {
    if (this.runtimeViewerPresenceRetryTimer) {
      clearTimeout(this.runtimeViewerPresenceRetryTimer);
      this.runtimeViewerPresenceRetryTimer = null;
    }
  }

  private waitForRuntimeViewerPresence(hasViewers: boolean): Promise<void> {
    if (
      !this.options.setRuntimeViewerPresence ||
      this.runtimeViewerPresencePublicationStopped ||
      (this.desiredRuntimeViewerPresence === hasViewers &&
        this.acknowledgedRuntimeViewerPresence === hasViewers &&
        !this.runtimeViewerPresenceInFlight)
    ) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.runtimeViewerPresenceWaiters.add({ hasViewers, resolve });
    });
  }

  private settleRuntimeViewerPresenceWaiters(): void {
    const desired = this.desiredRuntimeViewerPresence;
    for (const waiter of this.runtimeViewerPresenceWaiters) {
      const superseded = waiter.hasViewers !== desired;
      const acknowledged =
        !this.runtimeViewerPresenceInFlight &&
        waiter.hasViewers === desired &&
        waiter.hasViewers === this.acknowledgedRuntimeViewerPresence;
      if (
        this.runtimeViewerPresencePublicationStopped ||
        superseded ||
        acknowledged
      ) {
        this.runtimeViewerPresenceWaiters.delete(waiter);
        waiter.resolve();
      }
    }
  }

  private stopRuntimeViewerPresencePublication(): void {
    if (this.runtimeViewerPresencePublicationStopped) return;
    this.runtimeViewerPresencePublicationStopped = true;
    this.clearRuntimeViewerPresenceRetryTimer();
    this.settleRuntimeViewerPresenceWaiters();
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
