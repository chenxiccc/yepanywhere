import { beforeEach, describe, expect, it, vi } from "vitest";
import { asClientSummarySourceKey } from "../clientSummaryStore";
import {
  clearRouteRetentionForSource,
  getRouteRetentionDiagnostics,
  readRouteRetention,
  readRouteRetentionResult,
  resetRouteRetentionForTests,
  subscribeRouteRetention,
  writeRouteRetention,
} from "../routeRetention";

const SOURCE_A = asClientSummarySourceKey("host:a");
const SOURCE_B = asClientSummarySourceKey("host:b");

describe("routeRetention", () => {
  beforeEach(() => {
    resetRouteRetentionForTests();
  });

  it("matches route keys by source, route, project, and normalized query", () => {
    writeRouteRetention(
      {
        sourceKey: SOURCE_A,
        routeId: "git-status",
        projectId: "project-a",
        queryParams: new URLSearchParams("b=2&a=1"),
      },
      { selectedFileKey: "a.ts" },
      { nowMs: 0 },
    );

    expect(
      readRouteRetention<{ selectedFileKey: string }>(
        {
          sourceKey: SOURCE_A,
          routeId: "git-status",
          projectId: "project-a",
          queryParams: new URLSearchParams("a=1&b=2"),
        },
        { nowMs: 1 },
      )?.selectedFileKey,
    ).toBe("a.ts");
    expect(
      readRouteRetention(
        {
          sourceKey: SOURCE_B,
          routeId: "git-status",
          projectId: "project-a",
          queryParams: new URLSearchParams("a=1&b=2"),
        },
        { nowMs: 1 },
      ),
    ).toBeNull();
  });

  it("expires entries by TTL", () => {
    const key = {
      sourceKey: SOURCE_A,
      routeId: "settings",
      projectId: null,
    };

    writeRouteRetention(
      key,
      { category: "providers" },
      { ttlMs: 10, nowMs: 0 },
    );

    expect(readRouteRetention(key, { nowMs: 9 })).toEqual({
      category: "providers",
    });
    expect(readRouteRetentionResult(key, { nowMs: 11 })).toMatchObject({
      value: null,
      missReason: "expired",
    });
  });

  it("does not publish while a quiet external-store read observes expiry", () => {
    const key = {
      sourceKey: SOURCE_A,
      routeId: "git-status:file-projections",
      projectId: "project-a",
    };
    writeRouteRetention(key, { statusKey: "old" }, { ttlMs: 10, nowMs: 0 });
    const listener = vi.fn();
    const unsubscribe = subscribeRouteRetention(listener);

    expect(
      readRouteRetention(key, {
        nowMs: 11,
        touch: false,
        recordDiagnostics: false,
      }),
    ).toBeNull();
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
  });

  it("evicts least-recently-used entries when over the entry cap", () => {
    const first = { sourceKey: SOURCE_A, routeId: "one" };
    const second = { sourceKey: SOURCE_A, routeId: "two" };
    const third = { sourceKey: SOURCE_A, routeId: "three" };

    writeRouteRetention(first, { value: 1 }, { maxEntries: 2, nowMs: 0 });
    writeRouteRetention(second, { value: 2 }, { maxEntries: 2, nowMs: 1 });
    expect(readRouteRetention(first, { nowMs: 2 })).toEqual({ value: 1 });
    writeRouteRetention(third, { value: 3 }, { maxEntries: 2, nowMs: 3 });

    expect(readRouteRetention(first, { nowMs: 4 })).toEqual({ value: 1 });
    expect(readRouteRetention(second, { nowMs: 4 })).toBeNull();
    expect(readRouteRetention(third, { nowMs: 4 })).toEqual({ value: 3 });
  });

  it("evicts older entries when over the byte cap", () => {
    const first = { sourceKey: SOURCE_A, routeId: "one" };
    const second = { sourceKey: SOURCE_A, routeId: "two" };

    writeRouteRetention(first, { value: 1 }, { approxBytes: 6, maxBytes: 10 });
    writeRouteRetention(second, { value: 2 }, { approxBytes: 6, maxBytes: 10 });

    expect(readRouteRetention(first)).toBeNull();
    expect(readRouteRetention(second)).toEqual({ value: 2 });
    expect(
      getRouteRetentionDiagnostics().events.some(
        (event) => event.type === "evict" && event.reason === "lru",
      ),
    ).toBe(true);
  });

  it("clears one source without touching another", () => {
    writeRouteRetention(
      { sourceKey: SOURCE_A, routeId: "inbox" },
      { value: 1 },
    );
    writeRouteRetention(
      { sourceKey: SOURCE_B, routeId: "inbox" },
      { value: 2 },
    );

    clearRouteRetentionForSource(SOURCE_A);

    expect(readRouteRetention({ sourceKey: SOURCE_A, routeId: "inbox" })).toBe(
      null,
    );
    expect(
      readRouteRetention({ sourceKey: SOURCE_B, routeId: "inbox" }),
    ).toEqual({ value: 2 });
  });
});
