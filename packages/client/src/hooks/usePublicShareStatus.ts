import { useEffect, useSyncExternalStore } from "react";
import { type PublicShareStatusResponse, api } from "../api/client";
import { useOptionalRemoteConnection } from "../contexts/RemoteConnectionContext";
import {
  createClientQueryKey,
  ensureClientQuery,
  type ClientQueryRequestContext,
  type ClientQuerySettlement,
} from "../lib/clientQueryController";
import {
  type ClientSummarySourceKey,
  useClientSummarySourceKey,
} from "../lib/clientSummaryStore";
import { isRemoteClient } from "../lib/connection";
import { useRetainedClientQuery } from "./useRetainedClientQuery";

interface UsePublicShareStatusOptions {
  poll?: boolean;
}

interface UsePublicShareStatusResult {
  status: PublicShareStatusResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const PUBLIC_SHARE_GLOBAL_STATUS_POLL_MS = 5000;
const EMPTY_PUBLIC_SHARE_STATUS_SNAPSHOT: PublicShareStatusSnapshot = {
  status: null,
  error: null,
};
const PUBLIC_SHARE_STATUS_QUERY_KEY = createClientQueryKey({
  endpoint: "public-shares/status",
});
const PUBLIC_SHARE_STATUS_REVALIDATE_EVENTS = ["refresh", "reconnect"] as const;

interface PublicShareStatusSnapshot {
  status: PublicShareStatusResponse | null;
  observedAt?: number;
  error: string | null;
}

interface PublicShareStatusPollEntry {
  retainedCount: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const publicShareStatusSnapshotsBySource = new Map<
  ClientSummarySourceKey,
  PublicShareStatusSnapshot
>();
const publicShareStatusSnapshotListeners = new Set<() => void>();
const publicShareStatusPollersBySource = new Map<
  ClientSummarySourceKey,
  PublicShareStatusPollEntry
>();

function emitPublicShareStatusSnapshotChange(): void {
  for (const listener of Array.from(publicShareStatusSnapshotListeners)) {
    listener();
  }
}

function subscribePublicShareStatusSnapshots(listener: () => void): () => void {
  publicShareStatusSnapshotListeners.add(listener);
  return () => {
    publicShareStatusSnapshotListeners.delete(listener);
  };
}

function getPublicShareStatusSnapshot(
  sourceKey: ClientSummarySourceKey,
): PublicShareStatusSnapshot {
  return (
    publicShareStatusSnapshotsBySource.get(sourceKey) ??
    EMPTY_PUBLIC_SHARE_STATUS_SNAPSHOT
  );
}

function acceptPublicShareStatusSnapshot(
  sourceKey: ClientSummarySourceKey,
  status: PublicShareStatusResponse,
  observedAt: number,
): void {
  const current = publicShareStatusSnapshotsBySource.get(sourceKey);
  if (current?.observedAt !== undefined && current.observedAt > observedAt) {
    return;
  }

  publicShareStatusSnapshotsBySource.set(sourceKey, {
    status,
    observedAt,
    error: null,
  });
  emitPublicShareStatusSnapshotChange();
}

function reportPublicShareStatusError(
  sourceKey: ClientSummarySourceKey,
  error: unknown,
): void {
  const current = getPublicShareStatusSnapshot(sourceKey);
  publicShareStatusSnapshotsBySource.set(sourceKey, {
    ...current,
    error:
      error instanceof Error ? error.message : "Failed to load share status",
  });
  emitPublicShareStatusSnapshotChange();
}

function publicShareStatusFetcher(): Promise<PublicShareStatusResponse> {
  return api.getPublicShareStatus();
}

function applyPublicShareStatusSnapshot(
  status: PublicShareStatusResponse,
  context: ClientQueryRequestContext,
): void {
  acceptPublicShareStatusSnapshot(
    context.sourceKey,
    status,
    context.requestStartedAt,
  );
}

function ensurePublicShareStatus(
  sourceKey: ClientSummarySourceKey,
  force: boolean,
): Promise<ClientQuerySettlement> {
  return ensureClientQuery({
    sourceKey,
    key: PUBLIC_SHARE_STATUS_QUERY_KEY,
    force,
    fetcher: publicShareStatusFetcher,
    applySnapshot: applyPublicShareStatusSnapshot,
  });
}

function schedulePublicShareStatusPoll(
  sourceKey: ClientSummarySourceKey,
  entry: PublicShareStatusPollEntry,
): void {
  if (entry.retainedCount <= 0 || entry.timer) {
    return;
  }

  entry.timer = setTimeout(() => {
    entry.timer = null;
    void ensurePublicShareStatus(sourceKey, true)
      .catch((error) => {
        reportPublicShareStatusError(sourceKey, error);
      })
      .finally(() => {
        schedulePublicShareStatusPoll(sourceKey, entry);
      });
  }, PUBLIC_SHARE_GLOBAL_STATUS_POLL_MS);
}

function retainPublicShareStatusPoll(
  sourceKey: ClientSummarySourceKey,
): () => void {
  let entry = publicShareStatusPollersBySource.get(sourceKey);
  if (!entry) {
    entry = { retainedCount: 0, timer: null };
    publicShareStatusPollersBySource.set(sourceKey, entry);
  }
  entry.retainedCount += 1;
  schedulePublicShareStatusPoll(sourceKey, entry);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.retainedCount = Math.max(0, entry.retainedCount - 1);
    if (entry.retainedCount === 0) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      publicShareStatusPollersBySource.delete(sourceKey);
    }
  };
}

function usePublicShareStatusSnapshot(
  sourceKey: ClientSummarySourceKey,
): PublicShareStatusSnapshot {
  return useSyncExternalStore(
    subscribePublicShareStatusSnapshots,
    () => getPublicShareStatusSnapshot(sourceKey),
    () => EMPTY_PUBLIC_SHARE_STATUS_SNAPSHOT,
  );
}

export function resetPublicShareStatusForTests(): void {
  publicShareStatusSnapshotsBySource.clear();
  publicShareStatusSnapshotListeners.clear();
  for (const entry of publicShareStatusPollersBySource.values()) {
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
  }
  publicShareStatusPollersBySource.clear();
}

export function usePublicShareStatus(
  options: UsePublicShareStatusOptions = {},
): UsePublicShareStatusResult {
  const { poll = false } = options;
  const sourceKey = useClientSummarySourceKey();
  const remoteConnection = useOptionalRemoteConnection();
  const ready =
    !isRemoteClient() ||
    (remoteConnection !== null && remoteConnection.connection !== null);
  const snapshot = usePublicShareStatusSnapshot(sourceKey);

  useEffect(() => {
    if (!poll || !ready) {
      return undefined;
    }
    return retainPublicShareStatusPoll(sourceKey);
  }, [poll, ready, sourceKey]);

  const { loading, error, refetch } = useRetainedClientQuery({
    sourceKey,
    key: PUBLIC_SHARE_STATUS_QUERY_KEY,
    bootstrapTier: "supplementary",
    ready,
    hasData: snapshot.observedAt !== undefined,
    revalidateOn: PUBLIC_SHARE_STATUS_REVALIDATE_EVENTS,
    fetcher: publicShareStatusFetcher,
    applySnapshot: applyPublicShareStatusSnapshot,
  });

  return {
    status: snapshot.status,
    loading,
    error: snapshot.error ?? (error ? error.message : null),
    refresh: async () => {
      await refetch();
    },
  };
}
