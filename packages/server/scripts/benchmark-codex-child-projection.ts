import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCodexSessionEntry,
  truncateSessionTitle,
} from "@yep-anywhere/shared";
import { CodexSessionReader } from "../src/sessions/codex-reader.js";
import { readJsonlLines } from "../src/utils/jsonl.js";

const CALLERS = 20;
const TARGET_FILE_BYTES = 6 * 1024 * 1024;
const SAMPLES = 5;
const PROJECT_PATH = "/benchmark/project";

interface Measurement {
  durationMs: number;
  workStarts: number;
  sourceBytes: number;
  retainedBytes: number;
  entryCacheSessions: number;
}

function line(type: string, payload: unknown, timestamp: string): string {
  return JSON.stringify({ type, timestamp, payload });
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function writeFixture(root: string): Promise<{
  parentId: string;
  parentPath: string;
}> {
  const now = "2026-08-05T00:00:00.000Z";
  const parentId = "benchmark-parent";
  const childId = "benchmark-child";
  const callId = "call-benchmark-child";
  const dateDir = join(root, "2026", "08", "05");
  await mkdir(dateDir, { recursive: true });
  const parentPath = join(dateDir, `rollout-${parentId}.jsonl`);
  const ordinary = line(
    "event_msg",
    { type: "agent_message", message: "x".repeat(4_000) },
    now,
  );
  const lines = [
    line(
      "session_meta",
      {
        id: parentId,
        cwd: PROJECT_PATH,
        timestamp: now,
        model_provider: "openai",
      },
      now,
    ),
  ];
  let bytes = Buffer.byteLength(`${lines[0]}\n`);
  const ordinaryBytes = Buffer.byteLength(`${ordinary}\n`);
  while (bytes + ordinaryBytes < TARGET_FILE_BYTES) {
    lines.push(ordinary);
    bytes += ordinaryBytes;
  }
  lines.push(
    line(
      "response_item",
      {
        type: "function_call",
        name: "spawn_agent",
        call_id: callId,
        arguments: JSON.stringify({
          role: "reviewer",
          prompt: "Inspect the benchmark projection",
        }),
      },
      now,
    ),
    line(
      "response_item",
      {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({ agent_id: childId, nickname: "Hume" }),
      },
      now,
    ),
  );
  await writeFile(parentPath, `${lines.join("\n")}\n`);
  await writeFile(
    join(dateDir, `rollout-${childId}.jsonl`),
    `${line(
      "session_meta",
      {
        id: childId,
        cwd: PROJECT_PATH,
        timestamp: now,
        parent_thread_id: parentId,
        source: { subagent: { thread_spawn: { parent_thread_id: parentId } } },
      },
      now,
    )}\n`,
  );
  return { parentId, parentPath };
}

async function legacyListProviderChildren(
  parentId: string,
  parentPath: string,
): Promise<number> {
  const entries = (await readJsonlLines(parentPath))
    .map((jsonlLine) => parseCodexSessionEntry(jsonlLine))
    .filter((entry) => entry !== null);
  const launches = new Map<string, { title?: string; agentType?: string }>();
  let children = 0;
  for (const entry of entries) {
    if (entry.type !== "response_item") continue;
    const payload = entry.payload;
    if (payload.type === "function_call" && payload.name === "spawn_agent") {
      const args = JSON.parse(payload.arguments) as Record<string, unknown>;
      const prompt = typeof args.prompt === "string" ? args.prompt : undefined;
      const role = typeof args.role === "string" ? args.role : undefined;
      launches.set(payload.call_id, {
        ...(prompt && { title: truncateSessionTitle(prompt) }),
        ...(role && { agentType: role }),
      });
      continue;
    }
    if (
      payload.type === "function_call_output" &&
      launches.has(payload.call_id) &&
      JSON.stringify(payload.output).includes("benchmark-child")
    ) {
      children += 1;
    }
  }
  if (parentId !== "benchmark-parent" || children !== 1) {
    throw new Error("Legacy projection did not preserve the child contract");
  }
  return children;
}

async function measureLegacy(
  parentId: string,
  parentPath: string,
  fileBytes: number,
): Promise<Measurement> {
  const startedAt = performance.now();
  const children = await Promise.all(
    Array.from({ length: CALLERS }, () =>
      legacyListProviderChildren(parentId, parentPath),
    ),
  );
  if (children.some((count) => count !== 1)) {
    throw new Error("Legacy callers disagreed on child count");
  }
  return {
    durationMs: performance.now() - startedAt,
    workStarts: CALLERS,
    sourceBytes: fileBytes * CALLERS,
    retainedBytes: fileBytes * CALLERS,
    entryCacheSessions: 0,
  };
}

async function measureProjection(
  sessionsDir: string,
  parentId: string,
): Promise<Measurement> {
  const readers = Array.from(
    { length: CALLERS },
    () => new CodexSessionReader({ sessionsDir, projectPath: PROJECT_PATH }),
  );
  const statsBefore = readers[0]!.getProviderChildProjectionCacheStats();
  const startedAt = performance.now();
  const children = await Promise.all(
    readers.map((reader) => reader.listProviderChildSessions(parentId)),
  );
  const durationMs = performance.now() - startedAt;
  const statsAfter = readers[0]!.getProviderChildProjectionCacheStats();
  if (children.some((list) => list.length !== 1)) {
    throw new Error("Projection callers disagreed on child count");
  }
  const metrics = readers
    .map((reader) => reader.getLastProviderChildProjectionMetrics())
    .filter((metric) => metric?.status === "computed");
  const measurement = {
    durationMs,
    workStarts: statsAfter.workStarts - statsBefore.workStarts,
    sourceBytes: metrics.reduce(
      (total, metric) => total + (metric?.sourceBytesRead ?? 0),
      0,
    ),
    retainedBytes: metrics[0]?.retainedBytes ?? 0,
    entryCacheSessions: readers.reduce(
      (total, reader) => total + reader.getEntryCacheStats().sessions,
      0,
    ),
  };
  readers[0]!.invalidateCache();
  return measurement;
}

const scratchDir = join(
  tmpdir(),
  `codex-child-projection-benchmark-${randomUUID()}`,
);
await mkdir(scratchDir, { recursive: true });
try {
  const { parentId, parentPath } = await writeFixture(scratchDir);
  const fileBytes = Number((await stat(parentPath)).size);
  const acceptedReader = new CodexSessionReader({
    sessionsDir: scratchDir,
    projectPath: PROJECT_PATH,
  });
  const acceptedStartedAt = performance.now();
  const coldAccepted =
    acceptedReader.listAcceptedProviderChildSessions(parentId);
  const acceptedReturnMs = performance.now() - acceptedStartedAt;
  if (coldAccepted.length !== 0) {
    throw new Error("Cold accepted projection unexpectedly contained children");
  }
  await acceptedReader.listProviderChildSessions(parentId);
  acceptedReader.invalidateCache();

  const baseline: Measurement[] = [];
  const projection: Measurement[] = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    baseline.push(await measureLegacy(parentId, parentPath, fileBytes));
    projection.push(await measureProjection(scratchDir, parentId));
  }

  const baselineWork = baseline[0]?.workStarts ?? 0;
  const projectionWork = projection[0]?.workStarts ?? 0;
  const baselineBytes = baseline[0]?.sourceBytes ?? 0;
  const projectionBytes = projection[0]?.sourceBytes ?? 0;
  const baselineMedianMs = median(baseline.map(({ durationMs }) => durationMs));
  const projectionMedianMs = median(
    projection.map(({ durationMs }) => durationMs),
  );
  const avoidedWorkPercent = 100 * (1 - projectionWork / baselineWork);
  const avoidedBytesPercent = 100 * (1 - projectionBytes / baselineBytes);
  const speedup = baselineMedianMs / projectionMedianMs;

  console.log(
    [
      "CODEX_CHILD_PROJECTION:",
      `callers=${CALLERS}`,
      `file_bytes=${fileBytes}`,
      `samples=${SAMPLES}`,
      `baseline_full_parses=${baselineWork}`,
      `projection_builds=${projectionWork}`,
      `avoided_full_parses_percent=${avoidedWorkPercent.toFixed(2)}`,
      `baseline_logical_source_bytes=${baselineBytes}`,
      `projection_source_bytes=${projectionBytes}`,
      `avoided_source_bytes_percent=${avoidedBytesPercent.toFixed(2)}`,
      `baseline_median_ms=${baselineMedianMs.toFixed(2)}`,
      `projection_median_ms=${projectionMedianMs.toFixed(2)}`,
      `wall_speedup=${speedup.toFixed(2)}x`,
      `cold_accepted_return_ms=${acceptedReturnMs.toFixed(3)}`,
      `retained_projection_bytes=${projection[0]?.retainedBytes ?? 0}`,
      `entry_cache_sessions=${projection[0]?.entryCacheSessions ?? 0}`,
    ].join(" "),
  );
} finally {
  await rm(scratchDir, { recursive: true, force: true });
}
