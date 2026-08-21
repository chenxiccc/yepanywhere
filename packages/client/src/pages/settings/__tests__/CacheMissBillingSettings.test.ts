import type { CacheMissBillingRecord } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  cacheMissBillingSettingsForServer,
  filterCacheMissEvents,
} from "../CacheMissBillingSettings";

function record(
  id: string,
  timestamp: string,
  elapsedSinceExpectedCacheMs?: number,
): CacheMissBillingRecord {
  return {
    id,
    timestamp,
    provider: "claude",
    sessionId: `session-${id}`,
    projectId: "project-1" as CacheMissBillingRecord["projectId"],
    sessionPath: `/projects/project-1/sessions/session-${id}`,
    reason: "warm-session-cache-hit",
    outcome: "expected-cache-hit",
    exception: false,
    observedUsage: {
      inputTokens: 100,
      cacheReadTokens: 100,
      totalContextTokens: 100,
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
    ...(elapsedSinceExpectedCacheMs === undefined
      ? {}
      : { elapsedSinceExpectedCacheMs }),
    expectedCacheSource: "warm-session",
  };
}

describe("filterCacheMissEvents", () => {
  const nowMs = Date.parse("2026-08-20T12:00:00.000Z");
  const events = [
    record("eligible", "2026-08-20T11:30:00.000Z", 5 * 60_000),
    record("past-idle-cutoff", "2026-08-20T11:30:00.000Z", 20 * 60_000),
    record("untimed", "2026-08-20T11:30:00.000Z"),
    record("too-old", "2026-08-20T09:00:00.000Z", 5 * 60_000),
  ];

  it("applies recency and idle cutoff to one shared event subset", () => {
    expect(
      filterCacheMissEvents(events, 1, 10, nowMs).map(({ id }) => id),
    ).toEqual(["eligible", "untimed"]);
  });

  it("treats blank recency and zero idle cutoff as unlimited", () => {
    expect(
      filterCacheMissEvents(events, null, 0, nowMs).map(({ id }) => id),
    ).toEqual(events.map(({ id }) => id));
  });
});

describe("cacheMissBillingSettingsForServer", () => {
  const settings = {
    enabled: true,
    recentActivityMinutes: 10,
    ignoreAfterMinutes: 30,
  };

  it("omits ignore-after when the server capability is absent", () => {
    expect(cacheMissBillingSettingsForServer(settings, false)).toEqual({
      enabled: true,
      recentActivityMinutes: 10,
    });
  });

  it("preserves ignore-after when the server capability is present", () => {
    expect(cacheMissBillingSettingsForServer(settings, true)).toEqual(settings);
  });
});
