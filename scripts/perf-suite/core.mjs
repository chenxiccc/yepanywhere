import { readFile } from "node:fs/promises";
import process from "node:process";

export const SUITE_VERSION = 8;
export const PERF_RUN_MARKER_PREFIX = "ya-perf-suite-";
export const GENERALIZED_PROJECT_PATHS_BASE =
  "61cb5f358b9ccb56549d0515ded703ec534996a6";
const DEFAULT_CONFIG_PATH = new URL("./config.json", import.meta.url);
const DEFAULT_RATCHETS_PATH = new URL("./ratchets.json", import.meta.url);

export function parseArgs(argv) {
  const options = {
    checkout: null,
    "cohort-parent-marker": null,
    config: DEFAULT_CONFIG_PATH,
    driver: "server",
    "fixture-repository": null,
    history: null,
    label: "working-tree",
    output: null,
    ratchets: DEFAULT_RATCHETS_PATH,
    scenario: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--help") {
      console.log(
        "Usage: node run.mjs --checkout PATH --scenario NAME " +
          "[--driver server|browser|built-client|specialized] " +
          "[--cohort-parent-marker MARKER] " +
          "[--fixture-repository PATH] [--label LABEL] [--config FILE] " +
          "[--ratchets FILE] [--output FILE] [--history FILE]",
      );
      process.exit(0);
    }
    if (!name?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${name}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    index += 1;
    const key = name.slice(2);
    if (!(key in options)) {
      throw new Error(`Unknown option: ${name}`);
    }
    options[key] = value;
  }
  if (!options.checkout) throw new Error("--checkout is required");
  if (!options.scenario) throw new Error("--scenario is required");
  if (
    !["server", "browser", "built-client", "specialized"].includes(
      options.driver,
    )
  ) {
    throw new Error(
      "--driver must be server, browser, built-client, or specialized",
    );
  }
  return options;
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

export function validateScenario(scenario, name) {
  for (const field of [
    "projects",
    "sessionsPerProject",
    "initialTurns",
    "newTurns",
    "concurrentClients",
    "payloadBytes",
    "repetitions",
  ]) {
    requirePositiveInteger(scenario[field], `scenarios.${name}.${field}`);
  }
  requirePositiveInteger(scenario.settleMs, `scenarios.${name}.settleMs`);
  if (scenario.browserCacheBudgetsMiB !== undefined) {
    if (
      !Array.isArray(scenario.browserCacheBudgetsMiB) ||
      scenario.browserCacheBudgetsMiB.length === 0 ||
      scenario.browserCacheBudgetsMiB.some(
        (value) => !Number.isInteger(value) || value < 0,
      )
    ) {
      throw new Error(
        `scenarios.${name}.browserCacheBudgetsMiB must be nonnegative integers`,
      );
    }
  }
  if (scenario.browserWorkingSetSessions !== undefined) {
    requirePositiveInteger(
      scenario.browserWorkingSetSessions,
      `scenarios.${name}.browserWorkingSetSessions`,
    );
  }
  if (
    scenario.browserViewport !== undefined &&
    (typeof scenario.browserViewport !== "object" ||
      scenario.browserViewport === null ||
      !Number.isInteger(scenario.browserViewport.width) ||
      scenario.browserViewport.width <= 0 ||
      !Number.isInteger(scenario.browserViewport.height) ||
      scenario.browserViewport.height <= 0)
  ) {
    throw new Error(
      `scenarios.${name}.browserViewport must have positive integer dimensions`,
    );
  }
  for (const field of ["streamChunks", "streamChunkBytes", "idleReapSeconds"]) {
    if (scenario[field] !== undefined) {
      requirePositiveInteger(scenario[field], `scenarios.${name}.${field}`);
    }
  }
  if (
    scenario.streamDelayMs !== undefined &&
    (!Number.isInteger(scenario.streamDelayMs) || scenario.streamDelayMs < 0)
  ) {
    throw new Error(
      `scenarios.${name}.streamDelayMs must be a nonnegative integer`,
    );
  }
  if (scenario.browserSettings !== undefined) {
    if (
      !scenario.browserSettings ||
      typeof scenario.browserSettings !== "object" ||
      Array.isArray(scenario.browserSettings) ||
      Object.entries(scenario.browserSettings).some(
        ([key, value]) => key.length === 0 || typeof value !== "string",
      )
    ) {
      throw new Error(
        `scenarios.${name}.browserSettings must be a string-to-string object`,
      );
    }
  }
  if (
    scenario.interactionTrace !== undefined &&
    (typeof scenario.interactionTrace !== "object" ||
      scenario.interactionTrace === null ||
      scenario.interactionTrace.enabled !== true ||
      !Number.isInteger(scenario.interactionTrace.tooltipDelayMs) ||
      scenario.interactionTrace.tooltipDelayMs < 0 ||
      !Number.isInteger(scenario.interactionTrace.hoverCardDelayMs) ||
      scenario.interactionTrace.hoverCardDelayMs < 0 ||
      !["full", "scale-control", "sidebar-switch"].includes(
        scenario.interactionTrace.scope,
      ) ||
      (scenario.interactionTrace.scope === "sidebar-switch" &&
        (!Number.isInteger(scenario.interactionTrace.sidebarSwitchRounds) ||
          scenario.interactionTrace.sidebarSwitchRounds <= 0)) ||
      (scenario.interactionTrace.beforeAndAfterAppend !== undefined &&
        (scenario.interactionTrace.scope !== "sidebar-switch" ||
          scenario.interactionTrace.beforeAndAfterAppend !== true ||
          !Number.isInteger(
            scenario.interactionTrace.idleBeforeSecondSwitchMs,
          ) ||
          scenario.interactionTrace.idleBeforeSecondSwitchMs < 0)) ||
      (scenario.interactionTrace.alternateCausalArms !== undefined &&
        (scenario.interactionTrace.alternateCausalArms !== true ||
          scenario.interactionTrace.beforeAndAfterAppend !== true)) ||
      (scenario.interactionTrace.requireRetainedAfterFirstSwitch !==
        undefined &&
        (scenario.interactionTrace.scope !== "sidebar-switch" ||
          scenario.interactionTrace.requireRetainedAfterFirstSwitch !== true)))
  ) {
    throw new Error(
      `scenarios.${name}.interactionTrace has invalid scope or timing`,
    );
  }
  if (
    scenario.interactionTraceOnly !== undefined &&
    (scenario.interactionTraceOnly !== true ||
      scenario.interactionTrace?.enabled !== true)
  ) {
    throw new Error(
      `scenarios.${name}.interactionTraceOnly requires an enabled interactionTrace`,
    );
  }
}

export function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ];
}

export function summarize(values) {
  return {
    count: values.length,
    medianMs: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    maxMs: round(Math.max(...values, 0)),
  };
}

export function round(value, digits = 3) {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

export function bytesToMiB(bytes) {
  return round(bytes / (1024 * 1024));
}

export function bytesToKiB(bytes) {
  return round(bytes / 1024);
}

export function encodeProjectPath(projectPath) {
  return projectPath.replace(/[/\\:]/g, "-");
}

export function deterministicPayload(bytes, seed) {
  const prefix =
    `[${seed}]\n` +
    "glossary-tooltips governs rendered hints.\n" +
    "Inspect topics/glossary-tooltips.md, " +
    "packages/server/src/augments/project-path-links.ts, and README.md.\n" +
    "Negative controls: runs/perf-absent.jsonl text/plain v2.1.223.\n";
  if (bytes < prefix.length) {
    throw new Error(
      `payloadBytes ${bytes} cannot fit semantic fixture (${prefix.length})`,
    );
  }
  const alphabet =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let state = 2166136261;
  for (const character of seed) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619) >>> 0;
  }
  const output = [prefix];
  let remaining = bytes - prefix.length;
  while (remaining > 0) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const chunk = alphabet[state % alphabet.length];
    output.push(chunk);
    remaining -= 1;
  }
  return output.join("");
}

export function transcriptRows({
  projectPath,
  sessionId,
  startTurn,
  turns,
  payloadBytes,
}) {
  const rows = [];
  let parentUuid = startTurn === 0 ? null : `${sessionId}-a-${startTurn - 1}`;
  for (let offset = 0; offset < turns; offset += 1) {
    const turn = startTurn + offset;
    const userUuid = `${sessionId}-u-${turn}`;
    const assistantUuid = `${sessionId}-a-${turn}`;
    const timestamp = new Date(Date.UTC(2026, 7, 8, 12, turn, 0)).toISOString();
    rows.push(
      JSON.stringify({
        parentUuid,
        isSidechain: false,
        userType: "external",
        cwd: projectPath,
        sessionId,
        version: "2.1.223",
        gitBranch: "main",
        type: "user",
        message: {
          role: "user",
          content: deterministicPayload(
            payloadBytes,
            `${sessionId}:user:${turn}`,
          ),
        },
        uuid: userUuid,
        timestamp,
      }),
    );
    rows.push(
      JSON.stringify({
        parentUuid: userUuid,
        isSidechain: false,
        cwd: projectPath,
        sessionId,
        version: "2.1.223",
        gitBranch: "main",
        type: "assistant",
        message: {
          id: `msg_${assistantUuid}`,
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [
            {
              type: "text",
              text: deterministicPayload(
                payloadBytes,
                `${sessionId}:assistant:${turn}`,
              ),
            },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: Math.max(1, Math.ceil(payloadBytes / 4)),
          },
        },
        requestId: `req_${assistantUuid}`,
        uuid: assistantUuid,
        timestamp,
      }),
    );
    parentUuid = assistantUuid;
  }
  return `${rows.join("\n")}\n`;
}

export function assertCount(actual, expected, description) {
  if (actual !== expected) {
    throw new Error(`${description}: expected ${expected}, got ${actual}`);
  }
}

export function bodyArray(body, field, description) {
  const value = body?.[field];
  if (!Array.isArray(value)) {
    throw new Error(`${description} response lacks ${field}[]`);
  }
  return value;
}

export function getMetric(value, dottedPath) {
  return dottedPath.split(".").reduce((current, key) => current?.[key], value);
}
