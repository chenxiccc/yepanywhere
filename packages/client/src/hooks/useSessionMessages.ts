import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { PaginationInfo } from "../api/client";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { getMessageId } from "../lib/mergeMessages";
import type { SessionDetailRevealSnapshotResult } from "../lib/sessionDetail/revealSnapshot";
import {
  buildReturnedToolUseToAgent,
  canRevealReturnedSessionDetail,
  createStoreBackedSessionDetailSelector,
  getReturnedAgentContent,
  getReturnedSessionMessages,
} from "../lib/sessionDetail/returnedDetail";
import type {
  SessionLoadProgress,
  SessionLoadProgressStage,
} from "../lib/sessionDetail/loadProgress";
import {
  createSessionDetailCoordinator,
  type SessionDetailCoordinator,
  type SessionDetailLoadCompleteResult,
  type SessionDetailRevealSnapshotInput,
} from "../lib/sessionDetail/sessionDetailCoordinator";
import { markReloadPerfPhase } from "../lib/diagnostics/reloadPerfProbe";
import {
  getSessionActiveWindowTrimEnabled,
  getSessionScrollBehaviorMode,
  getSessionTranscriptCacheEnabled,
  recordLastSessionTranscriptBytes,
} from "./useSessionPerformanceSettings";
import { getStreamingEnabled } from "./useStreamingEnabled";
import { shouldRetainSessionScrollMemory } from "../lib/sessionScrollBehavior";
import type { Message, SessionMetadata } from "../types";
import {
  isSessionDetailShadowDiagnosticsEnabled,
  reportSessionDetailStoreDivergence,
  type SessionDetailRuntimeStateInput,
} from "../lib/sessionDetail/shadowDiagnostics";
import {
  selectSessionDetailLastMessageId,
  selectSessionDetailRuntimeSnapshot,
  selectSessionDetailSession,
} from "../lib/sessionDetail/selectors";
import {
  clearDefaultSessionDetailMemoryCache,
  type SessionDetailEntryKeyInput,
} from "../lib/sessionDetail/sessionDetailStore";
import type { GetSessionResult } from "../lib/sourceRuntime";
import type {
  AgentContent,
  AgentContentMap,
  AgentContextUsage,
  SessionDetailAction,
} from "../lib/sessionDetail/types";
import type {
  SessionRouteScrollSnapshot,
  SessionRouteSnapshot,
} from "../lib/sessionRouteSnapshots";

/** Result from initial session load */
export type SessionLoadResult = SessionDetailLoadCompleteResult;
export type { AgentContent, AgentContentMap } from "../lib/sessionDetail/types";

const DEFAULT_INITIAL_TAIL_TURNS = 20;

export type SessionMetadataUpdate =
  | SessionMetadata
  | null
  | ((previous: SessionMetadata | null) => SessionMetadata | null);

export type { SessionLoadProgress, SessionLoadProgressStage };

/** Options for useSessionMessages */
export interface UseSessionMessagesOptions {
  projectId: string;
  sessionId: string;
  tailTurns?: number;
  tailFrom?: string;
  /** Enable opt-in progress paint yields for large initial transcript loads */
  detailedLoadingProgress?: boolean;
  /** Called when initial load completes with session data */
  onLoadComplete?: (result: SessionLoadResult) => void;
  /** Called on load error */
  onLoadError?: (error: Error) => void;
}

/** Result from useSessionMessages hook */
export interface UseSessionMessagesResult {
  /** Messages in the session */
  messages: Message[];
  /** Subagent content keyed by agentId */
  agentContent: AgentContentMap;
  /** Mapping from Task tool_use_id → agentId */
  toolUseToAgent: Map<string, string>;
  /** Whether initial load is in progress */
  loading: boolean;
  /** Fine-grained initial load progress for opt-in display */
  sessionLoadProgress: SessionLoadProgress;
  /** Session data from initial load */
  session: SessionMetadata | null;
  /** Apply session metadata updates through the session detail action layer */
  updateSession: (update: SessionMetadataUpdate) => void;
  /** Handle streaming content updates (for useStreamingContent) */
  handleStreamingUpdate: (message: Message, agentId?: string) => void;
  /** Handle stream message event (buffered until initial load completes) */
  handleStreamMessageEvent: (incoming: Message) => void;
  /** Handle stream subagent message event */
  handleStreamSubagentMessage: (incoming: Message, agentId: string) => void;
  /** Register toolUse → agent mapping */
  registerToolUseAgent: (toolUseId: string, agentId: string) => void;
  /** Merge loaded subagent content with any live content already seen */
  mergeLoadedAgentContent: (agentId: string, content: AgentContent) => void;
  /** Update agent context usage metadata */
  updateAgentContextUsage: (
    agentId: string,
    contextUsage: AgentContextUsage,
  ) => void;
  /** Remove transient streaming placeholder rows from a subagent */
  clearAgentStreamingPlaceholders: (agentId: string) => void;
  /** Remove transient streaming placeholder rows from the main transcript */
  clearStreamingPlaceholders: () => void;
  /** Remove a local optimistic self-send that the server accepted cancelling */
  removeUnconfirmedSelfSend: (tempId: string) => void;
  /** Fetch new messages incrementally (for file change events) */
  fetchNewMessages: () => Promise<void>;
  /** Fetch session metadata only */
  fetchSessionMetadata: () => Promise<void>;
  /** Pagination info from compact-boundary-based loading */
  pagination: PaginationInfo | undefined;
  /** Ephemeral render signal incremented after each accepted active-window trim. */
  activeWindowTrimRevision: number;
  /** Whether older messages are being loaded */
  loadingOlder: boolean;
  /** Load the next chunk of older messages */
  loadOlderMessages: () => Promise<void>;
  /** Retained scroll anchor from the last same-tab route visit */
  initialScrollSnapshot: SessionRouteScrollSnapshot | null;
  /** Update the retained scroll anchor without re-rendering this hook */
  updateRouteScrollSnapshot: (snapshot: SessionRouteScrollSnapshot) => void;
  /** Update active-window follow intent immediately, without snapshot debounce. */
  updateActiveWindowFollowingBottom: (followingBottom: boolean) => void;
  /** True when the initial render was hydrated from a retained route snapshot */
  restoredFromSnapshot: boolean;
}

function readSessionLoadCache(
  coordinator: SessionDetailCoordinator,
): SessionRouteSnapshot | undefined {
  return coordinator.readInitialRouteSnapshot({
    enabled:
      getSessionTranscriptCacheEnabled() && typeof window !== "undefined",
  });
}

export function __resetSessionLoadCacheForTest(): void {
  clearDefaultSessionDetailMemoryCache();
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function yieldForSessionLoadingProgressPaint(
  enabled: boolean | undefined,
): Promise<void> {
  if (!enabled) {
    return Promise.resolve();
  }

  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Hook for managing session messages with stream buffering.
 *
 * Handles:
 * - Initial REST load of messages
 * - Buffering stream messages until initial load completes
 * - Merging stream and JSONL messages
 * - Routing subagent messages to agentContent
 */
export function useSessionMessages(
  options: UseSessionMessagesOptions,
): UseSessionMessagesResult {
  const {
    projectId,
    sessionId,
    tailTurns,
    tailFrom,
    detailedLoadingProgress,
    onLoadComplete,
    onLoadError,
  } = options;
  const effectiveTailTurns =
    tailTurns ?? (tailFrom ? undefined : DEFAULT_INITIAL_TAIL_TURNS);
  const runtime = useCurrentSourceRuntime();
  const sourceKey = runtime.sourceKey;
  const sourceSummary = runtime.summary;
  const snapshotKey: SessionDetailEntryKeyInput = useMemo(
    () => ({
      sourceKey,
      projectId,
      sessionId,
      tailTurns: effectiveTailTurns,
      tailFrom,
    }),
    [effectiveTailTurns, projectId, sessionId, sourceKey, tailFrom],
  );
  const coordinator = useMemo(
    () =>
      createSessionDetailCoordinator({
        entryKey: snapshotKey,
        runtime,
        activeWindowTrim: { enabled: getSessionActiveWindowTrimEnabled },
      }),
    [runtime, snapshotKey],
  );
  const sourceApi = coordinator.api;
  const snapshotKeyString = coordinator.entryKeyString;
  const cachedLoadRef = useRef<{
    key: string;
    coordinator: SessionDetailCoordinator;
    load: SessionRouteSnapshot | undefined;
  } | null>(null);
  if (
    cachedLoadRef.current?.key !== snapshotKeyString ||
    cachedLoadRef.current.coordinator !== coordinator
  ) {
    cachedLoadRef.current = {
      key: snapshotKeyString,
      coordinator,
      load: readSessionLoadCache(coordinator),
    };
  }
  const cachedLoad = cachedLoadRef.current.load;

  // Core state
  const [loading, setLoading] = useState(true);
  const [revealedSnapshotKey, setRevealedSnapshotKey] = useState<string | null>(
    null,
  );
  const [sessionLoadProgress, setSessionLoadProgress] =
    useState<SessionLoadProgress>(() => coordinator.buildLoadProgress("idle"));
  const [loadingOlder, setLoadingOlder] = useState(false);

  // Store-authoritative fields come from reducer-owned state. The remaining ref
  // holds hook-only scroll bookkeeping, which is intentionally not reactive.
  const scrollSnapshotRef = useRef<SessionRouteScrollSnapshot | undefined>(
    shouldRetainSessionScrollMemory(getSessionScrollBehaviorMode())
      ? cachedLoad?.scrollSnapshot
      : undefined,
  );
  const dispatchSessionDetailAction = useCallback(
    (action: SessionDetailAction) => {
      coordinator.dispatch(action);
    },
    [coordinator],
  );

  const readStoreSession = useCallback(
    () => coordinator.readSelected(selectSessionDetailSession) ?? null,
    [coordinator],
  );

  const readStoreLastMessageId = useCallback(
    () => coordinator.readSelected(selectSessionDetailLastMessageId),
    [coordinator],
  );

  const cleanupCurrentStoreRouteSnapshot = useCallback(() => {
    return coordinator.cleanupCurrentRouteSnapshot({
      enabled:
        getSessionTranscriptCacheEnabled() && typeof window !== "undefined",
      retainScrollSnapshot: shouldRetainSessionScrollMemory(
        getSessionScrollBehaviorMode(),
      ),
      scrollSnapshot: scrollSnapshotRef.current,
    });
  }, [coordinator]);
  const recordCurrentEntryBytes = useCallback(() => {
    const bytes = coordinator.getEntryApproxBytes();
    if (bytes) {
      recordLastSessionTranscriptBytes(bytes);
    }
  }, [coordinator]);
  const resetSessionDetailState = useCallback(
    (snapshot?: SessionRouteSnapshot) => {
      if (snapshot) {
        coordinator.replaceRouteSnapshot(snapshot);
        return;
      }
      coordinator.resetEntryState();
    },
    [coordinator],
  );

  // Hold the store entry for the mounted session: retention protects it from
  // TTL/LRU eviction, so incremental dispatches always land on real state.
  useEffect(() => coordinator.retain(), [coordinator]);

  const reportStoreDivergence = useCallback(
    (
      boundary: string,
      livePatch: Partial<SessionDetailRuntimeStateInput> = {},
    ) => {
      if (!isSessionDetailShadowDiagnosticsEnabled()) {
        return;
      }
      const store = coordinator.readSelected(
        selectSessionDetailRuntimeSnapshot,
      );
      if (!store) {
        return;
      }
      // Session and pagination are store-authoritative, so their live values
      // default to the store snapshot; only explicitly patched fields can
      // still diverge here.
      const liveSession = livePatch.session ?? store.session;
      const live: SessionDetailRuntimeStateInput = {
        messages: livePatch.messages ?? store.messages,
        session: liveSession,
        pagination: livePatch.pagination ?? store.pagination,
        agentContent: livePatch.agentContent ?? store.agentContent,
        toolUseToAgentEntries:
          livePatch.toolUseToAgentEntries ?? store.toolUseToAgentEntries,
      };
      reportSessionDetailStoreDivergence({
        boundary,
        projectId,
        sessionId,
        live,
        store,
      });
    },
    [coordinator, projectId, sessionId],
  );

  const updateSession = useCallback(
    (update: SessionMetadataUpdate) => {
      const previous = readStoreSession();
      const next = typeof update === "function" ? update(previous) : update;
      if (next === previous) {
        return;
      }
      dispatchSessionDetailAction({
        type: "setSessionMetadata",
        session: next,
      });
      reportStoreDivergence("session-metadata", {
        session: next,
      });
    },
    [dispatchSessionDetailAction, readStoreSession, reportStoreDivergence],
  );

  const warnSessionDetailStore = useCallback(
    (payload: Record<string, unknown>) => {
      if (!import.meta.env.DEV) {
        return;
      }
      console.warn("[SessionDetailStore]", {
        ...payload,
        projectId,
        sessionId,
      });
    },
    [projectId, sessionId],
  );

  const warnMissingStoreBackedDetailAfterReveal = useCallback(() => {
    warnSessionDetailStore({
      event: "session-detail-store-missing-after-reveal",
    });
  }, [warnSessionDetailStore]);

  const canRevealReturnedDetail = canRevealReturnedSessionDetail({
    revealedSnapshotKey,
    snapshotKeyString,
    loading,
  });
  const selectStoreBackedDetail = useMemo(() => {
    return createStoreBackedSessionDetailSelector(canRevealReturnedDetail);
  }, [canRevealReturnedDetail]);
  const storeBackedDetail = useSyncExternalStore(
    useCallback(
      (listener) => {
        return coordinator.subscribe(selectStoreBackedDetail, listener);
      },
      [coordinator, selectStoreBackedDetail],
    ),
    useCallback(
      () => coordinator.readSelected(selectStoreBackedDetail),
      [coordinator, selectStoreBackedDetail],
    ),
    () => undefined,
  );
  const returnedMessages = getReturnedSessionMessages(storeBackedDetail);
  const returnedAgentContent = getReturnedAgentContent(storeBackedDetail);
  const returnedToolUseToAgentEntries =
    storeBackedDetail?.revealed?.toolUseToAgentEntries;
  const returnedToolUseToAgent = useMemo(
    () => buildReturnedToolUseToAgent(returnedToolUseToAgentEntries),
    [returnedToolUseToAgentEntries],
  );
  useEffect(() => {
    if (!canRevealReturnedDetail || storeBackedDetail?.revealed) {
      return;
    }
    warnMissingStoreBackedDetailAfterReveal();
  }, [
    canRevealReturnedDetail,
    storeBackedDetail,
    warnMissingStoreBackedDetailAfterReveal,
  ]);

  useEffect(() => {
    return () => {
      recordCurrentEntryBytes();
      cleanupCurrentStoreRouteSnapshot();
    };
  }, [cleanupCurrentStoreRouteSnapshot, recordCurrentEntryBytes]);

  // Process a stream message event.
  const processStreamMessage = useCallback(
    (incoming: Message, fromBufferedReplay = false) => {
      const streamingEnabled = getStreamingEnabled();

      coordinator.applyStreamMessage(incoming, {
        fromBufferedReplay,
        streamingEnabled,
      });
    },
    [coordinator],
  );

  // Process a buffered stream subagent message
  const processStreamSubagentMessage = useCallback(
    (incoming: Message, agentId: string) => {
      const streamingEnabled = getStreamingEnabled();
      dispatchSessionDetailAction({
        type: "applyStreamSubagentMessage",
        agentId,
        message: incoming,
        streamingEnabled,
      });
    },
    [dispatchSessionDetailAction],
  );

  // Initial load. When a warm in-tab cache exists, the REST request is an
  // incremental refresh after the cached tail; merge that delta instead of
  // replacing the cached transcript.
  useEffect(() => {
    let cancelled = false;
    let warmHydrated = false;
    let pendingWarmData: GetSessionResult | null = null;
    let pendingWarmError: Error | null = null;
    let initialAfterMessageId: string | undefined;
    const warmLoad = readSessionLoadCache(coordinator);
    const initialLoad = coordinator.beginInitialLoad({
      warmSnapshot: warmLoad,
    });

    const notifyLoadComplete = (data: GetSessionResult) => {
      sourceSummary.reportProviderRuntimeStatusSnapshot(
        coordinator.buildProviderRuntimeStatusSnapshot(data),
      );
      onLoadComplete?.(coordinator.buildLoadCompleteResult(data));
    };

    const readRevealSnapshotAfterStoreUpdate = (
      boundary: string,
      fallback: SessionDetailRevealSnapshotInput,
    ): SessionDetailRevealSnapshotResult => {
      const reveal = coordinator.buildRevealSnapshot({
        ...fallback,
        scrollSnapshot: fallback.scrollSnapshot ?? scrollSnapshotRef.current,
      });
      if (!reveal.storeBacked) {
        warnSessionDetailStore({
          event: "session-detail-selector-missing-after-dispatch",
          boundary,
          selector: "runtimeSnapshot",
        });
      }
      return reveal;
    };

    const applyRevealSnapshot = (snapshot: SessionRouteSnapshot) => {
      scrollSnapshotRef.current = shouldRetainSessionScrollMemory(
        getSessionScrollBehaviorMode(),
      )
        ? snapshot.scrollSnapshot
        : undefined;
      setRevealedSnapshotKey(snapshotKeyString);
    };

    const writeRevealSnapshotToLoadCache = (
      reveal: SessionDetailRevealSnapshotResult,
    ) => {
      return coordinator.writeCacheableRevealSnapshot(reveal, {
        enabled:
          getSessionTranscriptCacheEnabled() && typeof window !== "undefined",
        retainScrollSnapshot: shouldRetainSessionScrollMemory(
          getSessionScrollBehaviorMode(),
        ),
      });
    };

    const completeInitialReveal = (options: {
      snapshot: SessionRouteSnapshot;
      sourceMessageCount: number;
      provider?: string;
      restoredFromSnapshot?: boolean;
    }) => {
      const completion = coordinator.buildInitialRevealCompletion(options);
      const { snapshot } = completion;
      applyRevealSnapshot(snapshot);
      markReloadPerfPhase(
        "session_initial_messages_state_queued",
        completion.messagesQueuedPerfDetail,
      );

      // Mark ready and flush buffered stream events after the reveal snapshot
      // has been queued so buffered events merge on top of loaded transcript.
      initialLoad.completeReveal({
        processMessage: processStreamMessage,
        processSubagentMessage: processStreamSubagentMessage,
      });

      setLoading(false);
      setSessionLoadProgress(completion.loadCompleteProgress);
      markReloadPerfPhase(
        "session_initial_load_complete",
        completion.loadCompletePerfDetail,
      );
    };

    const finishWarmHydration = (options: {
      loadedSession: SessionMetadata;
      loadedPagination?: PaginationInfo;
      sourceMessageCount: number;
      provider?: string;
      diagnosticBoundary: string;
    }): SessionDetailRevealSnapshotResult => {
      const reveal = readRevealSnapshotAfterStoreUpdate(
        options.diagnosticBoundary,
        {
          session: options.loadedSession,
          pagination: options.loadedPagination,
          lastMessageId: readStoreLastMessageId(),
          scrollSnapshot: scrollSnapshotRef.current,
        },
      );
      const { snapshot } = reveal;
      completeInitialReveal({
        snapshot,
        sourceMessageCount: options.sourceMessageCount,
        provider: options.provider,
        restoredFromSnapshot: true,
      });
      return reveal;
    };

    const applyWarmDataBeforeHydration = (data: GetSessionResult) => {
      if (!warmLoad) return;
      markReloadPerfPhase(
        "session_initial_load_data_ready",
        coordinator.buildInitialLoadDataReadyPerfDetail(data, {
          restoredFromSnapshot: true,
        }),
      );
      const applied = coordinator.applyWarmRefresh(data, {
        warmSnapshot: warmLoad,
        initialAfterMessageId,
      });
      setSessionLoadProgress(
        coordinator.buildAppliedLoadProgress("rendering", applied),
      );
      const reveal = finishWarmHydration({
        loadedSession: data.session,
        loadedPagination: applied.pagination,
        sourceMessageCount: applied.sourceMessageCount,
        provider: data.session.provider,
        diagnosticBoundary: "warm-catchup-before-hydration",
      });
      writeRevealSnapshotToLoadCache(reveal);
      notifyLoadComplete(data);
    };

    const applyWarmDeltaAfterHydration = (data: GetSessionResult) => {
      if (!warmLoad) return;
      markReloadPerfPhase(
        "session_initial_load_data_ready",
        coordinator.buildInitialLoadDataReadyPerfDetail(data, {
          restoredFromSnapshot: true,
          appliedAfterSnapshotHydration: true,
        }),
      );
      const applied = coordinator.applyWarmRefresh(data, {
        warmSnapshot: warmLoad,
        initialAfterMessageId,
      });
      const reveal = readRevealSnapshotAfterStoreUpdate(
        "warm-catchup-after-hydration",
        {
          session: data.session,
          pagination: applied.pagination,
          lastMessageId: readStoreLastMessageId(),
          scrollSnapshot: scrollSnapshotRef.current,
        },
      );
      const { snapshot } = reveal;
      applyRevealSnapshot(snapshot);
      setSessionLoadProgress(
        coordinator.buildRouteSnapshotLoadProgress("complete", snapshot, {
          messageCount: snapshot.pagination?.returnedMessageCount,
        }),
      );
      notifyLoadComplete(data);
    };

    markReloadPerfPhase("session_initial_load_start", {
      projectId,
      sessionId,
      tailCompactions: 2,
      tailTurns: effectiveTailTurns,
      tailFrom,
      restoredFromSnapshot: initialLoad.restoredFromSnapshot,
    });
    scrollSnapshotRef.current = shouldRetainSessionScrollMemory(
      getSessionScrollBehaviorMode(),
    )
      ? warmLoad?.scrollSnapshot
      : undefined;
    setRevealedSnapshotKey(null);
    if (warmLoad) {
      resetSessionDetailState(warmLoad);
      setSessionLoadProgress(
        coordinator.buildRouteSnapshotLoadProgress("fetching", warmLoad),
      );
      setLoading(true);
      void (async () => {
        setSessionLoadProgress(
          coordinator.buildRouteSnapshotLoadProgress("rendering", warmLoad),
        );
        await yieldForSessionLoadingProgressPaint(true);
        if (cancelled) return;
        warmHydrated = true;
        if (pendingWarmData) {
          applyWarmDataBeforeHydration(pendingWarmData);
          return;
        }
        finishWarmHydration({
          loadedSession: warmLoad.session,
          loadedPagination: warmLoad.pagination,
          sourceMessageCount: warmLoad.messages.length,
          provider: warmLoad.session.provider,
          diagnosticBoundary: "warm-route-snapshot",
        });
        if (pendingWarmError) {
          onLoadError?.(pendingWarmError);
        }
      })();
    } else {
      setSessionLoadProgress(coordinator.buildLoadProgress("fetching"));
      resetSessionDetailState();
      setLoading(true);
    }

    initialAfterMessageId = readStoreLastMessageId();
    sourceApi
      .getSession({
        projectId,
        sessionId,
        afterMessageId: initialAfterMessageId,
        tailCompactions: 2,
        tailTurns: effectiveTailTurns,
        tailFrom,
      })
      .then(async (data) => {
        if (cancelled) return;
        if (warmLoad) {
          if (!warmHydrated) {
            pendingWarmData = data;
            return;
          }
          applyWarmDeltaAfterHydration(data);
          return;
        }
        markReloadPerfPhase(
          "session_initial_load_data_ready",
          coordinator.buildInitialLoadDataReadyPerfDetail(data),
        );
        setSessionLoadProgress(
          coordinator.buildDataLoadProgress("rendering", data),
        );
        await yieldForSessionLoadingProgressPaint(detailedLoadingProgress);
        if (cancelled) return;

        const applied = coordinator.applyInitialLoad(data);
        const reveal = readRevealSnapshotAfterStoreUpdate("initial-load", {
          session: data.session,
          pagination: applied.pagination,
          lastMessageId: readStoreLastMessageId(),
          scrollSnapshot: scrollSnapshotRef.current,
        });
        const { snapshot } = reveal;
        completeInitialReveal({
          snapshot,
          sourceMessageCount: applied.sourceMessageCount,
          provider: data.session.provider,
        });

        writeRevealSnapshotToLoadCache(reveal);

        notifyLoadComplete(data);
      })
      .catch((err) => {
        if (cancelled) return;
        if (warmLoad) {
          const error = toError(err);
          markReloadPerfPhase(
            "session_initial_load_error",
            coordinator.buildInitialLoadErrorPerfDetail(error, {
              restoredFromSnapshot: true,
            }),
          );
          if (!warmHydrated) {
            pendingWarmError = error;
            return;
          }
          onLoadError?.(error);
          return;
        }
        markReloadPerfPhase(
          "session_initial_load_error",
          coordinator.buildInitialLoadErrorPerfDetail(err),
        );
        setSessionLoadProgress(coordinator.buildLoadProgress("error"));
        setLoading(false);
        onLoadError?.(err);
      });
    return () => {
      cancelled = true;
    };
  }, [
    projectId,
    sessionId,
    effectiveTailTurns,
    tailFrom,
    detailedLoadingProgress,
    onLoadComplete,
    onLoadError,
    coordinator,
    resetSessionDetailState,
    processStreamMessage,
    processStreamSubagentMessage,
    readStoreLastMessageId,
    snapshotKeyString,
    sourceApi,
    warnSessionDetailStore,
    sourceSummary,
  ]);

  // Handle streaming content updates (from useStreamingContent)
  const handleStreamingUpdate = useCallback(
    (streamingMessage: Message, agentId?: string) => {
      const messageId = getMessageId(streamingMessage);
      if (!messageId) return;

      dispatchSessionDetailAction({
        type: "upsertStreamingPlaceholder",
        message: streamingMessage,
        agentId,
      });
    },
    [dispatchSessionDetailAction],
  );

  // Handle stream message event (with buffering)
  const handleStreamMessageEvent = useCallback(
    (incoming: Message) => {
      coordinator.handleStreamMessage(incoming, processStreamMessage);
    },
    [coordinator, processStreamMessage],
  );

  // Handle stream subagent message event (with buffering)
  const handleStreamSubagentMessage = useCallback(
    (incoming: Message, agentId: string) => {
      coordinator.handleStreamSubagentMessage(
        incoming,
        agentId,
        processStreamSubagentMessage,
      );
    },
    [coordinator, processStreamSubagentMessage],
  );

  // Register toolUse → agent mapping
  const registerToolUseAgent = useCallback(
    (toolUseId: string, agentId: string) => {
      dispatchSessionDetailAction({
        type: "registerToolUseAgent",
        toolUseId,
        agentId,
      });
    },
    [dispatchSessionDetailAction],
  );

  const mergeLoadedAgentContent = useCallback(
    (agentId: string, content: AgentContent) => {
      dispatchSessionDetailAction({
        type: "mergeLoadedAgentContent",
        agentId,
        content,
      });
    },
    [dispatchSessionDetailAction],
  );

  const updateAgentContextUsage = useCallback(
    (agentId: string, contextUsage: AgentContextUsage) => {
      dispatchSessionDetailAction({
        type: "updateAgentContextUsage",
        agentId,
        contextUsage,
      });
    },
    [dispatchSessionDetailAction],
  );

  const clearAgentStreamingPlaceholders = useCallback(
    (agentId: string) => {
      dispatchSessionDetailAction({
        type: "clearAgentStreamingPlaceholders",
        agentId,
      });
    },
    [dispatchSessionDetailAction],
  );

  const clearStreamingPlaceholders = useCallback(() => {
    dispatchSessionDetailAction({ type: "clearStreamingPlaceholders" });
  }, [dispatchSessionDetailAction]);

  const removeUnconfirmedSelfSend = useCallback(
    (tempId: string) => {
      dispatchSessionDetailAction({
        type: "removeUnconfirmedSelfSend",
        tempId,
      });
    },
    [dispatchSessionDetailAction],
  );

  // Fetch new messages incrementally (for file change events)
  const fetchNewMessages = useCallback(() => {
    return coordinator.runExclusiveFetchNewMessages(async () => {
      try {
        const afterMessageId = readStoreLastMessageId();
        const data = await sourceApi.getSession(
          afterMessageId
            ? {
                projectId,
                sessionId,
                afterMessageId,
              }
            : {
                projectId,
                sessionId,
                tailCompactions: 2,
                tailTurns: effectiveTailTurns,
                tailFrom,
              },
        );
        sourceSummary.reportProviderRuntimeStatusSnapshot(
          coordinator.buildProviderRuntimeStatusSnapshot(data),
        );
        const applied = coordinator.applyIncrementalRefresh(data, {
          afterMessageId,
        });
        if (applied.applied) {
          reportStoreDivergence("catchup", { session: data.session });
        }
        // Update session metadata (including title, model, contextUsage) which may have changed
        // For new sessions, prev may be null if JSONL didn't exist on initial load
        updateSession((prev) =>
          prev ? { ...prev, ...data.session } : data.session,
        );
      } catch {
        // Silent fail for incremental updates
      }
    });
  }, [
    coordinator,
    effectiveTailTurns,
    projectId,
    sessionId,
    tailFrom,
    readStoreLastMessageId,
    reportStoreDivergence,
    sourceApi,
    sourceSummary,
    updateSession,
  ]);

  // Load older messages (previous chunk before the current truncation point)
  const loadOlderMessages = useCallback(async () => {
    const request = coordinator.buildOlderPageRequest();
    if (!request.requested) {
      return;
    }
    coordinator.suppressActiveWindowTrimForHistoryExpansion();
    setLoadingOlder(true);
    try {
      const data = await sourceApi.getSession(request.input);
      sourceSummary.reportProviderRuntimeStatusSnapshot(
        coordinator.buildProviderRuntimeStatusSnapshot(data),
      );
      coordinator.applyOlderPage(data);
      reportStoreDivergence("older-page", { session: data.session });
    } catch {
      // Silent fail for loading older messages
    } finally {
      setLoadingOlder(false);
    }
  }, [coordinator, reportStoreDivergence, sourceApi, sourceSummary]);

  const updateRouteScrollSnapshot = useCallback(
    (snapshot: SessionRouteScrollSnapshot) => {
      coordinator.setActiveWindowFollowingBottom(snapshot.atBottom);
      if (!shouldRetainSessionScrollMemory(getSessionScrollBehaviorMode())) {
        scrollSnapshotRef.current = undefined;
        return;
      }
      scrollSnapshotRef.current = snapshot;
      coordinator.patchScrollSnapshot(snapshot);
    },
    [coordinator],
  );
  const updateActiveWindowFollowingBottom = useCallback(
    (followingBottom: boolean) => {
      coordinator.setActiveWindowFollowingBottom(followingBottom);
    },
    [coordinator],
  );

  // Fetch session metadata only
  const fetchSessionMetadata = useCallback(async () => {
    try {
      const data = await sourceApi.getSessionMetadata({
        projectId,
        sessionId,
      });
      sourceSummary.reportProviderRuntimeStatusSnapshot(
        coordinator.buildProviderRuntimeStatusSnapshot(data),
      );
      const metadataSession = {
        ...data.session,
        ownership: data.ownership,
      };
      // For new sessions, prev may be null if JSONL didn't exist on initial load
      updateSession((prev) =>
        prev ? { ...prev, ...metadataSession } : metadataSession,
      );
    } catch {
      // Silent fail for metadata updates
    }
  }, [
    coordinator,
    projectId,
    sessionId,
    sourceApi,
    sourceSummary,
    updateSession,
  ]);
  const selectedInitialScrollSnapshot = shouldRetainSessionScrollMemory(
    getSessionScrollBehaviorMode(),
  )
    ? (coordinator.readScrollSnapshot() ?? cachedLoad?.scrollSnapshot ?? null)
    : null;

  return {
    messages: returnedMessages,
    agentContent: returnedAgentContent,
    toolUseToAgent: returnedToolUseToAgent,
    loading,
    sessionLoadProgress,
    session: storeBackedDetail?.session ?? null,
    updateSession,
    handleStreamingUpdate,
    handleStreamMessageEvent,
    handleStreamSubagentMessage,
    registerToolUseAgent,
    mergeLoadedAgentContent,
    updateAgentContextUsage,
    clearAgentStreamingPlaceholders,
    clearStreamingPlaceholders,
    removeUnconfirmedSelfSend,
    fetchNewMessages,
    fetchSessionMetadata,
    pagination: storeBackedDetail?.pagination,
    activeWindowTrimRevision:
      storeBackedDetail?.revealed?.activeWindowTrimRevision ?? 0,
    loadingOlder,
    loadOlderMessages,
    initialScrollSnapshot: selectedInitialScrollSnapshot,
    updateRouteScrollSnapshot,
    updateActiveWindowFollowingBottom,
    restoredFromSnapshot: Boolean(cachedLoad),
  };
}
