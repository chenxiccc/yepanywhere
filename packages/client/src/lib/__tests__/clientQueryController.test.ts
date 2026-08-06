import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createClientQueryKey,
  ensureClientQuery,
  getClientQueryState,
  invalidateClientQueries,
  invalidateClientQuery,
  resetClientQueryControllerForTests,
  retainClientQuery,
} from "../clientQueryController";
import {
  asClientSummarySourceKey,
  type ClientSummarySourceKey,
} from "../clientSummaryStore";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const SOURCE_A = asClientSummarySourceKey("host:a");
const SOURCE_B = asClientSummarySourceKey("host:b");

describe("clientQueryController", () => {
  beforeEach(() => {
    resetClientQueryControllerForTests();
    vi.useRealTimers();
  });

  it("serializes object keys stably", () => {
    expect(createClientQueryKey({ b: 2, a: 1 })).toBe(
      createClientQueryKey({ a: 1, b: 2 }),
    );
  });

  it("shares an in-flight request when coverage is compatible", async () => {
    const request = deferred<string>();
    const fetcher = vi.fn(() => request.promise);
    const applySnapshot = vi.fn();

    const first = ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "global",
      coverage: { minRows: 100 },
      fetcher,
      applySnapshot,
    });
    const second = ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "global",
      coverage: { minRows: 50 },
      fetcher,
      applySnapshot,
    });

    expect(second).toBe(first);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);

    request.resolve("loaded");
    await Promise.all([first, second]);

    expect(applySnapshot).toHaveBeenCalledTimes(1);
    expect(getClientQueryState(SOURCE_A, "global")).toMatchObject({
      coverage: { minRows: 100 },
      inFlight: false,
      stale: false,
    });
  });

  it("uses fresh compatible coverage without another fetch", async () => {
    const fetcher = vi.fn(async () => "loaded");
    const applySnapshot = vi.fn();

    await ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "global",
      coverage: { minRows: 100 },
      fetcher,
      applySnapshot,
    });
    await ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "global",
      coverage: { minRows: 50 },
      fetcher,
      applySnapshot,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(applySnapshot).toHaveBeenCalledTimes(1);
  });

  it("forces a new request even when compatible coverage is fresh", async () => {
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");
    const applySnapshot = vi.fn();

    await ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "global",
      coverage: { minRows: 100 },
      fetcher,
      applySnapshot,
    });
    await ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "global",
      coverage: { minRows: 50 },
      force: true,
      fetcher,
      applySnapshot,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(applySnapshot).toHaveBeenCalledTimes(2);
  });

  it("shares compatible in-flight requests even when force is set", async () => {
    const revalidation = deferred<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("first")
      .mockReturnValueOnce(revalidation.promise);
    const applySnapshot = vi.fn();

    await ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "global",
      coverage: { minRows: 100 },
      fetcher,
      applySnapshot,
    });

    const forcedLarge = ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "global",
      coverage: { minRows: 100 },
      force: true,
      fetcher,
      applySnapshot,
    });
    const forcedSmall = ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "global",
      coverage: { minRows: 50 },
      force: true,
      fetcher,
      applySnapshot,
    });

    expect(forcedSmall).toBe(forcedLarge);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(getClientQueryState(SOURCE_A, "global")).toMatchObject({
      inFlight: true,
      stale: true,
    });

    revalidation.resolve("second");
    await Promise.all([forcedLarge, forcedSmall]);

    expect(applySnapshot).toHaveBeenCalledTimes(2);
    expect(getClientQueryState(SOURCE_A, "global")).toMatchObject({
      coverage: { minRows: 100 },
      inFlight: false,
      stale: false,
    });
  });

  it("fetches again when cached coverage is insufficient", async () => {
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("small")
      .mockResolvedValueOnce("large");
    const applySnapshot = vi.fn();

    await ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "global",
      coverage: { minRows: 15 },
      fetcher,
      applySnapshot,
    });
    await ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "global",
      coverage: { minRows: 50 },
      fetcher,
      applySnapshot,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(getClientQueryState(SOURCE_A, "global")?.coverage).toEqual({
      minRows: 50,
    });
  });

  it("isolates otherwise-identical queries by source", async () => {
    const fetcher = vi.fn(async () => "loaded");
    const appliedSources: ClientSummarySourceKey[] = [];

    await ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "global",
      coverage: { minRows: 50 },
      fetcher,
      applySnapshot: (_result, context) => {
        appliedSources.push(context.sourceKey);
      },
    });
    await ensureClientQuery({
      sourceKey: SOURCE_B,
      key: "global",
      coverage: { minRows: 50 },
      fetcher,
      applySnapshot: (_result, context) => {
        appliedSources.push(context.sourceKey);
      },
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(appliedSources).toEqual([SOURCE_A, SOURCE_B]);
  });

  it("reports late responses with the source captured at request start", async () => {
    const firstRequest = deferred<string>();
    const secondRequest = deferred<string>();
    const fetcherA = vi.fn(() => firstRequest.promise);
    const fetcherB = vi.fn(() => secondRequest.promise);
    const applied: Array<{
      sourceKey: ClientSummarySourceKey;
      result: string;
    }> = [];

    const first = ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "global",
      coverage: { minRows: 50 },
      fetcher: fetcherA,
      applySnapshot: (result, context) => {
        applied.push({ sourceKey: context.sourceKey, result });
      },
    });
    const second = ensureClientQuery({
      sourceKey: SOURCE_B,
      key: "global",
      coverage: { minRows: 50 },
      fetcher: fetcherB,
      applySnapshot: (result, context) => {
        applied.push({ sourceKey: context.sourceKey, result });
      },
    });

    secondRequest.resolve("second");
    await second;
    firstRequest.resolve("first");
    await first;

    expect(applied).toEqual([
      { sourceKey: SOURCE_B, result: "second" },
      { sourceKey: SOURCE_A, result: "first" },
    ]);
  });

  it("tracks retain counts and marks retained queries stale", async () => {
    const release = retainClientQuery({
      sourceKey: SOURCE_A,
      key: "global",
    });
    expect(getClientQueryState(SOURCE_A, "global")?.retainedCount).toBe(1);

    const fetcher = vi.fn(async () => "loaded");
    await ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "global",
      coverage: { minRows: 50 },
      fetcher,
    });

    invalidateClientQuery(SOURCE_A, "global");
    expect(getClientQueryState(SOURCE_A, "global")?.stale).toBe(true);

    await ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "global",
      coverage: { minRows: 50 },
      fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    release();
    expect(getClientQueryState(SOURCE_A, "global")?.retainedCount).toBe(0);
  });

  it("starts post-invalidation demand separately when the old request finishes first", async () => {
    const oldRequest = deferred<string>();
    const newRequest = deferred<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);
    const applied: string[] = [];

    const old = ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "global",
      coverage: { minRows: 100 },
      fetcher,
      applySnapshot: (result) => {
        applied.push(result);
      },
    });
    await Promise.resolve();

    invalidateClientQuery(SOURCE_A, "global");
    const current = ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "global",
      coverage: { minRows: 50 },
      fetcher,
      applySnapshot: (result) => {
        applied.push(result);
      },
    });
    expect(current).not.toBe(old);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(2);

    oldRequest.resolve("old");
    await old;
    expect(applied).toEqual([]);
    expect(getClientQueryState(SOURCE_A, "global")).toMatchObject({
      inFlight: true,
      stale: true,
    });

    newRequest.resolve("current");
    await current;
    expect(applied).toEqual(["current"]);
    expect(getClientQueryState(SOURCE_A, "global")).toMatchObject({
      coverage: { minRows: 50 },
      inFlight: false,
      stale: false,
    });
  });

  it("does not let an old completion widen newer-generation coverage", async () => {
    const oldRequest = deferred<string>();
    const newRequest = deferred<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);
    const applied: string[] = [];

    const old = ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "global",
      coverage: { minRows: 100 },
      fetcher,
      applySnapshot: (result) => {
        applied.push(result);
      },
    });
    await Promise.resolve();
    invalidateClientQuery(SOURCE_A, "global");
    const current = ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "global",
      coverage: { minRows: 50 },
      fetcher,
      applySnapshot: (result) => {
        applied.push(result);
      },
    });
    await Promise.resolve();

    newRequest.resolve("current");
    await current;
    expect(getClientQueryState(SOURCE_A, "global")).toMatchObject({
      coverage: { minRows: 50 },
      inFlight: true,
      stale: false,
    });

    oldRequest.resolve("old");
    await old;
    expect(applied).toEqual(["current"]);
    expect(getClientQueryState(SOURCE_A, "global")).toMatchObject({
      coverage: { minRows: 50 },
      inFlight: false,
      stale: false,
    });
  });

  it("shares forced callers admitted to the same generation", async () => {
    const revalidation = deferred<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("initial")
      .mockReturnValueOnce(revalidation.promise);
    await ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "global",
      coverage: { minRows: 50 },
      fetcher,
    });

    const refetches = Array.from({ length: 4 }, () =>
      ensureClientQuery({
        sourceKey: SOURCE_A,
        key: "global",
        coverage: { minRows: 50 },
        force: true,
        fetcher,
      }),
    );
    expect(new Set(refetches).size).toBe(1);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(2);

    revalidation.resolve("current");
    await Promise.all(refetches);
    expect(getClientQueryState(SOURCE_A, "global")?.stale).toBe(false);
  });

  it("keeps forced concurrent snapshots and coverage correct in either completion order", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-08-05T00:00:00.000Z"));

    for (const completionOrder of ["large-first", "small-first"] as const) {
      const key = `global:${completionOrder}`;
      const smallRequest = deferred<string>();
      const largeRequest = deferred<string>();
      const fetcher = vi
        .fn<() => Promise<string>>()
        .mockResolvedValueOnce("initial")
        .mockReturnValueOnce(smallRequest.promise)
        .mockReturnValueOnce(largeRequest.promise);
      let snapshot = "initial";

      await ensureClientQuery({
        sourceKey: SOURCE_A,
        key,
        coverage: { minRows: 100 },
        fetcher,
      });

      const applySnapshot = (result: string) => {
        snapshot = result;
      };
      const small = ensureClientQuery({
        sourceKey: SOURCE_A,
        key,
        coverage: { minRows: 50 },
        force: true,
        fetcher,
        applySnapshot,
      });
      const large = ensureClientQuery({
        sourceKey: SOURCE_A,
        key,
        coverage: { minRows: 100 },
        force: true,
        fetcher,
        applySnapshot,
      });
      const medium = ensureClientQuery({
        sourceKey: SOURCE_A,
        key,
        coverage: { minRows: 75 },
        force: true,
        fetcher,
        applySnapshot,
      });

      expect(medium).toBe(large);
      expect(small).not.toBe(large);
      await Promise.resolve();
      expect(fetcher).toHaveBeenCalledTimes(3);

      if (completionOrder === "large-first") {
        largeRequest.resolve("large");
        await large;
        smallRequest.resolve("small");
        await small;
      } else {
        smallRequest.resolve("small");
        await small;
        largeRequest.resolve("large");
        await large;
      }

      expect(snapshot).toBe("large");
      expect(getClientQueryState(SOURCE_A, key)).toMatchObject({
        coverage: { minRows: 100 },
        inFlight: false,
        stale: false,
      });
    }
  });

  it("does not let a dominated late failure overwrite query state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-08-05T00:00:00.000Z"));

    const smallRequest = deferred<string>();
    const largeRequest = deferred<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("initial")
      .mockReturnValueOnce(smallRequest.promise)
      .mockReturnValueOnce(largeRequest.promise);
    let snapshot = "initial";

    await ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "dominated-error",
      coverage: { minRows: 100 },
      fetcher,
    });
    const applySnapshot = (result: string) => {
      snapshot = result;
    };
    const small = ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "dominated-error",
      coverage: { minRows: 50 },
      force: true,
      fetcher,
      applySnapshot,
    });
    const large = ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "dominated-error",
      coverage: { minRows: 100 },
      force: true,
      fetcher,
      applySnapshot,
    });
    await Promise.resolve();

    largeRequest.resolve("large");
    await large;
    smallRequest.reject(new Error("late narrow failure"));
    await expect(small).resolves.toEqual({ status: "covered" });

    expect(snapshot).toBe("large");
    expect(getClientQueryState(SOURCE_A, "dominated-error")).toMatchObject({
      coverage: { minRows: 100 },
      stale: false,
      error: undefined,
    });
  });

  it("still propagates current and incomparable same-generation failures", async () => {
    const currentError = new Error("current failure");
    await expect(
      ensureClientQuery({
        sourceKey: SOURCE_A,
        key: "current-error",
        fetcher: async () => {
          throw currentError;
        },
      }),
    ).rejects.toBe(currentError);
    expect(getClientQueryState(SOURCE_A, "current-error")?.error).toBe(
      currentError,
    );

    const rowsRequest = deferred<string>();
    const statsRequest = deferred<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(rowsRequest.promise)
      .mockReturnValueOnce(statsRequest.promise);
    const rows = ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "incomparable-error",
      coverage: { minRows: 100 },
      fetcher,
    });
    const stats = ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "incomparable-error",
      coverage: { includeStats: true },
      fetcher,
    });
    await Promise.resolve();

    statsRequest.resolve("stats");
    await stats;
    const rowsError = new Error("incomparable rows failure");
    rowsRequest.reject(rowsError);
    await expect(rows).rejects.toBe(rowsError);
    expect(getClientQueryState(SOURCE_A, "incomparable-error")?.error).toBe(
      rowsError,
    );
  });

  it("applies incomparable same-generation coverage independently", async () => {
    const rowsRequest = deferred<string>();
    const statsRequest = deferred<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("initial")
      .mockReturnValueOnce(rowsRequest.promise)
      .mockReturnValueOnce(statsRequest.promise);
    const applied: string[] = [];

    await ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "incomparable",
      fetcher,
    });
    const applySnapshot = (result: string) => {
      applied.push(result);
    };
    const rows = ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "incomparable",
      coverage: { minRows: 100 },
      force: true,
      fetcher,
      applySnapshot,
    });
    const stats = ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "incomparable",
      coverage: { includeStats: true },
      force: true,
      fetcher,
      applySnapshot,
    });
    await Promise.resolve();

    statsRequest.resolve("stats");
    await stats;
    rowsRequest.resolve("rows");
    await rows;

    expect(applied).toEqual(["stats", "rows"]);
    expect(getClientQueryState(SOURCE_A, "incomparable")).toMatchObject({
      coverage: { minRows: 100, includeStats: true },
      stale: false,
    });
  });

  it("keeps a query stale when an unforced invalidation races a joined force", async () => {
    const revalidation = deferred<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("first")
      .mockReturnValueOnce(revalidation.promise);

    await ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "global",
      coverage: { minRows: 50 },
      fetcher,
    });

    invalidateClientQuery(SOURCE_A, "global");
    const forced = ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "global",
      coverage: { minRows: 50 },
      force: true,
      fetcher,
    });
    const joined = ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "global",
      coverage: { minRows: 50 },
      force: true,
      fetcher,
    });
    expect(joined).toBe(forced);

    // Not a joining consumer: a real change landed while the request was open,
    // so its response is already behind.
    invalidateClientQuery(SOURCE_A, "global");
    revalidation.resolve("second");
    await forced;

    expect(getClientQueryState(SOURCE_A, "global")?.stale).toBe(true);
  });

  it("invalidates matching queries with a predicate", async () => {
    const fetcher = vi.fn(async () => "loaded");
    await ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "global",
      coverage: { minRows: 50 },
      fetcher,
    });
    await ensureClientQuery({
      sourceKey: SOURCE_A,
      key: "settings",
      fetcher,
    });

    invalidateClientQueries(
      (state) => state.sourceKey === SOURCE_A && state.key === "global",
    );

    expect(getClientQueryState(SOURCE_A, "global")?.stale).toBe(true);
    expect(getClientQueryState(SOURCE_A, "settings")?.stale).toBe(false);
  });
});
