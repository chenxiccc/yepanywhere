import { describe, expect, it } from "vitest";
import {
  countRecentlyActiveProviderChildren,
  firstDefinedProviderChildren,
  latestProviderChildUpdatedAt,
  providerChildSessionHref,
  providerChildTitle,
} from "../providerChildSessions";

const child = {
  id: "child-1",
  parentSessionId: "sess-1",
  title: "Audit the API",
  agentType: "Explore",
  updatedAt: "2026-08-16T12:00:00.000Z",
};

describe("providerChildSessions helpers", () => {
  it("builds a nested child URL without promoting the child id", () => {
    expect(providerChildSessionHref("", "proj-1", "sess-1", "agent/1")).toBe(
      "/projects/proj-1/sessions/sess-1/agents/agent%2F1",
    );
  });

  it("prefers a defined live list over session metadata", () => {
    expect(firstDefinedProviderChildren(undefined, [child])).toEqual([child]);
    expect(firstDefinedProviderChildren([], [child])).toEqual([]);
  });

  it("counts recently active children only while the parent is in-turn", () => {
    const now = Date.parse("2026-08-16T12:00:30.000Z");
    expect(countRecentlyActiveProviderChildren([child], "in-turn", now)).toBe(
      1,
    );
    expect(countRecentlyActiveProviderChildren([child], "idle", now)).toBe(0);
    expect(latestProviderChildUpdatedAt([child])).toBe(child.updatedAt);
    expect(providerChildTitle(child, "fallback")).toBe("Audit the API");
  });
});
