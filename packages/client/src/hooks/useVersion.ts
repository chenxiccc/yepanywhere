import { useCallback, useEffect, useSyncExternalStore } from "react";
import { type VersionInfo, api } from "../api/client";
import { useOptionalRemoteConnection } from "../contexts/RemoteConnectionContext";
import {
  createClientQueryKey,
  ensureClientQuery,
  type ClientQueryCoverage,
  type ClientQueryRequestContext,
} from "../lib/clientQueryController";
import {
  type ClientSummarySourceKey,
  useClientSummarySourceKey,
} from "../lib/clientSummaryStore";
import { isRemoteClient } from "../lib/connection";
import { useRetainedClientQuery } from "./useRetainedClientQuery";

interface UseVersionOptions {
  /** Request a fresh update check on initial mount. */
  freshOnMount?: boolean;
}

const VERSION_QUERY_KEY = createClientQueryKey({ endpoint: "version" });
const VERSION_REVALIDATE_EVENTS = ["reconnect"] as const;
const PENDING_SPEECH_BACKEND_RETRY_MS = 1000;

/**
 * `fresh` is coverage rather than request metadata because the controller
 * shares an in-flight request whenever the available coverage satisfies the
 * requested coverage. An ordinary need is satisfied by a fresh response, but a
 * fresh need must never settle for an ordinary one — which is exactly the
 * asymmetry `coverageSatisfies` gives an unrecognized key.
 */
const FRESH_VERSION_COVERAGE: ClientQueryCoverage = { fresh: true };

interface VersionSnapshot {
  version: VersionInfo | null;
  observedAt?: number;
}

const EMPTY_VERSION_SNAPSHOT: VersionSnapshot = { version: null };

const versionSnapshotsBySource = new Map<
  ClientSummarySourceKey,
  VersionSnapshot
>();
const versionSnapshotListeners = new Set<() => void>();

function emitVersionSnapshotChange(): void {
  for (const listener of Array.from(versionSnapshotListeners)) {
    listener();
  }
}

function subscribeVersionSnapshots(listener: () => void): () => void {
  versionSnapshotListeners.add(listener);
  return () => {
    versionSnapshotListeners.delete(listener);
  };
}

function getVersionSnapshot(
  sourceKey: ClientSummarySourceKey,
): VersionSnapshot {
  return versionSnapshotsBySource.get(sourceKey) ?? EMPTY_VERSION_SNAPSHOT;
}

function acceptVersionSnapshot(
  sourceKey: ClientSummarySourceKey,
  version: VersionInfo,
  observedAt: number,
): void {
  const current = versionSnapshotsBySource.get(sourceKey);
  if (current?.observedAt !== undefined && current.observedAt > observedAt) {
    return;
  }

  versionSnapshotsBySource.set(sourceKey, { version, observedAt });
  emitVersionSnapshotChange();
  syncPendingSpeechFollowUp(sourceKey);
}

function versionFetcher(
  context: ClientQueryRequestContext,
): Promise<VersionInfo> {
  return api.getVersion({ fresh: context.coverage.fresh === true });
}

function applyVersionSnapshot(
  version: VersionInfo,
  context: ClientQueryRequestContext,
): void {
  acceptVersionSnapshot(context.sourceKey, version, context.requestStartedAt);
}

/**
 * A forced update check for one source. Concurrent callers coalesce through the
 * controller's in-flight sharing; the resolved snapshot is returned so the
 * About surface can read the checked result directly.
 */
async function ensureFreshVersion(
  sourceKey: ClientSummarySourceKey,
): Promise<VersionInfo | null> {
  try {
    await ensureClientQuery({
      sourceKey,
      key: VERSION_QUERY_KEY,
      coverage: FRESH_VERSION_COVERAGE,
      force: true,
      fetcher: versionFetcher,
      applySnapshot: applyVersionSnapshot,
    });
  } catch {
    return null;
  }
  return getVersionSnapshot(sourceKey).version;
}

interface VersionFollowUpEntry {
  retainedCount: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const versionFollowUpsBySource = new Map<
  ClientSummarySourceKey,
  VersionFollowUpEntry
>();

function hasPendingSpeechBackend(version: VersionInfo | null): boolean {
  return (
    version?.voiceBackendStatuses?.some(
      (backend) => backend.validationStatus === "pending",
    ) ?? false
  );
}

/**
 * A restarted server can advertise configured speech backends before their
 * lightweight validation finishes, so the snapshot has to be re-read until they
 * settle. That is a property of the source's snapshot, not of any one mounted
 * consumer, so the follow-up is retained once per source instead of letting
 * every mounted `useVersion()` arm its own timer.
 */
function syncPendingSpeechFollowUp(sourceKey: ClientSummarySourceKey): void {
  const entry = versionFollowUpsBySource.get(sourceKey);
  if (!entry) return;

  const pending = hasPendingSpeechBackend(
    getVersionSnapshot(sourceKey).version,
  );
  if (!pending || entry.retainedCount <= 0) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    return;
  }
  if (entry.timer) return;

  entry.timer = setTimeout(() => {
    entry.timer = null;
    void ensureClientQuery({
      sourceKey,
      key: VERSION_QUERY_KEY,
      force: true,
      fetcher: versionFetcher,
      applySnapshot: applyVersionSnapshot,
    })
      .catch(() => {
        // A failed follow-up keeps the backend pending, so the `finally` below
        // re-arms rather than abandoning validation.
      })
      .finally(() => {
        syncPendingSpeechFollowUp(sourceKey);
      });
  }, PENDING_SPEECH_BACKEND_RETRY_MS);
}

function retainPendingSpeechFollowUp(
  sourceKey: ClientSummarySourceKey,
): () => void {
  let entry = versionFollowUpsBySource.get(sourceKey);
  if (!entry) {
    entry = { retainedCount: 0, timer: null };
    versionFollowUpsBySource.set(sourceKey, entry);
  }
  entry.retainedCount += 1;
  syncPendingSpeechFollowUp(sourceKey);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.retainedCount = Math.max(0, entry.retainedCount - 1);
    if (entry.retainedCount === 0) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      versionFollowUpsBySource.delete(sourceKey);
    }
  };
}

function useVersionSnapshot(
  sourceKey: ClientSummarySourceKey,
): VersionSnapshot {
  return useSyncExternalStore(
    subscribeVersionSnapshots,
    () => getVersionSnapshot(sourceKey),
    () => EMPTY_VERSION_SNAPSHOT,
  );
}

export function resetVersionSnapshotsForTests(): void {
  versionSnapshotsBySource.clear();
  versionSnapshotListeners.clear();
  for (const entry of versionFollowUpsBySource.values()) {
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
  }
  versionFollowUpsBySource.clear();
}

/**
 * Subscribe to the server version/capability snapshot for the connected source.
 *
 * Every consumer shares one retained snapshot: mounting after it resolves
 * issues no request. `freshOnMount` retains a fresh-coverage query instead, so
 * every acquisition that consumer owns — mount, reconnect, explicit check — is
 * an update check, while all other consumers stay on ordinary reads.
 *
 * Returns:
 * - version: Version info (current, latest, updateAvailable, optional capabilities)
 * - loading: Whether an acquisition this consumer needs is in progress
 * - error: Any error that occurred during fetch
 * - refetch: Force an ordinary refresh of the shared snapshot
 * - refetchFresh: Force an update check and resolve with the checked snapshot
 */
export function useVersion(options?: UseVersionOptions) {
  const freshOnMount = options?.freshOnMount ?? false;
  const sourceKey = useClientSummarySourceKey();
  const remoteConnection = useOptionalRemoteConnection();
  const ready =
    !isRemoteClient() ||
    (remoteConnection !== null && remoteConnection.connection !== null);
  const snapshot = useVersionSnapshot(sourceKey);

  const { loading, error, refetch } = useRetainedClientQuery({
    sourceKey,
    key: VERSION_QUERY_KEY,
    coverage: freshOnMount ? FRESH_VERSION_COVERAGE : undefined,
    // An update check must not be answered from a cached entry, so this
    // consumer's own acquisitions always reach the server.
    staleTimeMs: freshOnMount ? 0 : undefined,
    ready,
    hasData: snapshot.observedAt !== undefined,
    revalidateOn: VERSION_REVALIDATE_EVENTS,
    fetcher: versionFetcher,
    applySnapshot: applyVersionSnapshot,
  });

  useEffect(() => {
    if (!ready) return undefined;
    return retainPendingSpeechFollowUp(sourceKey);
  }, [ready, sourceKey]);

  // The retained query reports failures through `error` rather than rejecting,
  // so the shared snapshot is the result either way.
  const refetchOrdinary = useCallback(async () => {
    await refetch();
    return getVersionSnapshot(sourceKey).version;
  }, [refetch, sourceKey]);

  const refetchFresh = useCallback(
    () => ensureFreshVersion(sourceKey),
    [sourceKey],
  );

  return {
    version: snapshot.version,
    loading,
    error,
    refetch: refetchOrdinary,
    refetchFresh,
  };
}
