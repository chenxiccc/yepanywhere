import type { Message } from "../../types";
import type {
  SessionRouteScrollSnapshot,
  SessionRouteSnapshot,
} from "../sessionRouteSnapshots";
import type {
  GetSessionInput,
  GetSessionMetadataResult,
  GetSessionResult,
  YaSourceRuntime,
} from "../sourceRuntime";
import type { ProviderRuntimeStatusSnapshot } from "../clientSummaryCollections";
import {
  getActiveWindowStructuralKind,
  planActiveWindowTrim,
  shouldConsiderActiveWindowTrim,
  type ActiveWindowTrimCandidate,
  type ActiveWindowTrimPlanner,
} from "./activeWindowTrimPolicy";
import {
  createSessionLoadProgress,
  createSessionLoadProgressForWindow,
  type SessionLoadProgress,
  type SessionLoadProgressStage,
} from "./loadProgress";
import {
  selectSessionDetailActiveWindowTrimRevision,
  selectSessionDetailMessages,
  selectSessionDetailPagination,
  selectSessionDetailRuntimeSnapshot,
} from "./selectors";
import {
  buildSessionDetailRevealSnapshot,
  getCacheableSessionDetailRevealSnapshot,
  type SessionDetailRevealSnapshotFallback,
  type SessionDetailRevealSnapshotResult,
} from "./revealSnapshot";
import type { SessionDetailEntryKeyInput } from "./sessionDetailKey";
import { getSessionDetailEntryKey } from "./sessionDetailKey";
import {
  bufferSessionDetailStreamMessage,
  bufferSessionDetailStreamSubagentMessage,
  createSessionDetailStreamBuffer,
  drainSessionDetailStreamBuffer,
  resetSessionDetailStreamBuffer,
} from "./streamBuffer";
import type { SessionDetailAction, SessionDetailState } from "./types";
import type {
  SessionDetailEquality,
  SessionDetailSelector,
} from "./sessionDetailEntryStore";

type SessionDetailReadSelector<T> = (state: SessionDetailState) => T;

export interface SessionDetailCoordinatorInput {
  entryKey: SessionDetailEntryKeyInput;
  runtime: YaSourceRuntime;
  activeWindowTrim?: SessionDetailActiveWindowTrimRuntime;
}

export interface SessionDetailActiveWindowTrimRuntime {
  enabled: boolean | (() => boolean);
  nowMs?: () => number;
  planner?: ActiveWindowTrimPlanner;
}

export interface SessionDetailApplyStreamMessageOptions {
  fromBufferedReplay?: boolean;
  streamingEnabled?: boolean;
}

export interface SessionDetailStreamProcessors {
  processMessage(message: Message, fromBufferedReplay?: boolean): void;
  processSubagentMessage(message: Message, agentId: string): void;
}

export interface SessionDetailBeginInitialLoadOptions {
  warmSnapshot?: SessionRouteSnapshot;
}

export interface SessionDetailRouteSnapshotReadPolicy {
  enabled: boolean;
}

export interface SessionDetailRouteSnapshotWritePolicy {
  enabled: boolean;
  retainScrollSnapshot: boolean;
}

export interface SessionDetailCurrentRouteSnapshotWritePolicy
  extends SessionDetailRouteSnapshotWritePolicy {
  scrollSnapshot?: SessionRouteScrollSnapshot;
}

export interface SessionDetailInitialLoadLifecycle {
  readonly restoredFromSnapshot: boolean;
  completeReveal(processors: SessionDetailStreamProcessors): boolean;
}

export interface SessionDetailWarmRefreshOptions {
  warmSnapshot?: SessionRouteSnapshot;
  initialAfterMessageId?: string;
}

export interface SessionDetailIncrementalRefreshOptions {
  afterMessageId?: string;
}

export interface SessionDetailAppliedWarmRefresh {
  messageCount: number;
  pagination: GetSessionResult["pagination"];
  sourceMessageCount: number;
}

export interface SessionDetailAppliedIncrementalRefresh
  extends SessionDetailAppliedWarmRefresh {
  applied: boolean;
}

export type SessionDetailOlderPageRequest =
  | { requested: false }
  | { requested: true; input: GetSessionInput };

export type SessionDetailAppliedOlderPage = SessionDetailAppliedWarmRefresh;

export type SessionDetailAppliedInitialLoad = SessionDetailAppliedWarmRefresh;

export interface SessionDetailLoadProgressOptions {
  nowMs?: number;
}

export interface SessionDetailRouteSnapshotLoadProgressOptions
  extends SessionDetailLoadProgressOptions {
  messageCount?: number;
}

export interface SessionDetailRestoredPerfOptions {
  restoredFromSnapshot?: boolean;
}

export interface SessionDetailDataReadyPerfOptions
  extends SessionDetailRestoredPerfOptions {
  appliedAfterSnapshotHydration?: boolean;
}

export interface SessionDetailMessagesQueuedPerfOptions
  extends SessionDetailRestoredPerfOptions {
  snapshot: SessionRouteSnapshot;
  sourceMessageCount: number;
  provider?: string;
}

export interface SessionDetailInitialRevealCompletionInput
  extends SessionDetailMessagesQueuedPerfOptions,
    SessionDetailLoadProgressOptions {}

export interface SessionDetailInitialRevealCompletion {
  snapshot: SessionRouteSnapshot;
  messagesQueuedPerfDetail: Record<string, unknown>;
  loadCompleteProgress: SessionLoadProgress;
  loadCompletePerfDetail: Record<string, unknown>;
}

export interface SessionDetailLoadCompleteResult {
  session: GetSessionResult["session"];
  status: GetSessionResult["ownership"];
  pendingInputRequest?: GetSessionResult["pendingInputRequest"];
  slashCommands?: GetSessionResult["slashCommands"];
  deferredMessages?: GetSessionResult["deferredMessages"];
}

export type SessionDetailProviderRuntimeStatusInput =
  | Pick<GetSessionResult, "providerRuntimeStatus">
  | Pick<GetSessionMetadataResult, "providerRuntimeStatus">;

export type SessionDetailRevealSnapshotInput = Omit<
  SessionDetailRevealSnapshotFallback,
  "maxPersistedTimestampMs"
>;

export class SessionDetailCoordinator {
  readonly entryKey: SessionDetailEntryKeyInput;
  readonly runtime: YaSourceRuntime;

  private readonly streamBuffer = createSessionDetailStreamBuffer();
  private initialLoadComplete = false;
  private initialLoadEpoch = 0;
  private fetchNewMessagesInFlight: Promise<void> | null = null;
  private fetchNewMessagesPendingTask: (() => Promise<void>) | null = null;
  private readonly activeWindowTrimEnabled: () => boolean;
  private readonly activeWindowTrimNowMs: () => number;
  private readonly activeWindowTrimPlanner: ActiveWindowTrimPlanner;
  private codexStreamDurableIdAlignment = false;
  private activeWindowFollowingBottom = false;
  private activeWindowHistoryExpanded = false;
  private activeWindowStructuralRevision = 0;
  private activeWindowLastEvaluatedStructuralRevision = 0;
  private activeWindowPendingCandidate: ActiveWindowTrimCandidate | undefined;

  constructor({
    entryKey,
    runtime,
    activeWindowTrim,
  }: SessionDetailCoordinatorInput) {
    this.entryKey = entryKey;
    this.runtime = runtime;
    this.activeWindowTrimEnabled =
      typeof activeWindowTrim?.enabled === "function"
        ? activeWindowTrim.enabled
        : () => activeWindowTrim?.enabled === true;
    this.activeWindowTrimNowMs = activeWindowTrim?.nowMs ?? Date.now;
    this.activeWindowTrimPlanner =
      activeWindowTrim?.planner ?? planActiveWindowTrim;
  }

  get sourceKey() {
    return this.runtime.sourceKey;
  }

  get entryKeyString() {
    return getSessionDetailEntryKey(this.entryKey);
  }

  get api() {
    return this.runtime.api;
  }

  get cache() {
    return this.runtime.sessionDetails.cache;
  }

  beginInitialLoad(
    options: SessionDetailBeginInitialLoadOptions = {},
  ): SessionDetailInitialLoadLifecycle {
    const epoch = this.resetForInitialLoad();
    return {
      restoredFromSnapshot: Boolean(options.warmSnapshot),
      completeReveal: (processors) =>
        this.completeInitialReveal(epoch, processors),
    };
  }

  private resetForInitialLoad(): number {
    this.initialLoadEpoch += 1;
    this.initialLoadComplete = false;
    resetSessionDetailStreamBuffer(this.streamBuffer);
    return this.initialLoadEpoch;
  }

  dispatch(action: SessionDetailAction): SessionDetailState | undefined {
    return this.cache.dispatch(this.entryKey, {
      ...action,
      codexStreamDurableIdAlignment: this.codexStreamDurableIdAlignment,
    });
  }

  setCodexStreamDurableIdAlignment(aligned: boolean): void {
    this.codexStreamDurableIdAlignment = aligned;
  }

  applyStreamMessage(
    message: Message,
    options: SessionDetailApplyStreamMessageOptions = {},
  ): SessionDetailState | undefined {
    return this.dispatchTranscriptAction(
      {
        type: "applyStreamMessage",
        message,
        fromBufferedReplay: options.fromBufferedReplay,
        streamingEnabled: options.streamingEnabled,
      },
      { structuralMessages: [message] },
    );
  }

  setActiveWindowFollowingBottom(followingBottom: boolean): void {
    if (this.activeWindowFollowingBottom === followingBottom) {
      return;
    }
    this.activeWindowFollowingBottom = followingBottom;
    if (followingBottom) {
      this.maybeTrimActiveWindow(false);
    }
  }

  suppressActiveWindowTrimForHistoryExpansion(): void {
    this.activeWindowHistoryExpanded = true;
    this.activeWindowPendingCandidate = undefined;
  }

  readSelected<T>(selector: SessionDetailReadSelector<T>): T | undefined {
    return this.cache.readSelected(this.entryKey, selector);
  }

  readRouteSnapshot(): SessionRouteSnapshot | undefined {
    return this.cache.readRouteSnapshot(this.entryKey);
  }

  writeRouteSnapshot(snapshot: SessionRouteSnapshot): boolean {
    return this.cache.writeRouteSnapshot(this.entryKey, snapshot);
  }

  readInitialRouteSnapshot(
    policy: SessionDetailRouteSnapshotReadPolicy,
  ): SessionRouteSnapshot | undefined {
    if (!policy.enabled) {
      return undefined;
    }
    return this.readRouteSnapshot();
  }

  writeInitialRouteSnapshot(
    snapshot: SessionRouteSnapshot,
    policy: SessionDetailRouteSnapshotWritePolicy,
  ): boolean {
    if (!policy.enabled) {
      return false;
    }
    return this.writeRouteSnapshot({
      ...snapshot,
      scrollSnapshot: policy.retainScrollSnapshot
        ? snapshot.scrollSnapshot
        : undefined,
    });
  }

  writeCurrentRouteSnapshot({
    scrollSnapshot,
    ...policy
  }: SessionDetailCurrentRouteSnapshotWritePolicy): boolean {
    if (!policy.enabled) {
      return false;
    }
    const snapshot = this.readRouteSnapshot();
    if (!snapshot) {
      return false;
    }
    return this.writeInitialRouteSnapshot(
      {
        ...snapshot,
        scrollSnapshot,
      },
      policy,
    );
  }

  cleanupCurrentRouteSnapshot(
    policy: SessionDetailCurrentRouteSnapshotWritePolicy,
  ): boolean {
    if (this.writeCurrentRouteSnapshot(policy)) {
      return true;
    }
    this.deleteEntry();
    return false;
  }

  replaceRouteSnapshot(snapshot: SessionRouteSnapshot): boolean {
    const replaced = this.cache.replaceRouteSnapshot(this.entryKey, snapshot);
    if (replaced) {
      this.invalidateActiveWindowStructure();
      this.maybeTrimActiveWindow(false);
    }
    return replaced;
  }

  resetEntryState(): void {
    this.cache.resetEntryState(this.entryKey);
    this.invalidateActiveWindowStructure();
  }

  retain(): () => void {
    return this.cache.retain(this.entryKey);
  }

  subscribe<T>(
    selector: SessionDetailSelector<T>,
    listener: () => void,
    equality?: SessionDetailEquality<T>,
  ): () => void {
    return this.cache.subscribe(this.entryKey, selector, listener, equality);
  }

  readScrollSnapshot(): SessionRouteScrollSnapshot | undefined {
    return this.cache.readScrollSnapshot(this.entryKey);
  }

  patchScrollSnapshot(snapshot: SessionRouteScrollSnapshot): void {
    this.cache.patchScrollSnapshot(this.entryKey, snapshot);
  }

  deleteEntry(): boolean {
    return this.cache.deleteEntry(this.entryKey);
  }

  getEntryApproxBytes(): number | undefined {
    return this.cache
      .getStats()
      .entries.find((entry) => entry.key === this.entryKeyString)?.approxBytes;
  }

  buildLoadProgress(
    stage: SessionLoadProgressStage,
    options: SessionDetailLoadProgressOptions = {},
  ): SessionLoadProgress {
    return createSessionLoadProgress(stage, {}, options.nowMs);
  }

  buildDataLoadProgress(
    stage: SessionLoadProgressStage,
    data: GetSessionResult,
    options: SessionDetailLoadProgressOptions = {},
  ): SessionLoadProgress {
    return createSessionLoadProgressForWindow(stage, {
      messageCount: data.messages.length,
      pagination: data.pagination,
      nowMs: options.nowMs,
    });
  }

  buildAppliedLoadProgress(
    stage: SessionLoadProgressStage,
    applied: SessionDetailAppliedWarmRefresh,
    options: SessionDetailLoadProgressOptions = {},
  ): SessionLoadProgress {
    return createSessionLoadProgressForWindow(stage, {
      messageCount: applied.messageCount,
      pagination: applied.pagination,
      nowMs: options.nowMs,
    });
  }

  buildRouteSnapshotLoadProgress(
    stage: SessionLoadProgressStage,
    snapshot: SessionRouteSnapshot,
    options: SessionDetailRouteSnapshotLoadProgressOptions = {},
  ): SessionLoadProgress {
    return createSessionLoadProgressForWindow(stage, {
      messageCount: options.messageCount ?? snapshot.messages.length,
      pagination: snapshot.pagination,
      nowMs: options.nowMs,
    });
  }

  buildInitialLoadDataReadyPerfDetail(
    data: GetSessionResult,
    options: SessionDetailDataReadyPerfOptions = {},
  ): Record<string, unknown> {
    return {
      messages: data.messages.length,
      provider: data.session.provider,
      totalMessages: data.pagination?.totalMessageCount,
      hasOlderMessages: data.pagination?.hasOlderMessages,
      ...(options.restoredFromSnapshot && { restoredFromSnapshot: true }),
      ...(options.appliedAfterSnapshotHydration && {
        appliedAfterSnapshotHydration: true,
      }),
    };
  }

  buildInitialMessagesQueuedPerfDetail({
    snapshot,
    sourceMessageCount,
    provider,
    restoredFromSnapshot,
  }: SessionDetailMessagesQueuedPerfOptions): Record<string, unknown> {
    return {
      messages: sourceMessageCount,
      totalMessages: snapshot.messages.length,
      provider,
      ...(restoredFromSnapshot && { restoredFromSnapshot: true }),
    };
  }

  buildInitialLoadCompletePerfDetail(
    sourceMessageCount: number,
    options: SessionDetailRestoredPerfOptions = {},
  ): Record<string, unknown> {
    return {
      messages: sourceMessageCount,
      ...(options.restoredFromSnapshot && { restoredFromSnapshot: true }),
    };
  }

  buildInitialLoadErrorPerfDetail(
    error: unknown,
    options: SessionDetailRestoredPerfOptions = {},
  ): Record<string, unknown> {
    return {
      message: error instanceof Error ? error.message : String(error),
      ...(options.restoredFromSnapshot && { restoredFromSnapshot: true }),
    };
  }

  buildInitialRevealCompletion({
    snapshot,
    sourceMessageCount,
    provider,
    restoredFromSnapshot,
    nowMs,
  }: SessionDetailInitialRevealCompletionInput): SessionDetailInitialRevealCompletion {
    return {
      snapshot,
      messagesQueuedPerfDetail: this.buildInitialMessagesQueuedPerfDetail({
        snapshot,
        sourceMessageCount,
        provider,
        restoredFromSnapshot,
      }),
      loadCompleteProgress: this.buildRouteSnapshotLoadProgress(
        "complete",
        snapshot,
        { nowMs },
      ),
      loadCompletePerfDetail: this.buildInitialLoadCompletePerfDetail(
        sourceMessageCount,
        { restoredFromSnapshot },
      ),
    };
  }

  applyInitialLoad(data: GetSessionResult): SessionDetailAppliedInitialLoad {
    const sourceMessageCount = data.messages.length;
    this.dispatchTranscriptAction(
      {
        type: "loadPersistedTranscript",
        messages: data.messages,
        session: data.session,
        pagination: data.pagination,
      },
      { invalidateStructure: true },
    );
    return {
      messageCount: sourceMessageCount,
      pagination: data.pagination,
      sourceMessageCount,
    };
  }

  applyWarmRefresh(
    data: GetSessionResult,
    options: SessionDetailWarmRefreshOptions,
  ): SessionDetailAppliedWarmRefresh {
    const sourceMessageCount = data.messages.length;
    if (!options.warmSnapshot) {
      return {
        messageCount: sourceMessageCount,
        pagination: data.pagination,
        sourceMessageCount,
      };
    }

    if (options.initialAfterMessageId === undefined) {
      this.dispatchTranscriptAction(
        {
          type: "loadPersistedTranscript",
          messages: data.messages,
          session: data.session,
          pagination: data.pagination,
        },
        { invalidateStructure: true },
      );
      return {
        messageCount: sourceMessageCount,
        pagination: data.pagination,
        sourceMessageCount,
      };
    }

    if (data.pagination) {
      this.dispatchTranscriptAction(
        {
          type: "replaceTailWindow",
          messages: data.messages,
          session: data.session,
          pagination: data.pagination,
        },
        { invalidateStructure: true },
      );
      return {
        messageCount: sourceMessageCount,
        pagination: data.pagination,
        sourceMessageCount,
      };
    }

    this.dispatchTranscriptAction(
      {
        type: "applyCatchupMessages",
        session: data.session,
        messages: data.messages,
      },
      { structuralMessages: data.messages },
    );
    const merged = this.readSelected(selectSessionDetailRuntimeSnapshot);
    return {
      messageCount: merged?.messages.length ?? sourceMessageCount,
      pagination: merged?.pagination,
      sourceMessageCount,
    };
  }

  applyIncrementalRefresh(
    data: GetSessionResult,
    options: SessionDetailIncrementalRefreshOptions,
  ): SessionDetailAppliedIncrementalRefresh {
    const sourceMessageCount = data.messages.length;
    if (sourceMessageCount === 0) {
      const current = this.readSelected(selectSessionDetailRuntimeSnapshot);
      return {
        applied: false,
        messageCount: current?.messages.length ?? 0,
        pagination: current?.pagination,
        sourceMessageCount,
      };
    }

    if (options.afterMessageId !== undefined && data.pagination) {
      this.dispatchTranscriptAction(
        {
          type: "replaceTailWindow",
          messages: data.messages,
          session: data.session,
          pagination: data.pagination,
        },
        { invalidateStructure: true },
      );
      return {
        applied: true,
        messageCount: sourceMessageCount,
        pagination: data.pagination,
        sourceMessageCount,
      };
    }

    this.dispatchTranscriptAction(
      {
        type: "applyCatchupMessages",
        messages: data.messages,
        session: data.session,
        pagination: data.pagination,
      },
      { structuralMessages: data.messages },
    );
    const merged = this.readSelected(selectSessionDetailRuntimeSnapshot);
    return {
      applied: true,
      messageCount: merged?.messages.length ?? sourceMessageCount,
      pagination: merged?.pagination,
      sourceMessageCount,
    };
  }

  applyFullTailReconciliation(
    data: GetSessionResult,
  ): SessionDetailAppliedWarmRefresh {
    const sourceMessageCount = data.messages.length;
    this.dispatchTranscriptAction(
      {
        type: "replaceTailWindow",
        messages: data.messages,
        session: data.session,
        pagination: data.pagination,
      },
      { invalidateStructure: true },
    );
    return {
      messageCount: sourceMessageCount,
      pagination: data.pagination,
      sourceMessageCount,
    };
  }

  buildOlderPageRequest(): SessionDetailOlderPageRequest {
    const pagination = this.readSelected(selectSessionDetailPagination);
    if (!pagination?.hasOlderMessages || !pagination.truncatedBeforeMessageId) {
      return { requested: false };
    }
    return {
      requested: true,
      input: {
        projectId: this.entryKey.projectId,
        sessionId: this.entryKey.sessionId,
        tailCompactions: 2,
        beforeMessageId: pagination.truncatedBeforeMessageId,
      },
    };
  }

  applyOlderPage(data: GetSessionResult): SessionDetailAppliedOlderPage {
    const sourceMessageCount = data.messages.length;
    this.suppressActiveWindowTrimForHistoryExpansion();
    this.dispatch({
      type: "prependOlderMessages",
      messages: data.messages,
      pagination: data.pagination,
    });
    const merged = this.readSelected(selectSessionDetailRuntimeSnapshot);
    return {
      messageCount: merged?.messages.length ?? sourceMessageCount,
      pagination: merged?.pagination ?? data.pagination,
      sourceMessageCount,
    };
  }

  buildRevealSnapshot(
    fallback: SessionDetailRevealSnapshotInput,
  ): SessionDetailRevealSnapshotResult {
    const selected = this.readSelected(selectSessionDetailRuntimeSnapshot);
    return buildSessionDetailRevealSnapshot({
      selected: selected
        ? {
            ...selected,
            scrollSnapshot: this.readScrollSnapshot(),
          }
        : undefined,
      fallback: {
        ...fallback,
        maxPersistedTimestampMs:
          selected?.maxPersistedTimestampMs ?? Number.NEGATIVE_INFINITY,
      },
    });
  }

  getCacheableRevealSnapshot(
    reveal: SessionDetailRevealSnapshotResult,
  ): SessionRouteSnapshot | undefined {
    return getCacheableSessionDetailRevealSnapshot(reveal);
  }

  writeCacheableRevealSnapshot(
    reveal: SessionDetailRevealSnapshotResult,
    policy: SessionDetailRouteSnapshotWritePolicy,
  ): boolean {
    const cacheableSnapshot = this.getCacheableRevealSnapshot(reveal);
    if (!cacheableSnapshot) {
      return false;
    }
    return this.writeInitialRouteSnapshot(cacheableSnapshot, policy);
  }

  buildLoadCompleteResult(
    data: GetSessionResult,
  ): SessionDetailLoadCompleteResult {
    return {
      session: data.session,
      status: data.ownership,
      pendingInputRequest: data.pendingInputRequest,
      slashCommands: data.slashCommands,
      deferredMessages: data.deferredMessages,
    };
  }

  buildProviderRuntimeStatusSnapshot(
    data: SessionDetailProviderRuntimeStatusInput,
  ): ProviderRuntimeStatusSnapshot {
    return {
      sessionId: this.entryKey.sessionId,
      projectId: this.entryKey.projectId,
      providerRuntimeStatus: data.providerRuntimeStatus ?? null,
    };
  }

  private completeInitialReveal(
    epoch: number,
    processors: SessionDetailStreamProcessors,
  ): boolean {
    if (epoch !== this.initialLoadEpoch) {
      return false;
    }
    this.initialLoadComplete = true;
    this.flushBufferedStream(processors);
    return true;
  }

  handleStreamMessage(
    message: Message,
    processMessage: SessionDetailStreamProcessors["processMessage"],
  ): void {
    if (!this.initialLoadComplete) {
      bufferSessionDetailStreamMessage(this.streamBuffer, message);
      return;
    }
    processMessage(message);
  }

  handleStreamSubagentMessage(
    message: Message,
    agentId: string,
    processSubagentMessage: SessionDetailStreamProcessors["processSubagentMessage"],
  ): void {
    if (!this.initialLoadComplete) {
      bufferSessionDetailStreamSubagentMessage(
        this.streamBuffer,
        message,
        agentId,
      );
      return;
    }
    processSubagentMessage(message, agentId);
  }

  runExclusiveFetchNewMessages(task: () => Promise<void>): Promise<void> {
    if (this.fetchNewMessagesInFlight) {
      this.fetchNewMessagesPendingTask = task;
      return this.fetchNewMessagesInFlight;
    }

    let resolveRequest!: () => void;
    let rejectRequest!: (reason: unknown) => void;
    const request = new Promise<void>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    this.fetchNewMessagesInFlight = request;
    void this.drainFetchNewMessages(task).then(resolveRequest, rejectRequest);
    return request;
  }

  private async drainFetchNewMessages(
    initialTask: () => Promise<void>,
  ): Promise<void> {
    let nextTask: (() => Promise<void>) | null = initialTask;
    let firstError: unknown;
    let failed = false;

    while (nextTask) {
      const task = nextTask;
      this.fetchNewMessagesPendingTask = null;
      try {
        await task();
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
      nextTask = this.fetchNewMessagesPendingTask;
    }

    this.fetchNewMessagesInFlight = null;
    if (failed) throw firstError;
  }

  private flushBufferedStream(processors: SessionDetailStreamProcessors): void {
    const buffer = drainSessionDetailStreamBuffer(this.streamBuffer);
    for (const item of buffer) {
      if (item.type === "message") {
        processors.processMessage(item.message, true);
      } else {
        processors.processSubagentMessage(item.message, item.agentId);
      }
    }
  }

  private dispatchTranscriptAction(
    action: SessionDetailAction,
    change: {
      invalidateStructure?: boolean;
      structuralMessages?: readonly Message[];
    },
  ): SessionDetailState | undefined {
    const previousMessages = this.readSelected(selectSessionDetailMessages);
    const next = this.dispatch(action);
    if (!next || next.messages === previousMessages) {
      return next;
    }

    const completedTranscriptGrowth =
      next.messages.length > (previousMessages?.length ?? 0);
    if (change.invalidateStructure) {
      this.invalidateActiveWindowStructure();
    } else if (
      change.structuralMessages?.some(
        (message) => getActiveWindowStructuralKind(message) !== null,
      )
    ) {
      this.activeWindowStructuralRevision += 1;
      this.activeWindowPendingCandidate = undefined;
    }
    this.maybeTrimActiveWindow(completedTranscriptGrowth);
    return next;
  }

  private invalidateActiveWindowStructure(): void {
    this.activeWindowStructuralRevision += 1;
    this.activeWindowPendingCandidate = undefined;
  }

  private maybeTrimActiveWindow(completedTranscriptGrowth: boolean): void {
    const nowMs = this.activeWindowTrimNowMs();
    if (
      !shouldConsiderActiveWindowTrim({
        enabled: this.activeWindowTrimEnabled(),
        followingBottom: this.activeWindowFollowingBottom,
        historyExpanded: this.activeWindowHistoryExpanded,
        tailFrom: this.entryKey.tailFrom,
        structuralRevision: this.activeWindowStructuralRevision,
        lastEvaluatedStructuralRevision:
          this.activeWindowLastEvaluatedStructuralRevision,
        completedTranscriptGrowth,
        pendingCandidateEligibleAfterMs:
          this.activeWindowPendingCandidate?.eligibleAfterMs,
        nowMs,
      })
    ) {
      return;
    }

    const pendingCandidate = this.activeWindowPendingCandidate;
    if (
      this.activeWindowStructuralRevision ===
        this.activeWindowLastEvaluatedStructuralRevision &&
      pendingCandidate &&
      nowMs > pendingCandidate.eligibleAfterMs
    ) {
      this.activeWindowPendingCandidate = undefined;
      this.dispatchActiveWindowTrim(pendingCandidate, nowMs);
      return;
    }

    const messages = this.readSelected(selectSessionDetailMessages);
    if (!messages) {
      return;
    }
    const result = this.activeWindowTrimPlanner({
      messages,
      nowMs,
      tailTurns: this.entryKey.tailTurns,
    });
    this.activeWindowLastEvaluatedStructuralRevision =
      this.activeWindowStructuralRevision;
    this.activeWindowPendingCandidate =
      result.kind === "deferred" ? result.candidate : undefined;
    if (result.kind === "ready") {
      this.dispatchActiveWindowTrim(result.candidate, nowMs);
    }
  }

  private dispatchActiveWindowTrim(
    candidate: ActiveWindowTrimCandidate,
    nowMs: number,
  ): void {
    const previousRevision =
      this.readSelected(selectSessionDetailActiveWindowTrimRevision) ?? 0;
    const next = this.dispatch({
      type: "trimLoadedWindow",
      startMessageId: candidate.startMessageId,
      reason: candidate.reason,
      nowMs,
    });
    if (!next || next.activeWindowTrimRevision === previousRevision) {
      return;
    }

    const scrollSnapshot = this.readScrollSnapshot();
    if (scrollSnapshot) {
      const { anchor: _removedAnchor, ...retainedScrollSnapshot } =
        scrollSnapshot;
      this.patchScrollSnapshot({
        ...retainedScrollSnapshot,
        atBottom: true,
        updatedAtMs: nowMs,
      });
    }
  }
}

export function createSessionDetailCoordinator(
  input: SessionDetailCoordinatorInput,
): SessionDetailCoordinator {
  return new SessionDetailCoordinator(input);
}
