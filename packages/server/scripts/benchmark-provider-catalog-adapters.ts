import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { encodeProjectId } from "../src/projects/paths.js";
import { GrokSessionCatalogAdapter } from "../src/sessions/catalog-adapters/grok-catalog-adapter.js";
import { PiSessionCatalogAdapter } from "../src/sessions/catalog-adapters/pi-catalog-adapter.js";
import type {
  NativeSessionCatalogAdapter,
  SessionCatalogRow,
} from "../src/sessions/catalog-types.js";
import { GrokSessionReader } from "../src/sessions/grok-reader.js";
import { PiSessionReader } from "../src/sessions/pi-reader.js";

/**
 * Grok and pi keep one install-wide store keyed by cwd, so `mayHaveGrokSessions`
 * and `mayHavePiSessions` return true for every project and each project's
 * reader re-walks the whole store to keep the few directories that match. Both
 * arms below do real filesystem work over the same synthetic store; the only
 * difference is that the baseline repeats the walk once per project.
 */
const PROJECTS = 200;
const SESSIONS_PER_PROJECT = 5;

const root = await mkdtemp(join(tmpdir(), "ya-catalog-adapter-bench-"));
const grokDir = join(root, "grok", "sessions");
const piDir = join(root, "pi", "sessions");

const projectPaths = Array.from(
  { length: PROJECTS },
  (_, index) => `/work/project-${index}`,
);

async function seed(): Promise<void> {
  for (const [index, projectPath] of projectPaths.entries()) {
    const grokCwdDir = join(grokDir, encodeURIComponent(projectPath));
    const piCwdDir = join(piDir, projectPath.replace(/\//g, "-"));
    await mkdir(grokCwdDir, { recursive: true });
    await mkdir(piCwdDir, { recursive: true });

    for (let session = 0; session < SESSIONS_PER_PROJECT; session += 1) {
      const sessionId = `p${index}-s${session}`;
      const grokSessionDir = join(grokCwdDir, sessionId);
      await mkdir(grokSessionDir, { recursive: true });
      await writeFile(
        join(grokSessionDir, "summary.json"),
        JSON.stringify({
          info: { id: sessionId, cwd: projectPath },
          created_at: "2026-08-01T00:00:00.000Z",
          updated_at: "2026-08-02T00:00:00.000Z",
          generated_title: `Session ${sessionId}`,
          num_messages: 12,
        }),
        "utf-8",
      );

      await writeFile(
        join(piCwdDir, `2026-06-22T00-00-00-00${session}Z_${sessionId}.jsonl`),
        `${JSON.stringify({
          type: "session",
          id: sessionId,
          cwd: projectPath,
          timestamp: "2026-06-22T00:00:00.000Z",
        })}\n`,
        "utf-8",
      );
    }
  }
}

interface Arm {
  durationMs: number;
  storeEnumerations: number;
  rows: number;
}

/** Today's shape: one reader per project, each re-walking the whole store. */
async function measurePerProjectReaders(
  make: (projectPath: string) => {
    listSessions(id: UrlProjectId): Promise<unknown[]>;
  },
): Promise<Arm> {
  const startedAt = performance.now();
  let rows = 0;
  for (const projectPath of projectPaths) {
    const reader = make(projectPath);
    rows += (await reader.listSessions(encodeProjectId(projectPath))).length;
  }
  return {
    durationMs: performance.now() - startedAt,
    storeEnumerations: projectPaths.length,
    rows,
  };
}

async function measureAdapter(
  adapter: NativeSessionCatalogAdapter,
): Promise<Arm & { metrics: Record<string, number> }> {
  const startedAt = performance.now();
  const scan = await adapter.scan({
    catalogEpoch: "benchmark",
    targetGeneration: 1,
    mode: { kind: "complete" },
    signal: new AbortController().signal,
  });
  let rows = 0;
  for await (const _row of scan.rows as AsyncIterable<SessionCatalogRow>) {
    rows += 1;
  }
  return {
    durationMs: performance.now() - startedAt,
    storeEnumerations: 1,
    rows,
    metrics: { ...scan.metrics },
  };
}

function report(
  label: string,
  baseline: Arm,
  adapter: Arm & { metrics: Record<string, number> },
): string {
  if (adapter.rows !== baseline.rows) {
    throw new Error(
      `${label}: adapter produced ${adapter.rows} rows against ${baseline.rows}`,
    );
  }
  return [
    `${label}_per_project_ms=${baseline.durationMs.toFixed(2)}`,
    `${label}_adapter_ms=${adapter.durationMs.toFixed(2)}`,
    `${label}_speedup=${(baseline.durationMs / adapter.durationMs).toFixed(2)}x`,
    `${label}_per_project_store_walks=${baseline.storeEnumerations}`,
    `${label}_adapter_store_walks=${adapter.storeEnumerations}`,
    `${label}_rows=${adapter.rows}`,
  ].join(" ");
}

try {
  await seed();

  const grokBaseline = await measurePerProjectReaders(
    (projectPath) =>
      new GrokSessionReader({ sessionsDir: grokDir, projectPath }),
  );
  const grokAdapter = await measureAdapter(
    new GrokSessionCatalogAdapter({ sessionsDir: grokDir }),
  );

  const piBaseline = await measurePerProjectReaders(
    (projectPath) => new PiSessionReader({ sessionsDir: piDir, projectPath }),
  );
  const piAdapter = await measureAdapter(
    new PiSessionCatalogAdapter({ sessionsDir: piDir }),
  );

  console.log(
    [
      "PROVIDER_CATALOG_ADAPTERS:",
      `projects=${PROJECTS}`,
      `sessions_per_project=${SESSIONS_PER_PROJECT}`,
      report("grok", grokBaseline, grokAdapter),
      // Every project's pi reader opens each transcript header to learn its
      // cwd, so the header reads are what the single pass collapses.
      `pi_per_project_header_reads=${PROJECTS * PROJECTS * SESSIONS_PER_PROJECT}`,
      `pi_adapter_header_reads=${piAdapter.metrics.headersRead ?? 0}`,
      report("pi", piBaseline, piAdapter),
    ].join(" "),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
