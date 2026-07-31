#!/usr/bin/env node

import http from "node:http";
import https from "node:https";

const DEFAULT_BASE_URL = "https://localhost:3400";
const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_MAX_MINUTES = 90;

function usage() {
  console.log(`Usage: pnpm agent:monitor -- <session-id> [options]

Options:
  --base-url <url>          YA server (default: ${DEFAULT_BASE_URL})
  --interval-seconds <n>   Poll interval (default: ${DEFAULT_INTERVAL_SECONDS})
  --max-minutes <n>        Wall-clock deadline (default: ${DEFAULT_MAX_MINUTES})
  -h, --help               Show help

Exit status:
  0  the process reached verified idle
  2  invalid arguments
  3  the process needs attention or input
  4  the process terminated or reported a terminal provider error
  5  the deadline or API error budget was exceeded

The monitor reads process state only. It never fetches the transcript or sends
messages, approvals, interrupts, or retries.
`);
}

function positiveNumber(value, option) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive number`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    maxMinutes: DEFAULT_MAX_MINUTES,
    sessionId: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    if (arg === "--base-url") {
      options.baseUrl = argv[++index];
      if (!options.baseUrl) throw new Error("--base-url requires a value");
      continue;
    }
    if (arg === "--interval-seconds") {
      options.intervalSeconds = positiveNumber(
        argv[++index],
        "--interval-seconds",
      );
      continue;
    }
    if (arg === "--max-minutes") {
      options.maxMinutes = positiveNumber(argv[++index], "--max-minutes");
      continue;
    }
    if (arg?.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    if (options.sessionId) throw new Error("provide exactly one session id");
    options.sessionId = arg;
  }

  if (!options.sessionId) throw new Error("a session id is required");
  return options;
}

function isLoopback(hostname) {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

function getJson(url) {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.get(
      url,
      {
        headers: { Accept: "application/json" },
        ...(url.protocol === "https:" && isLoopback(url.hostname)
          ? { rejectUnauthorized: false }
          : {}),
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if ((response.statusCode ?? 500) >= 400) {
            reject(
              new Error(`HTTP ${response.statusCode}: ${body.slice(0, 300)}`),
            );
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`invalid JSON response: ${error.message}`));
          }
        });
      },
    );
    request.setTimeout(15_000, () => {
      request.destroy(new Error("request timed out after 15 seconds"));
    });
    request.on("error", reject);
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function summarize(processInfo) {
  const liveness = processInfo.liveness ?? {};
  const runtime = processInfo.providerRuntimeStatus;
  const silenceSeconds = Number.isFinite(liveness.silenceMs)
    ? Math.round(liveness.silenceMs / 1000)
    : "?";
  return [
    `state=${processInfo.state ?? "unknown"}`,
    `liveness=${liveness.derivedStatus ?? "unknown"}`,
    `work=${liveness.activeWorkKind ?? "unknown"}`,
    `queue=${processInfo.queueDepth ?? liveness.queueDepth ?? "?"}`,
    `silence=${silenceSeconds}s`,
    `runtime=${runtime?.kind ?? "none"}`,
  ].join(" ");
}

function terminalResult(processInfo) {
  const liveness = processInfo.liveness ?? {};
  const runtime = processInfo.providerRuntimeStatus;
  const queueDepth = processInfo.queueDepth ?? liveness.queueDepth;

  if (runtime?.kind === "terminal") {
    return { exitCode: 4, label: "provider-terminal" };
  }
  if (
    processInfo.state === "terminated" ||
    liveness.activeWorkKind === "terminated"
  ) {
    return { exitCode: 4, label: "terminated" };
  }
  if (
    processInfo.state === "waiting-input" ||
    liveness.activeWorkKind === "waiting-input" ||
    liveness.derivedStatus === "needs-attention"
  ) {
    return { exitCode: 3, label: "needs-attention" };
  }
  if (
    processInfo.state === "idle" &&
    queueDepth === 0 &&
    liveness.activeWorkKind === "none" &&
    liveness.derivedStatus === "verified-idle"
  ) {
    return { exitCode: 0, label: "complete" };
  }
  return null;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`agent-monitor: ${error.message}`);
  usage();
  process.exit(2);
}

const baseUrl = new URL(options.baseUrl);
const processUrl = new URL(
  `/api/sessions/${encodeURIComponent(options.sessionId)}/process`,
  baseUrl,
);
const intervalMs = options.intervalSeconds * 1000;
const deadline = Date.now() + options.maxMinutes * 60_000;
let consecutiveErrors = 0;

while (Date.now() < deadline) {
  try {
    const payload = await getJson(processUrl);
    consecutiveErrors = 0;
    if (!payload?.process) {
      console.error(
        "agent-monitor: process is absent before a terminal boundary",
      );
      process.exit(4);
    }

    const summary = summarize(payload.process);
    console.log(`${new Date().toISOString()} ${summary}`);

    const result = terminalResult(payload.process);
    if (result) {
      console.log(`agent-monitor: ${result.label}`);
      process.exit(result.exitCode);
    }
  } catch (error) {
    consecutiveErrors += 1;
    console.error(
      `agent-monitor: poll failed (${consecutiveErrors}/3): ${error.message}`,
    );
    if (consecutiveErrors >= 3) process.exit(5);
  }

  await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
}

console.error(`agent-monitor: deadline exceeded after ${options.maxMinutes}m`);
process.exit(5);
