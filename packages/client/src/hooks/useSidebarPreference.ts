import { useCallback, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";

/**
 * Hook to manage expanded, collapsed-rail, and minimized sidebar preferences.
 * Persists to localStorage.
 */
export function useSidebarPreference(forceExpanded = false): {
  isExpanded: boolean;
  isMinimized: boolean;
  setIsExpanded: (expanded: boolean) => void;
  toggleExpanded: () => void;
  minimizeToFloatingToggle: () => void;
  restoreCollapsedSidebar: () => void;
} {
  const [isExpanded, setIsExpandedState] = useState(() => {
    if (forceExpanded) {
      return true;
    }
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(UI_KEYS.sidebarExpanded);
      // Default to expanded if no preference saved
      return stored === null ? true : stored === "true";
    }
    return true;
  });
  const [isMinimized, setIsMinimizedState] = useState(
    () =>
      typeof window !== "undefined" &&
      localStorage.getItem(UI_KEYS.sidebarMinimized) === "true",
  );

  const setIsExpanded = useCallback((expanded: boolean) => {
    setIsExpandedState(expanded);
    localStorage.setItem(UI_KEYS.sidebarExpanded, String(expanded));
    if (expanded) {
      setIsMinimizedState(false);
      localStorage.setItem(UI_KEYS.sidebarMinimized, "false");
    }
  }, []);

  const toggleExpanded = useCallback(() => {
    // Use functional update to avoid stale closure issues
    setIsExpandedState((prev) => {
      const next = !prev;
      localStorage.setItem(UI_KEYS.sidebarExpanded, String(next));
      return next;
    });
    setIsMinimizedState(false);
    localStorage.setItem(UI_KEYS.sidebarMinimized, "false");
  }, []);

  const minimizeToFloatingToggle = useCallback(() => {
    setIsExpandedState(false);
    localStorage.setItem(UI_KEYS.sidebarExpanded, "false");
    setIsMinimizedState(true);
    localStorage.setItem(UI_KEYS.sidebarMinimized, "true");
  }, []);

  const restoreCollapsedSidebar = useCallback(() => {
    setIsMinimizedState(false);
    localStorage.setItem(UI_KEYS.sidebarMinimized, "false");
  }, []);

  return {
    isExpanded,
    isMinimized,
    setIsExpanded,
    toggleExpanded,
    minimizeToFloatingToggle,
    restoreCollapsedSidebar,
  };
}
