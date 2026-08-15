import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  PERF_RUN_MARKER_PREFIX,
  bodyArray,
  encodeProjectPath,
  percentile,
  round,
  transcriptRows,
} from "./core.mjs";

const requireServerDependency = createRequire(
  new URL("../../packages/server/package.json", import.meta.url),
);
const { WebSocket: InspectorWebSocket, WebSocketServer } =
  requireServerDependency("ws");
const { version: INSPECTOR_WEBSOCKET_VERSION } =
  requireServerDependency("ws/package.json");
const HARNESS_SOURCE_URLS = [
  "aggregation.mjs",
  "browser-driver.mjs",
  "browser-memory.mjs",
  "built-client-driver.mjs",
  "core.mjs",
  "host-profile.mjs",
  "process-fixture.mjs",
  "ratchet-evaluation.mjs",
  "ratchet-targets.mjs",
  "request-clients.mjs",
  "run.mjs",
  "server-driver.mjs",
  "simulated-provider-worker.mjs",
  "specialized-driver.mjs",
  "telemetry.mjs",
].map((name) => new URL(name, import.meta.url));
const REQUIRED_FIXTURE_PATHS = [
  "GLOSSARY.md",
  "README.md",
  "topics/glossary-tooltips.md",
  "packages/server/src/augments/project-path-links.ts",
];
let activePerfRunMarker = null;

export function setActivePerfRunMarker(marker) {
  activePerfRunMarker = marker;
}

export async function runProcess(command, args, { cwd }) {
  const child = spawn(command, args, {
    cwd,
    env: activePerfRunMarker
      ? { ...process.env, PERF_RUN_ID: activePerfRunMarker }
      : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  const output = Buffer.concat(stdout).toString("utf8").trim();
  if (code !== 0) {
    const errorOutput = [output, Buffer.concat(stderr).toString("utf8").trim()]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `${command} ${args.join(" ")} exited ${code}: ${errorOutput}`,
    );
  }
  return output;
}

export function perfSweepExecutable() {
  return process.env.YA_PERF_SWEEP || "perf-sweep";
}

export async function runPerfSweep(marker, { kill = false } = {}) {
  const args = [marker];
  if (kill) args.push("--kill", "--kill-group");
  const executable = perfSweepExecutable();
  const child = spawn(executable, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const outcome = await new Promise((resolve, reject) => {
    child.once("error", (error) => reject(error));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(
        `${executable} is required; install perf-sweep or set YA_PERF_SWEEP`,
      );
    }
    throw error;
  });
  return {
    ...outcome,
    command: [executable, ...args],
    stdout: Buffer.concat(stdout).toString("utf8").trim(),
    stderr: Buffer.concat(stderr).toString("utf8").trim(),
  };
}

export function reportSweep(stage, result) {
  for (const output of [result.stdout, result.stderr]) {
    if (output)
      console.log(`${stage}: ${output.replaceAll("\n", `\n${stage}: `)}`);
  }
}

export function validateSweepExit(result, stage) {
  if (![0, 10, 11].includes(result.code) || result.signal) {
    throw new Error(
      `${stage}: perf-sweep exited ${result.code ?? result.signal}`,
    );
  }
}

export async function requireCleanPerfHost() {
  const result = await runPerfSweep(PERF_RUN_MARKER_PREFIX);
  reportSweep("SWEEP-PREFLIGHT", result);
  validateSweepExit(result, "SWEEP-PREFLIGHT");
  if (result.code !== 0) {
    throw new Error(
      "Another YA perf run or its debris is present; inspect it before measuring",
    );
  }
}

export async function reapPerfRun(marker, stage) {
  const initial = await runPerfSweep(marker, { kill: true });
  reportSweep(stage, initial);
  validateSweepExit(initial, stage);
  const verification = await runPerfSweep(marker);
  reportSweep(`${stage}-VERIFY`, verification);
  validateSweepExit(verification, `${stage}-VERIFY`);
  if (verification.code !== 0) {
    throw new Error(`${stage}: marked processes survived cleanup`);
  }
  return {
    marker,
    debrisFound: initial.code !== 0,
    initialExitCode: initial.code,
    pass: initial.code === 0 && verification.code === 0,
    verifiedClean: verification.code === 0,
  };
}

export function installSignalSweep(marker) {
  let handling = false;
  const handlers = new Map();
  for (const [signal, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    const handler = () => {
      if (handling) return;
      handling = true;
      const result = spawnSync(
        perfSweepExecutable(),
        [marker, "--kill", "--kill-group"],
        { encoding: "utf8" },
      );
      for (const output of [result.stdout, result.stderr]) {
        if (output?.trim()) process.stderr.write(`${output.trim()}\n`);
      }
      process.exit(exitCode);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  };
}

export async function createFixture(root, scenario, fixtureConfig) {
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

export function prepareAppendedTurns(fixture, scenario) {
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

export async function appendTurns(appends) {
  await Promise.all(
    appends.map(({ content, file }) => appendFile(file, content)),
  );
}

export async function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

export async function findPortPair(start) {
  for (let port = start; port < start + 500; port += 3) {
    if ((await canBind(port)) && (await canBind(port + 1))) return port;
  }
  throw new Error(`No free port pair starting at ${start}`);
}

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function requestJson(
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
                "X-Yep-Anywhere": "true",
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

export async function waitForJson(
  url,
  predicate,
  { description, timeoutMs, pollMs = 25 },
) {
  const deadline = performance.now() + timeoutMs;
  let lastBody = null;
  let lastError = null;
  while (performance.now() < deadline) {
    try {
      const response = await requestJson(url, {
        timeoutMs: Math.min(1_000, timeoutMs),
      });
      lastBody = response.body;
      if (predicate(response.body)) return response;
    } catch (error) {
      lastError = error;
    }
    await wait(pollMs);
  }
  throw new Error(
    `${description} timed out` +
      (lastError
        ? `: ${lastError.message}`
        : `; last response ${JSON.stringify(lastBody)}`),
  );
}

export async function startPerfRelay() {
  const sockets = new Set();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (
        message.type === "server_register" ||
        message.type === "server_register_channel"
      ) {
        socket.send(JSON.stringify({ type: "server_registered" }));
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("performance relay did not acquire a TCP port");
  }
  return {
    url: `ws://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function connectEventSocket(baseUrl, timeoutMs) {
  const url = new URL(baseUrl);
  url.protocol = "ws:";
  url.pathname = "/api/ws";
  url.search = "";
  const socket = new InspectorWebSocket(url);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("performance event WebSocket timed out"));
    }, timeoutMs);
    socket.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  return socket;
}

export async function waitForRecordedEvent(
  events,
  predicate,
  { description, timeoutMs },
) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const event = events.find(predicate);
    if (event) return event;
    await wait(10);
  }
  throw new Error(`${description} timed out after ${timeoutMs} ms`);
}

export async function waitForReady({
  baseUrl,
  maintenanceUrl,
  timeoutMs,
  child,
}) {
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
      const projectResponse = await requestJson(`${baseUrl}/api/projects`, {
        timeoutMs: 5_000,
      });
      return {
        projectResponse,
        startupMs: performance.now() - started,
      };
    } catch (error) {
      lastError = error;
      await wait(100);
    }
  }
  throw new Error(
    `Server readiness timed out: ${lastError?.message ?? "unknown"}`,
  );
}

export async function openInspector(maintenanceUrl, timeoutMs, port) {
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

export async function collectGarbage(inspectorUrl, timeoutMs) {
  await new Promise((resolve, reject) => {
    const socket = new InspectorWebSocket(inspectorUrl);
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

export async function sampleMemory(inspectorUrl, maintenanceUrl, timeoutMs) {
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

export function gitRevision(checkout) {
  return runProcess("git", ["rev-parse", "HEAD"], { cwd: checkout });
}

export async function prepareBuiltClientCheckout(checkout, executionRevision) {
  const marker =
    `${PERF_RUN_MARKER_PREFIX}build-${process.pid}-${Date.now()}-` +
    executionRevision.slice(0, 8);
  const previousMarker = activePerfRunMarker;
  activePerfRunMarker = marker;
  const removeSignalSweep = installSignalSweep(marker);
  const started = performance.now();
  let cleanup = null;
  try {
    await runProcess("pnpm", ["run", "build"], { cwd: checkout });
    const requiredAssets = [
      path.join(checkout, "packages/server/dist/index.js"),
      path.join(checkout, "packages/client/dist/index.html"),
    ];
    for (const asset of requiredAssets) {
      const assetStats = await stat(asset).catch(() => null);
      if (!assetStats?.isFile()) {
        throw new Error(`built-client preparation lacks ${asset}`);
      }
    }
    cleanup = await reapPerfRun(marker, "SWEEP-BUILD");
    if (!cleanup.pass) {
      throw new Error("built-client preparation left marked process debris");
    }
    return {
      command: ["pnpm", "run", "build"],
      elapsedMs: round(performance.now() - started),
      excludedFromMeasurement: true,
      executionRevision,
      cleanup,
    };
  } finally {
    if (!cleanup) {
      await reapPerfRun(marker, "SWEEP-BUILD-EMERGENCY");
    }
    removeSignalSweep();
    activePerfRunMarker = previousMarker;
  }
}

export function absoluteFilePath(file) {
  return file instanceof URL ? fileURLToPath(file) : path.resolve(file);
}

export function repositoryRelativePath(repository, file) {
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

export function harnessSourceFiles() {
  return HARNESS_SOURCE_URLS.map(fileURLToPath);
}

export async function harnessIdentity(repository, options, config, ratchets) {
  const sourceFiles = harnessSourceFiles();
  const repositoryPaths = [...sourceFiles, options.config, options.ratchets]
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
  for (const file of sourceFiles) {
    content.update(`\0source:${path.basename(file)}\0`);
    content.update(await readFile(file));
  }
  content.update("\0inspector-websocket-version\0");
  content.update(INSPECTOR_WEBSOCKET_VERSION);
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

export async function gitIsAncestor(checkout, ancestor, descendant) {
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

export async function startServer({
  checkout,
  driver,
  envOverrides = {},
  fixture,
  port,
  root,
  config,
  runMarker,
}) {
  const isDevBrowser = driver === "browser";
  const isBuiltClient = driver === "built-client";
  const usesDevWrapper = isDevBrowser || driver === "specialized";
  const logPath = path.join(root, "server.log");
  const log = createWriteStream(logPath, { flags: "a" });
  const dataDir = path.join(root, "data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(dataDir, "install.json"),
    `${JSON.stringify(
      {
        version: 2,
        installId: "00000000-0000-4000-8000-000000000001",
        createdAt: "2026-01-01T00:00:00.000Z",
        catalogFamilies: config.fixture.providerCatalogFamilies,
        catalogMetadataMigrationComplete: true,
      },
      null,
      2,
    )}\n`,
  );
  const env = {
    ...process.env,
    AUTH_DISABLED: "true",
    CLAUDE_CONFIG_DIR: fixture.configDir,
    CLAUDE_SESSIONS_DIR: path.join(fixture.configDir, "projects"),
    CODEX_SESSIONS_DIR: path.join(root, "empty-codex"),
    ENABLED_PROVIDERS:
      isDevBrowser || isBuiltClient ? "perf-fixture-none" : "claude",
    GEMINI_SESSIONS_DIR: path.join(root, "empty-gemini"),
    GROK_SESSIONS_DIR: path.join(root, "empty-grok"),
    LOG_LEVEL: "error",
    LOG_TO_FILE: "false",
    MAINTENANCE_PORT: String(port + 1),
    NO_BACKEND_RELOAD: "true",
    PI_SESSIONS_DIR: path.join(root, "empty-pi"),
    PORT: String(port),
    PERF_RUN_ID: runMarker,
    VITE_PORT: String(port + 2),
    VOICE_INPUT: "false",
    USE_MOCK_SDK: "true",
    YEP_DATA_DIR: dataDir,
    YEP_PROFILE: `perf-${process.pid}`,
    ...(isBuiltClient
      ? {
          CLIENT_DIST_PATH: path.join(checkout, "packages/client/dist"),
          NODE_ENV: "production",
        }
      : {}),
    ...envOverrides,
  };
  const processStartedAtMs = performance.now();
  const child = spawn(
    isBuiltClient ? process.execPath : "pnpm",
    isBuiltClient
      ? [
          path.join(checkout, "packages/server/dist/index.js"),
          "--perf-run-id",
          runMarker,
        ]
      : usesDevWrapper
        ? [
            "--dir",
            ".",
            "run",
            "dev",
            "--no-frontend-reload",
            "--perf-run-id",
            runMarker,
          ]
        : [
            "--dir",
            "packages/server",
            "run",
            "dev",
            "--perf-run-id",
            runMarker,
          ],
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
    const processManifestPath = path.join(root, "process-manifest.jsonl");
    await appendFile(
      processManifestPath,
      `${JSON.stringify({
        recordedAt: new Date().toISOString(),
        role: usesDevWrapper
          ? "YA dev server"
          : isBuiltClient
            ? "YA production server"
            : "YA server",
        pid: child.pid,
        pgid: child.pid,
        ports: [port, port + 1, ...(usesDevWrapper ? [port + 2] : [])],
        marker: runMarker,
      })}\n`,
    );
    const readiness = await waitForReady({
      baseUrl,
      maintenanceUrl,
      timeoutMs: config.server.startupTimeoutMs,
      child,
    });
    let inspectorUrl = null;
    if (!isBuiltClient) {
      const inspectorPort = await findPortPair(port + 1_000);
      inspectorUrl = await openInspector(
        maintenanceUrl,
        config.server.requestTimeoutMs,
        inspectorPort,
      );
    }
    return {
      baseUrl,
      child,
      inspectorUrl,
      log,
      logPath,
      maintenanceUrl,
      processStartedAtMs,
      processManifestPath,
      readyProjects: bodyArray(
        readiness.projectResponse.body,
        "projects",
        "readiness project list",
      ),
      startupMs: readiness.startupMs,
    };
  } catch (error) {
    log.end();
    await stopServer(child);
    const output = await readFile(logPath, "utf8").catch(() => "");
    throw new Error(`${error.message}\n${output.slice(-4_000)}`);
  }
}

export async function stopServer(child) {
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

export async function readProcessManifest(file) {
  const contents = await readFile(file, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
