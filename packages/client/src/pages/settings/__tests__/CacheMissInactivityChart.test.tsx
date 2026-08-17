// @vitest-environment jsdom

import type { CacheMissBillingRecord } from "@yep-anywhere/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../../i18n";
import {
  bucketByInactivity,
  CacheMissInactivityChart,
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
      record({ elapsedSinceExpectedCacheMs: 30_000, wastedInputTokens: 5000 }),
      record({ elapsedSinceExpectedCacheMs: 90_000, wastedInputTokens: 7000 }),
      record({
        elapsedSinceExpectedCacheMs: 45 * 60_000,
        wastedInputTokens: 120_000,
      }),
    ]);

    expect(buckets.find((bucket) => bucket.toMinutes === 1)?.wastedTokens).toBe(
      5000,
    );
    expect(buckets.find((bucket) => bucket.toMinutes === 2)?.wastedTokens).toBe(
      7000,
    );
    expect(
      buckets.find((bucket) => bucket.toMinutes === 60)?.wastedTokens,
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

    const bucket = buckets.find((candidate) => candidate.toMinutes === 5);
    expect(bucket).toMatchObject({ misses: 1, hits: 1 });
  });

  it("puts anything past the last edge in the open bucket", () => {
    const buckets = bucketByInactivity([
      record({
        elapsedSinceExpectedCacheMs: 8 * 60 * 60_000,
        wastedInputTokens: 42,
      }),
    ]);

    const open = buckets[buckets.length - 1];
    expect(open?.toMinutes).toBeUndefined();
    expect(open?.wastedTokens).toBe(42);
  });

  it("ignores observations with no measured gap", () => {
    const buckets = bucketByInactivity([record({ wastedInputTokens: 999 })]);
    expect(buckets.every((bucket) => bucket.wastedTokens === 0)).toBe(true);
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

    expect(screen.getByText("30–60m")).toBeTruthy();
    expect(screen.getByText("120K")).toBeTruthy();
    expect(screen.getByText("1/2 missed")).toBeTruthy();
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
