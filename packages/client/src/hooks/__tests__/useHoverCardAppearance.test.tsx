// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_KEYS } from "../../lib/storageKeys";
import { useHoverCardSettings } from "../useHoverCardAppearance";
import { useTooltipAppearance } from "../useTooltipAppearance";

describe("useHoverCardSettings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not reread the legacy native delay during row rerenders", () => {
    localStorage.setItem(UI_KEYS.sessionHoverCardShowDelayMs, "420");
    const getItem = vi.spyOn(localStorage, "getItem");
    const { result, rerender } = renderHook(() => useHoverCardSettings());

    expect(result.current.showDelayMs).toBe(420);
    const readsAfterInitialization = getItem.mock.calls.filter(
      ([key]) => key === UI_KEYS.sessionHoverCardShowDelayMs,
    ).length;

    for (let index = 0; index < 20; index += 1) {
      rerender();
    }

    expect(
      getItem.mock.calls.filter(
        ([key]) => key === UI_KEYS.sessionHoverCardShowDelayMs,
      ),
    ).toHaveLength(readsAfterInitialization);
  });

  it("observes a cross-tab native delay update", () => {
    const { result } = renderHook(() => useHoverCardSettings());
    expect(result.current.showDelayMs).toBe(150);

    localStorage.setItem(UI_KEYS.sessionHoverCardShowDelayMs, "510");
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: UI_KEYS.sessionHoverCardShowDelayMs,
          newValue: "510",
        }),
      );
    });

    expect(result.current.showDelayMs).toBe(510);
  });

  it("drops the cached native delay when the shared delay retires it", () => {
    localStorage.setItem(UI_KEYS.sessionHoverCardShowDelayMs, "420");
    const { result } = renderHook(() => ({
      hoverCard: useHoverCardSettings(),
      tooltip: useTooltipAppearance(),
    }));
    expect(result.current.hoverCard.showDelayMs).toBe(420);

    act(() => result.current.tooltip.setTooltipDelayMs(80));
    expect(result.current.hoverCard.showDelayMs).toBe(240);

    act(() => result.current.tooltip.setTooltipMode("native"));
    expect(result.current.hoverCard.showDelayMs).toBe(150);
  });
});
