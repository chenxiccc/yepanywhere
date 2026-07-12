import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSelectedTerminalTabId,
  getSelectedTerminalTabId,
  setSelectedTerminalTabId,
} from "../projectTerminalStorage";

describe("projectTerminalStorage", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores selected terminal tab per project", () => {
    setSelectedTerminalTabId("proj-1", "tab-1");

    expect(getSelectedTerminalTabId("proj-1")).toBe("tab-1");
    expect(getSelectedTerminalTabId("proj-2")).toBeNull();
  });

  it("clears selected terminal tab per project", () => {
    setSelectedTerminalTabId("proj-1", "tab-1");
    clearSelectedTerminalTabId("proj-1");

    expect(getSelectedTerminalTabId("proj-1")).toBeNull();
  });
});
