import { performance } from "node:perf_hooks";
import {
  createVersionRoutes,
  getCurrentVersionInfoComputations,
  resetCurrentVersionInfoForTests,
} from "../src/routes/version.js";

const REQUESTS = 20;
const SAMPLES = 5;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/**
 * `perRequestProbe` models the previous shape, where every /api/version
 * assembly recomputed the install facts and so spent a `git describe` or
 * `npm root -g` subprocess.
 */
async function measure(
  perRequestProbe: boolean,
): Promise<{ durationMs: number; probes: number }> {
  resetCurrentVersionInfoForTests();
  const app = createVersionRoutes();
  const probesBefore = getCurrentVersionInfoComputations();
  const startedAt = performance.now();
  for (let request = 0; request < REQUESTS; request += 1) {
    if (perRequestProbe) resetCurrentVersionInfoForTests();
    const response = await app.request("/");
    if (response.status !== 200) {
      throw new Error(`Version route returned ${response.status}`);
    }
    await response.json();
  }
  return {
    durationMs: performance.now() - startedAt,
    probes: getCurrentVersionInfoComputations() - probesBefore,
  };
}

// Warm any first-call cost that belongs to neither shape.
await measure(false);

const perRequestSamples: number[] = [];
const retainedSamples: number[] = [];
let perRequestProbes = 0;
let retainedProbes = 0;
for (let sample = 0; sample < SAMPLES; sample += 1) {
  const perRequest = await measure(true);
  perRequestSamples.push(perRequest.durationMs);
  perRequestProbes = perRequest.probes;

  const retained = await measure(false);
  retainedSamples.push(retained.durationMs);
  retainedProbes = retained.probes;
}

const perRequestMedianMs = median(perRequestSamples);
const retainedMedianMs = median(retainedSamples);

console.log(
  [
    "VERSION_ROUTE:",
    `requests=${REQUESTS}`,
    `samples=${SAMPLES}`,
    `per_request_probes=${perRequestProbes}`,
    `retained_probes=${retainedProbes}`,
    `avoided_probes_percent=${(
      100 * (1 - retainedProbes / perRequestProbes)
    ).toFixed(2)}`,
    `per_request_median_ms=${perRequestMedianMs.toFixed(2)}`,
    `retained_median_ms=${retainedMedianMs.toFixed(2)}`,
    `speedup=${(perRequestMedianMs / retainedMedianMs).toFixed(2)}x`,
    `per_request_ms_each=${(perRequestMedianMs / REQUESTS).toFixed(2)}`,
    `retained_ms_each=${(retainedMedianMs / REQUESTS).toFixed(2)}`,
  ].join(" "),
);
