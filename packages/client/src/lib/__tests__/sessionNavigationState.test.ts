import { describe, expect, it } from "vitest";
import {
  createSessionNavigationState,
  normalizeInitialSessionStatus,
  parseSessionNavigationState,
} from "../sessionNavigationState";

describe("session navigation state", () => {
  it("accepts current self-owned initial status", () => {
    expect(
      normalizeInitialSessionStatus({
        owner: "self",
        processId: "process-1",
        permissionMode: "bypassPermissions",
        modeVersion: 4,
      }),
    ).toEqual({
      owner: "self",
      processId: "process-1",
      permissionMode: "bypassPermissions",
      modeVersion: 4,
    });
  });

  it("normalizes legacy owned initial status from browser history", () => {
    expect(
      normalizeInitialSessionStatus({
        state: "owned",
        processId: "process-1",
      }),
    ).toEqual({ owner: "self", processId: "process-1" });
  });

  it("drops malformed initial status", () => {
    expect(
      normalizeInitialSessionStatus({
        state: "owned",
      }),
    ).toBeUndefined();
  });

  it("drops malformed permission fields from initial status", () => {
    expect(
      normalizeInitialSessionStatus({
        owner: "self",
        processId: "process-1",
        permissionMode: "anything-goes",
        modeVersion: -1,
      }),
    ).toEqual({ owner: "self", processId: "process-1" });
  });

  it("parses only valid typed navigation fields", () => {
    expect(
      parseSessionNavigationState({
        initialStatus: {
          state: "owned",
          processId: "process-1",
          permissionMode: "acceptEdits",
          modeVersion: 1,
        },
        initialTitle: "Start here",
        initialModel: "gpt-5.3-codex",
        initialProvider: "codex",
        ignored: true,
      }),
    ).toEqual({
      initialStatus: {
        owner: "self",
        processId: "process-1",
        permissionMode: "acceptEdits",
        modeVersion: 1,
      },
      initialTitle: "Start here",
      initialModel: "gpt-5.3-codex",
      initialProvider: "codex",
    });
  });

  it("round-trips the bang-history action fields", () => {
    const created = createSessionNavigationState({
      composerPrefill: "!!git status",
      focusComposer: true,
      scrollToRenderId: "bang-object-1",
    });
    expect(created).toEqual({
      composerPrefill: "!!git status",
      focusComposer: true,
      scrollToRenderId: "bang-object-1",
    });
    expect(parseSessionNavigationState(created)).toEqual(created);
  });

  it("parses each bang-history action field independently and defensively", () => {
    expect(
      parseSessionNavigationState({ composerPrefill: "!!ls" }),
    ).toEqual({ composerPrefill: "!!ls" });
    expect(parseSessionNavigationState({ focusComposer: true })).toEqual({
      focusComposer: true,
    });
    expect(
      parseSessionNavigationState({ scrollToRenderId: "row-9" }),
    ).toEqual({ scrollToRenderId: "row-9" });

    // Wrong types are dropped, not coerced.
    expect(
      parseSessionNavigationState({
        composerPrefill: 42,
        focusComposer: "yes",
        scrollToRenderId: { id: "x" },
      }),
    ).toEqual({});
  });

  it("drops the action fields when creating from falsy values", () => {
    expect(
      createSessionNavigationState({
        composerPrefill: "",
        focusComposer: false,
        scrollToRenderId: "",
      }),
    ).toEqual({});
  });

  it("creates canonical navigation state", () => {
    expect(
      createSessionNavigationState({
        initialStatus: {
          owner: "self",
          processId: "process-1",
          permissionMode: "plan",
          modeVersion: 3,
        },
        initialProvider: "codex",
      }),
    ).toEqual({
      initialStatus: {
        owner: "self",
        processId: "process-1",
        permissionMode: "plan",
        modeVersion: 3,
      },
      initialProvider: "codex",
    });
  });
});
