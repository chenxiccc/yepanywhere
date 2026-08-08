#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const SUITE_VERSION = 2;
const GENERALIZED_PROJECT_PATHS_BASE =
  "61cb5f358b9ccb56549d0515ded703ec534996a6";
const DEFAULT_CONFIG_PATH = new URL("./config.json", import.meta.url);
const DEFAULT_RATCHETS_PATH = new URL("./ratchets.json", import.meta.url);

function parseArgs(argv) {
  const options = {
    checkout: null,
    config: DEFAULT_CONFIG_PATH,
    driver: "server",
    "fixture-repository": null,
    label: "working-tree",
    output: null,
    ratchets: DEFAULT_RATCHETS_PATH,
    scenario: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--help") {
      console.log(
        "Usage: node run.mjs --checkout PATH --scenario NAME [--driver server|browser] " +
          "[--fixture-repository PATH] [--label LABEL] [--config FILE] " +
          "[--ratchets FILE] [--output FILE]",
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
  if (options.driver !== "server" && options.driver !== "browser") {
    throw new Error("--driver must be server or browser");
  }
  return options;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function validateScenario(scenario, name) {
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
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ];
}

function summarize(values) {
  return {
    count: values.length,
    medianMs: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    maxMs: round(Math.max(...values, 0)),
  };
}

function round(value, digits = 3) {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function bytesToMiB(bytes) {
  return round(bytes / (1024 * 1024));
}

function bytesToKiB(bytes) {
  return round(bytes / 1024);
}

function encodeProjectPath(projectPath) {
  return projectPath.replace(/[/\\:]/g, "-");
}

function deterministicPayload(bytes, seed) {
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

function transcriptRows({
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

async function runProcess(command, args, { cwd }) {
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  const output = Buffer.concat(stdout).toString("utf8").trim();
  if (code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${code}: ` +
        Buffer.concat(stderr).toString("utf8").trim(),
    );
  }
  return output;
}

const REQUIRED_FIXTURE_PATHS = [
  "GLOSSARY.md",
  "README.md",
  "topics/glossary-tooltips.md",
  "packages/server/src/augments/project-path-links.ts",
];

async function createFixture(root, scenario, fixtureConfig) {
  const configDir = path.join(root, "claude");
  const sourceRoot = path.join(root, "projects");
  const fixtureGitDir = path.join(root, "fixture.git");
  const sessionFiles = [];
  await mkdir(path.join(configDir, "projects"), { recursive: true });
  await mkdir(sourceRoot, { recursive: true });
  await runProcess(
    "git",
    ["clone", "--shared", "--bare", fixtureConfig.repository, fixtureGitDir],
    { cwd: root },
  );
  const resolvedRevision = await runProcess(
    "git",
    [`--git-dir=${fixtureGitDir}`, "rev-parse", fixtureConfig.revision],
    { cwd: root },
  );
  if (resolvedRevision !== fixtureConfig.revision) {
    throw new Error(
      `fixture revision resolved to ${resolvedRevision}, expected ${fixtureConfig.revision}`,
    );
  }

  for (
    let projectIndex = 0;
    projectIndex < scenario.projects;
    projectIndex += 1
  ) {
    const projectPath = path.join(sourceRoot, `project-${projectIndex}`);
    await runProcess(
      "git",
      [
        `--git-dir=${fixtureGitDir}`,
        "worktree",
        "add",
        "--detach",
        projectPath,
        resolvedRevision,
      ],
      { cwd: root },
    );
    for (const relativePath of REQUIRED_FIXTURE_PATHS) {
      const fixturePath = path.join(projectPath, relativePath);
      const fixtureStats = await stat(fixturePath).catch(() => null);
      if (!fixtureStats?.isFile()) {
        throw new Error(
          `fixture ${resolvedRevision} lacks required file ${relativePath}`,
        );
      }
    }

    const sessionDir = path.join(
      configDir,
      "projects",
      encodeProjectPath(projectPath),
    );
    await mkdir(sessionDir, { recursive: true });

    for (
      let sessionIndex = 0;
      sessionIndex < scenario.sessionsPerProject;
      sessionIndex += 1
    ) {
      const sessionId = `perf-p${projectIndex}-s${sessionIndex}`;
      const file = path.join(sessionDir, `${sessionId}.jsonl`);
      await writeFile(
        file,
        transcriptRows({
          projectPath,
          sessionId,
          startTurn: 0,
          turns: scenario.initialTurns,
          payloadBytes: scenario.payloadBytes,
        }),
      );
      sessionFiles.push({ file, projectPath, sessionId });
    }
  }

  return {
    configDir,
    fixtureRevision: resolvedRevision,
    sessionFiles,
    sourceRoot,
  };
}

function prepareAppendedTurns(fixture, scenario) {
  return fixture.sessionFiles.map(({ file, projectPath, sessionId }) => ({
    content: transcriptRows({
      projectPath,
      sessionId,
      startTurn: scenario.initialTurns,
      turns: scenario.newTurns,
      payloadBytes: scenario.payloadBytes,
    }),
    file,
  }));
}

async function appendTurns(appends) {
  await Promise.all(
    appends.map(({ content, file }) => appendFile(file, content)),
  );
}

async function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function findPortPair(start) {
  for (let port = start; port < start + 500; port += 3) {
    if ((await canBind(port)) && (await canBind(port + 1))) return port;
  }
  throw new Error(`No free port pair starting at ${start}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(
  url,
  { agent, json, method = "GET", needle, timeoutMs },
) {
  const started = performance.now();
  const parsed = new URL(url);
  const encodedBody = json === undefined ? null : JSON.stringify(json);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        agent,
        headers:
          encodedBody === null
            ? undefined
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(encodedBody),
              },
        hostname: parsed.hostname,
        method,
        path: `${parsed.pathname}${parsed.search}`,
        port: parsed.port,
        timeout: timeoutMs,
      },
      (response) => {
        const chunks = [];
        let firstByteMs = null;
        let needleMs = null;
        let searchTail = "";
        response.on("data", (chunk) => {
          chunks.push(chunk);
          firstByteMs ??= performance.now() - started;
          if (needle && needleMs === null) {
            searchTail += chunk.toString("utf8");
            if (searchTail.includes(needle)) {
              needleMs = performance.now() - started;
            } else if (searchTail.length > needle.length * 2) {
              searchTail = searchTail.slice(-needle.length * 2);
            }
          }
        });
        response.on("end", () => {
          const bodyReceivedMs = performance.now() - started;
          const body = Buffer.concat(chunks).toString("utf8");
          if (
            !response.statusCode ||
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            reject(
              new Error(
                `${response.statusCode ?? "unknown"} ${url}: ${body.slice(0, 500)}`,
              ),
            );
            return;
          }
          try {
            const parseStarted = performance.now();
            const parsedBody = body.length === 0 ? null : JSON.parse(body);
            const jsonParseMs = performance.now() - parseStarted;
            const measuredFirstByteMs =
              firstByteMs ?? performance.now() - started;
            resolve({
              body: parsedBody,
              bodyReceivedMs,
              bodyTransferMs: Math.max(0, bodyReceivedMs - measuredFirstByteMs),
              bytes: Buffer.byteLength(body),
              firstByteMs: measuredFirstByteMs,
              headers: response.headers,
              jsonParseMs,
              ms: performance.now() - started,
              needleMs,
            });
          } catch (error) {
            reject(new Error(`Invalid JSON from ${url}: ${error.message}`));
          }
        });
      },
    );
    request.once("timeout", () =>
      request.destroy(new Error(`Timed out: ${url}`)),
    );
    request.once("error", reject);
    request.end(encodedBody ?? undefined);
  });
}

function requestProfile(response) {
  const header = response.headers?.["server-timing"];
  const serverTimings = {};
  if (typeof header === "string") {
    for (const entry of header.split(",")) {
      const match = /^\s*([^;\s]+);dur=([0-9.]+)\s*$/.exec(entry);
      if (match) serverTimings[match[1]] = Number(match[2]);
    }
  }
  const owners = [
    "ya-project",
    "ya-read",
    "ya-normalize",
    "ya-route",
    "ya-augment",
  ];
  const serverTotalMs = serverTimings["ya-total"];
  const ownerValues = owners.map((name) => serverTimings[name]);
  const hasServerProfile =
    typeof serverTotalMs === "number" &&
    ownerValues.every((value) => typeof value === "number");
  const markedServerMs = hasServerProfile
    ? ownerValues.reduce((sum, value) => sum + value, 0)
    : null;
  const frameworkSerializeLoopbackMs = hasServerProfile
    ? Math.max(0, response.firstByteMs - serverTotalMs)
    : null;
  const serverPhaseResidualMs = hasServerProfile
    ? Math.max(0, serverTotalMs - markedServerMs)
    : null;
  const nonOverlappingPhases = hasServerProfile
    ? {
        projectMs: serverTimings["ya-project"],
        readMs: serverTimings["ya-read"],
        normalizeMs: serverTimings["ya-normalize"],
        routeMs: serverTimings["ya-route"],
        augmentMs: serverTimings["ya-augment"],
        serverResidualMs: serverPhaseResidualMs,
        frameworkSerializeLoopbackMs,
        bodyTransferMs: response.bodyTransferMs,
        jsonParseMs: response.jsonParseMs,
      }
    : null;
  const coveredMs = nonOverlappingPhases
    ? sumAvailablePhases(nonOverlappingPhases)
    : null;
  const harnessResidualMs =
    coveredMs === null ? null : Math.max(0, response.ms - coveredMs);
  if (nonOverlappingPhases && harnessResidualMs !== null) {
    nonOverlappingPhases.harnessResidualMs = harnessResidualMs;
  }
  return {
    available: hasServerProfile,
    bodyTransferMs: response.bodyTransferMs,
    coverage:
      coveredMs !== null && response.ms > 0
        ? {
            coveredMs: round(coveredMs + harnessResidualMs),
            fraction: round((coveredMs + harnessResidualMs) / response.ms),
            totalMs: round(response.ms),
          }
        : null,
    frameworkSerializeLoopbackMs,
    jsonParseMs: response.jsonParseMs,
    markedServerMs,
    nonOverlappingPhases,
    serverPhaseResidualMs,
    serverTimings,
  };
}

async function waitForReady({ baseUrl, maintenanceUrl, timeoutMs, child }) {
  const started = performance.now();
  let lastError = null;
  while (performance.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(
        `Server exited before readiness with code ${child.exitCode}`,
      );
    }
    try {
      await requestJson(`${maintenanceUrl}/health`, {
        timeoutMs: 1_000,
      });
      await requestJson(`${baseUrl}/api/projects`, { timeoutMs: 5_000 });
      return performance.now() - started;
    } catch (error) {
      lastError = error;
      await wait(100);
    }
  }
  throw new Error(
    `Server readiness timed out: ${lastError?.message ?? "unknown"}`,
  );
}

async function openInspector(maintenanceUrl, timeoutMs, port) {
  const response = await requestJson(`${maintenanceUrl}/inspector/open`, {
    json: { host: "127.0.0.1", port },
    method: "POST",
    timeoutMs,
  });
  if (typeof response.body?.url !== "string") {
    throw new Error("Maintenance inspector/open response lacks url");
  }
  return response.body.url;
}

async function collectGarbage(inspectorUrl, timeoutMs) {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(inspectorUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Inspector garbage collection timed out"));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({ id: 1, method: "HeapProfiler.collectGarbage" }),
      );
    });
    socket.addEventListener("message", (event) => {
      const response = JSON.parse(String(event.data));
      if (response.id !== 1) return;
      clearTimeout(timeout);
      socket.close();
      if (response.error) {
        reject(
          new Error(
            `Inspector garbage collection failed: ${response.error.message}`,
          ),
        );
      } else {
        resolve();
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Inspector WebSocket failed"));
    });
  });
}

async function sampleMemory(inspectorUrl, maintenanceUrl, timeoutMs) {
  await collectGarbage(inspectorUrl, timeoutMs);
  await wait(100);
  const samples = [];
  for (let index = 0; index < 7; index += 1) {
    const { body } = await requestJson(`${maintenanceUrl}/status`, {
      timeoutMs,
    });
    const raw = body?.memory?.raw;
    if (
      !raw ||
      typeof raw.heapUsed !== "number" ||
      typeof raw.rss !== "number"
    ) {
      throw new Error("Maintenance /status lacks memory.raw.heapUsed/rss");
    }
    samples.push({
      diagnostics: body.diagnostics ?? null,
      raw,
      v8: body.memory.v8 ?? null,
    });
    if (index < 6) await wait(150);
  }
  const minimumHeap = samples.reduce((best, sample) =>
    sample.raw.heapUsed < best.raw.heapUsed ? sample : best,
  );
  return {
    heapUsedBytes: minimumHeap.raw.heapUsed,
    heapTotalBytes: minimumHeap.raw.heapTotal,
    rssBytes: percentile(
      samples.map((sample) => sample.raw.rss),
      0.5,
    ),
    externalBytes: minimumHeap.raw.external,
    arrayBuffersBytes: minimumHeap.raw.arrayBuffers ?? 0,
    diagnostics: minimumHeap.diagnostics,
    v8: minimumHeap.v8,
  };
}

function gitRevision(checkout) {
  return runProcess("git", ["rev-parse", "HEAD"], { cwd: checkout });
}

function absoluteFilePath(file) {
  return file instanceof URL ? fileURLToPath(file) : path.resolve(file);
}

function repositoryRelativePath(repository, file) {
  const relative = path.relative(repository, absoluteFilePath(file));
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative;
}

async function harnessIdentity(repository, options, config, ratchets) {
  const runner = fileURLToPath(import.meta.url);
  const repositoryPaths = [runner, options.config, options.ratchets]
    .map((file) => repositoryRelativePath(repository, file))
    .filter(Boolean);
  const revision = await runProcess(
    "git",
    ["log", "-1", "--format=%H", "--", ...repositoryPaths],
    { cwd: repository },
  );
  const dirty =
    (await runProcess(
      "git",
      ["status", "--porcelain", "--", ...repositoryPaths],
      { cwd: repository },
    )) !== "";
  const content = createHash("sha256");
  content.update(await readFile(runner));
  content.update("\0config\0");
  content.update(JSON.stringify(config));
  content.update("\0ratchets\0");
  content.update(JSON.stringify(ratchets));
  return {
    contentSha256: content.digest("hex"),
    dirty,
    revision,
  };
}

async function gitIsAncestor(checkout, ancestor, descendant) {
  const child = spawn(
    "git",
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { cwd: checkout, stdio: "ignore" },
  );
  const code = await new Promise((resolve) => child.once("exit", resolve));
  if (code === 0) return true;
  if (code === 1) return false;
  throw new Error(
    `git merge-base --is-ancestor ${ancestor} ${descendant} exited ${code}`,
  );
}

async function startServer({ checkout, driver, fixture, port, root, config }) {
  const logPath = path.join(root, "server.log");
  const log = createWriteStream(logPath, { flags: "a" });
  const env = {
    ...process.env,
    AUTH_DISABLED: "true",
    CLAUDE_CONFIG_DIR: fixture.configDir,
    CLAUDE_SESSIONS_DIR: path.join(fixture.configDir, "projects"),
    CODEX_SESSIONS_DIR: path.join(root, "empty-codex"),
    ENABLED_PROVIDERS: "claude",
    GEMINI_SESSIONS_DIR: path.join(root, "empty-gemini"),
    GROK_SESSIONS_DIR: path.join(root, "empty-grok"),
    LOG_LEVEL: "error",
    LOG_TO_FILE: "false",
    MAINTENANCE_PORT: String(port + 1),
    NO_BACKEND_RELOAD: "true",
    PI_SESSIONS_DIR: path.join(root, "empty-pi"),
    PORT: String(port),
    VITE_PORT: String(port + 2),
    VOICE_INPUT: "false",
    YEP_DATA_DIR: path.join(root, "data"),
    YEP_PROFILE: `perf-${process.pid}`,
  };
  const child = spawn(
    "pnpm",
    driver === "browser"
      ? ["dev", "--no-frontend-reload"]
      : ["--filter", "@yep-anywhere/server", "dev"],
    {
      cwd: checkout,
      detached: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const baseUrl = `http://127.0.0.1:${port}`;
  const maintenanceUrl = `http://127.0.0.1:${port + 1}`;
  try {
    const startupMs = await waitForReady({
      baseUrl,
      maintenanceUrl,
      timeoutMs: config.server.startupTimeoutMs,
      child,
    });
    const inspectorPort = await findPortPair(port + 1_000);
    const inspectorUrl = await openInspector(
      maintenanceUrl,
      config.server.requestTimeoutMs,
      inspectorPort,
    );
    return {
      baseUrl,
      child,
      inspectorUrl,
      log,
      logPath,
      maintenanceUrl,
      startupMs,
    };
  } catch (error) {
    log.end();
    await stopServer(child);
    const output = await readFile(logPath, "utf8").catch(() => "");
    throw new Error(`${error.message}\n${output.slice(-4_000)}`);
  }
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    wait(8_000).then(() => false),
  ]);
  if (!exited) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

function assertCount(actual, expected, description) {
  if (actual !== expected) {
    throw new Error(`${description}: expected ${expected}, got ${actual}`);
  }
}

function bodyArray(body, field, description) {
  const value = body?.[field];
  if (!Array.isArray(value)) {
    throw new Error(`${description} response lacks ${field}[]`);
  }
  return value;
}

function requestTarget(target) {
  return typeof target === "string" ? { url: target } : target;
}

async function runClientBatch(agents, targets, timeoutMs) {
  const latencies = [];
  const firstByteLatencies = [];
  const readableTextLatencies = [];
  const bytes = [];
  const profiles = [];
  const bodies = Array.from({ length: targets.length });
  let next = 0;
  await Promise.all(
    agents.map(async (agent) => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= targets.length) return;
        const target = requestTarget(targets[index]);
        const response = await requestJson(target.url, {
          agent,
          needle: target.needle,
          timeoutMs,
        });
        bodies[index] = response.body;
        latencies.push(response.ms);
        firstByteLatencies.push(response.firstByteMs);
        if (target.needle) {
          if (response.needleMs === null) {
            throw new Error(`Readable-text marker absent from ${target.url}`);
          }
          readableTextLatencies.push(response.needleMs);
        }
        bytes.push(response.bytes);
        profiles.push(requestProfile(response));
      }
    }),
  );
  return {
    bodies,
    bytes,
    firstByteLatencies,
    latencies,
    profiles,
    readableTextLatencies,
  };
}

async function runHerd(agents, targets, timeoutMs) {
  const latencies = [];
  const firstByteLatencies = [];
  const readableTextLatencies = [];
  const bytes = [];
  const bodies = [];
  const profiles = [];
  await Promise.all(
    agents.map(async (agent) => {
      for (const rawTarget of targets) {
        const target = requestTarget(rawTarget);
        const response = await requestJson(target.url, {
          agent,
          needle: target.needle,
          timeoutMs,
        });
        latencies.push(response.ms);
        firstByteLatencies.push(response.firstByteMs);
        if (target.needle) {
          if (response.needleMs === null) {
            throw new Error(`Readable-text marker absent from ${target.url}`);
          }
          readableTextLatencies.push(response.needleMs);
        }
        bytes.push(response.bytes);
        bodies.push(response.body);
        profiles.push(requestProfile(response));
      }
    }),
  );
  return {
    bodies,
    bytes,
    firstByteLatencies,
    latencies,
    profiles,
    readableTextLatencies,
  };
}

function memoryView(sample) {
  const caches = sample.diagnostics?.caches ?? null;
  const knownCacheSourceBytes = caches
    ? (caches.claudeTranscript?.retainedSourceBytes ?? 0) +
      (caches.projectPaths?.retainedBytes ?? 0)
    : null;
  return {
    heapUsedMiB: bytesToMiB(sample.heapUsedBytes),
    heapTotalMiB: bytesToMiB(sample.heapTotalBytes),
    rssMiB: bytesToMiB(sample.rssBytes),
    externalMiB: bytesToMiB(sample.externalBytes),
    arrayBuffersMiB: bytesToMiB(sample.arrayBuffersBytes),
    knownCaches: caches,
    residuals: {
      heapUsedLessKnownCacheSourceMiB:
        knownCacheSourceBytes === null
          ? null
          : bytesToMiB(sample.heapUsedBytes - knownCacheSourceBytes),
    },
    v8: sample.v8,
  };
}

function summarizeRequestProfiles(profiles) {
  const available = profiles.filter((profile) => profile.available);
  const values = (selector, source = profiles) =>
    source
      .map(selector)
      .filter((value) => typeof value === "number" && Number.isFinite(value));
  return {
    availableCount: available.length,
    sampleCount: profiles.length,
    bodyTransfer: summarize(values((profile) => profile.bodyTransferMs)),
    jsonParse: summarize(values((profile) => profile.jsonParseMs)),
    phaseCoverage: phaseCoverageReport(available),
    server: {
      project: summarize(
        values((profile) => profile.serverTimings["ya-project"], available),
      ),
      read: summarize(
        values((profile) => profile.serverTimings["ya-read"], available),
      ),
      normalize: summarize(
        values((profile) => profile.serverTimings["ya-normalize"], available),
      ),
      route: summarize(
        values((profile) => profile.serverTimings["ya-route"], available),
      ),
      augment: summarize(
        values((profile) => profile.serverTimings["ya-augment"], available),
      ),
      total: summarize(
        values((profile) => profile.serverTimings["ya-total"], available),
      ),
      marked: summarize(values((profile) => profile.markedServerMs, available)),
      residual: summarize(
        values((profile) => profile.serverPhaseResidualMs, available),
      ),
    },
    frameworkSerializeLoopback: summarize(
      values((profile) => profile.frameworkSerializeLoopbackMs, available),
    ),
  };
}

function clientTelemetry(page) {
  return page.evaluate(async () => {
    const memory = performance.memory;
    const detailStore = await import(
      "/src/lib/sessionDetail/sessionDetailStore.ts"
    );
    return {
      memory: memory
        ? {
            usedJSHeapMiB: memory.usedJSHeapSize / (1024 * 1024),
            totalJSHeapMiB: memory.totalJSHeapSize / (1024 * 1024),
            limitMiB: memory.jsHeapSizeLimit / (1024 * 1024),
          }
        : null,
      dom: {
        nodes: document.getElementsByTagName("*").length,
        messageRows: document.querySelectorAll(".message-render-row").length,
        streamingBlocks: document.querySelectorAll(".streaming-block").length,
        toolRows: document.querySelectorAll(".tool-row").length,
      },
      transcriptMemory: detailStore.getSessionTranscriptMemoryStats(),
    };
  });
}

const EXPECTED_GLOSSARY_TITLE =
  "glossary-tooltips: Glossary tooltips enrich every Markdown-render-eligible view with subtle, copyable definition hints from one governing current GLOSSARY.md and its project-contained include graph, using an in-memory compiled phrase automaton to keep matching linear in rendered text.";
const EXPECTED_PROJECT_PATHS = [
  "topics/glossary-tooltips.md",
  "packages/server/src/augments/project-path-links.ts",
  "README.md",
];
const NEGATIVE_PROJECT_PATHS = [
  "runs/perf-absent.jsonl",
  "text/plain",
  "v2.1.223",
];

function sessionBrowserTarget(server, detail, turn) {
  return {
    detail,
    marker: `[${detail.sessionId}:assistant:${turn}]`,
    url:
      `${server.baseUrl}/projects/${encodeURIComponent(detail.projectId)}` +
      `/sessions/${encodeURIComponent(detail.sessionId)}`,
  };
}

async function waitForReadableTail(page, marker, timeoutMs) {
  await page.waitForFunction(
    (needle) => document.body?.innerText.includes(needle),
    marker,
    { timeout: timeoutMs },
  );
}

async function waitForFinalDisplay(
  page,
  target,
  { glossarySupported, projectPathsSupported, started, timeoutMs },
) {
  await waitForReadableTail(page, target.marker, timeoutMs);
  const browserTiming = {
    readableTailAtMs: await page.evaluate(() => performance.now()),
    glossaryHighlightAtMs: null,
    projectPathHighlightAtMs: null,
    finalDisplayAtMs: null,
  };
  const milestones = {
    readableTailMs: performance.now() - started,
    glossaryHighlightMs: null,
    projectPathHighlightMs: null,
  };
  Object.defineProperty(milestones, "browserTiming", {
    enumerable: false,
    value: browserTiming,
  });
  if (glossarySupported) {
    try {
      await page.waitForFunction(
        ({ marker, title }) => {
          const row = [
            ...document.querySelectorAll(".message-render-row"),
          ].find((candidate) => candidate.textContent?.includes(marker));
          return [
            ...(row?.querySelectorAll("[data-glossary-term]") ?? []),
          ].some(
            (term) =>
              (term.getAttribute("data-tooltip") ||
                term.getAttribute("title")) === title,
          );
        },
        { marker: target.marker, title: EXPECTED_GLOSSARY_TITLE },
        { timeout: timeoutMs },
      );
    } catch (error) {
      const diagnosis = await page.evaluate((marker) => {
        const row = [...document.querySelectorAll(".message-render-row")].find(
          (candidate) => candidate.textContent?.includes(marker),
        );
        return {
          enabled: localStorage.getItem("yep-anywhere-glossary-hints-enabled"),
          rowGlossaryTitles: [
            ...(row?.querySelectorAll("[data-glossary-term]") ?? []),
          ].map((term) => ({
            themed: term.getAttribute("data-tooltip"),
            title: term.getAttribute("title"),
          })),
          rowText: row?.textContent?.slice(0, 500) ?? null,
        };
      }, target.marker);
      throw new Error(
        `glossary final display missing: ${JSON.stringify(diagnosis)}`,
        { cause: error },
      );
    }
    milestones.glossaryHighlightMs = performance.now() - started;
    browserTiming.glossaryHighlightAtMs = await page.evaluate(() =>
      performance.now(),
    );
  }
  if (projectPathsSupported) {
    await page.waitForFunction(
      ({ expectedPaths, marker }) => {
        const row = [...document.querySelectorAll(".message-render-row")].find(
          (candidate) => candidate.textContent?.includes(marker),
        );
        if (!row) return false;
        const paths = [
          ...row.querySelectorAll('a[data-ya-resource="local-file"]'),
        ].map((anchor) => anchor.getAttribute("data-ya-path") ?? "");
        return expectedPaths.every((expected) =>
          paths.some(
            (actual) => actual === expected || actual.endsWith(`/${expected}`),
          ),
        );
      },
      { expectedPaths: EXPECTED_PROJECT_PATHS, marker: target.marker },
      { timeout: timeoutMs },
    );
    milestones.projectPathHighlightMs = performance.now() - started;
    browserTiming.projectPathHighlightAtMs = await page.evaluate(() =>
      performance.now(),
    );
    const wronglyLinked = await page.evaluate(
      ({ marker, negativePaths }) => {
        const row = [...document.querySelectorAll(".message-render-row")].find(
          (candidate) => candidate.textContent?.includes(marker),
        );
        if (!row) return negativePaths;
        const linkedText = [
          ...row.querySelectorAll('a[data-ya-resource="local-file"]'),
        ].map((anchor) => anchor.textContent ?? "");
        return negativePaths.filter((negative) =>
          linkedText.some((text) => text.includes(negative)),
        );
      },
      { marker: target.marker, negativePaths: NEGATIVE_PROJECT_PATHS },
    );
    if (wronglyLinked.length > 0) {
      throw new Error(
        `project-path negative controls were linked: ${wronglyLinked.join(", ")}`,
      );
    }
  }
  milestones.finalHighlightMs = Math.max(
    milestones.readableTailMs,
    milestones.glossaryHighlightMs ?? 0,
    milestones.projectPathHighlightMs ?? 0,
  );
  browserTiming.finalDisplayAtMs =
    browserTiming.projectPathHighlightAtMs ??
    browserTiming.glossaryHighlightAtMs ??
    browserTiming.readableTailAtMs;
  return milestones;
}

async function navigateSpa(page, url) {
  await page.evaluate((nextUrl) => {
    history.pushState(null, "", nextUrl);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, url);
}

async function navigateProfiledSpa(page, url) {
  await page.evaluate((nextUrl) => {
    window.__yaPerfMarks = [];
    window.__yaPerfNavigationStartMs = performance.now();
    performance.clearResourceTimings();
    history.pushState(null, "", nextUrl);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, url);
}

function phaseDuration(start, end) {
  if (typeof start !== "number" || typeof end !== "number" || end < start) {
    return null;
  }
  return round(end - start);
}

function sumAvailablePhases(phases) {
  const values = Object.values(phases);
  return values.every((value) => typeof value === "number")
    ? round(values.reduce((sum, value) => sum + value, 0))
    : null;
}

function phaseCoverageReport(profiles) {
  const available = profiles.filter(
    (profile) => profile.available && profile.coverage?.totalMs > 0,
  );
  const totalMs = available.reduce(
    (sum, profile) => sum + profile.coverage.totalMs,
    0,
  );
  if (totalMs <= 0) {
    return {
      explainedFraction: null,
      individuallySignificant: [],
      rankedPhases: [],
      smallestSetAt80Percent: [],
    };
  }
  const totals = new Map();
  for (const profile of available) {
    for (const [name, duration] of Object.entries(
      profile.nonOverlappingPhases,
    )) {
      totals.set(name, (totals.get(name) ?? 0) + duration);
    }
  }
  const rankedPhases = [...totals.entries()]
    .map(([name, duration]) => ({
      fraction: round(duration / totalMs),
      meanMs: round(duration / available.length),
      name,
    }))
    .sort((left, right) => right.fraction - left.fraction);
  const smallestSetAt80Percent = [];
  let explainedFraction = 0;
  for (const phase of rankedPhases) {
    if (explainedFraction >= 0.8) break;
    smallestSetAt80Percent.push(phase.name);
    explainedFraction += phase.fraction;
  }
  return {
    explainedFraction: round(explainedFraction),
    individuallySignificant: rankedPhases
      .filter((phase) => phase.fraction >= 0.1)
      .map((phase) => phase.name),
    rankedPhases,
    smallestSetAt80Percent,
  };
}

async function collectClientNavigationProfile(
  page,
  target,
  milestones,
  timeoutMs,
) {
  const expectedPath =
    `/api/projects/${encodeURIComponent(target.detail.projectId)}` +
    `/sessions/${encodeURIComponent(target.detail.sessionId)}`;
  try {
    await page.waitForFunction(
      (path) =>
        performance
          .getEntriesByType("resource")
          .some((entry) => new URL(entry.name).pathname === path),
      expectedPath,
      { timeout: timeoutMs },
    );
  } catch (error) {
    const diagnosis = await page.evaluate(() => ({
      marks: window.__yaPerfMarks ?? [],
      resources: performance
        .getEntriesByType("resource")
        .map((entry) => entry.name),
    }));
    throw new Error(
      `session detail Resource Timing missing for ${expectedPath}: ${JSON.stringify(diagnosis)}`,
      { cause: error },
    );
  }
  const observed = await page.evaluate(
    ({ path, sessionId }) => {
      const marks = window.__yaPerfMarks ?? [];
      const resource = performance
        .getEntriesByType("resource")
        .find((entry) => new URL(entry.name).pathname === path);
      return {
        marks,
        navigationStartAtMs: window.__yaPerfNavigationStartMs ?? 0,
        resource: resource
          ? {
              responseEnd: resource.responseEnd,
              responseStart: resource.responseStart,
              startTime: resource.startTime,
            }
          : null,
        sessionId,
      };
    },
    { path: expectedPath, sessionId: target.detail.sessionId },
  );
  const browserTiming = milestones.browserTiming;
  if (typeof browserTiming?.finalDisplayAtMs !== "number") {
    return {
      available: false,
      reason: "final-display browser timestamp unavailable",
    };
  }
  const start = observed.marks.find(
    (mark) =>
      mark.name === "session_initial_load_start" &&
      mark.detail?.sessionId === observed.sessionId,
  );
  if (!start || !observed.resource) {
    return {
      available: false,
      reason: !start
        ? "session load marks unavailable"
        : "session detail resource timing unavailable",
    };
  }
  const marksAfterStart = observed.marks.filter(
    (mark) => mark.atMs >= start.atMs,
  );
  const dataReady = marksAfterStart.find(
    (mark) => mark.name === "session_initial_load_data_ready",
  );
  const stateQueued = marksAfterStart.find(
    (mark) => mark.name === "session_initial_messages_state_queued",
  );
  const commit = stateQueued
    ? marksAfterStart.find(
        (mark) =>
          mark.name === "message_list_commit_effect" &&
          mark.atMs >= stateQueued.atMs,
      )
    : null;
  if (!stateQueued || !commit) {
    return {
      available: false,
      reason: !stateQueued
        ? "session state-queued mark unavailable"
        : "MessageList commit mark unavailable",
    };
  }
  const restoredFromSnapshot = start.detail?.restoredFromSnapshot === true;
  const resource = observed.resource;
  const requestPhases = {
    loadStartToRequestStartMs: phaseDuration(start.atMs, resource.startTime),
    requestToResponseStartMs: phaseDuration(
      resource.startTime,
      resource.responseStart,
    ),
    responseTransferMs: phaseDuration(
      resource.responseStart,
      resource.responseEnd,
    ),
    responseEndToDataReadyMs: phaseDuration(
      resource.responseEnd,
      dataReady?.atMs,
    ),
    dataReadyToStateQueuedMs: phaseDuration(dataReady?.atMs, stateQueued.atMs),
  };
  const finalDisplayPhases = {
    commitToReadableTailMs: phaseDuration(
      commit.atMs,
      browserTiming.readableTailAtMs,
    ),
    ...(typeof browserTiming.glossaryHighlightAtMs === "number"
      ? {
          readableTailToGlossaryHighlightMs: phaseDuration(
            browserTiming.readableTailAtMs,
            browserTiming.glossaryHighlightAtMs,
          ),
        }
      : {}),
    ...(typeof browserTiming.projectPathHighlightAtMs === "number"
      ? {
          [typeof browserTiming.glossaryHighlightAtMs === "number"
            ? "glossaryToProjectPathHighlightMs"
            : "readableTailToProjectPathHighlightMs"]: phaseDuration(
            browserTiming.glossaryHighlightAtMs ??
              browserTiming.readableTailAtMs,
            browserTiming.projectPathHighlightAtMs,
          ),
        }
      : {}),
  };
  const revealPhases = {
    navigationToLoadStartMs: phaseDuration(
      observed.navigationStartAtMs,
      start.atMs,
    ),
    ...(restoredFromSnapshot
      ? {
          loadStartToStateQueuedMs: phaseDuration(start.atMs, stateQueued.atMs),
        }
      : requestPhases),
    stateQueuedToCommitMs: phaseDuration(stateQueued.atMs, commit.atMs),
    ...finalDisplayPhases,
  };
  const preprocessEnd = marksAfterStart
    .filter(
      (mark) =>
        mark.name === "message_list_preprocess_end" &&
        mark.atMs >= stateQueued.atMs &&
        mark.atMs <= commit.atMs,
    )
    .at(-1);
  const groupEnd = marksAfterStart
    .filter(
      (mark) =>
        mark.name === "message_list_group_end" &&
        mark.atMs >= stateQueued.atMs &&
        mark.atMs <= commit.atMs,
    )
    .at(-1);
  const preprocessMs =
    typeof preprocessEnd?.detail?.durationMs === "number"
      ? round(preprocessEnd.detail.durationMs)
      : null;
  const groupMs =
    typeof groupEnd?.detail?.durationMs === "number"
      ? round(groupEnd.detail.durationMs)
      : null;
  const queuedToCommitMs = revealPhases.stateQueuedToCommitMs;
  const renderOtherMs =
    typeof queuedToCommitMs === "number" &&
    typeof preprocessMs === "number" &&
    typeof groupMs === "number"
      ? round(Math.max(0, queuedToCommitMs - preprocessMs - groupMs))
      : null;
  const phaseTotalMs = sumAvailablePhases(revealPhases);
  const navigationToFinalDisplayMs = phaseDuration(
    observed.navigationStartAtMs,
    browserTiming.finalDisplayAtMs,
  );
  return {
    available: phaseTotalMs !== null,
    branch: restoredFromSnapshot
      ? "warm-cache-reveal-with-overlapping-refresh"
      : "network-before-reveal",
    coverage:
      phaseTotalMs !== null && navigationToFinalDisplayMs > 0
        ? {
            coveredMs: phaseTotalMs,
            fraction: round(phaseTotalMs / navigationToFinalDisplayMs),
            totalMs: navigationToFinalDisplayMs,
          }
        : null,
    messageListWithinQueuedToCommit: {
      groupMs,
      preprocessMs,
      renderOtherMs,
    },
    nonOverlappingPhases: revealPhases,
    refresh: {
      completedAfterFinalDisplay:
        resource.responseEnd > browserTiming.finalDisplayAtMs,
      phases: requestPhases,
      responseEndRelativeToFinalDisplayMs: round(
        resource.responseEnd - browserTiming.finalDisplayAtMs,
      ),
    },
  };
}

async function prepareClientAppendProfile(page) {
  await page.evaluate(() => {
    window.__yaPerfAppendStartMs = performance.now();
    window.__yaPerfMarks = [];
  });
}

async function collectClientAppendProfile(page, milestones) {
  const observed = await page.evaluate(() => ({
    appendStartAtMs: window.__yaPerfAppendStartMs,
    marks: window.__yaPerfMarks ?? [],
  }));
  const browserTiming = milestones.browserTiming;
  const preprocessStart = observed.marks.find(
    (mark) => mark.name === "message_list_preprocess_start",
  );
  const preprocessEnd = observed.marks.find(
    (mark) =>
      mark.name === "message_list_preprocess_end" &&
      mark.atMs >= (preprocessStart?.atMs ?? Number.POSITIVE_INFINITY),
  );
  const groupEnd = observed.marks.find(
    (mark) =>
      mark.name === "message_list_group_end" &&
      mark.atMs >= (preprocessEnd?.atMs ?? Number.POSITIVE_INFINITY),
  );
  const commit = observed.marks.find(
    (mark) =>
      mark.name === "message_list_commit_effect" &&
      mark.atMs >= (groupEnd?.atMs ?? Number.POSITIVE_INFINITY),
  );
  if (
    typeof observed.appendStartAtMs !== "number" ||
    !preprocessStart ||
    !preprocessEnd ||
    !groupEnd ||
    !commit ||
    typeof browserTiming?.finalDisplayAtMs !== "number"
  ) {
    return {
      available: false,
      reason: "append MessageList phase marks unavailable",
    };
  }
  const groupDurationMs =
    typeof groupEnd.detail?.durationMs === "number"
      ? groupEnd.detail.durationMs
      : 0;
  const groupStartAtMs = groupEnd.atMs - groupDurationMs;
  const phases = {
    appendStartToPreprocessMs: phaseDuration(
      observed.appendStartAtMs,
      preprocessStart.atMs,
    ),
    preprocessMs: phaseDuration(preprocessStart.atMs, preprocessEnd.atMs),
    preprocessToGroupMs: phaseDuration(preprocessEnd.atMs, groupStartAtMs),
    groupMs: phaseDuration(groupStartAtMs, groupEnd.atMs),
    groupToCommitMs: phaseDuration(groupEnd.atMs, commit.atMs),
    commitToReadableTailMs: phaseDuration(
      commit.atMs,
      browserTiming.readableTailAtMs,
    ),
    ...(typeof browserTiming.glossaryHighlightAtMs === "number"
      ? {
          readableTailToGlossaryHighlightMs: phaseDuration(
            browserTiming.readableTailAtMs,
            browserTiming.glossaryHighlightAtMs,
          ),
        }
      : {}),
    ...(typeof browserTiming.projectPathHighlightAtMs === "number"
      ? {
          [typeof browserTiming.glossaryHighlightAtMs === "number"
            ? "glossaryToProjectPathHighlightMs"
            : "readableTailToProjectPathHighlightMs"]: phaseDuration(
            browserTiming.glossaryHighlightAtMs ??
              browserTiming.readableTailAtMs,
            browserTiming.projectPathHighlightAtMs,
          ),
        }
      : {}),
  };
  const coveredMs = sumAvailablePhases(phases);
  const totalMs = phaseDuration(
    observed.appendStartAtMs,
    browserTiming.finalDisplayAtMs,
  );
  return {
    available: coveredMs !== null,
    coverage:
      coveredMs !== null && totalMs > 0
        ? { coveredMs, fraction: round(coveredMs / totalMs), totalMs }
        : null,
    nonOverlappingPhases: phases,
  };
}

function summarizeClientAppendProfiles(profiles) {
  const available = profiles.filter((profile) => profile.available);
  const names = [
    ...new Set(
      available.flatMap((profile) =>
        Object.keys(profile.nonOverlappingPhases ?? {}),
      ),
    ),
  ];
  return {
    availableCount: available.length,
    coverage: {
      minimumFraction:
        available.length > 0
          ? round(
              Math.min(
                ...available.map((profile) => profile.coverage?.fraction ?? 0),
              ),
            )
          : null,
      medianFraction:
        available.length > 0
          ? round(
              percentile(
                available.map((profile) => profile.coverage?.fraction ?? 0),
                0.5,
              ),
            )
          : null,
    },
    nonOverlappingPhases: Object.fromEntries(
      names.map((name) => [
        name,
        summarize(
          available
            .map((profile) => profile.nonOverlappingPhases[name])
            .filter((value) => typeof value === "number"),
        ),
      ]),
    ),
    phaseCoverage: phaseCoverageReport(available),
    sampleCount: profiles.length,
    unavailableCount: profiles.length - available.length,
  };
}

function summarizeClientNavigationProfiles(profiles) {
  const available = profiles.filter((profile) => profile.available);
  const phaseSummary = (path) =>
    summarize(
      available
        .map((profile) => getMetric(profile, path))
        .filter((value) => typeof value === "number"),
    );
  const branches = Object.fromEntries(
    [...new Set(available.map((profile) => profile.branch))].map((branch) => [
      branch,
      available.filter((profile) => profile.branch === branch).length,
    ]),
  );
  const phaseNames = [
    ...new Set(
      available.flatMap((profile) =>
        Object.keys(profile.nonOverlappingPhases ?? {}),
      ),
    ),
  ];
  const refreshPhaseNames = [
    ...new Set(
      available.flatMap((profile) =>
        Object.keys(profile.refresh?.phases ?? {}),
      ),
    ),
  ];
  return {
    availableCount: available.length,
    branches,
    coverage: {
      minimumFraction:
        available.length > 0
          ? round(
              Math.min(
                ...available.map((profile) => profile.coverage?.fraction ?? 0),
              ),
            )
          : null,
      medianFraction:
        available.length > 0
          ? round(
              percentile(
                available.map((profile) => profile.coverage?.fraction ?? 0),
                0.5,
              ),
            )
          : null,
    },
    messageListWithinQueuedToCommit: Object.fromEntries(
      ["groupMs", "preprocessMs", "renderOtherMs"].map((name) => [
        name,
        phaseSummary(`messageListWithinQueuedToCommit.${name}`),
      ]),
    ),
    nonOverlappingPhases: Object.fromEntries(
      phaseNames.map((name) => [
        name,
        phaseSummary(`nonOverlappingPhases.${name}`),
      ]),
    ),
    phaseCoverage: phaseCoverageReport(available),
    refresh: {
      completedAfterFinalDisplayCount: available.filter(
        (profile) => profile.refresh.completedAfterFinalDisplay,
      ).length,
      phases: Object.fromEntries(
        refreshPhaseNames.map((name) => [
          name,
          phaseSummary(`refresh.phases.${name}`),
        ]),
      ),
      responseEndRelativeToFinalDisplayMs: phaseSummary(
        "refresh.responseEndRelativeToFinalDisplayMs",
      ),
    },
    sampleCount: profiles.length,
    unavailableReasons: Object.fromEntries(
      [
        ...new Set(
          profiles
            .filter((profile) => !profile.available)
            .map((profile) => profile.reason),
        ),
      ].map((reason) => [
        reason,
        profiles.filter((profile) => profile.reason === reason).length,
      ]),
    ),
  };
}

function waitWithTimeout(promise, timeoutMs, description) {
  return Promise.race([
    promise,
    wait(timeoutMs).then(() => {
      throw new Error(`${description} timed out after ${timeoutMs} ms`);
    }),
  ]);
}

async function runCacheRefreshProof({
  cacheBudgetMiB,
  config,
  page,
  target,
  glossarySupported,
  projectPathsSupported,
}) {
  const expectedPath =
    `/api/projects/${encodeURIComponent(target.detail.projectId)}` +
    `/sessions/${encodeURIComponent(target.detail.sessionId)}`;
  let interceptedUrl = null;
  let releaseRequest;
  let requestSeen;
  let requestContinued;
  const releasePromise = new Promise((resolve) => {
    releaseRequest = resolve;
  });
  const requestSeenPromise = new Promise((resolve) => {
    requestSeen = resolve;
  });
  const requestContinuedPromise = new Promise((resolve) => {
    requestContinued = resolve;
  });
  const routePattern = "**/api/projects/**/sessions/**";
  const handler = async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== expectedPath || interceptedUrl) {
      await route.continue();
      return;
    }
    interceptedUrl = url;
    requestSeen();
    await releasePromise;
    await route.continue();
    requestContinued();
  };
  await page.route(routePattern, handler);
  try {
    const started = performance.now();
    let milestones = null;
    let visibleBeforeRelease = false;
    await navigateSpa(page, target.url);
    await waitWithTimeout(
      requestSeenPromise,
      config.fixture.cacheProofTimeoutMs,
      "cache proof detail request",
    );
    if (cacheBudgetMiB > 0) {
      milestones = await waitForFinalDisplay(page, target, {
        glossarySupported,
        projectPathsSupported,
        started,
        timeoutMs: config.fixture.cacheProofTimeoutMs,
      });
      visibleBeforeRelease = true;
    } else {
      await wait(config.fixture.cacheDisabledObservationMs);
      visibleBeforeRelease = await page.evaluate(
        (marker) => document.body?.innerText.includes(marker) ?? false,
        target.marker,
      );
      if (visibleBeforeRelease) {
        throw new Error(
          "cache-disabled revisit rendered transcript before refresh release",
        );
      }
    }
    releaseRequest();
    await waitWithTimeout(
      requestContinuedPromise,
      config.server.requestTimeoutMs,
      "cache proof request release",
    );
    if (!milestones) {
      milestones = await waitForFinalDisplay(page, target, {
        glossarySupported,
        projectPathsSupported,
        started,
        timeoutMs: config.server.requestTimeoutMs,
      });
    }
    const requestHadCursor = interceptedUrl.searchParams.has("afterMessageId");
    if (cacheBudgetMiB > 0 && !requestHadCursor) {
      throw new Error(
        "cache-enabled revisit made a cursorless refresh request",
      );
    }
    if (cacheBudgetMiB === 0 && requestHadCursor) {
      throw new Error(
        "cache-disabled revisit unexpectedly sent a cache cursor",
      );
    }
    return {
      milestones,
      readableBeforeRefresh: visibleBeforeRelease,
      requestHadCursor,
      requestWasHeld: true,
    };
  } finally {
    releaseRequest();
    await page.unroute(routePattern, handler);
  }
}

async function measureBrowserMode({
  checkout,
  config,
  details,
  generalizedProjectPathsSupported,
  glossarySupported,
  repetition,
  scenario,
  server,
}) {
  const playwrightPath = path.join(
    checkout,
    "packages/client/node_modules/@playwright/test/index.mjs",
  );
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  const browser = await chromium.launch({
    args: ["--enable-precise-memory-info"],
    headless: true,
  });
  const budgets = scenario.browserCacheBudgetsMiB ?? [0, 24];
  const orderedBudgets = budgets.map(
    (_, index) => budgets[(index + repetition) % budgets.length],
  );
  const modes = [];
  const livePages = [];
  const detailsByProjectMap = new Map();
  for (const detail of details) {
    const projectDetails = detailsByProjectMap.get(detail.projectId) ?? [];
    projectDetails.push(detail);
    detailsByProjectMap.set(detail.projectId, projectDetails);
  }
  const detailsByProject = [...detailsByProjectMap.values()];
  const workingSets = Array.from(
    { length: scenario.concurrentClients },
    (_, pageIndex) => {
      const projectDetails =
        detailsByProject[pageIndex % detailsByProject.length];
      return Array.from(
        { length: config.fixture.workingSetSessions },
        (_, offset) =>
          projectDetails[(pageIndex + offset) % projectDetails.length],
      ).map((detail) =>
        sessionBrowserTarget(server, detail, scenario.initialTurns - 1),
      );
    },
  );

  try {
    for (const cacheBudgetMiB of orderedBudgets) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
      });
      await context.addInitScript(
        ({ budget }) => {
          localStorage.setItem("yep-anywhere-glossary-hints-enabled", "true");
          localStorage.setItem(
            "yep-anywhere-session-transcript-cache-enabled",
            String(budget > 0),
          );
          localStorage.setItem(
            "yep-anywhere-session-transcript-cache-budget-mb",
            String(budget),
          );
          localStorage.setItem(
            "yep-anywhere-developer-mode",
            JSON.stringify({ remoteLogCollectionEnabled: true }),
          );
          window.__yaPerfTelemetry = [];
          window.__yaPerfMarks = [];
          window.__yaPerfNavigationStartMs = 0;
          performance.setResourceTimingBufferSize(5000);
          window.__YA_RELOAD_PERF_PROBE__ = {
            mark(name, detail) {
              window.__yaPerfMarks.push({
                atMs: performance.now(),
                detail,
                name,
              });
            },
          };
          const originalFetch = window.fetch.bind(window);
          window.fetch = async (input, init) => {
            const url = typeof input === "string" ? input : input.url;
            if (
              url.includes("/client-logs") &&
              typeof init?.body === "string"
            ) {
              try {
                const payload = JSON.parse(init.body);
                for (const entry of payload.entries ?? []) {
                  if (entry.prefix !== "[ClientTelemetry]") continue;
                  const marker = "[ClientTelemetry] ";
                  const offset = entry.message.indexOf(marker);
                  if (offset >= 0) {
                    window.__yaPerfTelemetry.push(
                      JSON.parse(entry.message.slice(offset + marker.length)),
                    );
                  }
                }
              } catch {
                // The real request remains authoritative.
              }
            }
            return originalFetch(input, init);
          };
        },
        { budget: cacheBudgetMiB },
      );

      const pages = [];
      const coldMilestones = [];
      const coldProfiles = [];
      const warmMilestones = [];
      const warmProfiles = [];
      const warmCacheTelemetry = [];
      const cacheProofs = [];
      const appendTargets = [];
      for (let index = 0; index < scenario.concurrentClients; index += 1) {
        pages.push(await context.newPage());
      }

      await Promise.all(
        pages.map(async (page, index) => {
          const workingSet = workingSets[index];
          for (
            let targetIndex = 0;
            targetIndex < workingSet.length;
            targetIndex += 1
          ) {
            const target = workingSet[targetIndex];
            const started = performance.now();
            if (targetIndex === 0) {
              await page.goto(target.url, { waitUntil: "domcontentloaded" });
            } else {
              await navigateProfiledSpa(page, target.url);
            }
            const milestones = await waitForFinalDisplay(page, target, {
              glossarySupported,
              projectPathsSupported: generalizedProjectPathsSupported,
              started,
              timeoutMs: config.server.requestTimeoutMs,
            });
            coldMilestones.push(milestones);
            coldProfiles.push(
              await collectClientNavigationProfile(
                page,
                target,
                milestones,
                config.server.requestTimeoutMs,
              ),
            );
          }

          await navigateSpa(page, `${server.baseUrl}/projects`);
          await page.waitForFunction(
            () => !document.querySelector(".message-list"),
            undefined,
            { timeout: config.server.requestTimeoutMs },
          );
          const cacheTelemetry = await clientTelemetry(page);
          warmCacheTelemetry.push(cacheTelemetry);
          const expectedWarmEntries =
            cacheBudgetMiB === 0 ? 0 : workingSet.length;
          assertCount(
            cacheTelemetry.transcriptMemory.warmCacheEntryCount,
            expectedWarmEntries,
            `${cacheBudgetMiB} MiB browser working-set cache entries`,
          );
          if (cacheBudgetMiB === 0) {
            assertCount(
              cacheTelemetry.transcriptMemory.warmCacheBytes,
              0,
              "disabled browser transcript-cache warm bytes",
            );
          } else {
            if (cacheTelemetry.transcriptMemory.warmCacheBytes < 1) {
              throw new Error(
                `browser transcript cache ${cacheBudgetMiB} MiB retained no bytes`,
              );
            }
            if (
              cacheTelemetry.transcriptMemory.warmCacheBytes >
              cacheBudgetMiB * 1024 * 1024
            ) {
              throw new Error(
                `browser transcript cache exceeded ${cacheBudgetMiB} MiB budget`,
              );
            }
          }

          for (const target of workingSet) {
            const started = performance.now();
            await navigateProfiledSpa(page, target.url);
            const milestones = await waitForFinalDisplay(page, target, {
              glossarySupported,
              projectPathsSupported: generalizedProjectPathsSupported,
              started,
              timeoutMs: config.server.requestTimeoutMs,
            });
            warmMilestones.push(milestones);
            warmProfiles.push(
              await collectClientNavigationProfile(
                page,
                target,
                milestones,
                config.server.requestTimeoutMs,
              ),
            );
          }

          const proofTarget = workingSet[0];
          cacheProofs.push(
            await runCacheRefreshProof({
              cacheBudgetMiB,
              config,
              glossarySupported,
              page,
              projectPathsSupported: generalizedProjectPathsSupported,
              target: proofTarget,
            }),
          );
          appendTargets[index] = proofTarget;
        }),
      );

      const telemetryDeadline = performance.now() + 17_000;
      let yaTelemetry = [];
      while (performance.now() < telemetryDeadline) {
        yaTelemetry = (
          await Promise.all(
            pages.map((page) =>
              page.evaluate(() => window.__yaPerfTelemetry ?? []),
            ),
          )
        )
          .flat()
          .filter((entry) => entry.path?.includes("/sessions/"));
        if (yaTelemetry.length >= pages.length) break;
        await wait(250);
      }
      const directTelemetry = await Promise.all(pages.map(clientTelemetry));
      const milestoneSummary = (samples, field) =>
        summarize(
          samples
            .map((sample) => sample[field])
            .filter((value) => typeof value === "number"),
        );
      modes.push({
        cacheBudgetMiB,
        correctness: {
          cacheProofs,
          glossaryHintsRendered: glossarySupported,
          projectPathsRendered: generalizedProjectPathsSupported,
          workingSetSessions: config.fixture.workingSetSessions,
        },
        latency: {
          coldTail: milestoneSummary(coldMilestones, "readableTailMs"),
          coldGlossaryHighlight: milestoneSummary(
            coldMilestones,
            "glossaryHighlightMs",
          ),
          coldProjectPathHighlight: milestoneSummary(
            coldMilestones,
            "projectPathHighlightMs",
          ),
          coldFinalHighlight: milestoneSummary(
            coldMilestones,
            "finalHighlightMs",
          ),
          warmTail: milestoneSummary(warmMilestones, "readableTailMs"),
          warmGlossaryHighlight: milestoneSummary(
            warmMilestones,
            "glossaryHighlightMs",
          ),
          warmProjectPathHighlight: milestoneSummary(
            warmMilestones,
            "projectPathHighlightMs",
          ),
          warmFinalHighlight: milestoneSummary(
            warmMilestones,
            "finalHighlightMs",
          ),
        },
        profiles: {
          coldNavigation: summarizeClientNavigationProfiles(coldProfiles),
          warmNavigation: summarizeClientNavigationProfiles(warmProfiles),
        },
        telemetry: directTelemetry,
        warmCacheTelemetry,
        yaTelemetry,
        liveMilestones: [],
        liveProfiles: [],
      });
      livePages.push({
        appendTargets,
        context,
        mode: modes.at(-1),
        pages,
      });
    }

    return {
      modes,
      livePages,
      async prepareAppend() {
        await Promise.all(
          livePages.flatMap(({ pages }) =>
            pages.map((page) => prepareClientAppendProfile(page)),
          ),
        );
      },
      async observeAppend() {
        const started = performance.now();
        await Promise.all(
          livePages.flatMap(({ appendTargets, mode, pages }) =>
            pages.map(async (page, index) => {
              const target = sessionBrowserTarget(
                server,
                appendTargets[index].detail,
                scenario.initialTurns + scenario.newTurns - 1,
              );
              const milestones = await waitForFinalDisplay(page, target, {
                glossarySupported,
                projectPathsSupported: generalizedProjectPathsSupported,
                started,
                timeoutMs: config.server.requestTimeoutMs,
              });
              mode.liveMilestones.push(milestones);
              mode.liveProfiles.push(
                await collectClientAppendProfile(page, milestones),
              );
            }),
          ),
        );
        const milestoneSummary = (samples, field) =>
          summarize(
            samples
              .map((sample) => sample[field])
              .filter((value) => typeof value === "number"),
          );
        for (const mode of modes) {
          mode.latency.appendedLiveTail = milestoneSummary(
            mode.liveMilestones,
            "readableTailMs",
          );
          mode.latency.appendedLiveGlossaryHighlight = milestoneSummary(
            mode.liveMilestones,
            "glossaryHighlightMs",
          );
          mode.latency.appendedLiveProjectPathHighlight = milestoneSummary(
            mode.liveMilestones,
            "projectPathHighlightMs",
          );
          mode.latency.appendedLiveFinalHighlight = milestoneSummary(
            mode.liveMilestones,
            "finalHighlightMs",
          );
          mode.profiles.append = summarizeClientAppendProfiles(
            mode.liveProfiles,
          );
          delete mode.liveMilestones;
          delete mode.liveProfiles;
        }
      },
      async close() {
        await Promise.all(livePages.map(({ context }) => context.close()));
        await browser.close();
      },
    };
  } catch (error) {
    await Promise.all(livePages.map(({ context }) => context.close()));
    await browser.close();
    throw error;
  }
}

async function measureRepetition({
  checkout,
  config,
  driver,
  executionRevision,
  fixtureConfig,
  generalizedProjectPathsSupported,
  label,
  repetition,
  scenario,
  scenarioName,
  workRoot,
}) {
  const repetitionRoot = path.join(workRoot, `rep-${repetition}`);
  await mkdir(repetitionRoot, { recursive: true });
  const fixture = await createFixture(repetitionRoot, scenario, fixtureConfig);
  const port = await findPortPair(config.server.portBase + repetition * 3);
  const server = await startServer({
    checkout,
    driver,
    fixture,
    port,
    root: repetitionRoot,
    config,
  });
  let browserMeasurement = null;
  const agents = Array.from(
    { length: scenario.concurrentClients },
    () => new http.Agent({ keepAlive: true, maxSockets: 1 }),
  );
  const expectedSessions = scenario.projects * scenario.sessionsPerProject;
  const initialMessages = scenario.initialTurns * 2;
  const appendedMessages = (scenario.initialTurns + scenario.newTurns) * 2;

  try {
    await wait(scenario.settleMs);
    const startupMemory = await sampleMemory(
      server.inspectorUrl,
      server.maintenanceUrl,
      config.server.requestTimeoutMs,
    );

    const projectResponse = await requestJson(
      `${server.baseUrl}/api/projects`,
      {
        agent: agents[0],
        timeoutMs: config.server.requestTimeoutMs,
      },
    );
    const projects = bodyArray(
      projectResponse.body,
      "projects",
      "project list",
    );
    assertCount(projects.length, scenario.projects, "project count");

    const versionResponse = await requestJson(`${server.baseUrl}/api/version`, {
      agent: agents[0],
      timeoutMs: config.server.requestTimeoutMs,
    });
    const capabilities = Array.isArray(versionResponse.body?.capabilities)
      ? versionResponse.body.capabilities
      : [];
    const glossarySupported = capabilities.includes("glossary-tooltips");
    const glossaryBatch = glossarySupported
      ? await runClientBatch(
          agents,
          projects.map(
            (project) =>
              `${server.baseUrl}/api/projects/${encodeURIComponent(project.id)}/glossary-artifact`,
          ),
          config.server.requestTimeoutMs,
        )
      : {
          bodies: [],
          bytes: [],
          firstByteLatencies: [],
          latencies: [],
          readableTextLatencies: [],
        };
    glossaryBatch.bodies.forEach((body, index) => {
      if (
        body?.status !== "ready" ||
        !Array.isArray(body.artifact?.terminals)
      ) {
        throw new Error(`project ${projects[index].id} glossary was not ready`);
      }
      if (body.artifact.terminals.length === 0) {
        throw new Error(`project ${projects[index].id} glossary had no terms`);
      }
    });

    const sessionListUrls = projects.map(
      (project) =>
        `${server.baseUrl}/api/projects/${encodeURIComponent(project.id)}/sessions`,
    );
    const projectSessionBatch = await runClientBatch(
      agents,
      sessionListUrls,
      config.server.requestTimeoutMs,
    );
    const details = [];
    for (let index = 0; index < projects.length; index += 1) {
      const sessions = bodyArray(
        projectSessionBatch.bodies[index],
        "sessions",
        `project ${projects[index].id} session list`,
      );
      assertCount(
        sessions.length,
        scenario.sessionsPerProject,
        `project ${projects[index].id} session count`,
      );
      for (const session of sessions) {
        details.push({ projectId: projects[index].id, sessionId: session.id });
      }
    }
    assertCount(details.length, expectedSessions, "total session count");
    const warmProjectSessionBatch = await runClientBatch(
      agents,
      sessionListUrls,
      config.server.requestTimeoutMs,
    );
    warmProjectSessionBatch.bodies.forEach((body, index) => {
      assertCount(
        bodyArray(
          body,
          "sessions",
          `warm project ${projects[index].id} session list`,
        ).length,
        scenario.sessionsPerProject,
        `warm project ${projects[index].id} session count`,
      );
    });

    const collectionHerd = await runHerd(
      agents,
      [
        `${server.baseUrl}/api/sessions?limit=100`,
        `${server.baseUrl}/api/inbox`,
      ],
      config.server.requestTimeoutMs,
    );
    let globalCollectionResponses = 0;
    let inboxResponses = 0;
    for (const body of collectionHerd.bodies) {
      if (Array.isArray(body?.sessions)) {
        globalCollectionResponses += 1;
        assertCount(
          body.sessions.length,
          expectedSessions,
          "collection session count",
        );
        continue;
      }
      inboxResponses += 1;
      for (const tier of [
        "needsAttention",
        "active",
        "recentActivity",
        "unread8h",
        "unread24h",
      ]) {
        bodyArray(body, tier, "Inbox collection herd");
      }
    }
    assertCount(
      globalCollectionResponses,
      scenario.concurrentClients,
      "global collection response count",
    );
    assertCount(
      inboxResponses,
      scenario.concurrentClients,
      "Inbox response count",
    );
    const collectionMemory = await sampleMemory(
      server.inspectorUrl,
      server.maintenanceUrl,
      config.server.requestTimeoutMs,
    );

    if (driver === "browser") {
      browserMeasurement = await measureBrowserMode({
        checkout,
        config,
        details,
        generalizedProjectPathsSupported,
        glossarySupported,
        repetition,
        scenario,
        server,
      });
    }
    const browserLoadedMemory = browserMeasurement
      ? await sampleMemory(
          server.inspectorUrl,
          server.maintenanceUrl,
          config.server.requestTimeoutMs,
        )
      : null;

    const detailTargets = details.map(({ projectId, sessionId }) => ({
      url:
        `${server.baseUrl}/api/projects/${encodeURIComponent(projectId)}` +
        `/sessions/${encodeURIComponent(sessionId)}?fullHistory=1&fullHistoryReason=performance-survey`,
      needle: `[${sessionId}:assistant:${scenario.initialTurns - 1}]`,
    }));
    const coldDetails = await runClientBatch(
      agents,
      detailTargets,
      config.server.requestTimeoutMs,
    );
    coldDetails.bodies.forEach((body, index) => {
      assertCount(
        bodyArray(body, "messages", `cold detail ${index}`).length,
        initialMessages,
        `cold detail ${index} message count`,
      );
    });
    if (
      !coldDetails.bodies.some((body) =>
        JSON.stringify(body).includes("README.md"),
      )
    ) {
      throw new Error("session detail omitted the project-file link fixture");
    }

    const warmDetails = await runHerd(
      agents,
      detailTargets,
      config.server.requestTimeoutMs,
    );
    for (let index = 0; index < warmDetails.bodies.length; index += 1) {
      assertCount(
        bodyArray(warmDetails.bodies[index], "messages", `warm detail ${index}`)
          .length,
        initialMessages,
        `warm detail ${index} message count`,
      );
    }
    const detailMemory = await sampleMemory(
      server.inspectorUrl,
      server.maintenanceUrl,
      config.server.requestTimeoutMs,
    );

    const preparedAppends = prepareAppendedTurns(fixture, scenario);
    await browserMeasurement?.prepareAppend();
    const browserAppendObservation = browserMeasurement?.observeAppend();
    await appendTurns(preparedAppends);
    await browserAppendObservation;
    await wait(config.server.appendObservationMs);
    const appendedDetailTargets = detailTargets.map((target, index) => ({
      ...target,
      needle:
        `[${details[index].sessionId}:assistant:` +
        `${scenario.initialTurns + scenario.newTurns - 1}]`,
    }));
    const appendedDetails = await runHerd(
      agents,
      appendedDetailTargets,
      config.server.requestTimeoutMs,
    );
    for (let index = 0; index < appendedDetails.bodies.length; index += 1) {
      assertCount(
        bodyArray(
          appendedDetails.bodies[index],
          "messages",
          `appended detail ${index}`,
        ).length,
        appendedMessages,
        `appended detail ${index} message count`,
      );
    }
    const appendedMemory = await sampleMemory(
      server.inspectorUrl,
      server.maintenanceUrl,
      config.server.requestTimeoutMs,
    );

    await wait(scenario.settleMs);
    const settledMemory = await sampleMemory(
      server.inspectorUrl,
      server.maintenanceUrl,
      config.server.requestTimeoutMs,
    );
    const retainedHeapBytes =
      settledMemory.heapUsedBytes - startupMemory.heapUsedBytes;
    const retainedRssBytes = settledMemory.rssBytes - startupMemory.rssBytes;
    const totalTurns =
      expectedSessions * (scenario.initialTurns + scenario.newTurns);

    return {
      schemaVersion: 2,
      suiteVersion: SUITE_VERSION,
      identity: {
        executionRevision,
        fixtureRevision: fixture.fixtureRevision,
      },
      label,
      repetition,
      scenario: scenarioName,
      parameters: scenario,
      host: {
        hostname: os.hostname(),
        loadAverage: os.loadavg().map((value) => round(value)),
        logicalCpus: os.cpus().length,
        platform: `${os.platform()} ${os.release()}`,
      },
      runtime: {
        driver,
        node: process.version,
        serverStartupMs: round(server.startupMs),
        serverLog: server.logPath,
      },
      correctness: {
        projects: projects.length,
        sessions: details.length,
        initialMessagesPerSession: initialMessages,
        appendedMessagesPerSession: appendedMessages,
        glossarySupported,
        glossaryArtifacts: glossaryBatch.bodies.length,
        generalizedProjectPathsSupported,
        projectFileLinkNeedle: "README.md",
        fixtureRevision: fixture.fixtureRevision,
      },
      latency: {
        version: summarize([versionResponse.ms]),
        projectList: summarize([projectResponse.ms]),
        glossaryArtifacts: summarize(glossaryBatch.latencies),
        projectSessions: summarize(projectSessionBatch.latencies),
        projectSessionsWarm: summarize(warmProjectSessionBatch.latencies),
        collectionHerd: summarize(collectionHerd.latencies),
        detailCold: summarize(coldDetails.latencies),
        detailColdFirstByte: summarize(coldDetails.firstByteLatencies),
        detailColdTailText: summarize(coldDetails.readableTextLatencies),
        detailWarmHerd: summarize(warmDetails.latencies),
        detailWarmHerdFirstByte: summarize(warmDetails.firstByteLatencies),
        detailWarmHerdTailText: summarize(warmDetails.readableTextLatencies),
        detailAppendedHerd: summarize(appendedDetails.latencies),
        detailAppendedHerdFirstByte: summarize(
          appendedDetails.firstByteLatencies,
        ),
        detailAppendedHerdTailText: summarize(
          appendedDetails.readableTextLatencies,
        ),
      },
      profiles: {
        serverDetail: {
          cold: summarizeRequestProfiles(coldDetails.profiles),
          warm: summarizeRequestProfiles(warmDetails.profiles),
          appended: summarizeRequestProfiles(appendedDetails.profiles),
        },
      },
      browser: browserMeasurement
        ? {
            modes: browserMeasurement.modes,
          }
        : null,
      responseMiB: {
        collectionHerd: bytesToMiB(
          collectionHerd.bytes.reduce((sum, value) => sum + value, 0),
        ),
        detailCold: bytesToMiB(
          coldDetails.bytes.reduce((sum, value) => sum + value, 0),
        ),
        detailWarmHerd: bytesToMiB(
          warmDetails.bytes.reduce((sum, value) => sum + value, 0),
        ),
        detailAppendedHerd: bytesToMiB(
          appendedDetails.bytes.reduce((sum, value) => sum + value, 0),
        ),
      },
      memory: {
        startup: memoryView(startupMemory),
        collection: memoryView(collectionMemory),
        browserLoaded: browserLoadedMemory
          ? memoryView(browserLoadedMemory)
          : null,
        detail: memoryView(detailMemory),
        appended: memoryView(appendedMemory),
        settled: memoryView(settledMemory),
        retainedHeapMiB: bytesToMiB(retainedHeapBytes),
        retainedRssMiB: bytesToMiB(retainedRssBytes),
        retainedHeapKiBPerProject: bytesToKiB(
          retainedHeapBytes / scenario.projects,
        ),
        retainedHeapKiBPerSession: bytesToKiB(
          retainedHeapBytes / expectedSessions,
        ),
        retainedHeapKiBPerTurn: bytesToKiB(retainedHeapBytes / totalTurns),
        retainedHeapKiBPerClient: bytesToKiB(
          retainedHeapBytes / scenario.concurrentClients,
        ),
      },
    };
  } finally {
    await browserMeasurement?.close();
    for (const agent of agents) agent.destroy();
    server.log.end();
    await stopServer(server.child);
  }
}

function getMetric(value, dottedPath) {
  return dottedPath.split(".").reduce((current, key) => current?.[key], value);
}

function aggregateRuns(runs) {
  const paths = [
    "runtime.serverStartupMs",
    "latency.glossaryArtifacts.p95Ms",
    "latency.projectSessions.p95Ms",
    "latency.projectSessionsWarm.p95Ms",
    "latency.collectionHerd.p95Ms",
    "latency.detailCold.p95Ms",
    "latency.detailColdFirstByte.p95Ms",
    "latency.detailColdTailText.p95Ms",
    "latency.detailWarmHerd.p95Ms",
    "latency.detailWarmHerdFirstByte.p95Ms",
    "latency.detailWarmHerdTailText.p95Ms",
    "latency.detailAppendedHerd.p95Ms",
    "latency.detailAppendedHerdFirstByte.p95Ms",
    "latency.detailAppendedHerdTailText.p95Ms",
    "memory.settled.heapUsedMiB",
    "memory.settled.rssMiB",
    "memory.retainedHeapMiB",
    "memory.retainedRssMiB",
    "memory.retainedHeapKiBPerProject",
    "memory.retainedHeapKiBPerSession",
    "memory.retainedHeapKiBPerTurn",
    "memory.retainedHeapKiBPerClient",
    "memory.settled.knownCaches.claudeTranscript.retainedSourceBytes",
    "memory.settled.knownCaches.claudeTranscript.retainedFiles",
    "memory.settled.knownCaches.projectPaths.retainedBytes",
    "memory.settled.knownCaches.projectPaths.projects",
    "memory.settled.knownCaches.projectPaths.watchers",
    "memory.settled.residuals.heapUsedLessKnownCacheSourceMiB",
    "memory.settled.v8.heapSpaces.old_space.usedBytes",
    "memory.settled.v8.heapSpaces.large_object_space.usedBytes",
    ...["cold", "warm", "appended"].flatMap((kind) => [
      `profiles.serverDetail.${kind}.server.project.p95Ms`,
      `profiles.serverDetail.${kind}.server.read.p95Ms`,
      `profiles.serverDetail.${kind}.server.normalize.p95Ms`,
      `profiles.serverDetail.${kind}.server.route.p95Ms`,
      `profiles.serverDetail.${kind}.server.augment.p95Ms`,
      `profiles.serverDetail.${kind}.server.total.p95Ms`,
      `profiles.serverDetail.${kind}.server.residual.p95Ms`,
      `profiles.serverDetail.${kind}.frameworkSerializeLoopback.p95Ms`,
      `profiles.serverDetail.${kind}.bodyTransfer.p95Ms`,
      `profiles.serverDetail.${kind}.jsonParse.p95Ms`,
    ]),
  ];
  return Object.fromEntries(
    paths.flatMap((metricPath) => {
      const profileKind = metricPath.match(
        /^profiles\.serverDetail\.(cold|warm|appended)\./,
      )?.[1];
      if (
        profileKind &&
        runs.every(
          (run) =>
            getMetric(
              run,
              `profiles.serverDetail.${profileKind}.availableCount`,
            ) === 0,
        )
      ) {
        return [];
      }
      const values = runs
        .map((run) => getMetric(run, metricPath))
        .filter((value) => typeof value === "number" && Number.isFinite(value));
      return values.length > 0
        ? [[metricPath, round(percentile(values, 0.5))]]
        : [];
    }),
  );
}

function aggregateBrowserRuns(runs) {
  const budgets = [
    ...new Set(
      runs.flatMap((run) =>
        (run.browser?.modes ?? []).map((mode) => mode.cacheBudgetMiB),
      ),
    ),
  ].sort((left, right) => left - right);
  return Object.fromEntries(
    budgets.map((cacheBudgetMiB) => {
      const modes = runs.map((run) =>
        run.browser?.modes.find(
          (mode) => mode.cacheBudgetMiB === cacheBudgetMiB,
        ),
      );
      if (modes.some((mode) => !mode)) {
        throw new Error(`Missing browser cache mode ${cacheBudgetMiB} MiB`);
      }
      const pageTelemetry = modes.flatMap((mode) => mode.telemetry);
      const cacheTelemetry = modes.flatMap((mode) => mode.warmCacheTelemetry);
      const clientProfileMetrics = {};
      for (const kind of ["coldNavigation", "warmNavigation", "append"]) {
        for (const group of [
          "nonOverlappingPhases",
          "messageListWithinQueuedToCommit",
        ]) {
          const names = [
            ...new Set(
              modes.flatMap((mode) =>
                Object.keys(mode.profiles?.[kind]?.[group] ?? {}),
              ),
            ),
          ];
          for (const name of names) {
            const values = modes
              .map((mode) => mode.profiles?.[kind]?.[group]?.[name]?.p95Ms)
              .filter((value) => typeof value === "number");
            if (values.length === 0) continue;
            clientProfileMetrics[`profiles.${kind}.${group}.${name}.p95Ms`] =
              round(percentile(values, 0.5));
          }
        }
      }
      return [
        String(cacheBudgetMiB),
        {
          ...clientProfileMetrics,
          "latency.coldTail.p95Ms": round(
            percentile(
              modes.map((mode) => mode.latency.coldTail.p95Ms),
              0.5,
            ),
          ),
          "latency.warmTail.p95Ms": round(
            percentile(
              modes.map((mode) => mode.latency.warmTail.p95Ms),
              0.5,
            ),
          ),
          "latency.appendedLiveTail.p95Ms": round(
            percentile(
              modes.map((mode) => mode.latency.appendedLiveTail.p95Ms),
              0.5,
            ),
          ),
          "latency.coldFinalHighlight.p95Ms": round(
            percentile(
              modes.map((mode) => mode.latency.coldFinalHighlight.p95Ms),
              0.5,
            ),
          ),
          "latency.warmFinalHighlight.p95Ms": round(
            percentile(
              modes.map((mode) => mode.latency.warmFinalHighlight.p95Ms),
              0.5,
            ),
          ),
          "latency.appendedLiveFinalHighlight.p95Ms": round(
            percentile(
              modes.map(
                (mode) => mode.latency.appendedLiveFinalHighlight.p95Ms,
              ),
              0.5,
            ),
          ),
          "memory.maxUsedJSHeapMiB": round(
            Math.max(
              ...pageTelemetry.map((entry) => entry.memory?.usedJSHeapMiB ?? 0),
            ),
          ),
          "memory.maxJSHeapLessTranscriptApproxMiB": round(
            Math.max(
              ...pageTelemetry.map((entry) =>
                entry.memory
                  ? entry.memory.usedJSHeapMiB -
                    entry.transcriptMemory.totalBytes / (1024 * 1024)
                  : 0,
              ),
            ),
          ),
          "transcriptCache.maxWarmBytes": Math.max(
            ...cacheTelemetry.map(
              (entry) => entry.transcriptMemory.warmCacheBytes,
            ),
            0,
          ),
          "transcriptCache.maxWarmEntries": Math.max(
            ...cacheTelemetry.map(
              (entry) => entry.transcriptMemory.warmCacheEntryCount,
            ),
            0,
          ),
          "transcriptCache.maxLiveBytes": Math.max(
            ...pageTelemetry.map(
              (entry) => entry.transcriptMemory.liveRetainedBytes,
            ),
            0,
          ),
          "transcriptCache.maxLiveEntries": Math.max(
            ...pageTelemetry.map(
              (entry) => entry.transcriptMemory.liveRetainedEntryCount,
            ),
            0,
          ),
          "dom.maxNodes": Math.max(
            ...pageTelemetry.map((entry) => entry.dom.nodes),
          ),
          "dom.maxMessageRows": Math.max(
            ...pageTelemetry.map((entry) => entry.dom.messageRows),
          ),
        },
      ];
    }),
  );
}

function evaluateMetricTargets(aggregate, targets, universe) {
  const checks = [];
  for (const [metricPath, target] of Object.entries(targets ?? {})) {
    const actual = aggregate?.[metricPath];
    if (typeof actual !== "number") {
      throw new Error(
        `Ratchet metric is not aggregated in ${universe}: ${metricPath}`,
      );
    }
    if (typeof target.max !== "number") {
      throw new Error(`Ratchet ${universe}.${metricPath} requires numeric max`);
    }
    checks.push({
      universe,
      metric: metricPath,
      actual,
      max: target.max,
      pass: actual <= target.max,
      rationale: target.rationale ?? null,
    });
  }
  return checks;
}

function evaluateRatchets(serverAggregate, browserAggregate, targets) {
  const checks = evaluateMetricTargets(
    serverAggregate,
    targets?.server,
    "server",
  );
  for (const [cacheBudgetMiB, browserTargets] of Object.entries(
    targets?.browser ?? {},
  )) {
    checks.push(
      ...evaluateMetricTargets(
        browserAggregate?.[cacheBudgetMiB],
        browserTargets,
        `browser.cache-${cacheBudgetMiB}-MiB`,
      ),
    );
  }
  return { checks, pass: checks.every((check) => check.pass) };
}

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
  if (fixtureConfig.workingSetSessions > scenario.sessionsPerProject) {
    throw new Error(
      "fixture.workingSetSessions must not exceed sessionsPerProject",
    );
  }
  const ratchets = await readJson(options.ratchets).catch((error) => {
    if (error.code === "ENOENT") return { schemaVersion: 1, scenarios: {} };
    throw error;
  });
  if (ratchets.schemaVersion !== 1)
    throw new Error("Unsupported ratchet schemaVersion");

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

  const runs = [];
  try {
    for (
      let repetition = 0;
      repetition < scenario.repetitions;
      repetition += 1
    ) {
      console.log(
        `${options.label}/${options.scenario}: repetition ${repetition + 1}/${scenario.repetitions}`,
      );
      const run = await measureRepetition({
        checkout,
        config,
        driver: options.driver,
        executionRevision: revision,
        fixtureConfig,
        generalizedProjectPathsSupported,
        label: options.label,
        repetition,
        scenario,
        scenarioName: options.scenario,
        workRoot,
      });
      run.revision = revision;
      runs.push(run);
      console.log(
        `  heap ${run.memory.settled.heapUsedMiB} MiB ` +
          `(retained ${run.memory.retainedHeapMiB} MiB); ` +
          `append p95 ${run.latency.detailAppendedHerd.p95Ms} ms`,
      );
    }

    const aggregate = aggregateRuns(runs);
    const browserAggregate =
      options.driver === "browser" ? aggregateBrowserRuns(runs) : null;
    const ratchet = evaluateRatchets(
      aggregate,
      browserAggregate,
      ratchets.drivers?.[options.driver]?.scenarios?.[options.scenario],
    );
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
      aggregate,
      browserAggregate,
      ratchet,
      runs,
    };
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`wrote ${output}`);
    for (const check of ratchet.checks) {
      console.log(
        `${check.pass ? "PASS" : "FAIL"} ${check.universe}.` +
          `${check.metric}: ${check.actual} <= ${check.max}`,
      );
    }
    if (!ratchet.pass) process.exitCode = 1;
  } finally {
    if (!config.keepWorkDirectories) {
      await rm(workRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
