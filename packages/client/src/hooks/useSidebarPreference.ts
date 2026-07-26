import { useCallback, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";

/** The desktop sidebar's display modes (topics/ui-architecture.md). */
export type SidebarDisplayMode = "expanded" | "collapsed" | "minimized";

// The mode persists as the two browser-local keys (sidebarExpanded,
// sidebarMinimized) rather than one enum key, so stored preferences and
// browserSettingsBackup round-trip unchanged across bundle versions.
function loadStoredMode(): SidebarDisplayMode {
  if (typeof window === "undefined") {
    return "expanded";
  }
  // No stored preference defaults to expanded.
  if (localStorage.getItem(UI_KEYS.sidebarExpanded) === "false") {
    return localStorage.getItem(UI_KEYS.sidebarMinimized) === "true"
      ? "minimized"
      : "collapsed";
  }
  return "expanded";
}

function saveStoredMode(mode: SidebarDisplayMode): void {
  localStorage.setItem(UI_KEYS.sidebarExpanded, String(mode === "expanded"));
  localStorage.setItem(UI_KEYS.sidebarMinimized, String(mode === "minimized"));
}

/**
 * Hook to manage the sidebar display-mode preference.
 * Persists to localStorage.
 */
export function useSidebarPreference(forceExpanded = false): {
  isExpanded: boolean;
  isMinimized: boolean;
  toggleExpanded: () => void;
  minimizeToFloatingToggle: () => void;
  restoreCollapsedSidebar: () => void;
} {
  const [mode, setModeState] = useState<SidebarDisplayMode>(() =>
    forceExpanded ? "expanded" : loadStoredMode(),
  );

  const setMode = useCallback((next: SidebarDisplayMode) => {
    setModeState(next);
    saveStoredMode(next);
  }, []);

  const toggleExpanded = useCallback(() => {
    // Use functional update to avoid stale closure issues
    setModeState((prev) => {
      const next = prev === "expanded" ? "collapsed" : "expanded";
      saveStoredMode(next);
      return next;
    });
  }, []);

  const minimizeToFloatingToggle = useCallback(
    () => setMode("minimized"),
    [setMode],
  );

  const restoreCollapsedSidebar = useCallback(
    () => setMode("collapsed"),
    [setMode],
  );

  return {
    isExpanded: mode === "expanded",
    isMinimized: mode === "minimized",
    toggleExpanded,
    minimizeToFloatingToggle,
    restoreCollapsedSidebar,
  };
}
