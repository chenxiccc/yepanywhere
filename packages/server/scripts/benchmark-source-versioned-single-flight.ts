import { performance } from "node:perf_hooks";
import {
  SourceVersionedSingleFlight,
  type SourceVersionedWorkResult,
} from "../src/lib/sourceVersionedSingleFlight.js";

const CALLERS = 100;
const INPUT_BYTES = 512 * 1024;
const SAMPLES = 5;
const CACHE_HITS = 1_000;

interface Measurement {
  durationMs: number;
  workStarts: number;
  checksum: number;
}

function checksum(input: Uint8Array): number {
  let value = 0x811c9dc5;
  for (const byte of input) {
    value = Math.imul(value ^ byte, 0x01000193);
  }
  return value >>> 0;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function acceptedValue(result: SourceVersionedWorkResult<number>): number {
  if (result.status === "stale") {
    throw new Error(
      "Synthetic source changed during a fixed-version benchmark",
    );
  }
  return result.value;
}

async function measureBaseline(input: Uint8Array): Promise<Measurement> {
  let workStarts = 0;
  const startedAt = performance.now();
  const results = await Promise.all(
    Array.from({ length: CALLERS }, () =>
      Promise.resolve().then(() => {
        workStarts += 1;
        return checksum(input);
      }),
    ),
  );
  return {
    durationMs: performance.now() - startedAt,
    workStarts,
    checksum: results[0] ?? 0,
  };
}

async function measureSingleFlight(input: Uint8Array): Promise<Measurement> {
  let workStarts = 0;
  const work = new SourceVersionedSingleFlight<string, number>({
    maxRetainedBytes: 8,
    estimateBytes: () => 8,
  });
  const startedAt = performance.now();
  const results = await Promise.all(
    Array.from({ length: CALLERS }, () =>
      work.run({
        key: "synthetic-projection",
        sourceVersion: "fixture-v1",
        compute: async () => {
          workStarts += 1;
          return checksum(input);
        },
        isCurrent: async () => true,
      }),
    ),
  );
  const stats = work.getStats();
  if (stats.joinedCalls !== CALLERS - 1 || stats.retainedEntries !== 1) {
    throw new Error(`Unexpected single-flight stats: ${JSON.stringify(stats)}`);
  }

  for (let index = 0; index < CACHE_HITS; index += 1) {
    const result = await work.run({
      key: "synthetic-projection",
      sourceVersion: "fixture-v1",
      compute: async () => {
        workStarts += 1;
        return checksum(input);
      },
      isCurrent: async () => true,
    });
    acceptedValue(result);
  }
  const finalStats = work.getStats();
  if (finalStats.cacheHits !== CACHE_HITS || workStarts !== 1) {
    throw new Error(
      `Accepted version was recomputed: ${JSON.stringify(finalStats)}`,
    );
  }

  return {
    durationMs: performance.now() - startedAt,
    workStarts,
    checksum: acceptedValue(
      results[0] ?? { status: "stale", sourceVersion: "missing" },
    ),
  };
}

const input = Uint8Array.from(
  { length: INPUT_BYTES },
  (_, index) => (index * 31 + 17) & 0xff,
);
for (let index = 0; index < 3; index += 1) checksum(input);

const baseline: Measurement[] = [];
const singleFlight: Measurement[] = [];
for (let sample = 0; sample < SAMPLES; sample += 1) {
  baseline.push(await measureBaseline(input));
  singleFlight.push(await measureSingleFlight(input));
}

const baselineWork = baseline[0]?.workStarts ?? 0;
const singleFlightWork = singleFlight[0]?.workStarts ?? 0;
const expectedChecksum = baseline[0]?.checksum;
if (
  baselineWork !== CALLERS ||
  singleFlightWork !== 1 ||
  singleFlight.some((measurement) => measurement.checksum !== expectedChecksum)
) {
  throw new Error("Synthetic benchmark did not preserve the checksum contract");
}

const baselineMedianMs = median(baseline.map(({ durationMs }) => durationMs));
const singleFlightMedianMs = median(
  singleFlight.map(({ durationMs }) => durationMs),
);
const avoidedWorkPercent = 100 * (1 - singleFlightWork / baselineWork);
const wallSpeedup = baselineMedianMs / singleFlightMedianMs;

console.log(
  [
    "SOURCE_VERSIONED_SINGLE_FLIGHT:",
    `callers=${CALLERS}`,
    `input_bytes=${INPUT_BYTES}`,
    `samples=${SAMPLES}`,
    `baseline_work=${baselineWork}`,
    `single_flight_work=${singleFlightWork}`,
    `avoided_work_percent=${avoidedWorkPercent.toFixed(2)}`,
    `baseline_median_ms=${baselineMedianMs.toFixed(2)}`,
    `single_flight_median_ms=${singleFlightMedianMs.toFixed(2)}`,
    `wall_speedup=${wallSpeedup.toFixed(2)}x`,
    `sequential_cache_hits=${CACHE_HITS}`,
  ].join(" "),
);
