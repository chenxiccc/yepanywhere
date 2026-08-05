import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { SessionCatalogService } from "../src/services/SessionCatalogService.js";
import type {
  NativeSessionCatalogAdapter,
  SessionCatalogRow,
} from "../src/sessions/catalog-types.js";

const PROJECTS = 2_000;
const SESSIONS_PER_PROJECT = 5;
const READERS = 20;
const SAMPLES = 5;
const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");

function corpus(changedProject: number | null): SessionCatalogRow[] {
  const rows: SessionCatalogRow[] = [];
  for (let project = 0; project < PROJECTS; project += 1) {
    const projectPath = `/projects/p${project}`;
    for (let index = 0; index < SESSIONS_PER_PROJECT; index += 1) {
      const bumped = project === changedProject;
      rows.push({
        catalogFamily: "codex",
        storeKey: "default",
        sessionId: `p${project}-s${index}`,
        projectId: `id-p${project}` as UrlProjectId,
        projectPath,
        projectIdentityKey: projectPath,
        updatedAt: new Date(
          BASE_MS + project * 1_000 + index + (bumped ? 900_000 : 0),
        ).toISOString(),
        title: `Session ${index} of project ${project}`,
        fidelity: "identity",
        sourceVersion: `p${project}-s${index}@${bumped ? 2 : 1}`,
        location: { kind: "file", path: `/store/p${project}/s${index}.jsonl` },
      });
    }
  }
  return rows;
}

function adapter(
  rows: readonly SessionCatalogRow[],
  sourceVersion: string,
  onRow: () => void,
): NativeSessionCatalogAdapter {
  return {
    catalogFamily: "codex",
    storeKey: "default",
    scan: async () => ({
      sourceVersion,
      rows: (function* () {
        for (const row of rows) {
          onRow();
          yield { ...row };
        }
      })(),
    }),
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/**
 * Today's collection shape: each reader enumerates the provider-global store
 * off disk and filters it down to one project (tactical 093 § Current fault).
 */
async function measureStoreScanPerReader(
  storePath: string,
  projectIdentityKey: string,
): Promise<{ durationMs: number; rowsParsed: number }> {
  let rowsParsed = 0;
  const startedAt = performance.now();
  const results = await Promise.all(
    Array.from({ length: READERS }, async () => {
      const matched: SessionCatalogRow[] = [];
      const content = await readFile(storePath, "utf-8");
      for (const line of content.split("\n")) {
        if (!line) continue;
        rowsParsed += 1;
        const row = JSON.parse(line) as SessionCatalogRow;
        if (row.projectIdentityKey === projectIdentityKey) matched.push(row);
      }
      matched.sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
      );
      return matched;
    }),
  );
  if (results.some((matched) => matched.length !== SESSIONS_PER_PROJECT)) {
    throw new Error("Baseline scan did not resolve the project's sessions");
  }
  return { durationMs: performance.now() - startedAt, rowsParsed };
}

const dataDir = await mkdtemp(join(tmpdir(), `catalog-bench-${randomUUID()}-`));
try {
  const rows = corpus(null);
  const targetProject = "/projects/p7";
  const storePath = join(dataDir, "provider-store.jsonl");
  await writeFile(
    storePath,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf-8",
  );

  // Build one durable generation, as boot reconciliation would.
  const service = new SessionCatalogService({ dataDir });
  await service.initialize();
  let scannedRows = 0;
  const buildStartedAt = performance.now();
  const build = await service.reconcile([
    adapter(rows, "store-v1", () => {
      scannedRows += 1;
    }),
  ]);
  const buildMs = performance.now() - buildStartedAt;
  service.stop();

  // Restart: a replacement server answers from durable state, no adapter.
  const restartSamples: number[] = [];
  const baselineSamples: number[] = [];
  let restartRows = 0;
  let restartDiskReads = 0;
  let restartRowsParsed = 0;
  let baselineRowsParsed = 0;
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const restarted = new SessionCatalogService({ dataDir });
    const restartStartedAt = performance.now();
    await restarted.initialize();
    const served = await Promise.all(
      Array.from({ length: READERS }, () =>
        restarted.readProjectRows(targetProject),
      ),
    );
    restartSamples.push(performance.now() - restartStartedAt);
    restartRows = served[0]?.rows.length ?? 0;
    restartDiskReads = restarted.getMetrics().projectDiskReads;
    const bucket = served[0]?.bucket ?? -1;
    restartRowsParsed =
      restarted.getSnapshot().shards.find((shard) => shard.bucket === bucket)
        ?.rowCount ?? 0;
    restarted.stop();

    const baseline = await measureStoreScanPerReader(storePath, targetProject);
    baselineSamples.push(baseline.durationMs);
    baselineRowsParsed = baseline.rowsParsed;
  }

  if (restartRows !== SESSIONS_PER_PROJECT) {
    throw new Error(`Catalog served ${restartRows} rows after restart`);
  }

  // Second generation touching exactly one project: the delta must skip every
  // unchanged shard by hash rather than re-reading both generations.
  const incremental = new SessionCatalogService({ dataDir });
  await incremental.initialize();
  const beforeToken = incremental.getProjectToken(targetProject);
  const deltaStartedAt = performance.now();
  const second = await incremental.reconcile([
    adapter(corpus(11), "store-v2", () => {}),
  ]);
  const deltaMs = performance.now() - deltaStartedAt;
  const incrementalMetrics = incremental.getMetrics();
  const unchangedStatus = incremental.getProjectConditional(
    targetProject,
    beforeToken,
  ).status;
  incremental.stop();

  if (unchangedStatus !== "no-change") {
    throw new Error(
      `Unchanged project reported ${unchangedStatus} after an unrelated write`,
    );
  }

  const baselineMedianMs = median(baselineSamples);
  const restartMedianMs = median(restartSamples);
  const totalShards =
    incrementalMetrics.deltaShardsCompared +
    incrementalMetrics.deltaShardsSkippedByHash;

  console.log(
    [
      "SESSION_CATALOG:",
      `projects=${PROJECTS}`,
      `rows=${scannedRows}`,
      `readers=${READERS}`,
      `samples=${SAMPLES}`,
      `build_ms=${buildMs.toFixed(2)}`,
      `build_bytes=${build.metrics.bytesWritten}`,
      `baseline_rows_parsed=${baselineRowsParsed}`,
      `catalog_rows_parsed=${restartRowsParsed}`,
      `catalog_disk_reads=${restartDiskReads}`,
      `avoided_row_parses_percent=${(
        100 * (1 - restartRowsParsed / baselineRowsParsed)
      ).toFixed(2)}`,
      `baseline_median_ms=${baselineMedianMs.toFixed(2)}`,
      `restart_median_ms=${restartMedianMs.toFixed(2)}`,
      `restart_speedup=${(baselineMedianMs / restartMedianMs).toFixed(2)}x`,
      `delta_ms=${deltaMs.toFixed(2)}`,
      `delta_shards_read=${incrementalMetrics.deltaShardsCompared}`,
      `delta_shards_skipped=${incrementalMetrics.deltaShardsSkippedByHash}`,
      `delta_shards_skipped_percent=${(
        (100 * incrementalMetrics.deltaShardsSkippedByHash) /
          Math.max(1, totalShards)
      ).toFixed(2)}`,
      `delta_changes=${second.metrics.deltaChanges}`,
      `unchanged_project_conditional=${unchangedStatus}`,
    ].join(" "),
  );
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
