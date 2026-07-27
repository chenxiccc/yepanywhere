import { describe, expect, it } from "vitest";
import {
  createSourceControlNavigationState,
  parseSourceControlNavigationState,
} from "../sourceControlNavigationState";

describe("sourceControlNavigationState", () => {
  it("round-trips the tab-local origin session and cloned launch settings", () => {
    const state = createSourceControlNavigationState({
      projectId: "project-1",
      id: "session-1",
      title: "Fix polling",
      newSession: {
        provider: "codex",
        model: "gpt-5.4",
        thinking: { type: "adaptive", display: "summarized" },
        effort: "high",
      },
    });

    expect(parseSourceControlNavigationState(state)).toEqual(state);
  });

  it("rejects incomplete or invalid history state", () => {
    expect(
      parseSourceControlNavigationState({
        defaultSession: {
          projectId: "project-1",
          id: "session-1",
          title: "Fix polling",
          newSession: {
            provider: "codex",
            effort: "turbo",
          },
        },
      }),
    ).toEqual({});
    expect(
      parseSourceControlNavigationState({
        defaultSession: {
          id: "session-1",
          title: "Fix polling",
          newSession: { provider: "codex" },
        },
      }),
    ).toEqual({});
  });
});
