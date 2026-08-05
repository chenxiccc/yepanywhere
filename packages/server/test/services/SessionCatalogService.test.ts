import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SessionCatalogService,
  type SessionCatalogServiceOptions,
} from "../../src/services/SessionCatalogService.js";
import type {
  NativeSessionCatalogAdapter,
  SessionCatalogRow,
} from "../../src/sessions/catalog-types.js";

interface RowSpec {
  sessionId: string;
  project: string;
  updatedAt?: string;
  title?: string;
}

function row(spec: RowSpec): SessionCatalogRow {
  return {
    catalogFamily: "codex",
    storeKey: "default",
    sessionId: spec.sessionId,
    projectId: `id-${spec.project}` as UrlProjectId,
    projectPath: `/projects/${spec.project}`,
    projectIdentityKey: `/projects/${spec.project}`,
    updatedAt: spec.updatedAt ?? "2026-08-01T00:00:00.000Z",
    ...(spec.title === undefined ? {} : { title: spec.title }),
    fidelity: "identity",
    sourceVersion: `${spec.sessionId}@${spec.updatedAt ?? "base"}`,
    location: { kind: "file", path: `/store/${spec.sessionId}.jsonl` },
  };
}

interface CountingAdapter extends NativeSessionCatalogAdapter {
  scans: number;
}

function adapter(
  rows: readonly SessionCatalogRow[],
  options: { sourceVersion?: string; failWith?: Error } = {},
): CountingAdapter {
  const instance: CountingAdapter = {
    catalogFamily: "codex",
    storeKey: "default",
    scans: 0,
    scan: async () => {
      instance.scans += 1;
      if (options.failWith) throw options.failWith;
      return {
        sourceVersion: options.sourceVersion ?? "store-v1",
        rows: rows.map((candidate) => ({ ...candidate })),
      };
    },
  };
  return instance;
}

describe("SessionCatalogService", () => {
  let dataDir: string;
  const services: SessionCatalogService[] = [];

  function createService(
    overrides: Partial<SessionCatalogServiceOptions> = {},
  ): SessionCatalogService {
    const service = new SessionCatalogService({ dataDir, ...overrides });
    services.push(service);
    return service;
  }

  beforeEach(async () => {
    dataDir = join(tmpdir(), `session-catalog-${randomUUID()}`);
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    for (const service of services.splice(0)) service.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("serves the last durable generation after restart without scanning", async () => {
    const first = createService();
    await first.initialize();
    const source = adapter([
      row({ sessionId: "a", project: "alpha" }),
      row({ sessionId: "b", project: "beta" }),
    ]);
    await first.reconcile([source]);
    expect(source.scans).toBe(1);

    const restarted = createService();
    const snapshot = await restarted.initialize();
    const alpha = await restarted.readProjectRows("/projects/alpha");

    expect(snapshot.catalogGeneration).toBe(1);
    expect(alpha.rows.map((entry) => entry.sessionId)).toEqual(["a"]);
    expect(source.scans).toBe(1);
    expect(restarted.getMetrics().catalogEpoch).toBe(
      first.getMetrics().catalogEpoch,
    );
  });

  it("answers twenty simultaneous project readers with one shard read", async () => {
    const service = createService();
    await service.initialize();
    await service.reconcile([
      adapter([
        row({ sessionId: "a", project: "alpha" }),
        row({ sessionId: "b", project: "alpha" }),
      ]),
    ]);

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.readProjectRows("/projects/alpha"),
      ),
    );

    expect(results).toHaveLength(20);
    for (const result of results) {
      expect(result.rows.map((entry) => entry.sessionId)).toEqual(["a", "b"]);
    }
    expect(service.getMetrics().projectDiskReads).toBe(1);
  });

  it("keeps an unrelated project's shard token and rows across a generation", async () => {
    const service = createService();
    await service.initialize();
    await service.reconcile([
      adapter([
        row({ sessionId: "a", project: "alpha" }),
        row({ sessionId: "b", project: "beta" }),
      ]),
    ]);
    const alphaToken = service.getProjectToken("/projects/alpha");
    // The point of the test is a change isolated to another shard.
    expect(alphaToken.bucket).not.toBe(
      service.getProjectToken("/projects/beta").bucket,
    );
    await service.readProjectRows("/projects/alpha");
    const readsAfterFirst = service.getMetrics().projectDiskReads;

    // Only beta changes; alpha's bucket must stay at its own generation.
    await service.reconcile([
      adapter(
        [
          row({ sessionId: "a", project: "alpha" }),
          row({
            sessionId: "b",
            project: "beta",
            updatedAt: "2026-08-02T00:00:00.000Z",
          }),
        ],
        { sourceVersion: "store-v2" },
      ),
    ]);

    const metrics = service.getMetrics();
    expect(metrics.catalogGeneration).toBe(2);
    expect(service.getProjectToken("/projects/alpha").shardGeneration).toBe(
      alphaToken.shardGeneration,
    );
    expect(service.getProjectToken("/projects/beta").shardGeneration).toBe(2);
    expect(
      service.getProjectConditional("/projects/alpha", alphaToken).status,
    ).toBe("no-change");
    expect(metrics.deltaShardsSkippedByHash).toBeGreaterThan(0);

    // The unchanged shard is byte-identical, so its rows are reused.
    await service.readProjectRows("/projects/alpha");
    expect(service.getMetrics().projectDiskReads).toBe(readsAfterFirst);
  });

  it("advances a project's shard generation when its own rows change", async () => {
    const service = createService();
    await service.initialize();
    await service.reconcile([adapter([row({ sessionId: "a", project: "a" })])]);
    const before = service.getProjectToken("/projects/a");

    await service.reconcile([
      adapter([row({ sessionId: "a", project: "a", title: "renamed" })], {
        sourceVersion: "store-v2",
      }),
    ]);

    const after = service.getProjectToken("/projects/a");
    expect(after.shardGeneration).toBeGreaterThan(before.shardGeneration);
    expect(service.getProjectConditional("/projects/a", before).status).toBe(
      "changed",
    );
    const rows = await service.readProjectRows("/projects/a");
    expect(rows.rows[0]?.title).toBe("renamed");
  });

  it("keeps the last complete generation when a scan fails", async () => {
    const service = createService();
    await service.initialize();
    await service.reconcile([adapter([row({ sessionId: "a", project: "a" })])]);

    await expect(
      service.reconcile([
        adapter([row({ sessionId: "b", project: "a" })], {
          failWith: new Error("provider store unavailable"),
        }),
      ]),
    ).rejects.toThrow("provider store unavailable");

    const rows = await service.readProjectRows("/projects/a");
    expect(rows.rows.map((entry) => entry.sessionId)).toEqual(["a"]);
    expect(service.getMetrics().catalogGeneration).toBe(1);
    const generations = await readdir(
      join(dataDir, "session-catalog", "generations"),
    );
    expect(
      generations.filter((entry) => entry.startsWith(".staging-")),
    ).toEqual([]);
  });

  it("coalesces concurrent reconciliation of the same scope", async () => {
    const service = createService();
    await service.initialize();
    const source = adapter([row({ sessionId: "a", project: "a" })]);

    const results = await Promise.all([
      service.reconcile([source]),
      service.reconcile([source]),
      service.reconcile([source]),
    ]);

    expect(source.scans).toBe(1);
    expect(
      results.filter((result) => result.status === "computed"),
    ).toHaveLength(1);
    expect(results.filter((result) => result.status === "joined")).toHaveLength(
      2,
    );
    expect(service.getMetrics().reconciliationRequests).toBe(3);
  });

  it("answers conditional reads with no-change, deltas, or replacement", async () => {
    const service = createService();
    await service.initialize();
    await service.reconcile([adapter([row({ sessionId: "a", project: "a" })])]);
    const generationOne = service.getSnapshot();

    expect(service.getConditional(generationOne).status).toBe("no-change");

    await service.reconcile([
      adapter(
        [
          row({ sessionId: "a", project: "a" }),
          row({ sessionId: "b", project: "b" }),
        ],
        { sourceVersion: "store-v2" },
      ),
    ]);

    const conditional = service.getConditional(generationOne);
    expect(conditional.status).toBe("deltas");
    if (conditional.status === "deltas") {
      expect(conditional.deltas).toHaveLength(1);
      expect(conditional.deltas[0]?.changes).toEqual([
        { type: "upsert", row: expect.objectContaining({ sessionId: "b" }) },
      ]);
    }

    expect(
      service.getConditional({ ...generationOne, catalogEpoch: "other" })
        .status,
    ).toBe("replacement");
  });

  it("reports a removed session as a delete change", async () => {
    const service = createService();
    await service.initialize();
    await service.reconcile([
      adapter([
        row({ sessionId: "a", project: "a" }),
        row({ sessionId: "b", project: "a" }),
      ]),
    ]);
    const before = service.getSnapshot();

    await service.reconcile([
      adapter([row({ sessionId: "a", project: "a" })], {
        sourceVersion: "store-v2",
      }),
    ]);

    const conditional = service.getConditional(before);
    expect(conditional.status).toBe("deltas");
    if (conditional.status === "deltas") {
      expect(conditional.deltas[0]?.changes).toEqual([
        {
          type: "delete",
          key: { catalogFamily: "codex", storeKey: "default", sessionId: "b" },
        },
      ]);
    }
  });

  it("starts a fresh epoch instead of throwing on unreadable durable state", async () => {
    const first = createService();
    await first.initialize();
    await first.reconcile([adapter([row({ sessionId: "a", project: "a" })])]);
    const originalEpoch = first.getMetrics().catalogEpoch;
    await writeFile(
      join(dataDir, "session-catalog", "manifest.json"),
      "{ not json",
      "utf-8",
    );

    const recovered = createService();
    const snapshot = await recovered.initialize();

    expect(snapshot.catalogGeneration).toBe(0);
    expect(snapshot.catalogEpoch).not.toBe(originalEpoch);
    expect(recovered.getMetrics().resetFailures).toBe(1);
    expect(await recovered.readProjectRows("/projects/a")).toMatchObject({
      rows: [],
    });
    expect(
      await readdir(join(dataDir, "session-catalog", "generations")),
    ).toEqual([]);
  });

  it("starts a fresh epoch when the shard layout no longer matches", async () => {
    const first = createService({ bucketCount: 8 });
    await first.initialize();
    await first.reconcile([adapter([row({ sessionId: "a", project: "a" })])]);

    const rebucketed = createService({ bucketCount: 16 });
    const snapshot = await rebucketed.initialize();

    expect(snapshot.catalogGeneration).toBe(0);
    expect(rebucketed.getMetrics().resetFailures).toBe(1);
  });

  it("rejects a row that does not belong to its adapter", async () => {
    const service = createService();
    await service.initialize();
    const mismatched: NativeSessionCatalogAdapter = {
      catalogFamily: "codex",
      storeKey: "default",
      scan: async () => ({
        sourceVersion: "store-v1",
        rows: [{ ...row({ sessionId: "a", project: "a" }), storeKey: "other" }],
      }),
    };

    await expect(service.reconcile([mismatched])).rejects.toThrow(
      /yielded store other/,
    );
    expect(service.getMetrics().catalogGeneration).toBe(0);
  });

  it("retains only the newest rows within the recent-row budget", async () => {
    const service = createService({ maxRecentRows: 2 });
    await service.initialize();
    const snapshot = (
      await service.reconcile([
        adapter([
          row({
            sessionId: "old",
            project: "a",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
          row({
            sessionId: "new",
            project: "a",
            updatedAt: "2026-03-01T00:00:00.000Z",
          }),
          row({
            sessionId: "middle",
            project: "a",
            updatedAt: "2026-02-01T00:00:00.000Z",
          }),
        ]),
      ])
    ).snapshot;

    expect(snapshot.recentRows.map((entry) => entry.sessionId)).toEqual([
      "new",
      "middle",
    ]);
  });

  it("re-reads a project shard after the hot set evicts it", async () => {
    const service = createService({ maxHotBytes: 1 });
    await service.initialize();
    await service.reconcile([adapter([row({ sessionId: "a", project: "a" })])]);

    await service.readProjectRows("/projects/a");
    await service.readProjectRows("/projects/a");

    const metrics = service.getMetrics();
    expect(metrics.projectDiskReads).toBe(2);
    expect(metrics.hotSet.retainedBytes).toBeLessThanOrEqual(1);
  });

  it("persists the manifest atomically without leaving temporary files", async () => {
    const service = createService();
    await service.initialize();
    await service.reconcile([adapter([row({ sessionId: "a", project: "a" })])]);

    const entries = await readdir(join(dataDir, "session-catalog"));
    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    const manifest = JSON.parse(
      await readFile(
        join(dataDir, "session-catalog", "manifest.json"),
        "utf-8",
      ),
    ) as { shards: Array<{ contentHash: string; generation: number }> };
    expect(manifest.shards).not.toHaveLength(0);
    for (const shard of manifest.shards) {
      expect(shard.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(shard.generation).toBe(1);
    }
  });
});
