import { useCallback, useEffect, useState } from "react";
import { createLocalStorageValue } from "../lib/localStorageValue";
import { UI_KEYS } from "../lib/storageKeys";
import {
  DEFAULT_TOOLTIP_DELAY_MS,
  SESSION_HOVERCARD_DELAY_MULTIPLIER,
  useTooltipAppearance,
} from "./useTooltipAppearance";

export const DEFAULT_HOVERCARD_SHOW_DELAY_MS =
  DEFAULT_TOOLTIP_DELAY_MS * SESSION_HOVERCARD_DELAY_MULTIPLIER;

// Max height of the preview card; taller shows more of the opening request.
export const HOVERCARD_MAX_HEIGHT_MIN_PX = 80;
export const HOVERCARD_MAX_HEIGHT_MAX_PX = 600;
export const HOVERCARD_MAX_HEIGHT_STEP_PX = 10;
export const DEFAULT_HOVERCARD_MAX_HEIGHT_PX = 150;

export const HOVERCARD_APPEARANCE_CHANGE_EVENT =
  "yep-hovercard-appearance-change";

const nativeHoverCardShowDelayStore = createLocalStorageValue(
  UI_KEYS.sessionHoverCardShowDelayMs,
  DEFAULT_HOVERCARD_SHOW_DELAY_MS,
  (raw) => {
    const delayMs = Number(raw);
    return Number.isFinite(delayMs) ? Math.max(0, delayMs) : undefined;
  },
);

export interface HoverCardAppearance {
  showDelayMs: number;
  warmShowDelayMs: number;
  maxHeightPx: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function normalizeMaxHeight(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HOVERCARD_MAX_HEIGHT_PX;
  return clamp(
    roundToStep(value, HOVERCARD_MAX_HEIGHT_STEP_PX),
    HOVERCARD_MAX_HEIGHT_MIN_PX,
    HOVERCARD_MAX_HEIGHT_MAX_PX,
  );
}

function readStoredNumber(key: string, fallback: number): number {
  const stored = localStorage.getItem(key);
  return stored === null ? fallback : Number(stored);
}

function loadHoverCardAppearance(): HoverCardAppearance {
  return {
    showDelayMs: DEFAULT_HOVERCARD_SHOW_DELAY_MS,
    warmShowDelayMs: DEFAULT_TOOLTIP_DELAY_MS,
    maxHeightPx: normalizeMaxHeight(
      readStoredNumber(
        UI_KEYS.sessionHoverCardMaxHeightPx,
        DEFAULT_HOVERCARD_MAX_HEIGHT_PX,
      ),
    ),
  };
}

/**
 * Read-only hover-card settings, kept in sync across every list row via the
 * change event so a settings edit updates open lists without a remount.
 */
export function useHoverCardSettings(): HoverCardAppearance {
  const { tooltipMode, tooltipDelayMs } = useTooltipAppearance();
  const [appearance, setAppearance] = useState<HoverCardAppearance>(
    loadHoverCardAppearance,
  );

  useEffect(() => {
    const update = () => setAppearance(loadHoverCardAppearance());
    window.addEventListener(HOVERCARD_APPEARANCE_CHANGE_EVENT, update);
    return () =>
      window.removeEventListener(HOVERCARD_APPEARANCE_CHANGE_EVENT, update);
  }, []);

  const nativeDelayMs = nativeHoverCardShowDelayStore.read();
  return {
    ...appearance,
    showDelayMs:
      tooltipMode === "native"
        ? nativeDelayMs
        : tooltipDelayMs * SESSION_HOVERCARD_DELAY_MULTIPLIER,
    warmShowDelayMs: tooltipDelayMs,
  };
}

/** Read + write hover-card settings, for the settings pane. */
export function useHoverCardAppearance() {
  const { maxHeightPx } = useHoverCardSettings();

  const setHoverCardMaxHeightPx = useCallback((value: number) => {
    localStorage.setItem(
      UI_KEYS.sessionHoverCardMaxHeightPx,
      String(normalizeMaxHeight(value)),
    );
    window.dispatchEvent(new Event(HOVERCARD_APPEARANCE_CHANGE_EVENT));
  }, []);

  const resetHoverCardAppearance = useCallback(() => {
    localStorage.removeItem(UI_KEYS.sessionHoverCardMaxHeightPx);
    window.dispatchEvent(new Event(HOVERCARD_APPEARANCE_CHANGE_EVENT));
  }, []);

  return {
    hoverCardMaxHeightPx: maxHeightPx,
    setHoverCardMaxHeightPx,
    resetHoverCardAppearance,
  };
}
