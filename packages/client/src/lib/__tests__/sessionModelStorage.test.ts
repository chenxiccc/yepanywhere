// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  getSessionModelStorageKey,
  loadStoredSessionModel,
  removeStoredSessionModel,
  saveStoredSessionModel,
} from "../sessionModelStorage";

describe("session model storage", () => {
  afterEach(() => localStorage.clear());

  it("keys entries per session id", () => {
    expect(getSessionModelStorageKey("sess-1")).toBe("session-model-sess-1");
    expect(getSessionModelStorageKey("sess-2")).toBe("session-model-sess-2");
  });

  it("round-trips a saved model for its own session only", () => {
    saveStoredSessionModel("sess-1", "opus");
    expect(loadStoredSessionModel("sess-1")).toBe("opus");
    // A different session must not inherit the pick — this is the whole point
    // of per-session (vs global) persistence.
    expect(loadStoredSessionModel("sess-2")).toBeUndefined();
  });

  it("returns undefined when nothing is stored", () => {
    expect(loadStoredSessionModel("never-set")).toBeUndefined();
  });

  it("overwrites a prior pick for the same session", () => {
    saveStoredSessionModel("sess-1", "sonnet");
    saveStoredSessionModel("sess-1", "opus");
    expect(loadStoredSessionModel("sess-1")).toBe("opus");
  });

  it("trims whitespace on save and load", () => {
    saveStoredSessionModel("sess-1", "  opus  ");
    expect(loadStoredSessionModel("sess-1")).toBe("opus");
    // A stray whitespace-only stored value reads as no override.
    localStorage.setItem(getSessionModelStorageKey("sess-2"), "   ");
    expect(loadStoredSessionModel("sess-2")).toBeUndefined();
  });

  it("drops the entry when saving an empty selection", () => {
    saveStoredSessionModel("sess-1", "opus");
    saveStoredSessionModel("sess-1", "");
    expect(loadStoredSessionModel("sess-1")).toBeUndefined();
    expect(
      localStorage.getItem(getSessionModelStorageKey("sess-1")),
    ).toBeNull();
  });

  it("removes a stored pick explicitly", () => {
    saveStoredSessionModel("sess-1", "opus");
    removeStoredSessionModel("sess-1");
    expect(loadStoredSessionModel("sess-1")).toBeUndefined();
  });

  it("ignores empty session ids without throwing", () => {
    expect(() => saveStoredSessionModel("", "opus")).not.toThrow();
    expect(loadStoredSessionModel("")).toBeUndefined();
  });
});
