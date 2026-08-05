/**
 * The reload-status family's shared per-source state.
 *
 * `useReloadNotifications` is mounted by the app shell and again by the Settings
 * layout and the Development pane, so every consumer used to issue its own
 * `/dev/status`, `/status/workers`, and `/dev/safe-restart` on mount, on
 * reconnect, and on visibility restore, and to install its own `activityBus`
 * listeners for the events that update them.
 *
 * None of those are facts about a mounted consumer; they are facts about the
 * connected source. They live here once per source, consumers read them through
 * `useSyncExternalStore`, and `useRetainedClientQuery` owns the acquisition.
 *
 * Reading the shared result back through a per-hook `useState` is the trap this
 * shape exists to avoid: `applySnapshot` runs in the retained owner's closure,
 * so only whichever consumer happened to own the request would ever see the
 * value. Banner policy — which notices are pending, which the viewer dismissed —
 * stays in the hook, because that genuinely is per-consumer view state.
 */
import type { SafeRestartState } from "@yep-anywhere/shared";
import { fetchJSON } from "../api/client";
import { type WorkerActivityEvent, activityBus } from "./activityBus";
import {
  type ClientQueryRequestContext,
  createClientQueryKey,
} from "./clientQueryController";
import type { ClientSummarySourceKey } from "./clientSummaryStore";

export interface DevStatus {
  noBackendReload: boolean;
  noFrontendReload: boolean;
  backendDirty?: boolean;
}

export const DEV_STATUS_QUERY_KEY = createClientQueryKey({
  endpoint: "dev-status",
});
export const RESTART_SAFETY_QUERY_KEY = createClientQueryKey({
  endpoint: "dev-restart-safety",
});

const IDLE_SAFE_RESTART_STATE: SafeRestartState = {
  status: "idle",
  blockers: [],
  canRestartNow: true,
  updatedAt: "",
};

const EMPTY_WORKER_ACTIVITY: WorkerActivityEvent = {
  type: "worker-activity-changed",
  activeWorkers: 0,
  interruptibleSessionCount: 0,
  queueLength: 0,
  queuedSessionMessageCount: 0,
  hasActiveWork: false,
  timestamp: "",
};

const SAFETY_RETRY_DELAY_MS = 1_000;
const MAX_SAFETY_RETRIES = 3;

interface SourceSnapshotStore<T> {
  get(sourceKey: ClientSummarySourceKey): T;
  set(sourceKey: ClientSummarySourceKey, next: T): void;
  update(sourceKey: ClientSummarySourceKey, patch: (current: T) => T): void;
  subscribe(listener: () => void): () => void;
  reset(): void;
}

/**
 * `get` must return the same object until something changes it, because
 * `useSyncExternalStore` treats a new identity as a change; the shared `empty`
 * constant covers sources nothing has written yet.
 */
function createSourceSnapshotStore<T>(empty: T): SourceSnapshotStore<T> {
  const bySource = new Map<ClientSummarySourceKey, T>();
  const listeners = new Set<() => void>();

  const get = (sourceKey: ClientSummarySourceKey): T =>
    bySource.get(sourceKey) ?? empty;

  const set = (sourceKey: ClientSummarySourceKey, next: T): void => {
    bySource.set(sourceKey, next);
    for (const listener of Array.from(listeners)) {
      listener();
    }
  };

  return {
    get,
    set,
    update: (sourceKey, patch) => {
      set(sourceKey, patch(get(sourceKey)));
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset: () => {
      bySource.clear();
      listeners.clear();
    },
  };
}

export interface DevStatusSnapshot {
  devStatus: DevStatus | null;
  observedAt?: number;
}

const EMPTY_DEV_STATUS_SNAPSHOT: DevStatusSnapshot = { devStatus: null };

export interface RestartSafetySnapshot {
  workerActivity: WorkerActivityEvent;
  workerActivityLoaded: boolean;
  safeRestart: SafeRestartState;
  safeRestartLoaded: boolean;
}

const EMPTY_RESTART_SAFETY_SNAPSHOT: RestartSafetySnapshot = {
  workerActivity: EMPTY_WORKER_ACTIVITY,
  workerActivityLoaded: false,
  safeRestart: IDLE_SAFE_RESTART_STATE,
  safeRestartLoaded: false,
};

const devStatusStore = createSourceSnapshotStore(EMPTY_DEV_STATUS_SNAPSHOT);
const restartSafetyStore = createSourceSnapshotStore(
  EMPTY_RESTART_SAFETY_SNAPSHOT,
);

export const subscribeDevStatus = devStatusStore.subscribe;
export const subscribeRestartSafety = restartSafetyStore.subscribe;

export function getDevStatusSnapshot(
  sourceKey: ClientSummarySourceKey,
): DevStatusSnapshot {
  return devStatusStore.get(sourceKey);
}

export function getRestartSafetySnapshot(
  sourceKey: ClientSummarySourceKey,
): RestartSafetySnapshot {
  return restartSafetyStore.get(sourceKey);
}

export async function devStatusFetcher(): Promise<DevStatus | null> {
  return (await fetchJSON<DevStatus>("/dev/status")) ?? null;
}

/**
 * A failed read leaves the last known mode in place rather than blanking it.
 * The retained query still reports the failure through its `error`; discarding
 * a known-good mode on a transient blip only made the banners flicker.
 */
export function applyDevStatusSnapshot(
  devStatus: DevStatus | null,
  context: ClientQueryRequestContext,
): void {
  const current = devStatusStore.get(context.sourceKey);
  if (
    current.observedAt !== undefined &&
    current.observedAt > context.requestStartedAt
  ) {
    return;
  }
  devStatusStore.set(context.sourceKey, {
    devStatus,
    observedAt: context.requestStartedAt,
  });
}

export interface RestartSafetyResult {
  workerActivity: WorkerActivityEvent;
  safeRestart: SafeRestartState;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchRestartSafetyOnce(): Promise<RestartSafetyResult> {
  const [workerActivity, safeRestart] = await Promise.all([
    fetchJSON<WorkerActivityEvent>("/status/workers"),
    fetchJSON<SafeRestartState>("/dev/safe-restart"),
  ]);
  if (!workerActivity) throw new Error("Missing worker activity state");
  if (!safeRestart) throw new Error("Missing safe restart state");
  return { workerActivity, safeRestart };
}

/**
 * Worker activity and safe-restart state are only ever displayed together —
 * `backendReloadSafetyKnown` is the conjunction — so the retained query treats
 * them as one acquisition, and one failure retries the pair.
 *
 * The retry lives inside the fetcher rather than in a consumer effect so that it
 * stays one timer per source. A per-hook retry would rebuild exactly the
 * fan-out this module removes.
 */
export async function restartSafetyFetcher(): Promise<RestartSafetyResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_SAFETY_RETRIES; attempt += 1) {
    if (attempt > 0) {
      await delay(SAFETY_RETRY_DELAY_MS);
    }
    try {
      return await fetchRestartSafetyOnce();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function applyRestartSafetySnapshot(
  result: RestartSafetyResult,
  context: ClientQueryRequestContext,
): void {
  restartSafetyStore.update(context.sourceKey, (current) => ({
    ...current,
    workerActivity: result.workerActivity,
    workerActivityLoaded: true,
    safeRestart: result.safeRestart,
    safeRestartLoaded: true,
  }));
}

/** Adopt a safe-restart state the caller already has, such as a mutation reply. */
export function acceptSafeRestartState(
  sourceKey: ClientSummarySourceKey,
  safeRestart: SafeRestartState,
): void {
  restartSafetyStore.update(sourceKey, (current) => ({
    ...current,
    safeRestart,
    safeRestartLoaded: true,
  }));
}

function acceptWorkerActivity(
  sourceKey: ClientSummarySourceKey,
  workerActivity: WorkerActivityEvent,
): void {
  restartSafetyStore.update(sourceKey, (current) => ({
    ...current,
    workerActivity,
    workerActivityLoaded: true,
  }));
}

interface RetainedEventEntry {
  retainedCount: number;
  unsubscribers: (() => void)[];
}

const eventEntriesBySource = new Map<
  ClientSummarySourceKey,
  RetainedEventEntry
>();

/**
 * The push updates for this family, retained once per source.
 *
 * These events carry restart-safety facts, so they belong to the shared
 * snapshot rather than to each mounted consumer. `backend-reloaded` also
 * consumes the persisted dirty flag: the reload it announces is the thing that
 * flag was asking for, and a consumer that mounts afterwards must not be told
 * by a stale snapshot that the backend is still dirty.
 */
export function retainDevReloadStatusEvents(
  sourceKey: ClientSummarySourceKey,
): () => void {
  let entry = eventEntriesBySource.get(sourceKey);
  if (!entry) {
    entry = { retainedCount: 0, unsubscribers: [] };
    eventEntriesBySource.set(sourceKey, entry);
    entry.unsubscribers.push(
      activityBus.on("worker-activity-changed", (data: WorkerActivityEvent) => {
        acceptWorkerActivity(sourceKey, data);
      }),
      activityBus.on("safe-restart-changed", (data) => {
        acceptSafeRestartState(sourceKey, data.state);
      }),
      activityBus.on("backend-reloaded", () => {
        acceptSafeRestartState(sourceKey, IDLE_SAFE_RESTART_STATE);
        devStatusStore.update(sourceKey, (current) =>
          current.devStatus?.backendDirty
            ? {
                ...current,
                devStatus: { ...current.devStatus, backendDirty: false },
              }
            : current,
        );
      }),
    );
  }
  const boundEntry = entry;
  boundEntry.retainedCount += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    boundEntry.retainedCount -= 1;
    if (boundEntry.retainedCount > 0) return;
    for (const unsubscribe of boundEntry.unsubscribers) {
      unsubscribe();
    }
    eventEntriesBySource.delete(sourceKey);
  };
}

export function resetDevReloadStatusForTests(): void {
  for (const entry of eventEntriesBySource.values()) {
    for (const unsubscribe of entry.unsubscribers) {
      unsubscribe();
    }
  }
  eventEntriesBySource.clear();
  devStatusStore.reset();
  restartSafetyStore.reset();
}
