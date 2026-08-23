import {
  useCallback,
  useEffect,
  useReducer,
  useSyncExternalStore,
} from "react";
import { browserDebugLeaseController } from "../lib/browserDebugLease";

export function useBrowserDebugLease() {
  const [, tickCountdown] = useReducer((value: number) => value + 1, 0);
  const snapshot = useSyncExternalStore(
    browserDebugLeaseController.subscribe,
    browserDebugLeaseController.getSnapshot,
  );
  const enable = useCallback(
    (sessionId: string) => browserDebugLeaseController.enable(sessionId),
    [],
  );
  const disable = useCallback(() => browserDebugLeaseController.disable(), []);
  const reactivate = useCallback(
    () => browserDebugLeaseController.reactivate(),
    [],
  );

  useEffect(() => {
    void browserDebugLeaseController.reconcilePersistedLease();
  }, []);

  useEffect(() => {
    if (snapshot.phase !== "active") return;
    const interval = window.setInterval(tickCountdown, 1_000);
    return () => window.clearInterval(interval);
  }, [snapshot.phase]);

  const performanceSummary =
    snapshot.phase === "active"
      ? browserDebugLeaseController.getPerformanceSummary()
      : null;

  return {
    ...snapshot,
    performanceSummary,
    enable,
    disable,
    reactivate,
  };
}
