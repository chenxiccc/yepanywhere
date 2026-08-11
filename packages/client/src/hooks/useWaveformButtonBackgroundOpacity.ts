import { useSyncExternalStore } from "react";
import { createLocalStorageValue } from "../lib/localStorageValue";
import { UI_KEYS } from "../lib/storageKeys";

export const DEFAULT_WAVEFORM_BUTTON_BACKGROUND_OPACITY_PERCENT = 70;
export const MIN_WAVEFORM_BUTTON_BACKGROUND_OPACITY_PERCENT = 0;
export const MAX_WAVEFORM_BUTTON_BACKGROUND_OPACITY_PERCENT = 100;
export const WAVEFORM_BUTTON_BACKGROUND_OPACITY_STEP_PERCENT = 5;

function normalizeWaveformButtonBackgroundOpacityPercent(
  value: number,
): number {
  const finite = Number.isFinite(value)
    ? value
    : DEFAULT_WAVEFORM_BUTTON_BACKGROUND_OPACITY_PERCENT;
  const stepped =
    MIN_WAVEFORM_BUTTON_BACKGROUND_OPACITY_PERCENT +
    Math.round(
      (finite - MIN_WAVEFORM_BUTTON_BACKGROUND_OPACITY_PERCENT) /
        WAVEFORM_BUTTON_BACKGROUND_OPACITY_STEP_PERCENT,
    ) *
      WAVEFORM_BUTTON_BACKGROUND_OPACITY_STEP_PERCENT;
  return Math.min(
    MAX_WAVEFORM_BUTTON_BACKGROUND_OPACITY_PERCENT,
    Math.max(MIN_WAVEFORM_BUTTON_BACKGROUND_OPACITY_PERCENT, stepped),
  );
}

const store = createLocalStorageValue(
  UI_KEYS.waveformButtonBackgroundOpacityPercent,
  DEFAULT_WAVEFORM_BUTTON_BACKGROUND_OPACITY_PERCENT,
  (raw) => {
    const parsed = Number(raw);
    return Number.isFinite(parsed)
      ? normalizeWaveformButtonBackgroundOpacityPercent(parsed)
      : undefined;
  },
);

export const getWaveformButtonBackgroundOpacityPercent = store.read;
export const setWaveformButtonBackgroundOpacityPercent = (
  value: number,
): void => {
  store.set(normalizeWaveformButtonBackgroundOpacityPercent(value));
};

export function useWaveformButtonBackgroundOpacity() {
  const waveformButtonBackgroundOpacityPercent = useSyncExternalStore(
    store.subscribe,
    store.read,
    store.read,
  );
  return {
    waveformButtonBackgroundOpacityPercent,
    setWaveformButtonBackgroundOpacityPercent,
  };
}
