#!/usr/bin/env node

import { spawn } from "node:child_process";
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
import { pathToFileURL } from "node:url";

const SUITE_VERSION = 1;
const DEFAULT_CONFIG_PATH = new URL("./config.json", import.meta.url);
const DEFAULT_RATCHETS_PATH = new URL("./ratchets.json", import.meta.url);

function parseArgs(argv) {
  const options = {
    checkout: null,
    config: DEFAULT_CONFIG_PATH,
    driver: "server",
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
          "[--label LABEL] [--config FILE] [--ratchets FILE] [--output FILE]",
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
  const prefix = `[${seed}] PerfTerm README.md `;
  if (bytes <= prefix.length) return prefix.slice(0, bytes);
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

async function createFixture(root, scenario) {
  const configDir = path.join(root, "claude");
  const sourceRoot = path.join(root, "projects");
  const sessionFiles = [];
  await mkdir(path.join(configDir, "projects"), { recursive: true });
  await mkdir(sourceRoot, { recursive: true });

  for (
    let projectIndex = 0;
    projectIndex < scenario.projects;
    projectIndex += 1
  ) {
    const projectPath = path.join(sourceRoot, `project-${projectIndex}`);
    const sessionDir = path.join(
      configDir,
      "projects",
      encodeProjectPath(projectPath),
    );
    await mkdir(projectPath, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(projectPath, "README.md"),
      `project ${projectIndex}\n`,
    );
    await writeFile(
      path.join(projectPath, "GLOSSARY.md"),
      "# Glossary\n\n| term | definition |\n|---|---|\n" +
        "| **PerfTerm** | Deterministic performance fixture term. |\n",
    );

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

  return { configDir, sessionFiles, sourceRoot };
}

async function appendTurns(fixture, scenario) {
  await Promise.all(
    fixture.sessionFiles.map(({ file, projectPath, sessionId }) =>
      appendFile(
        file,
        transcriptRows({
          projectPath,
          sessionId,
          startTurn: scenario.initialTurns,
          turns: scenario.newTurns,
          payloadBytes: scenario.payloadBytes,
        }),
      ),
    ),
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
            resolve({
              body: body.length === 0 ? null : JSON.parse(body),
              bytes: Buffer.byteLength(body),
              firstByteMs: firstByteMs ?? performance.now() - started,
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
    samples.push(raw);
    if (index < 6) await wait(150);
  }
  const minimumHeap = samples.reduce((best, sample) =>
    sample.heapUsed < best.heapUsed ? sample : best,
  );
  return {
    heapUsedBytes: minimumHeap.heapUsed,
    heapTotalBytes: minimumHeap.heapTotal,
    rssBytes: percentile(
      samples.map((sample) => sample.rss),
      0.5,
    ),
    externalBytes: minimumHeap.external,
    arrayBuffersBytes: minimumHeap.arrayBuffers ?? 0,
  };
}

async function gitRevision(checkout) {
  const child = spawn("git", ["rev-parse", "HEAD"], {
    cwd: checkout,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  if (code !== 0) {
    throw new Error(Buffer.concat(stderr).toString("utf8"));
  }
  return Buffer.concat(stdout).toString("utf8").trim();
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
      }
    }),
  );
  return {
    bodies,
    bytes,
    firstByteLatencies,
    latencies,
    readableTextLatencies,
  };
}

async function runHerd(agents, targets, timeoutMs) {
  const latencies = [];
  const firstByteLatencies = [];
  const readableTextLatencies = [];
  const bytes = [];
  const bodies = [];
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
      }
    }),
  );
  return {
    bodies,
    bytes,
    firstByteLatencies,
    latencies,
    readableTextLatencies,
  };
}

function memoryView(sample) {
  return {
    heapUsedMiB: bytesToMiB(sample.heapUsedBytes),
    heapTotalMiB: bytesToMiB(sample.heapTotalBytes),
    rssMiB: bytesToMiB(sample.rssBytes),
    externalMiB: bytesToMiB(sample.externalBytes),
    arrayBuffersMiB: bytesToMiB(sample.arrayBuffersBytes),
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

async function waitForReadableTail(page, marker, timeoutMs) {
  await page.waitForFunction(
    (needle) => document.body?.innerText.includes(needle),
    marker,
    { timeout: timeoutMs },
  );
}

async function navigateSpa(page, url) {
  await page.evaluate((nextUrl) => {
    history.pushState(null, "", nextUrl);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, url);
}

async function measureBrowserMode({
  checkout,
  config,
  details,
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
      const coldTailMs = [];
      const warmTailMs = [];
      const warmCacheTelemetry = [];
      for (let index = 0; index < scenario.concurrentClients; index += 1) {
        pages.push(await context.newPage());
      }

      await Promise.all(
        pages.map(async (page, index) => {
          const detail = details[index % details.length];
          const marker = `[${detail.sessionId}:assistant:${scenario.initialTurns - 1}]`;
          const sessionUrl =
            `${server.baseUrl}/projects/${encodeURIComponent(detail.projectId)}` +
            `/sessions/${encodeURIComponent(detail.sessionId)}`;
          const started = performance.now();
          await page.goto(sessionUrl, { waitUntil: "domcontentloaded" });
          await waitForReadableTail(
            page,
            marker,
            config.server.requestTimeoutMs,
          );
          const readableTailMs = performance.now() - started;
          if (glossarySupported) {
            await page.waitForFunction(
              () =>
                document.querySelectorAll("[data-glossary-term]").length > 0,
              undefined,
              { timeout: config.server.requestTimeoutMs },
            );
          }
          coldTailMs.push(readableTailMs);
        }),
      );

      await Promise.all(
        pages.map(async (page, index) => {
          const detail = details[index % details.length];
          const marker = `[${detail.sessionId}:assistant:${scenario.initialTurns - 1}]`;
          const sessionUrl =
            `${server.baseUrl}/projects/${encodeURIComponent(detail.projectId)}` +
            `/sessions/${encodeURIComponent(detail.sessionId)}`;
          await navigateSpa(page, `${server.baseUrl}/projects`);
          await page.waitForFunction(
            () => !document.querySelector(".message-list"),
            undefined,
            { timeout: config.server.requestTimeoutMs },
          );
          warmCacheTelemetry.push(await clientTelemetry(page));
          const started = performance.now();
          await navigateSpa(page, sessionUrl);
          await waitForReadableTail(
            page,
            marker,
            config.server.requestTimeoutMs,
          );
          warmTailMs.push(performance.now() - started);
        }),
      );

      for (const entry of warmCacheTelemetry) {
        if (cacheBudgetMiB === 0) {
          assertCount(
            entry.transcriptMemory.warmCacheEntryCount,
            0,
            "disabled browser transcript-cache warm entries",
          );
          assertCount(
            entry.transcriptMemory.warmCacheBytes,
            0,
            "disabled browser transcript-cache warm bytes",
          );
        } else if (
          entry.transcriptMemory.warmCacheEntryCount < 1 ||
          entry.transcriptMemory.warmCacheBytes < 1
        ) {
          throw new Error(
            `browser transcript cache ${cacheBudgetMiB} MiB retained no warm transcript`,
          );
        }
      }

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
      modes.push({
        cacheBudgetMiB,
        correctness: {
          glossaryHintsRendered: glossarySupported,
        },
        latency: {
          coldTail: summarize(coldTailMs),
          warmTail: summarize(warmTailMs),
        },
        telemetry: directTelemetry,
        warmCacheTelemetry,
        yaTelemetry,
        liveTailMs: [],
      });
      livePages.push({ context, mode: modes.at(-1), pages });
    }

    return {
      modes,
      livePages,
      async observeAppend() {
        const started = performance.now();
        await Promise.all(
          livePages.flatMap(({ mode, pages }) =>
            pages.map(async (page, index) => {
              const detail = details[index % details.length];
              const marker =
                `[${detail.sessionId}:assistant:` +
                `${scenario.initialTurns + scenario.newTurns - 1}]`;
              await waitForReadableTail(
                page,
                marker,
                config.server.requestTimeoutMs,
              );
              mode.liveTailMs.push(performance.now() - started);
            }),
          ),
        );
        for (const mode of modes) {
          mode.latency.appendedLiveTail = summarize(mode.liveTailMs);
          delete mode.liveTailMs;
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
  label,
  repetition,
  scenario,
  scenarioName,
  workRoot,
}) {
  const repetitionRoot = path.join(workRoot, `rep-${repetition}`);
  await mkdir(repetitionRoot, { recursive: true });
  const fixture = await createFixture(repetitionRoot, scenario);
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

    const browserAppendObservation = browserMeasurement?.observeAppend();
    await appendTurns(fixture, scenario);
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
      schemaVersion: 1,
      suiteVersion: SUITE_VERSION,
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
        projectFileLinkNeedle: "README.md",
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
  ];
  return Object.fromEntries(
    paths.map((metricPath) => [
      metricPath,
      round(
        percentile(
          runs.map((run) => getMetric(run, metricPath)),
          0.5,
        ),
      ),
    ]),
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
      return [
        String(cacheBudgetMiB),
        {
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
          "memory.maxUsedJSHeapMiB": round(
            Math.max(
              ...pageTelemetry.map((entry) => entry.memory?.usedJSHeapMiB ?? 0),
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
  const ratchets = await readJson(options.ratchets).catch((error) => {
    if (error.code === "ENOENT") return { schemaVersion: 1, scenarios: {} };
    throw error;
  });
  if (ratchets.schemaVersion !== 1)
    throw new Error("Unsupported ratchet schemaVersion");

  const revision = await gitRevision(checkout);
  const runName =
    `${options.label}-${options.driver}-${options.scenario}-` +
    revision.slice(0, 8);
  const suiteRoot = path.dirname(new URL(import.meta.url).pathname);
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
      schemaVersion: 1,
      suiteVersion: SUITE_VERSION,
      driver: options.driver,
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
