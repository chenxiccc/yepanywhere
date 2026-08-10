import { describe, expect, it } from "vitest";
import {
  formatCodexStatusCommand,
  formatCodexUsageCommand,
  isCodexChatGptAccount,
  parseCodexUsageView,
} from "../../../src/sdk/providers/codex-account-commands.js";

describe("Codex account commands", () => {
  it("accepts the Codex /usage view aliases and rejects extra arguments", () => {
    expect(parseCodexUsageView(undefined)).toBe("daily");
    expect(parseCodexUsageView("day")).toBe("daily");
    expect(parseCodexUsageView("week")).toBe("weekly");
    expect(parseCodexUsageView("cumulative")).toBe("cumulative");
    expect(parseCodexUsageView("month")).toBeNull();
  });

  it("distinguishes ChatGPT subscription auth from API-key auth", () => {
    expect(isCodexChatGptAccount({ account: { type: "chatgpt" } })).toBe(true);
    expect(isCodexChatGptAccount({ account: { type: "apiKey" } })).toBe(false);
  });

  it("formats account token activity independently of session tokens", () => {
    const output = formatCodexUsageCommand(
      {
        summary: {
          lifetimeTokens: 1_234_567,
          peakDailyTokens: 45_000,
          longestRunningTurnSec: 3723,
          currentStreakDays: 2,
          longestStreakDays: 5,
        },
        dailyUsageBuckets: [
          { startDate: "2026-08-03", tokens: 100 },
          { startDate: "2026-08-04", tokens: 250 },
          { startDate: "2026-08-10", tokens: 400 },
        ],
      },
      "weekly",
    );

    expect(output.summary).toBe("/usage weekly");
    expect(output.details).toEqual([
      expect.stringContaining("Lifetime: 1,234,567"),
      expect.stringContaining("week of 2026-08-03  350"),
    ]);
    expect(output.details?.[1]).toContain("week of 2026-08-10  400");
  });

  it("keeps /status useful when account probes are unavailable", () => {
    const output = formatCodexStatusCommand({
      model: "gpt-5.6",
      cwd: "/workspace",
      permissionMode: "default",
      threadId: "thread-1",
      tokenUsage: {
        totalTokens: 1_200,
        inputTokens: 800,
        outputTokens: 400,
        cachedInputTokens: 600,
        contextWindow: 272_000,
      },
    });

    expect(output.details).toEqual([
      expect.stringContaining("Model: gpt-5.6"),
      "Account: unavailable",
      expect.stringContaining(
        "Token usage: 1,200 total (800 input + 400 output)",
      ),
      "Limits: unavailable",
    ]);
  });
});
