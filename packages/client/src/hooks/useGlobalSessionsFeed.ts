import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  api,
  type GlobalSessionItem,
  type GlobalSessionsResponse,
  type GlobalSessionStats,
  type ProjectOption,
} from "../api/client";
import { useOptionalRemoteConnection } from "../contexts/RemoteConnectionContext";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { isRemoteClient } from "../lib/connection";
import { acquireClientQueryBootstrapSlot } from "../lib/clientQueryBootstrap";
import {
  createClientQueryKey,
  ensureClientQuery,
  invalidateClientQuery,
  retainClientQuery,
} from "../lib/clientQueryController";
import {
  type QueryRevalidationHandle,
  retainQueryRevalidation,
} from "../lib/clientQueryRevalidation";
import {
  type ClientSummarySourceKey,
  useSessionCollectionQueryRecords,
  useSessionCollectionQueryState,
} from "../lib/clientSummaryStore";
import type { SessionCollectionQueryDescriptor } from "../lib/clientSummaryCollections";
import { createGlobalSessionsCollectionQueryDescriptor } from "../lib/clientSummaryQueries";
import {
  type ProcessStateEvent,
  type SessionCreatedEvent,
  type SessionMetadataChangedEvent,
  useFileActivity,
} from "./useFileActivity";

const REFETCH_DEBOUNCE_MS = 500;
/**
 * Reconnect is the only event the owner reacts to on its own. The rest arrive
 * through `useFileActivity` because this feed patches its collection from the
 * event before deciding whether a refetch is even needed, and that patch is
 * per-query bookkeeping rather than a revalidation.
 */
const GLOBAL_SESSIONS_REVALIDATE_EVENTS = ["reconnect"] as const;
const GLOBAL_SESSIONS_DEFAULT_LIMIT = 100;
const GLOBAL_SESSIONS_STALE_TIME_MS = 30_000;
const GLOBAL_SESSION_STATS_STALE_TIME_MS = 30_000;
const GLOBAL_SESSION_STATS_QUERY_KEY = createClientQueryKey({
  endpoint: "global-session-stats",
});

export interface UseGlobalSessionsOptions {
  projectId?: string | null;
  searchQuery?: string;
  limit?: number;
  includeArchived?: boolean;
  starred?: boolean;
  includeStats?: boolean;
}

export interface UseGlobalSessionsFeedResult {
  query: SessionCollectionQueryDescriptor;
  ready: boolean;
  loading: boolean;
  error: Error | null;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  refetch: () => Promise<void>;
  stats: GlobalSessionStats;
  projects: ProjectOption[];
}

/** Default stats when no data loaded */
export const DEFAULT_GLOBAL_SESSION_STATS: GlobalSessionStats = {
  totalCount: 0,
  unreadCount: 0,
  starredCount: 0,
  archivedCount: 0,
  providerCounts: {},
  executorCounts: {},
};

interface GlobalSessionsAuxiliaryState {
  stats: GlobalSessionStats;
  projects: ProjectOption[];
}

const DEFAULT_GLOBAL_SESSIONS_AUXILIARY: GlobalSessionsAuxiliaryState = {
  stats: DEFAULT_GLOBAL_SESSION_STATS,
  projects: [],
};

const globalSessionsAuxiliaryBySource = new Map<
  ClientSummarySourceKey,
  GlobalSessionsAuxiliaryState
>();
const globalSessionsAuxiliaryListeners = new Set<() => void>();

function subscribeGlobalSessionsAuxiliary(listener: () => void): () => void {
  globalSessionsAuxiliaryListeners.add(listener);
  return () => {
    globalSessionsAuxiliaryListeners.delete(listener);
  };
}

function getGlobalSessionsAuxiliary(
  sourceKey: ClientSummarySourceKey,
): GlobalSessionsAuxiliaryState {
  return (
    globalSessionsAuxiliaryBySource.get(sourceKey) ??
    DEFAULT_GLOBAL_SESSIONS_AUXILIARY
  );
}

function updateGlobalSessionsAuxiliary(
  sourceKey: ClientSummarySourceKey,
  update: Partial<GlobalSessionsAuxiliaryState>,
): void {
  const current = getGlobalSessionsAuxiliary(sourceKey);
  const next = {
    stats: update.stats ?? current.stats,
    projects: update.projects ?? current.projects,
  };
  if (next.stats === current.stats && next.projects === current.projects) {
    return;
  }

  globalSessionsAuxiliaryBySource.set(sourceKey, next);
  for (const listener of Array.from(globalSessionsAuxiliaryListeners)) {
    listener();
  }
}

function useGlobalSessionsAuxiliary(
  sourceKey: ClientSummarySourceKey,
): GlobalSessionsAuxiliaryState {
  return useSyncExternalStore(
    subscribeGlobalSessionsAuxiliary,
    () => getGlobalSessionsAuxiliary(sourceKey),
    () => DEFAULT_GLOBAL_SESSIONS_AUXILIARY,
  );
}

function createGlobalSessionsControllerQueryKey(
  descriptor: SessionCollectionQueryDescriptor,
): string {
  return createClientQueryKey({
    endpoint: "global-sessions",
    projectId: descriptor.projectId ?? null,
    searchQuery: descriptor.searchQuery?.trim() || null,
    includeArchived: descriptor.includeArchived === true,
    starred: descriptor.starred === true,
  });
}

export function resetGlobalSessionsFeedForTests(): void {
  globalSessionsAuxiliaryBySource.clear();
  globalSessionsAuxiliaryListeners.clear();
}

function shouldRefetchGlobalSessionsAfterProcessState(
  event: ProcessStateEvent,
  matched: boolean,
): boolean {
  return !matched || event.activity !== "in-turn";
}

function sessionCreatedEventToGlobalSessionItem(
  event: SessionCreatedEvent,
  projects: readonly ProjectOption[],
): GlobalSessionItem {
  const project = projects.find((p) => p.id === event.session.projectId);
  const projectName = event.session.projectName ?? project?.name ?? "";

  return {
    id: event.session.id,
    title: event.session.title,
    fullTitle: event.session.fullTitle,
    createdAt: event.session.createdAt,
    updatedAt: event.session.updatedAt,
    messageCount: event.session.messageCount,
    provider: event.session.provider,
    model: event.session.model,
    projectId: event.session.projectId,
    projectName,
    ownership: event.session.ownership,
    pendingInputType: event.session.pendingInputType,
    activity: event.session.activity,
    hasUnread: event.session.hasUnread,
    customTitle: event.session.customTitle,
    isArchived: event.session.isArchived,
    isStarred: event.session.isStarred,
    parentSessionId: event.session.parentSessionId,
    parentSessionKind: event.session.parentSessionKind,
    forkedFromSessionId: event.session.forkedFromSessionId,
    initialPrompt: event.session.initialPrompt,
    executor: event.session.executor,
    lastAgentText: event.session.lastAgentText,
  };
}

export function useGlobalSessionsFeed(
  options: UseGlobalSessionsOptions = {},
): UseGlobalSessionsFeedResult {
  const {
    projectId,
    searchQuery,
    limit,
    includeArchived,
    starred,
    includeStats = false,
  } = options;
  const remoteConnection = useOptionalRemoteConnection();
  const ready =
    !isRemoteClient() ||
    (remoteConnection !== null && remoteConnection.connection !== null);
  const query = useMemo(
    () =>
      createGlobalSessionsCollectionQueryDescriptor({
        projectId,
        searchQuery,
        includeArchived,
        starred,
      }),
    [projectId, searchQuery, includeArchived, starred],
  );
  const queryKey = useMemo(
    () => createGlobalSessionsControllerQueryKey(query),
    [query],
  );
  const requestedRows = limit ?? GLOBAL_SESSIONS_DEFAULT_LIMIT;
  const runtime = useCurrentSourceRuntime();
  const sourceKey = runtime.sourceKey;
  const sourceSummary = runtime.summary;
  const sourceKeyRef = useRef(sourceKey);
  sourceKeyRef.current = sourceKey;
  const auxiliary = useGlobalSessionsAuxiliary(sourceKey);
  const queryState = useSessionCollectionQueryState(query);
  const queryRecords = useSessionCollectionQueryRecords(query);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const queryStateRef = useRef(queryState);
  queryStateRef.current = queryState;
  const queryRecordsRef = useRef(queryRecords);
  queryRecordsRef.current = queryRecords;
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const projectsRef = useRef<ProjectOption[]>([]);
  projectsRef.current = auxiliary.projects;
  const requestSequenceRef = useRef(0);

  useEffect(() => {
    void sourceKey;
    void queryKey;
    requestSequenceRef.current += 1;
    // A pending debounce belongs to the shared owner, and releasing this
    // subscriber on a source/query change already drops it when nobody else
    // wants it.
    setError(null);
    setLoading(!queryStateRef.current);
  }, [sourceKey, queryKey]);

  useEffect(
    () =>
      retainClientQuery({
        sourceKey,
        key: queryKey,
      }),
    [sourceKey, queryKey],
  );

  useEffect(() => {
    if (!includeStats || projectId) {
      return undefined;
    }
    return retainClientQuery({
      sourceKey,
      key: GLOBAL_SESSION_STATS_QUERY_KEY,
    });
  }, [includeStats, projectId, sourceKey]);

  const fetch = useCallback(
    async (fetchOptions: { force?: boolean } = {}) => {
      if (!readyRef.current) {
        if (!queryStateRef.current) {
          setLoading(true);
        }
        return;
      }

      if (!queryStateRef.current || fetchOptions.force) {
        setLoading(true);
      }
      setError(null);

      const requestId = ++requestSequenceRef.current;
      const queryForRequest = query;
      const requestSourceKey = sourceKey;

      try {
        if (fetchOptions.force) {
          invalidateClientQuery(requestSourceKey, queryKey);
          if (includeStats && !projectId) {
            invalidateClientQuery(
              requestSourceKey,
              GLOBAL_SESSION_STATS_QUERY_KEY,
            );
          }
        }

        const sessionsPromise = ensureClientQuery<GlobalSessionsResponse>({
          sourceKey: requestSourceKey,
          key: queryKey,
          coverage: { minRows: requestedRows },
          staleTimeMs: GLOBAL_SESSIONS_STALE_TIME_MS,
          force: fetchOptions.force,
          fetcher: () =>
            api.getGlobalSessions({
              project: projectId ?? undefined,
              q: searchQuery || undefined,
              limit,
              includeArchived,
              starred,
              includeStats: false,
            }),
          applySnapshot: (data, context) => {
            sourceSummary.reportGlobalSessionsCollectionSnapshot(
              {
                query: queryForRequest,
                sessions: data.sessions,
                hasMore: data.hasMore,
                mode: "replace",
              },
              context.requestStartedAt,
            );
            updateGlobalSessionsAuxiliary(context.sourceKey, {
              projects: data.projects,
            });
          },
        });
        const statsPromise =
          includeStats && !projectId
            ? ensureClientQuery<{ stats: GlobalSessionStats }>({
                sourceKey: requestSourceKey,
                key: GLOBAL_SESSION_STATS_QUERY_KEY,
                coverage: { includeStats: true },
                staleTimeMs: GLOBAL_SESSION_STATS_STALE_TIME_MS,
                force: fetchOptions.force,
                fetcher: () => api.getGlobalSessionStats(),
                applySnapshot: (data, context) => {
                  updateGlobalSessionsAuxiliary(context.sourceKey, {
                    stats: data.stats,
                  });
                },
              })
            : Promise.resolve();

        await Promise.all([sessionsPromise, statsPromise]);
      } catch (err) {
        if (requestId === requestSequenceRef.current) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (requestId === requestSequenceRef.current) {
          setLoading(false);
        }
      }
    },
    [
      query,
      queryKey,
      projectId,
      searchQuery,
      limit,
      includeArchived,
      starred,
      includeStats,
      requestedRows,
      sourceKey,
      sourceSummary,
    ],
  );

  const loadMore = useCallback(async () => {
    if (!readyRef.current || !queryStateRef.current?.hasMore) {
      return;
    }

    const records = queryRecordsRef.current;
    const lastRecord = records[records.length - 1];
    if (!lastRecord) {
      return;
    }
    if (!lastRecord.updatedAt) {
      await fetch({ force: true });
      return;
    }

    const requestSourceKey = sourceKey;
    try {
      setError(null);
      const requestStartedAt = Date.now();
      const data = await api.getGlobalSessions({
        project: projectId ?? undefined,
        q: searchQuery || undefined,
        limit,
        after: lastRecord.updatedAt,
        includeArchived,
        starred,
        includeStats: false,
      });

      sourceSummary.reportGlobalSessionsCollectionSnapshot(
        {
          query,
          sessions: data.sessions,
          hasMore: data.hasMore,
          mode: "append",
        },
        requestStartedAt,
      );
      updateGlobalSessionsAuxiliary(requestSourceKey, {
        projects: data.projects,
      });
    } catch (err) {
      if (sourceKeyRef.current === requestSourceKey) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }, [
    fetch,
    query,
    projectId,
    searchQuery,
    limit,
    includeArchived,
    starred,
    sourceKey,
    sourceSummary,
  ]);

  // The debounce timer and the reconnect listener belong to the shared
  // `(sourceKey, queryKey)` owner. This feed's key is mounted from the sidebar,
  // the Global Sessions page, and the recent-sessions dropdown at once, so
  // per-hook timers meant one activity event scheduled one refetch per mount.
  const revalidationRef = useRef<QueryRevalidationHandle | null>(null);
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;

  const revalidationSubscriber = useCallback(
    () => ({
      coverage: { minRows: requestedRows },
      events: GLOBAL_SESSIONS_REVALIDATE_EVENTS,
      debounceMs: REFETCH_DEBOUNCE_MS,
      run: () => {
        void fetchRef.current({ force: true });
      },
    }),
    [requestedRows],
  );

  useEffect(() => {
    const handle = retainQueryRevalidation({
      sourceKey,
      key: queryKey,
      subscriber: revalidationSubscriber(),
    });
    revalidationRef.current = handle;
    return () => {
      revalidationRef.current = null;
      handle.release();
    };
  }, [sourceKey, queryKey, revalidationSubscriber]);

  // Coverage and closures change between renders; the owner needs the current
  // ones without the retention itself churning.
  useEffect(() => {
    revalidationRef.current?.update(revalidationSubscriber());
  });

  const debouncedRefetch = useCallback(() => {
    if (!readyRef.current) {
      return;
    }
    revalidationRef.current?.schedule();
  }, []);

  const handleProcessStateChange = useCallback(
    (event: ProcessStateEvent) => {
      const currentlyMatched = queryRecordsRef.current.some(
        (record) => record.id === event.sessionId,
      );
      if (
        shouldRefetchGlobalSessionsAfterProcessState(event, currentlyMatched)
      ) {
        debouncedRefetch();
      }
    },
    [debouncedRefetch],
  );

  const handleSessionCreated = useCallback(
    (event: SessionCreatedEvent) => {
      const observedAt = Date.now();
      sourceSummary.reportSessionCollectionCreated(event, observedAt);

      if (projectId && event.session.projectId !== projectId) return;
      if (starred && !event.session.isStarred) return;
      if (includeArchived !== true && event.session.isArchived) return;

      if (searchQuery) {
        debouncedRefetch();
        return;
      }

      sourceSummary.reportGlobalSessionsCollectionSnapshot(
        {
          query,
          sessions: [
            sessionCreatedEventToGlobalSessionItem(event, projectsRef.current),
          ],
          hasMore: queryStateRef.current?.hasMore ?? false,
          mode: "prepend",
        },
        observedAt,
      );
    },
    [
      projectId,
      starred,
      includeArchived,
      searchQuery,
      debouncedRefetch,
      query,
      sourceSummary,
    ],
  );

  const handleSessionMetadataChange = useCallback(
    (event: SessionMetadataChangedEvent) => {
      sourceSummary.reportSessionCollectionMetadataChanged(event);

      if (
        searchQuery ||
        (projectId &&
          event.projectId !== undefined &&
          event.projectId !== projectId)
      ) {
        debouncedRefetch();
      }
    },
    [debouncedRefetch, projectId, searchQuery, sourceSummary],
  );

  useFileActivity({
    maxEvents: 0,
    onSessionCreated: handleSessionCreated,
    onProcessStateChange: handleProcessStateChange,
    onSessionMetadataChange: handleSessionMetadataChange,
  });

  // This feed owns its acquisition rather than going through
  // `useRetainedClientQuery`, so it joins the startup ordering here. Only the
  // first fetch waits; `debouncedRefetch` and `refetch` never do.
  useEffect(() => {
    if (!ready) {
      return undefined;
    }

    let cancelled = false;
    const slot = acquireClientQueryBootstrapSlot(sourceKey, "navigation");
    void slot.ready().then(() => {
      if (cancelled) {
        slot.settle();
        return;
      }
      void fetch().finally(() => slot.settle());
    });
    return () => {
      cancelled = true;
      slot.settle();
    };
  }, [fetch, ready, sourceKey]);

  return {
    query,
    ready,
    loading: loading || (!ready && !queryState),
    error,
    hasMore: queryState?.hasMore ?? false,
    loadMore,
    refetch: () => fetch({ force: true }),
    stats:
      includeStats && !projectId
        ? auxiliary.stats
        : DEFAULT_GLOBAL_SESSION_STATS,
    projects: auxiliary.projects,
  };
}
