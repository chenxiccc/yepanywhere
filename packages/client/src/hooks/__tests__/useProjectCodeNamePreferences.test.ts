// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_KEYS } from "../../lib/storageKeys";
import {
  getProjectCodeNamePreferences,
  useProjectCodeNamePreferences,
} from "../useProjectCodeNamePreferences";

describe("useProjectCodeNamePreferences", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("defaults code names and their activity pulse off", () => {
    const { result } = renderHook(() => useProjectCodeNamePreferences());

    expect(result.current.projectCodeNamesEnabled).toBe(false);
    expect(result.current.projectCodeNameActivityPulseEnabled).toBe(false);
  });

  it("reads stored preferences", () => {
    localStorage.setItem(UI_KEYS.projectCodeNamesEnabled, "true");
    localStorage.setItem(UI_KEYS.projectCodeNameActivityPulseEnabled, "true");

    const { result } = renderHook(() => useProjectCodeNamePreferences());

    expect(result.current.projectCodeNamesEnabled).toBe(true);
    expect(result.current.projectCodeNameActivityPulseEnabled).toBe(true);
    expect(getProjectCodeNamePreferences()).toEqual({
      enabled: true,
      activityPulseEnabled: true,
    });
  });

  it("persists and publishes updates to mounted consumers", () => {
    const { result: first } = renderHook(() => useProjectCodeNamePreferences());
    const { result: second } = renderHook(() =>
      useProjectCodeNamePreferences(),
    );

    act(() => {
      first.current.setProjectCodeNamesEnabled(true);
      first.current.setProjectCodeNameActivityPulseEnabled(true);
    });

    expect(second.current.projectCodeNamesEnabled).toBe(true);
    expect(second.current.projectCodeNameActivityPulseEnabled).toBe(true);
    expect(localStorage.getItem(UI_KEYS.projectCodeNamesEnabled)).toBe("true");
    expect(
      localStorage.getItem(UI_KEYS.projectCodeNameActivityPulseEnabled),
    ).toBe("true");
  });
});
