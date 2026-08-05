import type { HostAwakeStatus } from "@yep-anywhere/shared";
import { useSyncExternalStore } from "react";
import { useOptionalRemoteConnection } from "../contexts/RemoteConnectionContext";
import { createClientQueryKey } from "../lib/clientQueryController";
import {
  type ClientSummarySourceKey,
  LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
  REMOTE_NONE_CLIENT_SUMMARY_SOURCE_KEY,
  useClientSummarySourceKey,
} from "../lib/clientSummaryStore";
import { isRemoteClient } from "../lib/connection";
import { getSourceRuntimeRegistry } from "../lib/sourceRuntime";
import { useRetainedClientQuery } from "./useRetainedClientQuery";

interface HostAwakeStatusSnapshot {
  status: HostAwakeStatus | null;
  observedAt?: number;
}

interface HostAwakeStatusResponse {
  status: HostAwakeStatus;
}

const EMPTY_SNAPSHOT: HostAwakeStatusSnapshot = { status: null };
const QUERY_KEY = createClientQueryKey({ endpoint: "host-awake-status" });
const snapshots = new Map<ClientSummarySourceKey, HostAwakeStatusSnapshot>();
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of Array.from(listeners)) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(
  sourceKey: ClientSummarySourceKey,
): HostAwakeStatusSnapshot {
  return snapshots.get(sourceKey) ?? EMPTY_SNAPSHOT;
}

function acceptSnapshot(
  sourceKey: ClientSummarySourceKey,
  status: HostAwakeStatus,
  observedAt: number,
): void {
  const current = snapshots.get(sourceKey);
  if (current?.observedAt !== undefined && current.observedAt > observedAt) {
    return;
  }
  snapshots.set(sourceKey, { status, observedAt });
  emitChange();
}

export function resetHostAwakeStatusForTests(): void {
  snapshots.clear();
  listeners.clear();
}

export function useHostAwakeStatus(enabled: boolean) {
  const sourceKey = useClientSummarySourceKey();
  const remoteConnection = useOptionalRemoteConnection();
  const hasResolvedRemoteSource =
    sourceKey !== LOCAL_CLIENT_SUMMARY_SOURCE_KEY &&
    sourceKey !== REMOTE_NONE_CLIENT_SUMMARY_SOURCE_KEY;
  const ready =
    !isRemoteClient() ||
    (remoteConnection !== null &&
      remoteConnection.connection !== null &&
      hasResolvedRemoteSource);
  const snapshot = useSyncExternalStore(
    subscribe,
    () => getSnapshot(sourceKey),
    () => EMPTY_SNAPSHOT,
  );

  const query = useRetainedClientQuery<HostAwakeStatusResponse>({
    sourceKey,
    key: QUERY_KEY,
    bootstrapTier: "supplementary",
    enabled,
    ready,
    hasData: snapshot.observedAt !== undefined,
    staleTimeMs: 0,
    revalidateOn: ["reconnect"],
    fetcher: (context) => {
      const forceRefresh =
        (context.meta as { forceServerRefresh?: boolean } | undefined)
          ?.forceServerRefresh === true;
      return getSourceRuntimeRegistry()
        .getOrCreateSourceRuntime(context.sourceKey)
        .transport.fetch<HostAwakeStatusResponse>(
          `/settings/host-awake/status${forceRefresh ? "?refresh=1" : ""}`,
        );
    },
    applySnapshot: (response, context) => {
      acceptSnapshot(
        context.sourceKey,
        response.status,
        context.requestStartedAt,
      );
    },
  });

  return {
    status: snapshot.status,
    isLoading: query.loading,
    error: query.error,
    refetch: (forceServerRefresh = false) =>
      query.refetch({
        force: true,
        meta: forceServerRefresh ? { forceServerRefresh: true } : undefined,
      }),
  };
}
