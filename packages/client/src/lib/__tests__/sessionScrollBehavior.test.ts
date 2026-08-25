import { describe, expect, it } from "vitest";
import {
  decideSessionScrollRestore,
  parseSessionScrollBehaviorMode,
} from "../sessionScrollBehavior";
import type { SessionRouteScrollSnapshot } from "../sessionRouteSnapshots";

function snapshot(
  overrides: Partial<SessionRouteScrollSnapshot> = {},
): SessionRouteScrollSnapshot {
  return {
    atBottom: true,
    scrollTop: 500,
    scrollHeight: 1000,
    clientHeight: 500,
    anchor: { id: "answer-1", topOffset: 0 },
    updatedAtMs: 100,
    ...overrides,
  };
}

describe("sessionScrollBehavior", () => {
  it("maps the retired manual-follow preference to remember-place", () => {
    expect(parseSessionScrollBehaviorMode("manual-follow")).toBe(
      "remember-place",
    );
  });

  it("uses stored follow intent for live-tail restore", () => {
    expect(
      decideSessionScrollRestore({
        mode: "live-tail",
        snapshot: snapshot({ atBottom: false, following: true }),
        topTolerancePx: 1,
      }),
    ).toBe("follow-bottom");
    expect(
      decideSessionScrollRestore({
        mode: "live-tail",
        snapshot: snapshot({ following: false }),
        topTolerancePx: 1,
      }),
    ).toBe("restore-position");
  });
});
