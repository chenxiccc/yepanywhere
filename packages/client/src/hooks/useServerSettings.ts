import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ServerSettings } from "../api/client";
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

interface UseServerSettingsResult {
  settings: ServerSettings | null;
  isLoading: boolean;
  error: string | null;
  updateSettings: (updates: Partial<ServerSettings>) => Promise<void>;
  updateSetting: <K extends keyof ServerSettings>(
    key: K,
    value: ServerSettings[K],
  ) => Promise<void>;
  refetch: () => Promise<void>;
}

interface ServerSettingsSnapshot {
  settings: ServerSettings | null;
  observedAt?: number;
}

const EMPTY_SERVER_SETTINGS_SNAPSHOT: ServerSettingsSnapshot = {
  settings: null,
};

const SERVER_SETTINGS_QUERY_KEY = createClientQueryKey({
  endpoint: "settings",
});
const SERVER_SETTINGS_REVALIDATE_EVENTS = ["refresh", "reconnect"] as const;
type ServerSettingsResponse = { settings: ServerSettings };

const serverSettingsSnapshotsBySource = new Map<
  ClientSummarySourceKey,
  ServerSettingsSnapshot
>();
const serverSettingsSnapshotListeners = new Set<() => void>();

function emitServerSettingsSnapshotChange(): void {
  for (const listener of Array.from(serverSettingsSnapshotListeners)) {
    listener();
  }
}

function subscribeServerSettingsSnapshots(listener: () => void): () => void {
  serverSettingsSnapshotListeners.add(listener);
  return () => {
    serverSettingsSnapshotListeners.delete(listener);
  };
}

function getServerSettingsSnapshot(
  sourceKey: ClientSummarySourceKey,
): ServerSettingsSnapshot {
  return (
    serverSettingsSnapshotsBySource.get(sourceKey) ??
    EMPTY_SERVER_SETTINGS_SNAPSHOT
  );
}

function acceptServerSettingsSnapshot(
  sourceKey: ClientSummarySourceKey,
  settings: ServerSettings,
  observedAt: number,
): void {
  const current = serverSettingsSnapshotsBySource.get(sourceKey);
  if (current?.observedAt !== undefined && current.observedAt > observedAt) {
    return;
  }

  serverSettingsSnapshotsBySource.set(sourceKey, {
    settings,
    observedAt,
  });
  emitServerSettingsSnapshotChange();
}

function nextMutationObservedAt(sourceKey: ClientSummarySourceKey): number {
  const currentObservedAt =
    serverSettingsSnapshotsBySource.get(sourceKey)?.observedAt ??
    Number.NEGATIVE_INFINITY;
  return Math.max(Date.now(), currentObservedAt + 1);
}

function getSourceTransport(sourceKey: ClientSummarySourceKey) {
  return getSourceRuntimeRegistry().getOrCreateSourceRuntime(sourceKey)
    .transport;
}

function fetchServerSettingsForSource(
  sourceKey: ClientSummarySourceKey,
): Promise<ServerSettingsResponse> {
  return getSourceTransport(sourceKey).fetch<ServerSettingsResponse>(
    "/settings",
  );
}

function updateServerSettingsForSource(
  sourceKey: ClientSummarySourceKey,
  updates: Partial<ServerSettings>,
): Promise<ServerSettingsResponse> {
  return getSourceTransport(sourceKey).fetch<ServerSettingsResponse>(
    "/settings",
    {
      method: "PUT",
      body: JSON.stringify(updates, (_key, value) =>
        value === undefined ? null : value,
      ),
    },
  );
}

function useServerSettingsSnapshot(
  sourceKey: ClientSummarySourceKey,
): ServerSettingsSnapshot {
  return useSyncExternalStore(
    subscribeServerSettingsSnapshots,
    () => getServerSettingsSnapshot(sourceKey),
    () => EMPTY_SERVER_SETTINGS_SNAPSHOT,
  );
}

export function resetServerSettingsForTests(): void {
  serverSettingsSnapshotsBySource.clear();
  serverSettingsSnapshotListeners.clear();
}

/**
 * Hook for managing server-wide settings.
 * Fetches settings through the retained query controller and provides update
 * functionality.
 */
export function useServerSettings(): UseServerSettingsResult {
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
  const snapshot = useServerSettingsSnapshot(sourceKey);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const {
    loading,
    error: queryError,
    refetch,
  } = useRetainedClientQuery({
    sourceKey,
    key: SERVER_SETTINGS_QUERY_KEY,
    bootstrapTier: "route",
    ready,
    hasData: snapshot.observedAt !== undefined,
    revalidateOn: SERVER_SETTINGS_REVALIDATE_EVENTS,
    fetcher: async (context) => {
      try {
        return await fetchServerSettingsForSource(context.sourceKey);
      } catch (err) {
        console.error("[useServerSettings] Failed to fetch settings:", err);
        throw err;
      }
    },
    applySnapshot: (response, context) => {
      acceptServerSettingsSnapshot(
        context.sourceKey,
        response.settings,
        context.requestStartedAt,
      );
    },
  });

  useEffect(() => {
    if (snapshot.observedAt !== undefined) {
      setMutationError(null);
    }
  }, [snapshot.observedAt]);

  const updateSettings = useCallback(
    async (updates: Partial<ServerSettings>): Promise<void> => {
      const requestSourceKey = sourceKey;
      try {
        setMutationError(null);
        const response = await updateServerSettingsForSource(
          requestSourceKey,
          updates,
        );
        acceptServerSettingsSnapshot(
          requestSourceKey,
          response.settings,
          nextMutationObservedAt(requestSourceKey),
        );
      } catch (err) {
        console.error("[useServerSettings] Failed to update settings:", err);
        setMutationError(
          err instanceof Error ? err.message : "Failed to update settings",
        );
        throw err;
      }
    },
    [sourceKey],
  );

  const updateSetting = useCallback(
    async <K extends keyof ServerSettings>(
      key: K,
      value: ServerSettings[K],
    ): Promise<void> => {
      await updateSettings({ [key]: value });
    },
    [updateSettings],
  );

  return {
    settings: snapshot.settings,
    isLoading: loading,
    error: mutationError ?? (queryError ? queryError.message : null),
    updateSettings,
    updateSetting,
    refetch,
  };
}
