import {
  getApplicableSubscriptionUsageWindows,
  getMostUsedSubscriptionUsageWindow,
  type ProviderSubscriptionUsage,
} from "../src/provider-subscription-usage.js";
import { describe, expect, it } from "vitest";

const usage: ProviderSubscriptionUsage = {
  provider: "claude",
  fetchedAt: "2026-07-29T00:00:00.000Z",
  windows: [
    {
      id: "five-hour",
      usedPercent: 0,
      windowDurationMinutes: 300,
      scope: { type: "provider" },
    },
    {
      id: "weekly",
      usedPercent: 72,
      windowDurationMinutes: 10_080,
      scope: { type: "provider" },
    },
    {
      id: "fable-weekly",
      usedPercent: 100,
      windowDurationMinutes: 10_080,
      scope: { type: "models", modelIds: ["fable"], label: "Fable" },
    },
  ],
};

describe("provider subscription usage", () => {
  it("combines provider-wide and matching model-scoped windows", () => {
    expect(
      getApplicableSubscriptionUsageWindows(usage, "fable").map(
        (window) => window.id,
      ),
    ).toEqual(["five-hour", "weekly", "fable-weekly"]);
    expect(
      getApplicableSubscriptionUsageWindows(usage, "sonnet").map(
        (window) => window.id,
      ),
    ).toEqual(["five-hour", "weekly"]);
  });

  it("selects maximum used percent instead of the least-used window", () => {
    expect(
      getMostUsedSubscriptionUsageWindow(usage, "fable")?.usedPercent,
    ).toBe(100);
    expect(
      getMostUsedSubscriptionUsageWindow(usage, "sonnet")?.usedPercent,
    ).toBe(72);
  });
});
