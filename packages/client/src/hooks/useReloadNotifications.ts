import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { SafeRestartState } from "@yep-anywhere/shared";
import { fetchJSON } from "../api/client";
import {
  type SourceChangeEvent,
  activityBus,
  getInterruptibleSessionCount,
} from "../lib/activityBus";
import { useClientSummarySourceKey } from "../lib/clientSummaryStore";
import {
  DEV_STATUS_QUERY_KEY,
  RESTART_SAFETY_QUERY_KEY,
  acceptSafeRestartState,
  applyDevStatusSnapshot,
  applyRestartSafetySnapshot,
  devStatusFetcher,
  getDevStatusSnapshot,
  getRestartSafetySnapshot,
  restartSafetyFetcher,
  retainDevReloadStatusEvents,
  subscribeDevStatus,
  subscribeRestartSafety,
} from "../lib/devReloadStatusStore";
import {
  buildFrontendReloadUrl,
  getFrontendReloadCleanupUrl,
} from "../lib/frontendReload";
import { useRetainedClientQuery } from "./useRetainedClientQuery";

export {
  FRONTEND_RELOAD_QUERY_PARAM,
  buildFrontendReloadUrl,
  getFrontendReloadCleanupUrl,
} from "../lib/frontendReload";

// Re-export for consumers
export type {
  SourceChangeEvent,
  WorkerActivityEvent,
} from "../lib/activityBus";

export interface PendingReloads {
  backend: boolean;
  frontend: boolean;
}

/**
 * Both queries revalidate on the same signals the hook used to sync on. The
 * debounce is zero so a reload notice stays as immediate as it was; the owner
 * still collapses a burst — a reconnect and the visibility restore that follows
 * it — into one request.
 */
const RELOAD_STATUS_REVALIDATE_EVENTS = ["reconnect", "refresh"] as const;
const RELOAD_STATUS_DEBOUNCE_MS = 0;

function subscribeActivityConnected(listener: () => void): () => void {
  return activityBus.subscribeConnected(listener);
}

function getActivityConnected(): boolean {
  return activityBus.connected;
}

export function getVisibleReloadBanners(
  isManualReloadMode: boolean,
  pendingReloads: PendingReloads,
  options: { backendReloadSafetyKnown?: boolean } = {},
): PendingReloads {
  if (!isManualReloadMode) {
    return { backend: false, frontend: false };
  }
  if (pendingReloads.backend) {
    if (options.backendReloadSafetyKnown === false) {
      return { backend: false, frontend: false };
    }
    return { backend: true, frontend: false };
  }
  return { backend: false, frontend: pendingReloads.frontend };
}

/**
 * The reload mode and the persisted dirty flag, shared per source.
 *
 * Split out because a consumer that only shows or hides a control needs this
 * and nothing else — subscribing it to the whole family would re-render it on
 * every worker-activity change.
 */
function useDevStatusSnapshot() {
  const sourceKey = useClientSummarySourceKey();
  const readDevStatus = useCallback(
    () => getDevStatusSnapshot(sourceKey),
    [sourceKey],
  );
  const snapshot = useSyncExternalStore(
    subscribeDevStatus,
    readDevStatus,
    readDevStatus,
  );
  // The login screen renders none of this and may not even be authenticated.
  const offLoginRoute = window.location.pathname !== "/login";

  useRetainedClientQuery({
    sourceKey,
    key: DEV_STATUS_QUERY_KEY,
    // Development-shell diagnostics: nothing a selected route paints.
    bootstrapTier: "supplementary",
    ready: offLoginRoute,
    hasData: snapshot.observedAt !== undefined,
    debounceMs: RELOAD_STATUS_DEBOUNCE_MS,
    revalidateOn: RELOAD_STATUS_REVALIDATE_EVENTS,
    fetcher: devStatusFetcher,
    applySnapshot: applyDevStatusSnapshot,
  });

  const devStatus = snapshot.devStatus;
  return {
    sourceKey,
    offLoginRoute,
    devStatus,
    // Whether manual reload mode is active at all. Nothing about restart safety
    // is displayed outside it, so it also gates the worker-activity and
    // safe-restart requests.
    isManualReloadMode:
      devStatus?.noBackendReload || devStatus?.noFrontendReload,
  };
}

/**
 * Just the reload mode, for consumers that show or hide a control rather than
 * render a banner. They share the same one-per-source dev-status acquisition
 * without retaining the restart-safety family they never display.
 */
export function useIsManualReloadMode(): boolean | undefined {
  return useDevStatusSnapshot().isManualReloadMode;
}

/**
 * Hook to manage reload notifications when running in manual reload mode.
 *
 * The server-side facts — reload mode, the persisted dirty flag, worker
 * activity, safe-restart state — are shared per source by
 * `lib/devReloadStatusStore`, so mounting this hook a second or third time
 * costs no request. What stays here is the per-consumer banner policy: which
 * notices are pending and which the viewer dismissed.
 */
export function useReloadNotifications() {
  const { sourceKey, offLoginRoute, devStatus, isManualReloadMode } =
    useDevStatusSnapshot();
  const [pendingReloads, setPendingReloads] = useState<PendingReloads>({
    backend: false,
    frontend: false,
  });
  const [dismissedReloads, setDismissedReloads] = useState<PendingReloads>({
    backend: false,
    frontend: false,
  });
  const [safeRestartMutating, setSafeRestartMutating] = useState(false);

  const readRestartSafety = useCallback(
    () => getRestartSafetySnapshot(sourceKey),
    [sourceKey],
  );
  const restartSafety = useSyncExternalStore(
    subscribeRestartSafety,
    readRestartSafety,
    readRestartSafety,
  );
  const connected = useSyncExternalStore(
    subscribeActivityConnected,
    getActivityConnected,
    getActivityConnected,
  );

  useRetainedClientQuery({
    sourceKey,
    key: RESTART_SAFETY_QUERY_KEY,
    bootstrapTier: "supplementary",
    // A deployment in neither reload mode displays none of this, so it must not
    // be requested merely because the hook is mounted globally.
    enabled: isManualReloadMode === true,
    ready: offLoginRoute,
    hasData:
      restartSafety.workerActivityLoaded && restartSafety.safeRestartLoaded,
    debounceMs: RELOAD_STATUS_DEBOUNCE_MS,
    revalidateOn: RELOAD_STATUS_REVALIDATE_EVENTS,
    fetcher: restartSafetyFetcher,
    applySnapshot: applyRestartSafetySnapshot,
  });

  useEffect(() => retainDevReloadStatusEvents(sourceKey), [sourceKey]);

  const showReloadIfNotDismissed = useCallback(
    (target: "backend" | "frontend") => {
      setPendingReloads((prev) => {
        if (dismissedReloads[target] || prev[target]) return prev;
        return { ...prev, [target]: true };
      });
    },
    [dismissedReloads],
  );

  // The persisted dirty flag and the safe-restart status are shared snapshot
  // values, so the banner reacts to the snapshot rather than to whichever
  // consumer's request happened to fetch it. That is what lets a later mount
  // raise the same notice without a request of its own.
  useEffect(() => {
    if (!devStatus) return;
    if (devStatus.backendDirty) {
      showReloadIfNotDismissed("backend");
    } else {
      setPendingReloads((prev) =>
        prev.backend ? { ...prev, backend: false } : prev,
      );
    }
  }, [devStatus, showReloadIfNotDismissed]);

  const safeRestartStatus = restartSafety.safeRestart.status;
  useEffect(() => {
    if (safeRestartStatus !== "idle") {
      showReloadIfNotDismissed("backend");
    }
  }, [safeRestartStatus, showReloadIfNotDismissed]);

  // Clean the cache-busting reload param back out after the fresh document loads
  // so copied/shared URLs do not retain reload-only query state.
  useEffect(() => {
    const cleanupUrl = getFrontendReloadCleanupUrl(window.location.href);
    if (!cleanupUrl) {
      return;
    }
    window.history.replaceState(window.history.state, "", cleanupUrl);
  }, []);

  // What is left on the bus for this consumer is banner policy: the data these
  // events also carry is applied once per source by the store.
  useEffect(() => {
    const unsubscribers = [
      activityBus.on("source-change", (data: SourceChangeEvent) => {
        showReloadIfNotDismissed(data.target);
      }),
      activityBus.on("backend-reloaded", () => {
        setPendingReloads((prev) => ({ ...prev, backend: false }));
        setDismissedReloads((prev) => ({ ...prev, backend: false }));
      }),
    ];

    return () => {
      for (const unsub of unsubscribers) {
        unsub();
      }
    };
  }, [showReloadIfNotDismissed]);

  // Reload the backend (triggers server restart)
  const reloadBackend = useCallback(async () => {
    console.log("[ReloadNotifications] Requesting backend reload...");
    try {
      await fetchJSON<{ ok: boolean }>("/server/restart", { method: "POST" });
      console.log("[ReloadNotifications] Reload completed");
      setPendingReloads((prev) => ({ ...prev, backend: false }));
    } catch (err) {
      console.log("[ReloadNotifications] Reload error (may be expected):", err);
    }
  }, []);

  const mutateSafeRestart = useCallback(
    async (method: "POST" | "DELETE") => {
      setSafeRestartMutating(true);
      try {
        const state = await fetchJSON<SafeRestartState>("/dev/safe-restart", {
          method,
        });
        if (state) {
          acceptSafeRestartState(sourceKey, state);
        }
      } finally {
        setSafeRestartMutating(false);
      }
    },
    [sourceKey],
  );

  const scheduleSafeRestart = useCallback(
    () => mutateSafeRestart("POST"),
    [mutateSafeRestart],
  );

  const cancelSafeRestart = useCallback(
    () => mutateSafeRestart("DELETE"),
    [mutateSafeRestart],
  );

  // Reload the frontend (browser refresh)
  const reloadFrontend = useCallback(() => {
    const reloadUrl = buildFrontendReloadUrl(
      window.location.href,
      String(Date.now()),
    );
    window.location.replace(reloadUrl);
  }, []);

  // Reload whichever needs it (backend first if both)
  const reload = useCallback(() => {
    if (pendingReloads.backend) {
      reloadBackend();
    } else if (pendingReloads.frontend) {
      reloadFrontend();
    }
  }, [pendingReloads, reloadBackend, reloadFrontend]);

  // Dismiss a pending reload notification
  const dismiss = useCallback((target: "backend" | "frontend") => {
    setDismissedReloads((prev) => ({
      ...prev,
      [target]: true,
    }));
    setPendingReloads((prev) => ({
      ...prev,
      [target]: false,
    }));
  }, []);

  // Dismiss all
  const dismissAll = useCallback(() => {
    setDismissedReloads({ backend: true, frontend: true });
    setPendingReloads({ backend: false, frontend: false });
  }, []);

  // Keyboard shortcut: Ctrl+Shift+R
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === "R") {
        e.preventDefault();
        reload();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [reload]);

  const workerActivity = restartSafety.workerActivity;
  const interruptibleSessionCount =
    getInterruptibleSessionCount(workerActivity);
  const queuedSessionMessageCount = Math.max(
    0,
    workerActivity.queuedSessionMessageCount ?? workerActivity.queueLength,
  );
  const backendReloadSafetyKnown =
    restartSafety.workerActivityLoaded && restartSafety.safeRestartLoaded;

  return {
    isManualReloadMode,
    pendingReloads,
    connected,
    reloadBackend,
    reloadFrontend,
    reload,
    scheduleSafeRestart,
    cancelSafeRestart,
    dismiss,
    dismissAll,
    workerActivity,
    interruptibleSessionCount,
    queuedSessionMessageCount,
    safeRestartState: restartSafety.safeRestart,
    safeRestartMutating,
    backendReloadSafetyKnown,
    unsafeToRestart:
      interruptibleSessionCount > 0 || queuedSessionMessageCount > 0,
  };
}
