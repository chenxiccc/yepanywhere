import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { SafeRestartState } from "@yep-anywhere/shared";
import { fetchJSON } from "../api/client";
import {
  type SourceChangeEvent,
  type WorkerActivityEvent,
  activityBus,
  getInterruptibleSessionCount,
} from "../lib/activityBus";
import {
  buildFrontendReloadUrl,
  getFrontendReloadCleanupUrl,
} from "../lib/frontendReload";

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

interface DevStatus {
  noBackendReload: boolean;
  noFrontendReload: boolean;
  backendDirty?: boolean;
}

const IDLE_SAFE_RESTART_STATE: SafeRestartState = {
  status: "idle",
  blockers: [],
  canRestartNow: true,
  updatedAt: "",
};
const SAFETY_SYNC_RETRY_DELAY_MS = 1_000;
const MAX_SAFETY_SYNC_RETRIES = 3;

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
 * Hook to manage reload notifications when running in manual reload mode.
 * Listens for source-change events via the global activityBus.
 */
export function useReloadNotifications() {
  const [pendingReloads, setPendingReloads] = useState<PendingReloads>({
    backend: false,
    frontend: false,
  });
  const [dismissedReloads, setDismissedReloads] = useState<PendingReloads>({
    backend: false,
    frontend: false,
  });
  const [devStatus, setDevStatus] = useState<DevStatus | null>(null);
  // Whether manual reload mode is active at all. Nothing this hook returns
  // about restart safety is displayed outside it, so it also gates the
  // worker-activity and safe-restart requests.
  const isManualReloadMode =
    devStatus?.noBackendReload || devStatus?.noFrontendReload;
  const isManualReloadModeRef = useRef(false);
  isManualReloadModeRef.current = isManualReloadMode === true;
  const connected = useSyncExternalStore(
    subscribeActivityConnected,
    getActivityConnected,
    getActivityConnected,
  );
  const [safeRestartState, setSafeRestartState] = useState<SafeRestartState>(
    IDLE_SAFE_RESTART_STATE,
  );
  const [safeRestartLoaded, setSafeRestartLoaded] = useState(false);
  const [safeRestartMutating, setSafeRestartMutating] = useState(false);
  const [workerActivityLoaded, setWorkerActivityLoaded] = useState(false);
  const [workerActivity, setWorkerActivity] = useState<WorkerActivityEvent>({
    type: "worker-activity-changed",
    activeWorkers: 0,
    interruptibleSessionCount: 0,
    queueLength: 0,
    queuedSessionMessageCount: 0,
    hasActiveWork: false,
    timestamp: "",
  });
  const safetySyncRetryTimerRef = useRef<number | null>(null);
  const safetySyncRetryCountRef = useRef(0);
  const syncRestartSafetyRef = useRef<(retrying?: boolean) => void>(() => {});

  const showReloadIfNotDismissed = useCallback(
    (target: "backend" | "frontend") => {
      setPendingReloads((prev) => {
        if (dismissedReloads[target]) return prev;
        return { ...prev, [target]: true };
      });
    },
    [dismissedReloads],
  );

  /**
   * Read the reload mode and the persisted dirty flag. This is the hook's only
   * `/dev/status` request: the mount used to read it to learn the mode, then
   * immediately read it a second time as part of the safety sync it triggered.
   */
  const syncDevStatus = useCallback(() => {
    if (window.location.pathname === "/login") {
      return;
    }

    fetchJSON<DevStatus>("/dev/status")
      .then((data) => {
        setDevStatus(data ?? null);
        if (data?.backendDirty) {
          showReloadIfNotDismissed("backend");
        } else if (data) {
          setPendingReloads((prev) => ({ ...prev, backend: false }));
        }
      })
      .catch(() => {
        setDevStatus(null);
      });
  }, [showReloadIfNotDismissed]);

  /**
   * Worker activity and safe-restart state, which only the manual-reload
   * banners and the Development pane display. A deployment in neither reload
   * mode has nothing to show, so it must not request these merely because the
   * hook is mounted globally.
   */
  const syncRestartSafety = useCallback(
    (retrying = false) => {
      if (window.location.pathname === "/login") {
        return;
      }
      if (!retrying) {
        safetySyncRetryCountRef.current = 0;
      }

      // Sync worker activity
      const workerActivityRequest = fetchJSON<WorkerActivityEvent>(
        "/status/workers",
      ).then((data) => {
        if (!data) throw new Error("Missing worker activity state");
        setWorkerActivity(data);
        setWorkerActivityLoaded(true);
      });

      const safeRestartRequest = fetchJSON<SafeRestartState>(
        "/dev/safe-restart",
      ).then((data) => {
        if (!data) throw new Error("Missing safe restart state");
        setSafeRestartState(data);
        setSafeRestartLoaded(true);
        if (data.status !== "idle") {
          showReloadIfNotDismissed("backend");
        }
      });

      void Promise.allSettled([workerActivityRequest, safeRestartRequest]).then(
        (results) => {
          const failed = results.some((result) => result.status === "rejected");
          if (!failed) {
            safetySyncRetryCountRef.current = 0;
            return;
          }
          if (
            safetySyncRetryTimerRef.current !== null ||
            safetySyncRetryCountRef.current >= MAX_SAFETY_SYNC_RETRIES
          ) {
            return;
          }
          safetySyncRetryCountRef.current += 1;
          safetySyncRetryTimerRef.current = window.setTimeout(() => {
            safetySyncRetryTimerRef.current = null;
            syncRestartSafetyRef.current(true);
          }, SAFETY_SYNC_RETRY_DELAY_MS);
        },
      );
    },
    [showReloadIfNotDismissed],
  );
  syncRestartSafetyRef.current = syncRestartSafety;

  useEffect(
    () => () => {
      if (safetySyncRetryTimerRef.current !== null) {
        window.clearTimeout(safetySyncRetryTimerRef.current);
      }
    },
    [],
  );

  // Check if server is in dev mode and get persisted dirty state
  useEffect(() => {
    syncDevStatus();
  }, [syncDevStatus]);

  // Clean the cache-busting reload param back out after the fresh document loads
  // so copied/shared URLs do not retain reload-only query state.
  useEffect(() => {
    const cleanupUrl = getFrontendReloadCleanupUrl(window.location.href);
    if (!cleanupUrl) {
      return;
    }
    window.history.replaceState(window.history.state, "", cleanupUrl);
  }, []);

  // Subscribe to events from the bus
  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    unsubscribers.push(
      activityBus.on("source-change", (data: SourceChangeEvent) => {
        showReloadIfNotDismissed(data.target);
      }),
    );

    unsubscribers.push(
      activityBus.on("backend-reloaded", () => {
        setPendingReloads((prev) => ({ ...prev, backend: false }));
        setDismissedReloads((prev) => ({ ...prev, backend: false }));
        setSafeRestartState(IDLE_SAFE_RESTART_STATE);
        setSafeRestartLoaded(true);
      }),
    );

    unsubscribers.push(
      activityBus.on("worker-activity-changed", (data: WorkerActivityEvent) => {
        setWorkerActivity(data);
        setWorkerActivityLoaded(true);
      }),
    );

    unsubscribers.push(
      activityBus.on("safe-restart-changed", (data) => {
        setSafeRestartState(data.state);
        setSafeRestartLoaded(true);
        if (data.state.status !== "idle") {
          showReloadIfNotDismissed("backend");
        }
      }),
    );

    // On reconnect, re-read the mode: a server that came back may have
    // restarted into a different one.
    unsubscribers.push(
      activityBus.on("reconnect", () => {
        syncDevStatus();
        if (isManualReloadModeRef.current) {
          syncRestartSafety();
        }
      }),
    );

    // On visibility restore, refresh data
    unsubscribers.push(
      activityBus.on("refresh", () => {
        syncDevStatus();
        if (isManualReloadModeRef.current) {
          syncRestartSafety();
        }
      }),
    );

    return () => {
      for (const unsub of unsubscribers) {
        unsub();
      }
    };
  }, [showReloadIfNotDismissed, syncDevStatus, syncRestartSafety]);

  // Initial safety sync once a reload mode is known to be active
  useEffect(() => {
    if (devStatus?.noBackendReload || devStatus?.noFrontendReload) {
      syncRestartSafety();
    }
  }, [devStatus, syncRestartSafety]);

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

  const scheduleSafeRestart = useCallback(async () => {
    setSafeRestartMutating(true);
    try {
      const state = await fetchJSON<SafeRestartState>("/dev/safe-restart", {
        method: "POST",
      });
      setSafeRestartState(state);
    } finally {
      setSafeRestartMutating(false);
    }
  }, []);

  const cancelSafeRestart = useCallback(async () => {
    setSafeRestartMutating(true);
    try {
      const state = await fetchJSON<SafeRestartState>("/dev/safe-restart", {
        method: "DELETE",
      });
      setSafeRestartState(state);
    } finally {
      setSafeRestartMutating(false);
    }
  }, []);

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

  const interruptibleSessionCount =
    getInterruptibleSessionCount(workerActivity);
  const queuedSessionMessageCount = Math.max(
    0,
    workerActivity.queuedSessionMessageCount ?? workerActivity.queueLength,
  );
  const backendReloadSafetyKnown = workerActivityLoaded && safeRestartLoaded;

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
    safeRestartState,
    safeRestartMutating,
    backendReloadSafetyKnown,
    unsafeToRestart:
      interruptibleSessionCount > 0 || queuedSessionMessageCount > 0,
  };
}
