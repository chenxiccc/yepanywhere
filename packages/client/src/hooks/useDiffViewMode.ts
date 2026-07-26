import { useCallback, useState } from "react";
import type { DiffViewMode } from "../lib/diffSideBySide";
import { UI_KEYS } from "../lib/storageKeys";

/**
 * The diff view-mode preference (topic: source-review-to-session, P8).
 * Device-local (screen sizes vary per device, so this is set once per device
 * and does not travel), defaulting to `auto`.
 */

function isMode(value: unknown): value is DiffViewMode {
  return value === "auto" || value === "unified" || value === "side-by-side";
}

function readMode(): DiffViewMode {
  try {
    const stored = localStorage.getItem(UI_KEYS.diffViewMode);
    if (isMode(stored)) return stored;
  } catch {
    // localStorage unavailable (private mode, SSR): fall through to default.
  }
  return "auto";
}

export function useDiffViewMode(): [
  DiffViewMode,
  (mode: DiffViewMode) => void,
] {
  const [mode, setModeState] = useState<DiffViewMode>(readMode);

  const setMode = useCallback((next: DiffViewMode) => {
    setModeState(next);
    try {
      localStorage.setItem(UI_KEYS.diffViewMode, next);
    } catch {
      // Best-effort persistence.
    }
  }, []);

  return [mode, setMode];
}
