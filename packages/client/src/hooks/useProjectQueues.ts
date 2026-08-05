import type {
  ProjectQueueDispatchState,
  ProjectQueueItemSummary,
  ProjectQueueProjectStatus,
  ProjectQueuePromoteNowResult,
  ProjectQueueRecoveredSessionQueueSummary,
  UpdateProjectQueueItemRequest,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useOptionalRemoteConnection } from "../contexts/RemoteConnectionContext";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { createClientQueryKey } from "../lib/clientQueryController";
import { isRemoteClient } from "../lib/connection";
import { serverSupportsProjectQueue } from "../lib/projectQueueVisibility";
import {
  type ClientSummarySourceKey,
  useProjectQueueDispatchState,
  useProjectQueueGlobalItems,
  useProjectQueueItemsByProject,
  useProjectQueueProjectStatusesByProject,
  useProjectQueueRecoveredSessionQueues,
} from "../lib/clientSummaryStore";
import { useRetainedClientQuery } from "./useRetainedClientQuery";
import { useVersion } from "./useVersion";

export interface UseProjectQueuesResult {
  queuesByProject: Record<string, readonly ProjectQueueItemSummary[]>;
  items: readonly ProjectQueueItemSummary[];
  projectStatusesByProject: Record<string, ProjectQueueProjectStatus>;
  recoveredSessionQueues: ProjectQueueRecoveredSessionQueueSummary[];
  loading: boolean;
  error: Error | null;
  mutatingItemId: string | null;
  mutatingDispatchState: boolean;
  mutatingPromoteItemId: string | null;
  dispatchState: ProjectQueueDispatchState;
  refetch: () => Promise<void>;
  pauseDispatch: () => Promise<void>;
  resumeDispatch: () => Promise<void>;
  promoteNow: (
    projectId: string,
    itemId: string,
    options?: { force?: boolean; deliveryIntent?: "steer" },
  ) => Promise<ProjectQueuePromoteNowResult>;
  updateItem: (
    projectId: string,
    itemId: string,
    request: UpdateProjectQueueItemRequest,
  ) => Promise<void>;
  deleteItem: (projectId: string, itemId: string) => Promise<void>;
  retryItem: (projectId: string, itemId: string) => Promise<void>;
  moveItemToTop: (projectId: string, itemId: string) => Promise<void>;
}

function uniqueProjectIds(projectIds: readonly string[]): string[] {
  return [...new Set(projectIds.filter(Boolean))];
}

function flattenQueues(
  queuesByProject: Record<string, readonly ProjectQueueItemSummary[]>,
): readonly ProjectQueueItemSummary[] {
  return Object.values(queuesByProject).flat();
}

const PROJECT_QUEUE_QUERY_KEY = createClientQueryKey({
  endpoint: "project-queue",
});
const PROJECT_QUEUE_REVALIDATE_EVENTS = [
  "refresh",
  "reconnect",
  "project-queue-changed",
  "session-queue-persistence-changed",
] as const;
const RUNNING_DISPATCH_STATE: ProjectQueueDispatchState = {
  status: "running",
};

/**
 * How long to wait before re-reading a project the server is actively working
 * (`ready` or `dispatching`) but has given no deadline for. This is the
 * missed-event guard the removed per-consumer interval used to be, kept at its
 * previous length so no situation recovers more slowly than before — the change
 * is that one source arms it once, rather than every mounted consumer arming
 * its own.
 */
const PROJECT_QUEUE_ACTIVE_FALLBACK_MS = 5000;
/** Never spin: a deadline already past still waits this long before firing. */
const PROJECT_QUEUE_MIN_DELAY_MS = 250;

interface ProjectQueueDeadline {
  /** Earliest instant the server said something could happen, if it said one. */
  deadlineAtMs: number | null;
  /** A project the server is acting on now, so a missed event is possible. */
  hasActiveProject: boolean;
}

const NO_PROJECT_QUEUE_DEADLINE: ProjectQueueDeadline = {
  deadlineAtMs: null,
  hasActiveProject: false,
};

/**
 * The exact instants the server reported, plus whether anything is in flight.
 * `nextAttemptAt` and `quietEligibleAt` are the queue's own scheduling
 * decisions, so honouring them is strictly better than sampling on a timer:
 * a project waiting out a 30-second quiet window is read once, at the end of
 * it, instead of six times during it.
 */
function readProjectQueueDeadline(
  statusesByProject: Record<string, ProjectQueueProjectStatus>,
): ProjectQueueDeadline {
  let deadlineAtMs: number | null = null;
  let hasActiveProject = false;

  for (const status of Object.values(statusesByProject)) {
    for (const iso of [status.nextAttemptAt, status.quietEligibleAt]) {
      if (!iso) continue;
      const atMs = Date.parse(iso);
      if (!Number.isFinite(atMs)) continue;
      deadlineAtMs =
        deadlineAtMs === null ? atMs : Math.min(deadlineAtMs, atMs);
    }
    if (status.state === "ready" || status.state === "dispatching") {
      hasActiveProject = true;
    }
  }

  return { deadlineAtMs, hasActiveProject };
}

interface ProjectQueueBackstopEntry {
  retainedCount: number;
  timer: ReturnType<typeof setTimeout> | null;
  firesAtMs: number | null;
  deadline: ProjectQueueDeadline;
  refetch: () => Promise<void>;
}

const projectQueueBackstopsBySource = new Map<
  ClientSummarySourceKey,
  ProjectQueueBackstopEntry
>();

function clearProjectQueueTimer(entry: ProjectQueueBackstopEntry): void {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  entry.firesAtMs = null;
}

/** Arm at most one timer per source, for the earliest thing that could happen. */
function syncProjectQueueBackstop(sourceKey: ClientSummarySourceKey): void {
  const entry = projectQueueBackstopsBySource.get(sourceKey);
  if (!entry) return;

  if (entry.retainedCount <= 0) {
    clearProjectQueueTimer(entry);
    return;
  }

  const nowMs = Date.now();
  const { deadlineAtMs, hasActiveProject } = entry.deadline;
  let firesAtMs = deadlineAtMs;
  if (hasActiveProject) {
    const fallbackAtMs = nowMs + PROJECT_QUEUE_ACTIVE_FALLBACK_MS;
    firesAtMs =
      firesAtMs === null ? fallbackAtMs : Math.min(firesAtMs, fallbackAtMs);
  }

  // Nothing scheduled and nothing in flight: events own every remaining
  // transition, so a blocked or paused backlog arms no timer at all.
  if (firesAtMs === null) {
    clearProjectQueueTimer(entry);
    return;
  }

  if (entry.timer && entry.firesAtMs !== null && entry.firesAtMs <= firesAtMs) {
    return;
  }

  clearProjectQueueTimer(entry);
  entry.firesAtMs = firesAtMs;
  entry.timer = setTimeout(
    () => {
      entry.timer = null;
      entry.firesAtMs = null;
      void entry
        .refetch()
        .catch(() => {
          // A failed backstop read leaves the deadline in place; the next
          // sync re-arms rather than abandoning the queue.
        })
        .finally(() => {
          syncProjectQueueBackstop(sourceKey);
        });
    },
    Math.max(PROJECT_QUEUE_MIN_DELAY_MS, firesAtMs - nowMs),
  );
}

function retainProjectQueueBackstop(
  sourceKey: ClientSummarySourceKey,
): () => void {
  let entry = projectQueueBackstopsBySource.get(sourceKey);
  if (!entry) {
    entry = {
      retainedCount: 0,
      timer: null,
      firesAtMs: null,
      deadline: NO_PROJECT_QUEUE_DEADLINE,
      refetch: async () => {},
    };
    projectQueueBackstopsBySource.set(sourceKey, entry);
  }
  entry.retainedCount += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.retainedCount = Math.max(0, entry.retainedCount - 1);
    if (entry.retainedCount === 0) {
      clearProjectQueueTimer(entry);
      projectQueueBackstopsBySource.delete(sourceKey);
    }
  };
}

function updateProjectQueueBackstop(
  sourceKey: ClientSummarySourceKey,
  deadline: ProjectQueueDeadline,
  refetch: () => Promise<void>,
): void {
  const entry = projectQueueBackstopsBySource.get(sourceKey);
  if (!entry) return;
  entry.deadline = deadline;
  entry.refetch = refetch;
  syncProjectQueueBackstop(sourceKey);
}

export function resetProjectQueueBackstopsForTests(): void {
  for (const entry of projectQueueBackstopsBySource.values()) {
    clearProjectQueueTimer(entry);
  }
  projectQueueBackstopsBySource.clear();
}

export function useProjectQueues(
  projectIds: readonly string[],
): UseProjectQueuesResult {
  const { version } = useVersion();
  const runtime = useCurrentSourceRuntime();
  const sourceKey = runtime.sourceKey;
  const sourceSummary = runtime.summary;
  const remoteConnection = useOptionalRemoteConnection();
  const enabled = serverSupportsProjectQueue(version);
  const ready =
    !isRemoteClient() ||
    (remoteConnection !== null && remoteConnection.connection !== null);
  const normalizedProjectIds = useMemo(
    () => uniqueProjectIds(projectIds),
    [projectIds],
  );
  const storedQueuesByProject =
    useProjectQueueItemsByProject(normalizedProjectIds);
  const storedGlobalItems = useProjectQueueGlobalItems(normalizedProjectIds);
  const storedDispatchState = useProjectQueueDispatchState();
  const storedRecoveredSessionQueues = useProjectQueueRecoveredSessionQueues();
  const storedProjectStatusesByProject =
    useProjectQueueProjectStatusesByProject();
  const [mutatingItemId, setMutatingItemId] = useState<string | null>(null);
  const [mutatingDispatchState, setMutatingDispatchState] = useState(false);
  const [mutatingPromoteItemId, setMutatingPromoteItemId] = useState<
    string | null
  >(null);
  const [mutationError, setMutationError] = useState<Error | null>(null);
  const queryEnabled = enabled && normalizedProjectIds.length > 0;
  const hasData = Object.keys(storedQueuesByProject).length > 0;
  const {
    loading,
    error: queryError,
    refetch,
  } = useRetainedClientQuery({
    sourceKey,
    key: PROJECT_QUEUE_QUERY_KEY,
    bootstrapTier: "navigation",
    enabled: queryEnabled,
    ready,
    hasData,
    revalidateOn: PROJECT_QUEUE_REVALIDATE_EVENTS,
    fetcher: () => api.getProjectQueueItems(),
    applySnapshot: (data, context) => {
      sourceSummary.reportProjectQueueGlobalCollectionSnapshot(
        data,
        context.requestStartedAt,
      );
    },
  });

  const updateItem = useCallback(
    async (
      projectId: string,
      itemId: string,
      request: UpdateProjectQueueItemRequest,
    ) => {
      setMutatingItemId(itemId);
      setMutationError(null);
      const requestSummary = sourceSummary;
      try {
        const response = await api.updateProjectQueueItem(
          projectId,
          itemId,
          request,
        );
        requestSummary.reportProjectQueueCollectionSnapshot(response.queue);
      } catch (err) {
        setMutationError(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        setMutatingItemId(null);
      }
    },
    [sourceSummary],
  );

  const deleteItem = useCallback(
    async (projectId: string, itemId: string) => {
      setMutatingItemId(itemId);
      setMutationError(null);
      const requestSummary = sourceSummary;
      try {
        const response = await api.deleteProjectQueueItem(projectId, itemId);
        requestSummary.reportProjectQueueCollectionSnapshot(response.queue);
      } catch (err) {
        setMutationError(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        setMutatingItemId(null);
      }
    },
    [sourceSummary],
  );

  const retryItem = useCallback(
    async (projectId: string, itemId: string) => {
      setMutatingItemId(itemId);
      setMutationError(null);
      const requestSummary = sourceSummary;
      try {
        const response = await api.retryProjectQueueItem(projectId, itemId);
        requestSummary.reportProjectQueueCollectionSnapshot(response.queue);
      } catch (err) {
        setMutationError(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        setMutatingItemId(null);
      }
    },
    [sourceSummary],
  );

  const moveItemToTop = useCallback(
    async (projectId: string, itemId: string) => {
      setMutatingItemId(itemId);
      setMutationError(null);
      const requestSummary = sourceSummary;
      try {
        const response = await api.moveProjectQueueItemToTop(projectId, itemId);
        requestSummary.reportProjectQueueCollectionSnapshot(response.queue);
      } catch (err) {
        setMutationError(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        setMutatingItemId(null);
      }
    },
    [sourceSummary],
  );

  const refetchQueues = useCallback(async () => {
    setMutationError(null);
    await refetch();
  }, [refetch]);

  const pauseDispatch = useCallback(async () => {
    setMutatingDispatchState(true);
    setMutationError(null);
    const requestSummary = sourceSummary;
    try {
      const response = await api.pauseProjectQueueDispatch();
      requestSummary.reportProjectQueueGlobalCollectionSnapshot(response);
    } catch (err) {
      setMutationError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      setMutatingDispatchState(false);
    }
  }, [sourceSummary]);

  const resumeDispatch = useCallback(async () => {
    setMutatingDispatchState(true);
    setMutationError(null);
    const requestSummary = sourceSummary;
    try {
      const response = await api.resumeProjectQueueDispatch();
      requestSummary.reportProjectQueueGlobalCollectionSnapshot(response);
    } catch (err) {
      setMutationError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      setMutatingDispatchState(false);
    }
  }, [sourceSummary]);

  const promoteNow = useCallback(
    async (
      projectId: string,
      itemId: string,
      options: { force?: boolean; deliveryIntent?: "steer" } = {},
    ) => {
      setMutatingPromoteItemId(itemId);
      setMutationError(null);
      const requestSummary = sourceSummary;
      try {
        const response = await api.promoteProjectQueueNow(projectId, {
          itemId,
          ...(options.force ? { force: true } : {}),
          ...(options.deliveryIntent
            ? { deliveryIntent: options.deliveryIntent }
            : {}),
        });
        requestSummary.reportProjectQueueGlobalCollectionSnapshot(response);
        return response.promoteResult;
      } catch (err) {
        setMutationError(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        setMutatingPromoteItemId(null);
      }
    },
    [sourceSummary],
  );

  const items = useMemo(
    () =>
      enabled
        ? storedGlobalItems.length > 0
          ? storedGlobalItems
          : flattenQueues(storedQueuesByProject)
        : [],
    [enabled, storedGlobalItems, storedQueuesByProject],
  );
  const projectIdSet = useMemo(
    () => new Set(normalizedProjectIds),
    [normalizedProjectIds],
  );
  const recoveredSessionQueues = useMemo(
    () =>
      enabled
        ? storedRecoveredSessionQueues.filter((item) =>
            projectIdSet.has(item.projectId),
          )
        : [],
    [enabled, projectIdSet, storedRecoveredSessionQueues],
  );

  const hasBacklog = items.length > 0 || recoveredSessionQueues.length > 0;
  const deadline = useMemo(
    () =>
      enabled && hasBacklog
        ? readProjectQueueDeadline(storedProjectStatusesByProject)
        : NO_PROJECT_QUEUE_DEADLINE,
    [enabled, hasBacklog, storedProjectStatusesByProject],
  );

  // One backstop owner per source, not one interval per mounted consumer.
  useEffect(() => {
    if (!enabled) return undefined;
    return retainProjectQueueBackstop(sourceKey);
  }, [enabled, sourceKey]);

  useEffect(() => {
    if (!enabled) return;
    updateProjectQueueBackstop(sourceKey, deadline, refetchQueues);
  }, [enabled, sourceKey, deadline, refetchQueues]);

  return {
    queuesByProject: enabled ? storedQueuesByProject : {},
    items,
    projectStatusesByProject: enabled ? storedProjectStatusesByProject : {},
    recoveredSessionQueues,
    loading,
    error: mutationError ?? queryError,
    mutatingItemId,
    mutatingDispatchState,
    mutatingPromoteItemId,
    dispatchState: enabled ? storedDispatchState : RUNNING_DISPATCH_STATE,
    refetch: refetchQueues,
    pauseDispatch,
    resumeDispatch,
    promoteNow,
    updateItem,
    deleteItem,
    retryItem,
    moveItemToTop,
  };
}
