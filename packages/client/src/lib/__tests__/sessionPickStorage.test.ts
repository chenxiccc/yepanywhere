// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  sessionModelPick,
  sessionPermissionModePick,
} from "../sessionPickStorage";

describe("sessionModelPick", () => {
  afterEach(() => localStorage.clear());

  it("keys entries per session id", () => {
    expect(sessionModelPick.storageKey("sess-1")).toBe("session-model-sess-1");
    expect(sessionModelPick.storageKey("sess-2")).toBe("session-model-sess-2");
  });

  it("round-trips a saved model for its own session only", () => {
    sessionModelPick.save("sess-1", "opus");
    expect(sessionModelPick.load("sess-1")).toBe("opus");
    // A different session must not inherit the pick — this is the whole point
    // of per-session (vs global) persistence.
    expect(sessionModelPick.load("sess-2")).toBeUndefined();
  });

  it("returns undefined when nothing is stored", () => {
    expect(sessionModelPick.load("never-set")).toBeUndefined();
  });

  it("overwrites a prior pick for the same session", () => {
    sessionModelPick.save("sess-1", "sonnet");
    sessionModelPick.save("sess-1", "opus");
    expect(sessionModelPick.load("sess-1")).toBe("opus");
  });

  it("trims whitespace on save and load", () => {
    sessionModelPick.save("sess-1", "  opus  ");
    expect(sessionModelPick.load("sess-1")).toBe("opus");
    // A stray whitespace-only stored value reads as no override.
    localStorage.setItem(sessionModelPick.storageKey("sess-2"), "   ");
    expect(sessionModelPick.load("sess-2")).toBeUndefined();
  });

  it("drops the entry when saving an empty selection", () => {
    sessionModelPick.save("sess-1", "opus");
    sessionModelPick.save("sess-1", "");
    expect(sessionModelPick.load("sess-1")).toBeUndefined();
    expect(
      localStorage.getItem(sessionModelPick.storageKey("sess-1")),
    ).toBeNull();
  });

  it("removes a stored pick explicitly", () => {
    sessionModelPick.save("sess-1", "opus");
    sessionModelPick.remove("sess-1");
    expect(sessionModelPick.load("sess-1")).toBeUndefined();
  });

  it("ignores empty session ids without throwing", () => {
    expect(() => sessionModelPick.save("", "opus")).not.toThrow();
    expect(sessionModelPick.load("")).toBeUndefined();
  });
});

describe("sessionPermissionModePick", () => {
  afterEach(() => localStorage.clear());

  it("uses the pre-consolidation storage key unchanged", () => {
    // Contract: existing stored preferences keep working across the move from
    // useSession-internal helpers to this shared store.
    expect(sessionPermissionModePick.storageKey("sess-1")).toBe(
      "permission-mode-sess-1",
    );
  });

  it("round-trips a saved mode per session", () => {
    sessionPermissionModePick.save("sess-1", "bypassPermissions");
    expect(sessionPermissionModePick.load("sess-1")).toBe("bypassPermissions");
    expect(sessionPermissionModePick.load("sess-2")).toBeUndefined();
  });

  it("rejects values outside the mode enum on load", () => {
    localStorage.setItem(
      sessionPermissionModePick.storageKey("sess-1"),
      "yolo",
    );
    expect(sessionPermissionModePick.load("sess-1")).toBeUndefined();
  });
});
