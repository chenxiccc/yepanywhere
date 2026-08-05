import { describe, expect, it } from "vitest";
import {
  SourceVersionedSingleFlight,
  type SourceVersionedWorkResult,
} from "../../src/lib/sourceVersionedSingleFlight.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function successful<T>(
  result: SourceVersionedWorkResult<T>,
): Extract<
  SourceVersionedWorkResult<T>,
  { status: "computed" | "hit" | "joined" }
> {
  if (result.status === "stale") {
    throw new Error("Expected accepted source-versioned work");
  }
  return result;
}

describe("SourceVersionedSingleFlight", () => {
  it("runs one computation for concurrent callers of one source version", async () => {
    const gate = deferred<string>();
    let workStarts = 0;
    const work = new SourceVersionedSingleFlight<string, string>({
      maxRetainedBytes: 1024,
      estimateBytes: (value) => value.length,
    });

    const requests = Array.from({ length: 20 }, () =>
      work.run({
        key: "session-1:children",
        sourceVersion: "mtime=10:size=100",
        compute: async () => {
          workStarts += 1;
          return gate.promise;
        },
        isCurrent: async () => true,
      }),
    );

    await Promise.resolve();
    expect(workStarts).toBe(1);
    gate.resolve("projection");
    const results = await Promise.all(requests);

    expect(
      results.filter((result) => result.status === "computed"),
    ).toHaveLength(1);
    expect(results.filter((result) => result.status === "joined")).toHaveLength(
      19,
    );
    expect(results.map((result) => successful(result).value)).toEqual(
      Array.from({ length: 20 }, () => "projection"),
    );
    expect(work.getStats()).toMatchObject({
      cacheHits: 0,
      joinedCalls: 19,
      workStarts: 1,
      retainedEntries: 1,
      retainedBytes: 10,
      inFlight: 0,
    });
  });

  it("serves an accepted exact version without recomputing", async () => {
    let workStarts = 0;
    const work = new SourceVersionedSingleFlight<string, string>({
      maxRetainedBytes: 1024,
      estimateBytes: (value) => value.length,
    });
    const options = {
      key: "session-1:children",
      sourceVersion: "v1",
      compute: async () => {
        workStarts += 1;
        return "projection";
      },
      isCurrent: async () => true,
    };

    expect((await work.run(options)).status).toBe("computed");
    expect((await work.run(options)).status).toBe("hit");
    expect(workStarts).toBe(1);
  });

  it("exposes the latest accepted value without a freshness claim", async () => {
    const work = new SourceVersionedSingleFlight<string, string>({
      maxRetainedBytes: 1024,
      estimateBytes: (value) => value.length,
    });

    expect(work.getAccepted("session-1:children")).toBeUndefined();
    await work.run({
      key: "session-1:children",
      sourceVersion: "v1",
      compute: async () => "projection",
      isCurrent: async () => true,
    });

    expect(work.getAccepted("session-1:children")).toEqual({
      sourceVersion: "v1",
      value: "projection",
    });
    expect(work.getStats()).toMatchObject({ acceptedPeeks: 1 });
  });

  it("passes the last accepted version into an incremental rebuild", async () => {
    const work = new SourceVersionedSingleFlight<string, string>({
      maxRetainedBytes: 1024,
      estimateBytes: (value) => value.length,
    });
    await work.run({
      key: "session-1:children",
      sourceVersion: "size=100",
      compute: async () => "first",
      isCurrent: async () => true,
    });

    const next = await work.run({
      key: "session-1:children",
      sourceVersion: "size=120",
      compute: async (previous) =>
        `${previous?.sourceVersion}:${previous?.value}:append`,
      isCurrent: async () => true,
    });

    expect(successful(next).value).toBe("size=100:first:append");
    expect(work.getStats()).toMatchObject({
      retainedEntries: 1,
      retainedBytes: "size=100:first:append".length,
    });
  });

  it("discards a late completion after a newer source version is observed", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    let currentVersion = "v1";
    const work = new SourceVersionedSingleFlight<string, string>({
      maxRetainedBytes: 1024,
      estimateBytes: (value) => value.length,
    });

    const oldRequest = work.run({
      key: "session-1:children",
      sourceVersion: "v1",
      compute: async () => first.promise,
      isCurrent: async (version) => currentVersion === version,
    });
    currentVersion = "v2";
    const newRequest = work.run({
      key: "session-1:children",
      sourceVersion: "v2",
      compute: async () => second.promise,
      isCurrent: async (version) => currentVersion === version,
    });

    second.resolve("new");
    expect(successful(await newRequest).value).toBe("new");
    first.resolve("old");
    await expect(oldRequest).resolves.toEqual({
      status: "stale",
      sourceVersion: "v1",
      previous: { sourceVersion: "v2", value: "new" },
    });

    const retained = await work.run({
      key: "session-1:children",
      sourceVersion: "v2",
      compute: async () => "unexpected",
      isCurrent: async () => true,
    });
    expect(retained).toMatchObject({ status: "hit", value: "new" });
    expect(work.getStats()).toMatchObject({ staleCompletions: 1 });
  });

  it("does not let a delayed older observation suppress current-version work", async () => {
    const currentGate = deferred<string>();
    const oldGate = deferred<string>();
    const currentVersion = "v2";
    const work = new SourceVersionedSingleFlight<string, string>({
      maxRetainedBytes: 1024,
      estimateBytes: (value) => value.length,
    });

    const currentRequest = work.run({
      key: "session-1:children",
      sourceVersion: "v2",
      compute: async () => currentGate.promise,
      isCurrent: async (version) => currentVersion === version,
    });
    const delayedOldRequest = work.run({
      key: "session-1:children",
      sourceVersion: "v1",
      compute: async () => oldGate.promise,
      isCurrent: async (version) => currentVersion === version,
    });

    currentGate.resolve("current");
    expect(successful(await currentRequest).value).toBe("current");
    oldGate.resolve("old");
    expect((await delayedOldRequest).status).toBe("stale");
    expect(
      await work.run({
        key: "session-1:children",
        sourceVersion: "v2",
        compute: async () => "unexpected",
        isCurrent: async () => true,
      }),
    ).toMatchObject({ status: "hit", value: "current" });
  });

  it("clears failed work so the same source version can retry", async () => {
    let attempts = 0;
    const work = new SourceVersionedSingleFlight<string, string>({
      maxRetainedBytes: 1024,
      estimateBytes: (value) => value.length,
    });
    const options = {
      key: "session-1:children",
      sourceVersion: "v1",
      compute: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("read failed");
        return "recovered";
      },
      isCurrent: async () => true,
    };

    await expect(work.run(options)).rejects.toThrow("read failed");
    expect(successful(await work.run(options)).value).toBe("recovered");
    expect(attempts).toBe(2);
    expect(work.getStats()).toMatchObject({ failures: 1, inFlight: 0 });
  });

  it("discards work invalidated while its source read is in flight", async () => {
    const gate = deferred<string>();
    const work = new SourceVersionedSingleFlight<string, string>({
      maxRetainedBytes: 1024,
      estimateBytes: (value) => value.length,
    });
    const pending = work.run({
      key: "session-1:children",
      sourceVersion: "v1",
      compute: async () => gate.promise,
      isCurrent: async () => true,
    });

    work.invalidate("session-1:children");
    gate.resolve("obsolete");
    expect((await pending).status).toBe("stale");
    expect(work.getStats()).toMatchObject({
      retainedEntries: 0,
      retainedBytes: 0,
      inFlight: 0,
    });
  });

  it("evicts least-recent accepted values to stay within the byte budget", async () => {
    const work = new SourceVersionedSingleFlight<string, string>({
      maxRetainedBytes: 10,
      estimateBytes: (value) => value.length,
    });
    const run = (key: string, value: string) =>
      work.run({
        key,
        sourceVersion: "v1",
        compute: async () => value,
        isCurrent: async () => true,
      });

    await run("a", "123456");
    await run("b", "abcdef");
    expect(work.getStats()).toMatchObject({
      evictions: 1,
      trackedKeys: 1,
      retainedEntries: 1,
      retainedBytes: 6,
    });
    expect((await run("b", "unexpected")).status).toBe("hit");
    expect((await run("a", "rebuild")).status).toBe("computed");
  });
});
