// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { UI_KEYS } from "../lib/storageKeys";
import { useDiffViewMode } from "./useDiffViewMode";

describe("useDiffViewMode", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to auto", () => {
    const { result } = renderHook(() => useDiffViewMode());
    expect(result.current[0]).toBe("auto");
  });

  it("persists a manual pick and restores it on remount (device-local)", () => {
    const first = renderHook(() => useDiffViewMode());
    act(() => first.result.current[1]("side-by-side"));
    expect(first.result.current[0]).toBe("side-by-side");
    expect(localStorage.getItem(UI_KEYS.diffViewMode)).toBe("side-by-side");
    first.unmount();

    const second = renderHook(() => useDiffViewMode());
    expect(second.result.current[0]).toBe("side-by-side");
  });

  it("ignores a garbage stored value", () => {
    localStorage.setItem(UI_KEYS.diffViewMode, "nonsense");
    const { result } = renderHook(() => useDiffViewMode());
    expect(result.current[0]).toBe("auto");
  });
});
