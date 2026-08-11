// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invalidateLocalStorageValues } from "../../lib/localStorageValue";
import { UI_KEYS } from "../../lib/storageKeys";
import {
  DEFAULT_WAVEFORM_BUTTON_BACKGROUND_OPACITY_PERCENT,
  getWaveformButtonBackgroundOpacityPercent,
  useWaveformButtonBackgroundOpacity,
} from "../useWaveformButtonBackgroundOpacity";

describe("useWaveformButtonBackgroundOpacity", () => {
  beforeEach(() => {
    localStorage.clear();
    invalidateLocalStorageValues(
      UI_KEYS.waveformButtonBackgroundOpacityPercent,
    );
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    invalidateLocalStorageValues(
      UI_KEYS.waveformButtonBackgroundOpacityPercent,
    );
  });

  it("defaults button backgrounds to 70 percent opacity", () => {
    expect(getWaveformButtonBackgroundOpacityPercent()).toBe(
      DEFAULT_WAVEFORM_BUTTON_BACKGROUND_OPACITY_PERCENT,
    );
  });

  it("normalizes stored and committed values to the five-percent scale", () => {
    localStorage.setItem(UI_KEYS.waveformButtonBackgroundOpacityPercent, "73");
    invalidateLocalStorageValues(
      UI_KEYS.waveformButtonBackgroundOpacityPercent,
    );

    const { result: first } = renderHook(() =>
      useWaveformButtonBackgroundOpacity(),
    );
    const { result: second } = renderHook(() =>
      useWaveformButtonBackgroundOpacity(),
    );
    expect(first.current.waveformButtonBackgroundOpacityPercent).toBe(75);

    act(() => {
      first.current.setWaveformButtonBackgroundOpacityPercent(112);
    });

    expect(first.current.waveformButtonBackgroundOpacityPercent).toBe(100);
    expect(second.current.waveformButtonBackgroundOpacityPercent).toBe(100);
    expect(
      localStorage.getItem(UI_KEYS.waveformButtonBackgroundOpacityPercent),
    ).toBe("100");
  });
});
