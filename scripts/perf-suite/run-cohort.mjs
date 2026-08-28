#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { PERF_RUN_MARKER_PREFIX, readJson } from "./core.mjs";
import {
  readHostCapacity,
  readHostSample,
  summarizeHostWindow,
} from "./host-profile.mjs";
import {
  installSignalSweep,
  reapPerfRun,
  requireCleanPerfHost,
  wait,
} from "./process-fixture.mjs";

const suiteRoot = path.dirname(fileURLToPath(import.meta.url));

function parseCohortArgs(argv) {
  const options = {
    checkout: null,
    config: path.join(suiteRoot, "config.json"),
    "fixture-repository": path.join(suiteRoot, "..", ".."),
    label: "cohort",
    lanes: null,
    "output-dir": null,
    ratchets: path.join(suiteRoot, "ratchets.json"),
    scenario: null,
    token: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--help") {
      console.log(
        "Usage: node run-cohort.mjs --checkout PATH --scenario NAME " +
          "--lanes N --token TOKEN --output-dir PATH [--config FILE] " +
          "[--fixture-repository PATH] [--label LABEL] [--ratchets FILE]",
      );
      process.exit(0);
    }
    if (!name?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${name}`);
    }
    const key = name.slice(2);
    if (!(key in options)) throw new Error(`Unknown option: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    options[key] = value;
    index += 1;
  }
  for (const key of ["checkout", "scenario", "lanes", "token", "output-dir"]) {
    if (!options[key]) throw new Error(`--${key} is required`);
  }
  options.lanes = Number(options.lanes);
  if (!Number.isSafeInteger(options.lanes) || options.lanes <= 0) {
    throw new Error("--lanes must be a positive integer");
  }
  if (!/^[a-zA-Z0-9-]+$/.test(options.token)) {
    throw new Error("--token must contain only letters, digits, and hyphens");
  }
  return options;
}

async function ensureNewDirectory(directory) {
  try {
    await stat(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true });
    return;
  }
  throw new Error(`cohort output directory already exists: ${directory}`);
}

async function runLane({
  checkout,
  cohortMarker,
  config,
  fixtureRepository,
  label,
  lane,
  outputDirectory,
  ratchets,
  scenario,
}) {
  const laneLabel = `${label}-lane-${lane + 1}`;
  const laneOutput = path.join(outputDirectory, `${laneLabel}.json`);
  const laneHistory = path.join(outputDirectory, `${laneLabel}-history.jsonl`);
  const logPath = path.join(outputDirectory, `${laneLabel}.log`);
  const args = [
    path.join(suiteRoot, "run.mjs"),
    "--checkout",
    checkout,
    "--scenario",
    scenario,
    "--driver",
    "specialized",
    "--fixture-repository",
    fixtureRepository,
    "--label",
    laneLabel,
    "--config",
    config,
    "--ratchets",
    ratchets,
    "--output",
    laneOutput,
    "--history",
    laneHistory,
    "--cohort-parent-marker",
    cohortMarker,
  ];
  const log = createWriteStream(logPath, { flags: "wx" });
  const child = spawn(process.execPath, args, {
    cwd: suiteRoot,
    env: {
      ...process.env,
      YA_PERF_COHORT_PARENT_MARKER: cohortMarker,
      YA_PERF_COHORT_PARENT_PID: String(process.pid),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const outcome = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  await new Promise((resolve) => log.end(resolve));
  let result = null;
  try {
    result = JSON.parse(await readFile(laneOutput, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return {
    ...outcome,
    history: laneHistory,
    hostEligible: result?.host?.eligibility?.pass ?? null,
    lane: lane + 1,
    log: logPath,
    output: result ? laneOutput : null,
    pass: result?.ratchet?.pass ?? false,
  };
}

async function main() {
  const options = parseCohortArgs(process.argv.slice(2));
  const outputDirectory = path.resolve(options["output-dir"]);
  await ensureNewDirectory(outputDirectory);
  const baseConfig = await readJson(options.config);
  const scenario = baseConfig.scenarios?.[options.scenario];
  if (!scenario) throw new Error(`Unknown scenario: ${options.scenario}`);
  if (scenario.repetitions !== 1) {
    throw new Error("cohort scenarios must declare exactly one repetition");
  }

  await requireCleanPerfHost();
  const cohortMarker =
    `${PERF_RUN_MARKER_PREFIX}cohort-${process.pid}-` +
    createHash("sha256")
      .update(`${options.token}:${Date.now()}`)
      .digest("hex")
      .slice(0, 10);
  const originalTitle = process.title;
  process.title = cohortMarker;
  const removeSignalSweep = installSignalSweep(cohortMarker);
  const hostCapacity = await readHostCapacity();
  const hostBaselineStart = await readHostSample(hostCapacity);
  await wait(baseConfig.hostEligibility.baselineSampleMs);
  const hostBaselineEnd = await readHostSample(hostCapacity);
  const laneConfigsDirectory = path.join(outputDirectory, "lane-configs");
  await mkdir(laneConfigsDirectory);
  const laneConfigs = await Promise.all(
    Array.from({ length: options.lanes }, async (_, lane) => {
      const laneConfig = structuredClone(baseConfig);
      laneConfig.server.portBase += lane * 20;
      const file = path.join(laneConfigsDirectory, `lane-${lane + 1}.json`);
      await writeFile(file, `${JSON.stringify(laneConfig, null, 2)}\n`, {
        flag: "wx",
      });
      return file;
    }),
  );
  const hostStart = await readHostSample(hostCapacity);
  let lanes = [];
  let failure = null;
  let cleanup = null;
  try {
    console.log(
      `${options.label}: launching ${options.lanes} concurrent specialized lanes`,
    );
    lanes = await Promise.all(
      laneConfigs.map((config, lane) =>
        runLane({
          checkout: path.resolve(options.checkout),
          cohortMarker,
          config,
          fixtureRepository: path.resolve(options["fixture-repository"]),
          label: options.label,
          lane,
          outputDirectory,
          ratchets: path.resolve(options.ratchets),
          scenario: options.scenario,
        }),
      ),
    );
  } catch (error) {
    failure = error;
  } finally {
    process.title = originalTitle;
    cleanup = await reapPerfRun(cohortMarker, "SWEEP-COHORT-FINAL");
    removeSignalSweep();
  }
  const hostEnd = await readHostSample(hostCapacity);
  const result = {
    schemaVersion: 1,
    kind: "ya-perf-specialized-cohort",
    marker: cohortMarker,
    label: options.label,
    scenario: options.scenario,
    laneCount: options.lanes,
    laneConfigs,
    lanes,
    cleanup,
    host: {
      capacity: hostCapacity,
      baseline: {
        start: hostBaselineStart,
        end: hostBaselineEnd,
        window: summarizeHostWindow(
          hostCapacity,
          hostBaselineStart,
          hostBaselineEnd,
        ),
      },
      start: hostStart,
      end: hostEnd,
      window: summarizeHostWindow(hostCapacity, hostStart, hostEnd),
    },
    pass:
      failure === null &&
      cleanup.pass &&
      lanes.length === options.lanes &&
      lanes.every((lane) => lane.code === 0 && lane.pass),
  };
  const resultPath = path.join(outputDirectory, "cohort.json");
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(`wrote ${resultPath}`);
  if (failure) throw failure;
  if (!result.pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
