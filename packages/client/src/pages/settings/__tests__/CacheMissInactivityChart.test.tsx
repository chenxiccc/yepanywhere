// @vitest-environment jsdom

import type { CacheMissBillingRecord } from "@yep-anywhere/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../../i18n";
import {
  bucketByInactivity,
  CacheMissInactivityChart,
  CacheMissProbabilityChart,
  CacheMissProviderChart,
  logarithmicRateWidth,
} from "../CacheMissInactivityChart";

function record(
  overrides: Partial<CacheMissBillingRecord>,
): CacheMissBillingRecord {
  return {
    id: Math.random().toString(36).slice(2),
    timestamp: "2026-08-17T00:00:00.000Z",
    provider: "claude",
    sessionId: "session-1",
    projectId: "project-1" as CacheMissBillingRecord["projectId"],
    sessionPath: "/projects/project-1/sessions/session-1",
    reason: "warm-session-cache-miss",
    outcome: "unexpected-recompute",
    exception: true,
    observedUsage: {
      inputTokens: 0,
      totalContextTokens: 0,
      uncachedInputTokens: 0,
    },
    expectedInputCost: {
      state: "expected-new-content",
      source: "warm-session",
      prefixBasis: "same-session-prefix",
      freshEnough: true,
      providerFreshWindowMinutes: 60,
    },
    wastedInputTokens: 0,
    freshWindowMinutes: 60,
    expectedCacheSource: "warm-session",
    ...overrides,
  };
}

describe("bucketByInactivity", () => {
  it("sums wasted tokens into the bucket holding the idle gap", () => {
    const buckets = bucketByInactivity([
      record({ elapsedSinceExpectedCacheMs: 29_999, wastedInputTokens: 5000 }),
      record({ elapsedSinceExpectedCacheMs: 90_000, wastedInputTokens: 7000 }),
      record({
        elapsedSinceExpectedCacheMs: 45 * 60_000,
        wastedInputTokens: 120_000,
      }),
    ]);

    expect(
      buckets.find((bucket) => bucket.toMinutes === 0.5)?.wastedTokens,
    ).toBe(5000);
    expect(buckets.find((bucket) => bucket.toMinutes === 2)?.wastedTokens).toBe(
      7000,
    );
    expect(
      buckets.find((bucket) => bucket.toMinutes === 64)?.wastedTokens,
    ).toBe(120_000);
  });

  it("counts hits alongside misses so a bucket shows its rate", () => {
    const buckets = bucketByInactivity([
      record({ elapsedSinceExpectedCacheMs: 4 * 60_000 }),
      record({
        elapsedSinceExpectedCacheMs: 4 * 60_000,
        outcome: "expected-cache-hit",
        reason: "warm-session-cache-hit",
      }),
    ]);

    const bucket = buckets.find((candidate) => candidate.toMinutes === 8);
    expect(bucket).toMatchObject({ misses: 1, hits: 1 });
  });

  it("counts expected expiry as a miss rather than a cache hit", () => {
    const buckets = bucketByInactivity([
      record({
        elapsedSinceExpectedCacheMs: 70 * 60_000,
        reason: "warm-session-cache-expiry",
        outcome: "expected-cache-expiry",
        exception: false,
        wastedInputTokens: 12_000,
        expectedInputCost: {
          state: "expected-new-content",
          source: "warm-session",
          prefixBasis: "same-session-prefix",
          freshEnough: false,
          providerFreshWindowMinutes: 60,
        },
      }),
    ]);

    expect(buckets[0]).toMatchObject({
      misses: 1,
      hits: 0,
      wastedTokens: 12_000,
    });
  });

  it("creates a doubling bucket for arbitrarily long gaps", () => {
    const buckets = bucketByInactivity([
      record({
        elapsedSinceExpectedCacheMs: 40 * 60 * 60_000,
        wastedInputTokens: 42,
      }),
    ]);

    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({
      fromMinutes: 2048,
      toMinutes: 4096,
      wastedTokens: 42,
    });
  });

  it("returns only ranges containing observations", () => {
    const buckets = bucketByInactivity([
      record({ elapsedSinceExpectedCacheMs: 20_000 }),
      record({ elapsedSinceExpectedCacheMs: 3 * 60_000 }),
    ]);

    expect(
      buckets.map(({ fromMinutes, toMinutes }) => [fromMinutes, toMinutes]),
    ).toEqual([
      [0, 0.5],
      [2, 4],
    ]);
  });

  it("ignores observations with no measured gap", () => {
    const buckets = bucketByInactivity([record({ wastedInputTokens: 999 })]);
    expect(buckets).toEqual([]);
  });
});

describe("CacheMissInactivityChart", () => {
  afterEach(cleanup);

  it("renders a row per populated bucket with its miss rate", () => {
    render(
      <I18nProvider>
        <CacheMissInactivityChart
          events={[
            record({
              elapsedSinceExpectedCacheMs: 45 * 60_000,
              wastedInputTokens: 120_000,
            }),
            record({
              elapsedSinceExpectedCacheMs: 45 * 60_000,
              outcome: "expected-cache-hit",
              reason: "warm-session-cache-hit",
            }),
          ]}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("32m–64m")).toBeTruthy();
    expect(screen.queryByText("16m–32m")).toBeNull();
    expect(screen.getByText("120K")).toBeTruthy();
    expect(screen.getByText("1/2 missed")).toBeTruthy();
  });

  it("splits zero, sub-30-second, and 30-second gaps at the first edge", () => {
    render(
      <I18nProvider>
        <CacheMissInactivityChart
          events={[
            record({ elapsedSinceExpectedCacheMs: 0 }),
            record({ elapsedSinceExpectedCacheMs: 29_999 }),
            record({ elapsedSinceExpectedCacheMs: 30_000 }),
          ]}
        />
      </I18nProvider>,
    );

    const firstBin = screen.getByText("0–30s").closest("li");
    expect(firstBin).toBeTruthy();
    expect(firstBin?.textContent).toContain("2/2 missed");
    expect(screen.getByText("30s–1m").closest("li")?.textContent).toContain(
      "1/1 missed",
    );
  });

  it("lists the exact provider/model tuples represented by a bar", () => {
    render(
      <I18nProvider>
        <CacheMissInactivityChart
          events={[
            record({
              elapsedSinceExpectedCacheMs: 30_000,
              model: "opus",
            }),
            record({
              elapsedSinceExpectedCacheMs: 30_000,
              provider: "codex",
              model: "gpt-5.6",
            }),
          ]}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("30s–1m").closest("li")?.title).toBe(
      "Provider / model tuples with events:\nclaude / opus\ncodex / gpt-5.6",
    );
  });

  it("says so when nothing timed has been recorded", () => {
    render(
      <I18nProvider>
        <CacheMissInactivityChart events={[]} />
      </I18nProvider>,
    );

    expect(
      screen.getByText("No timed observations recorded yet."),
    ).toBeTruthy();
  });
});

describe("cache-miss probability charts", () => {
  afterEach(cleanup);

  it("uses only complete records for both the bar and exact sample label", () => {
    render(
      <I18nProvider>
        <CacheMissProbabilityChart
          events={[
            record({ elapsedSinceExpectedCacheMs: 15 * 60_000 }),
            record({
              elapsedSinceExpectedCacheMs: 15 * 60_000,
              completeProbabilitySample: true,
            }),
            record({
              elapsedSinceExpectedCacheMs: 15 * 60_000,
              outcome: "expected-cache-hit",
              reason: "warm-session-cache-hit",
              completeProbabilitySample: true,
            }),
          ]}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getByText("1/2 missed")).toBeTruthy();
  });

  it("breaks the same complete sample down by provider", () => {
    render(
      <I18nProvider>
        <CacheMissProviderChart
          events={[
            record({ completeProbabilitySample: true, model: "opus" }),
            record({
              completeProbabilitySample: true,
              outcome: "expected-cache-hit",
              reason: "warm-session-cache-hit",
              model: "sonnet",
            }),
            record({
              provider: "codex",
              completeProbabilitySample: true,
              outcome: "expected-cache-hit",
              reason: "warm-session-cache-hit",
              model: "gpt-5.6",
            }),
          ]}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("claude").closest("li")?.textContent).toContain(
      "1/2 missed",
    );
    expect(screen.getByText("codex").closest("li")?.textContent).toContain(
      "0/1 missed",
    );
    expect(screen.getByText("claude").closest("li")?.title).toContain(
      "claude / opus",
    );
  });

  it("gives very small nonzero rates a visible logarithmic width", () => {
    expect(logarithmicRateWidth(0.0001)).toBeGreaterThan(0);
    expect(logarithmicRateWidth(0.0001)).toBeLessThan(
      logarithmicRateWidth(0.01),
    );
  });
});
