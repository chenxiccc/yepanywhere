#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  aggregateBrowserProcessMemory,
  aggregateBrowserRuns,
  aggregateRuns,
} from "./aggregation.mjs";
import {
  GENERALIZED_PROJECT_PATHS_BASE,
  PERF_RUN_MARKER_PREFIX,
  SUITE_VERSION,
  parseArgs,
  readJson,
  requirePositiveInteger,
  validateScenario,
} from "./core.mjs";
import {
  assessHostEligibility,
  readHostCapacity,
  readHostSample,
  summarizeHostWindow,
} from "./host-profile.mjs";
import {
  gitIsAncestor,
  gitRevision,
  harnessIdentity,
  installSignalSweep,
  prepareBuiltClientCheckout,
  reapPerfRun,
  requireCleanPerfHost,
  runProcess,
  setActivePerfRunMarker,
  wait,
} from "./process-fixture.mjs";
import {
  evaluateRatchets,
  resolveHostEligibilityPolicy,
} from "./ratchet-evaluation.mjs";
import { selectRatchetTargets } from "./ratchet-targets.mjs";
import { measureRepetition } from "./server-driver.mjs";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const suiteRoot = path.dirname(fileURLToPath(import.meta.url));
  const harnessRepository = await runProcess(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd: suiteRoot },
  );
  const fixtureRepository = path.resolve(
    options["fixture-repository"] ?? path.join(suiteRoot, "..", ".."),
  );
  const checkout = path.resolve(options.checkout);
  const checkoutStats = await stat(checkout);
  if (!checkoutStats.isDirectory())
    throw new Error(`${checkout} is not a directory`);
  const config = await readJson(options.config);
  if (config.schemaVersion !== 1)
    throw new Error("Unsupported config schemaVersion");
  const scenario = config.scenarios?.[options.scenario];
  if (!scenario) throw new Error(`Unknown scenario: ${options.scenario}`);
  validateScenario(scenario, options.scenario);
  const hostEligibilityPolicy = resolveHostEligibilityPolicy(
    config,
    options.driver,
  );
  const fixtureConfig = {
    ...config.fixture,
    repository: fixtureRepository,
  };
  if (!/^[0-9a-f]{40}$/.test(fixtureConfig.revision ?? "")) {
    throw new Error("fixture.revision must be a full 40-character SHA");
  }
  requirePositiveInteger(
    fixtureConfig.workingSetSessions,
    "fixture.workingSetSessions",
  );
  requirePositiveInteger(
    fixtureConfig.cacheProofTimeoutMs,
    "fixture.cacheProofTimeoutMs",
  );
  requirePositiveInteger(
    fixtureConfig.cacheDisabledObservationMs,
    "fixture.cacheDisabledObservationMs",
  );
  if (
    !Array.isArray(fixtureConfig.providerCatalogFamilies) ||
    fixtureConfig.providerCatalogFamilies.some(
      (family) => typeof family !== "string" || family.length === 0,
    )
  ) {
    throw new Error("fixture.providerCatalogFamilies must be a string array");
  }
  const browserWorkingSetSessions =
    scenario.browserWorkingSetSessions ?? fixtureConfig.workingSetSessions;
  if (
    options.driver === "browser" &&
    browserWorkingSetSessions > scenario.sessionsPerProject
  ) {
    throw new Error(
      "browser working-set sessions must not exceed sessionsPerProject",
    );
  }
  const ratchets = await readJson(options.ratchets).catch((error) => {
    if (error.code === "ENOENT") return { schemaVersion: 1, scenarios: {} };
    throw error;
  });
  if (ratchets.schemaVersion !== 1)
    throw new Error("Unsupported ratchet schemaVersion");

  await requireCleanPerfHost();

  const revision = await gitRevision(checkout);
  const harness = await harnessIdentity(
    harnessRepository,
    options,
    config,
    ratchets,
  );
  const generalizedProjectPathsSupported = await gitIsAncestor(
    checkout,
    GENERALIZED_PROJECT_PATHS_BASE,
    revision,
  );
  const preparation =
    options.driver === "built-client"
      ? await prepareBuiltClientCheckout(checkout, revision)
      : null;
  const runMarker =
    `${PERF_RUN_MARKER_PREFIX}${process.pid}-${Date.now()}-` +
    createHash("sha256")
      .update(`${options.driver}:${options.scenario}:${revision}`)
      .digest("hex")
      .slice(0, 8);
  setActivePerfRunMarker(runMarker);
  const removeSignalSweep = installSignalSweep(runMarker);
  const hostCapacity = await readHostCapacity();
  const baselineStart = await readHostSample(hostCapacity);
  await wait(hostEligibilityPolicy.baselineSampleMs);
  const baselineEnd = await readHostSample(hostCapacity);
  const baselineWindow = summarizeHostWindow(
    hostCapacity,
    baselineStart,
    baselineEnd,
  );
  const hostEligibility = assessHostEligibility(
    hostCapacity,
    baselineWindow,
    hostEligibilityPolicy,
  );
  const hostStart = baselineEnd;
  console.log(
    `YA_PERF_HOST_JSON ${JSON.stringify({
      capacity: hostCapacity,
      baseline: {
        start: baselineStart,
        end: baselineEnd,
        window: baselineWindow,
      },
      eligibility: hostEligibility,
      start: hostStart,
    })}`,
  );
  const runName =
    `${options.label}-${options.driver}-${options.scenario}-` +
    revision.slice(0, 8);
  const workRoot = path.join(suiteRoot, "work", runName);
  await rm(workRoot, { recursive: true, force: true });
  await mkdir(workRoot, { recursive: true });
  const output = options.output
    ? path.resolve(options.output)
    : path.join(suiteRoot, "results", `${runName}.json`);
  await mkdir(path.dirname(output), { recursive: true });
  const history = options.history
    ? path.resolve(options.history)
    : path.join(suiteRoot, "results", "history.jsonl");
  await mkdir(path.dirname(history), { recursive: true });

  const runs = [];
  const cleanup = [];
  let finalSweepComplete = false;
  try {
    for (
      let repetition = 0;
      repetition < scenario.repetitions;
      repetition += 1
    ) {
      console.log(
        `${options.label}/${options.scenario}: repetition ${repetition + 1}/${scenario.repetitions}`,
      );
      const repetitionHostStart = await readHostSample(hostCapacity);
      let run;
      let repetitionCleanup;
      try {
        run = await measureRepetition({
          checkout,
          config,
          driver: options.driver,
          executionRevision: revision,
          fixtureConfig,
          generalizedProjectPathsSupported,
          label: options.label,
          repetition,
          runMarker,
          scenario,
          scenarioName: options.scenario,
          workRoot,
        });
      } finally {
        repetitionCleanup = await reapPerfRun(
          runMarker,
          `SWEEP-REP-${repetition + 1}`,
        );
        cleanup.push({ repetition, ...repetitionCleanup });
      }
      const repetitionHostEnd = await readHostSample(hostCapacity);
      run.revision = revision;
      run.cleanup = repetitionCleanup;
      run.host = {
        capacityKey: hostCapacity.capacityKey,
        start: repetitionHostStart,
        end: repetitionHostEnd,
        window: summarizeHostWindow(
          hostCapacity,
          repetitionHostStart,
          repetitionHostEnd,
        ),
      };
      runs.push(run);
      if (options.driver === "built-client") {
        console.log(
          `  server useful-ready ` +
            `${run.runtime.serverStartupToSelectedSessionReadableMs} ms; ` +
            `built-client readable ${run.latency.builtClientColdTail.p95Ms} ms`,
        );
      } else if (options.driver === "specialized") {
        console.log(
          `  provider enriched ${run.latency.providerFinalEnriched.p95Ms} ms; ` +
            `semantic replay visible ` +
            `${run.latency.semanticActionReplayVisible.p95Ms} ms; ` +
            `idle release ${run.latency.idleOwnershipRelease.p95Ms} ms; ` +
            `share herd ${run.latency.publicShareHerd.p95Ms} ms`,
        );
      } else {
        console.log(
          `  heap ${run.memory.settled.heapUsedMiB} MiB ` +
            `(retained ${run.memory.retainedHeapMiB} MiB); ` +
            `append p95 ${run.latency.detailAppendedHerd.p95Ms} ms`,
        );
      }
    }

    const aggregate = aggregateRuns(runs);
    const browserAggregate =
      options.driver === "browser" ? aggregateBrowserRuns(runs) : null;
    const browserProcessAggregate =
      options.driver === "browser" ? aggregateBrowserProcessMemory(runs) : null;
    const selectedTargets = selectRatchetTargets(ratchets, {
      capacityKey: hostCapacity.capacityKey,
      driver: options.driver,
      scenario: options.scenario,
    });
    const ratchetEvaluation = evaluateRatchets(
      aggregate,
      browserAggregate,
      browserProcessAggregate,
      selectedTargets.targets,
    );
    const finalCleanup = await reapPerfRun(runMarker, "SWEEP-FINAL");
    cleanup.push({ repetition: null, ...finalCleanup });
    finalSweepComplete = true;
    const hostEnd = await readHostSample(hostCapacity);
    const historyKey = {
      capacityKey: hostCapacity.capacityKey,
      driver: options.driver,
      scenario: options.scenario,
    };
    const ratchet = {
      ...ratchetEvaluation,
      pass:
        ratchetEvaluation.pass &&
        hostEligibility.pass &&
        cleanup.every((entry) => entry.pass),
      hostEligibility,
      historyKey,
      targetSelection: selectedTargets.selection,
    };
    const result = {
      schemaVersion: 2,
      suiteVersion: SUITE_VERSION,
      driver: options.driver,
      identity: {
        executionRevision: revision,
        fixtureRevision: fixtureConfig.revision,
        harnessContentSha256: harness.contentSha256,
        harnessDirty: harness.dirty,
        harnessRevision: harness.revision,
      },
      label: options.label,
      revision,
      scenario: options.scenario,
      parameters: scenario,
      preparation,
      host: {
        capacity: hostCapacity,
        baseline: {
          start: baselineStart,
          end: baselineEnd,
          window: baselineWindow,
        },
        eligibility: hostEligibility,
        start: hostStart,
        end: hostEnd,
        window: summarizeHostWindow(hostCapacity, hostStart, hostEnd),
      },
      historyKey,
      cleanup,
      aggregate,
      browserAggregate,
      browserProcessAggregate,
      ratchet,
      runs,
    };
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
    const historyRecord = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      historyKey,
      identity: result.identity,
      label: result.label,
      output,
      host: {
        capacity: hostCapacity,
        eligibility: hostEligibility,
        window: result.host.window,
      },
      preparation,
      ratchet,
    };
    await appendFile(history, `${JSON.stringify(historyRecord)}\n`);
    console.log(`wrote ${output}`);
    for (const check of ratchet.checks) {
      console.log(
        `${check.pass ? "PASS" : "FAIL"} ${check.universe}.` +
          `${check.metric}: ${check.actual} <= ${check.max}`,
      );
    }
    console.log(
      `YA_PERF_HISTORY_JSON ${JSON.stringify({
        schemaVersion: 1,
        history,
        historyKey,
        targetSelection: selectedTargets.selection,
      })}`,
    );
    console.log(
      `YA_PERF_CAPACITY_RATCHET_JSON ${JSON.stringify({
        capacityOverrides: {
          [hostCapacity.capacityKey]: {
            rationale:
              "Registered from capacity-keyed perf history; inherits portable ceilings until measured overrides are accepted.",
          },
        },
      })}`,
    );
    console.log(
      `YA_PERF_RESULT_JSON ${JSON.stringify({
        schemaVersion: 1,
        output,
        revision,
        historyKey,
        hostEligible: hostEligibility.pass,
        pass: ratchet.pass,
        targetSelection: selectedTargets.selection,
      })}`,
    );
    if (!ratchet.pass) process.exitCode = 1;
  } finally {
    if (!finalSweepComplete) {
      const emergencyCleanup = await reapPerfRun(runMarker, "SWEEP-EMERGENCY");
      if (!emergencyCleanup.pass) process.exitCode = 1;
    }
    removeSignalSweep();
    setActivePerfRunMarker(null);
    if (!config.keepWorkDirectories) {
      await rm(workRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
