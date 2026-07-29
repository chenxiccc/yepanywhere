import {
  normalizeClaudeSubscriptionUsage,
  normalizeCodexSubscriptionUsage,
} from "../../../src/sdk/providers/provider-subscription-usage.js";
import { describe, expect, it } from "vitest";

describe("provider subscription usage normalization", () => {
  it("keeps Claude account windows and resolves model-specific buckets", () => {
    const usage = normalizeClaudeSubscriptionUsage(
      {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: {
            utilization: 0,
            resets_at: "2026-07-29T01:00:00Z",
          },
          seven_day: {
            utilization: 72,
            resets_at: "2026-08-02T00:00:00Z",
          },
          model_scoped: [
            {
              display_name: "Fable",
              utilization: 100,
              resets_at: "2026-08-03T00:00:00Z",
            },
          ],
        },
      },
      [
        { id: "fable", name: "Fable" },
        { id: "sonnet", name: "Sonnet" },
      ],
      new Date("2026-07-29T00:00:00Z"),
    );

    expect(usage).toEqual({
      provider: "claude",
      fetchedAt: "2026-07-29T00:00:00.000Z",
      windows: [
        expect.objectContaining({
          id: "claude:five-hour",
          usedPercent: 0,
          scope: { type: "provider" },
        }),
        expect.objectContaining({
          id: "claude:seven-day",
          usedPercent: 72,
          scope: { type: "provider" },
        }),
        expect.objectContaining({
          id: "claude:model:fable",
          usedPercent: 100,
          scope: {
            type: "models",
            modelIds: ["fable"],
            label: "Fable",
          },
        }),
      ],
    });
  });

  it("returns no Claude usage for API-key-style sessions", () => {
    expect(
      normalizeClaudeSubscriptionUsage(
        {
          subscription_type: null,
          rate_limits_available: false,
          rate_limits: null,
        },
        [],
      ),
    ).toBeNull();
  });

  it("maps Codex named buckets to catalog model ids", () => {
    const usage = normalizeCodexSubscriptionUsage(
      {
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: null,
          secondary: {
            usedPercent: 15,
            windowDurationMins: 10_080,
            resetsAt: 1_775_000_000,
          },
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            limitName: null,
            primary: null,
            secondary: {
              usedPercent: 15,
              windowDurationMins: 10_080,
              resetsAt: 1_775_000_000,
            },
          },
          codex_bengalfox: {
            limitId: "codex_bengalfox",
            limitName: "GPT-5.3-Codex-Spark",
            primary: null,
            secondary: {
              usedPercent: 100,
              windowDurationMins: 10_080,
              resetsAt: 1_775_000_000,
            },
          },
        },
      },
      [
        { id: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
        { id: "gpt-5.3-codex-spark", name: "GPT-5.3-Codex-Spark" },
      ],
      new Date("2026-07-29T00:00:00Z"),
    );

    expect(usage?.windows).toEqual([
      expect.objectContaining({
        id: "codex:codex:secondary",
        usedPercent: 15,
        scope: { type: "provider" },
      }),
      expect.objectContaining({
        id: "codex:codex_bengalfox:secondary",
        usedPercent: 100,
        scope: {
          type: "models",
          modelIds: ["gpt-5.3-codex-spark"],
          label: "GPT-5.3-Codex-Spark",
        },
      }),
    ]);
  });

  it("drops unknown Codex model buckets instead of applying them globally", () => {
    const usage = normalizeCodexSubscriptionUsage(
      {
        rateLimits: {
          limitId: "unknown-model",
          limitName: "Future Model",
          primary: {
            usedPercent: 90,
            windowDurationMins: 300,
            resetsAt: null,
          },
          secondary: null,
        },
      },
      [{ id: "known", name: "Known" }],
    );

    expect(usage).toBeNull();
  });
});
