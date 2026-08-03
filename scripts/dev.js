#!/usr/bin/env node

/**
 * Dev server wrapper script with configurable reload behavior.
 *
 * Usage:
 *   pnpm dev                      # Default: no Enter-to-restart
 *   pnpm dev --watch              # Enable backend auto-reload on file changes
 *   pnpm dev --no-frontend-reload # Frontend watches but doesn't HMR
 *
 * Environment:
 *   Create a .env file in the project root to set defaults:
 *     LOG_LEVEL=debug
 *     PORT=4000
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exitIfUnsafeHome } from "./safe-home.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const isWindows = process.platform === "win32";
const pnpmBin = isWindows ? "pnpm.cmd" : "pnpm";
// Node 24+ on Windows requires shell:true to spawn .cmd files (CVE-2024-27980).
// DEP0190 warns about unescaped args, but all args here are hardcoded literals.
const shellOption = isWindows ? { shell: true } : {};

exitIfUnsafeHome({ entrypoint: "pnpm dev" });

function isSuppressedViteBannerLine(line) {
  return (
    /^\s*VITE v.+ready in /.test(line) ||
    /^\s*➜\s+Local:/.test(line) ||
    /^\s*➜\s+Network:/.test(line) ||
    /^\s*➜\s+press h \+ enter to show help/.test(line)
  );
}

function forwardWithLineFilter(stream, output, shouldSuppressLine) {
  if (!stream) return;
  let buffered = "";

  stream.on("data", (chunk) => {
    buffered += chunk.toString();

    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";

    for (const line of lines) {
      if (!shouldSuppressLine(line)) {
        output.write(`${line}\n`);
      }
    }
  });

  stream.on("end", () => {
    if (buffered && !shouldSuppressLine(buffered)) {
      output.write(buffered);
    }
  });
}

// Load .env file if it exists (simple parser, no dependencies)
function loadEnvFile() {
  const envPath = join(rootDir, ".env");
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Remove surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Only set if not already in environment (CLI overrides .env)
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

// Parse CLI arguments
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: pnpm dev [options]

Options:
  --watch              Enable backend auto-reload (tsx watch mode)
  --no-frontend-reload Frontend watches but doesn't HMR
  -h, --help           Show this help message
`);
  process.exit(0);
}

// Backend auto-reload is OFF by default (no Enter-to-restart behavior)
// Use --watch to enable tsx watch mode
const backendWatch = args.includes("--watch");
const noFrontendReload = args.includes("--no-frontend-reload");

// Port configuration: PORT + 0 = server, PORT + 1 = maintenance, PORT + 2 = vite
const basePort = process.env.PORT
  ? Number.parseInt(process.env.PORT, 10)
  : 3400;
const vitePort = process.env.VITE_PORT
  ? Number.parseInt(process.env.VITE_PORT, 10)
  : basePort + 2;
const protocol = process.env.HTTPS_SELF_SIGNED === "true" ? "https" : "http";
const configuredHost = process.env.HOST?.trim();
const displayHost =
  configuredHost && configuredHost !== "0.0.0.0" && configuredHost !== "::"
    ? configuredHost
    : "localhost";

console.log("Starting dev server...");
console.log(`  Access at: ${protocol}://${displayHost}:${basePort}`);
console.log(
  `  Ports: server=${basePort}, maintenance=${basePort + 1}, vite=${vitePort}`,
);
console.log(
  `  Note: Vite output on :${vitePort} is internal HMR only; browse ${protocol}://${displayHost}:${basePort}`,
);
if (backendWatch) console.log("  Backend auto-reload: ENABLED (--watch)");
if (noFrontendReload) console.log("  Frontend HMR: DISABLED");
if (!backendWatch && !noFrontendReload)
  console.log("  Frontend HMR: ENABLED, Backend: manual restart only");

// Build environment for child processes
const env = {
  ...process.env,
  // When not using --watch, enable manual reload mode (shows banner on file changes)
  NO_BACKEND_RELOAD: backendWatch ? "" : "true",
  NO_FRONTEND_RELOAD: noFrontendReload ? "true" : "",
  // Pass vite port to both server and client for consistency
  VITE_PORT: String(vitePort),
};

const reloadSafeCodexHostEnabled =
  process.platform === "linux" && !backendWatch;
const runtimeDir = reloadSafeCodexHostEnabled
  ? mkdtempSync(join(tmpdir(), "ya-codex-runtime-"))
  : null;
if (runtimeDir) chmodSync(runtimeDir, 0o700);
const runtimeHostSocket = runtimeDir ? join(runtimeDir, "host.sock") : null;
const runtimeHostToken = runtimeDir
  ? randomBytes(32).toString("base64url")
  : null;
const wrapperToken = randomBytes(32).toString("base64url");

if (runtimeDir && runtimeHostSocket && runtimeHostToken) {
  env.YEP_CODEX_RUNTIME_DIR = runtimeDir;
  env.YEP_CODEX_RUNTIME_SOCKET = runtimeHostSocket;
  env.YEP_CODEX_RUNTIME_TOKEN = runtimeHostToken;
}

let wrapperState = "starting";
let serverChild = null;
let clientChild = null;
let runtimeHostChild = null;
let wrapperControlServer = null;
const wrapperControlSockets = new Set();
const runtimeProcessGroups = new Map();
let serverGeneration = 0;
let unexpectedRecoveryUsed = false;
let shutdownPromise = null;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function processTargetAlive(target) {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function managedTarget(child) {
  if (!child?.pid) return null;
  return isWindows ? child.pid : -child.pid;
}

function managedTargets(child) {
  const targets = new Set();
  const launcherTarget = managedTarget(child);
  if (launcherTarget !== null) targets.add(launcherTarget);
  if (Number.isInteger(child?.backendPid) && child.backendPid > 1) {
    targets.add(child.backendPid);
  }
  return [...targets];
}

function signalManagedChild(child, signal) {
  let signaled = false;
  for (const target of managedTargets(child)) {
    if (!processTargetAlive(target)) continue;
    try {
      process.kill(target, signal);
      signaled = true;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  return signaled;
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("exit", onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function stopManagedChild(child, name, firstWaitMs = 3_000) {
  const targets = managedTargets(child);
  if (!targets.some(processTargetAlive)) return;
  signalManagedChild(child, "SIGTERM");
  if (await waitForProcessTargetsExit(targets, firstWaitMs)) return;
  console.warn(`[Shutdown] ${name} did not stop after SIGTERM; forcing it`);
  for (const target of targets) {
    if (!processTargetAlive(target)) continue;
    try {
      process.kill(target, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  if (!(await waitForProcessTargetsExit(targets, 1_500))) {
    throw new Error(`${name} process target survived SIGKILL`);
  }
}

async function waitForProcessTargetsExit(targets, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (targets.some(processTargetAlive)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(25, remaining)),
    );
  }
  return true;
}

async function waitForProcessTargetExit(target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processTargetAlive(target)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(25, remaining)),
    );
  }
  return true;
}

async function reapRuntimeProcessGroup(processGroupId) {
  const target = -processGroupId;
  if (!processTargetAlive(target)) return;
  process.kill(target, "SIGTERM");
  if (await waitForProcessTargetExit(target, 1_500)) return;
  process.kill(target, "SIGTERM");
  if (await waitForProcessTargetExit(target, 500)) return;
  process.kill(target, "SIGKILL");
  if (!(await waitForProcessTargetExit(target, 1_000))) {
    throw new Error(
      `Codex runtime process group ${processGroupId} survived SIGKILL`,
    );
  }
}

function spawnManaged(command, childArgs, options) {
  return spawn(command, childArgs, {
    ...options,
    detached: !isWindows,
  });
}

async function startRuntimeHost() {
  if (!reloadSafeCodexHostEnabled) return;
  const host = spawn(
    process.execPath,
    [join(__dirname, "codex-runtime-host.mjs")],
    {
      cwd: rootDir,
      env,
      detached: !isWindows,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
  runtimeHostChild = host;

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      host.off("message", onMessage);
      host.off("error", onError);
      host.off("exit", onExitBeforeReady);
      fn();
    };
    const onMessage = (message) => {
      if (message?.type === "ready") finish(resolve);
    };
    const onError = (error) => finish(() => reject(error));
    const onExitBeforeReady = (code, signal) =>
      finish(() =>
        reject(
          new Error(
            `Codex runtime host exited before ready (code=${code}, signal=${signal})`,
          ),
        ),
      );
    const timeout = setTimeout(
      () =>
        finish(() => reject(new Error("Codex runtime host startup timed out"))),
      5_000,
    );
    host.on("message", onMessage);
    host.once("error", onError);
    host.once("exit", onExitBeforeReady);
  });

  host.on("message", (message) => {
    if (message?.type === "runtimeLaunched") {
      runtimeProcessGroups.set(message.runtimeId, message.processGroupId);
    } else if (message?.type === "runtimeExited") {
      runtimeProcessGroups.delete(message.runtimeId);
    }
  });
  host.on("exit", (code, signal) => {
    if (runtimeHostChild === host) runtimeHostChild = null;
    if (wrapperState === "shutting-down") return;
    console.error(
      `[CodexRuntimeHost] Exited unexpectedly (code=${code}, signal=${signal})`,
    );
    void shutdownWrapper("Codex runtime host exited unexpectedly", 1);
  });
}

async function stopRuntimeHost() {
  const host = runtimeHostChild;
  if (host && host.exitCode === null && host.signalCode === null) {
    try {
      host.send({ type: "shutdown", reason: "dev wrapper shutdown" });
    } catch {
      // The fallback process-group sweep below remains authoritative.
    }
    if (!(await waitForChildExit(host, 5_000))) {
      host.kill("SIGTERM");
      if (!(await waitForChildExit(host, 1_500))) {
        host.kill("SIGKILL");
        if (!(await waitForChildExit(host, 1_000))) {
          throw new Error("Codex runtime host survived SIGKILL");
        }
      }
    }
  }

  const results = await Promise.allSettled(
    [...runtimeProcessGroups.values()].map(reapRuntimeProcessGroup),
  );
  runtimeProcessGroups.clear();
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new Error(
      `Failed to reap ${failures.length} Codex runtime process group(s)`,
    );
  }
}

async function startWrapperControlServer() {
  const server = createNetServer((socket) => {
    wrapperControlSockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          socket.end(
            `${JSON.stringify({ ok: false, error: "invalid JSON" })}\n`,
          );
          return;
        }
        if (request.token !== wrapperToken) {
          socket.end(
            `${JSON.stringify({ ok: false, error: "unauthorized" })}\n`,
          );
          return;
        }
        if (request.op === "registerBackend") {
          if (
            request.generation !== serverChild?.yaGeneration ||
            !Number.isInteger(request.pid) ||
            request.pid <= 1
          ) {
            socket.end(
              `${JSON.stringify({ ok: false, error: "invalid backend registration" })}\n`,
            );
            return;
          }
          serverChild.backendPid = request.pid;
          socket.end(`${JSON.stringify({ ok: true })}\n`);
          continue;
        }
        if (request.op !== "reload") {
          socket.end(
            `${JSON.stringify({ ok: false, error: "unknown operation" })}\n`,
          );
          return;
        }
        if (wrapperState === "shutting-down") {
          socket.end(
            `${JSON.stringify({ ok: false, error: "wrapper is shutting down" })}\n`,
          );
          return;
        }
        socket.end(`${JSON.stringify({ ok: true, state: wrapperState })}\n`);
        setTimeout(() => {
          void requestServerReload("API request");
        }, 100);
      }
    });
    socket.on("close", () => wrapperControlSockets.delete(socket));
    socket.on("error", () => wrapperControlSockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  wrapperControlServer = server;
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Dev wrapper control server did not bind a TCP port");
  }
  env.YEP_DEV_WRAPPER_PORT = String(address.port);
  env.YEP_DEV_WRAPPER_TOKEN = wrapperToken;
}

async function closeWrapperControlServer() {
  for (const socket of wrapperControlSockets) socket.destroy();
  wrapperControlSockets.clear();
  const server = wrapperControlServer;
  wrapperControlServer = null;
  if (!server) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

async function requestServerReload(source) {
  if (wrapperState === "shutting-down") return;
  if (wrapperState === "reloading") {
    console.log(`[Reload] Coalesced ${source}`);
    return;
  }
  const server = serverChild;
  if (!server || server.exitCode !== null || server.signalCode !== null) {
    console.error(`[Reload] ${source} arrived without a live server`);
    return;
  }
  wrapperState = "reloading";
  console.log(`\n[Reload] Replacing backend after ${source}...`);
  signalManagedChild(server, isWindows ? "SIGTERM" : "SIGHUP");
  void completeServerReload(server);
}

async function completeServerReload(server) {
  try {
    if (!(await waitForProcessTargetsExit(managedTargets(server), 10_000))) {
      console.warn("[Reload] Backend did not stop after SIGHUP; escalating");
      await stopManagedChild(server, "backend reload", 2_000);
    }
  } catch (error) {
    console.error(`[Reload] ${errorMessage(error)}`);
    await shutdownWrapper("Backend reload cleanup failed", 1);
    return;
  }

  if (wrapperState !== "reloading") return;
  if (serverChild === server) serverChild = null;
  console.log("[Reload] Starting replacement backend");
  startServer();
  wrapperState = "running";
}

async function recoverUnexpectedServer(server, code) {
  try {
    await stopManagedChild(server, "backend recovery", 2_000);
  } catch (error) {
    console.error(`[Recovery] ${errorMessage(error)}`);
    await shutdownWrapper("Backend recovery cleanup failed", 1);
    return;
  }
  if (wrapperState !== "running") return;
  if (serverChild === server) serverChild = null;
  console.error(`[Recovery] Backend exited with code ${code}; retrying once`);
  startServer();
}

async function shutdownWrapper(reason, exitCode = 0) {
  if (shutdownPromise) return await shutdownPromise;
  wrapperState = "shutting-down";
  shutdownPromise = (async () => {
    console.log(`[Shutdown] ${reason}`);
    const failures = [];
    await closeWrapperControlServer().catch((error) => failures.push(error));

    await stopManagedChild(serverChild, "backend", 7_000).catch((error) =>
      failures.push(error),
    );
    await stopRuntimeHost().catch((error) => failures.push(error));
    await stopManagedChild(clientChild, "Vite").catch((error) =>
      failures.push(error),
    );

    if (runtimeDir && existsSync(runtimeDir)) {
      try {
        rmSync(runtimeDir, { recursive: true });
      } catch (error) {
        failures.push(error);
      }
    }

    for (const failure of failures) {
      console.error(`[Shutdown] ${errorMessage(failure)}`);
    }
    const finalExitCode = failures.length > 0 ? 1 : exitCode;
    console.log(
      failures.length > 0
        ? "[Shutdown] Cleanup failed"
        : "[Shutdown] Cleanup complete",
    );
    process.exit(finalExitCode);
  })();
  return await shutdownPromise;
}

process.on("SIGINT", () => {
  void shutdownWrapper("Received SIGINT");
});
process.on("SIGTERM", () => {
  void shutdownWrapper("Received SIGTERM");
});
if (!isWindows) {
  process.on("SIGHUP", () => {
    void requestServerReload("SIGHUP");
  });
}

/**
 * Spawn a server process
 */
function startServer() {
  // Use dev:watch for auto-reload, dev for no-reload (default)
  const serverScript = backendWatch ? "dev:watch" : "dev";

  serverGeneration += 1;
  const generation = `${process.pid}-${serverGeneration}`;
  const server = spawnManaged(pnpmBin, ["--filter", "server", serverScript], {
    cwd: rootDir,
    env: { ...env, YEP_SERVER_GENERATION: generation },
    stdio: "inherit",
    ...shellOption,
  });
  server.yaGeneration = generation;
  serverChild = server;

  server.on("exit", (code, signal) => {
    if (wrapperState === "shutting-down") return;
    if (wrapperState === "reloading") {
      return;
    }
    if (code !== null && code !== 0 && !unexpectedRecoveryUsed) {
      unexpectedRecoveryUsed = true;
      void recoverUnexpectedServer(server, code);
      return;
    }
    void shutdownWrapper(
      `Backend exited without reload intent (code=${code}, signal=${signal})`,
      code === 0 ? 0 : 1,
    );
  });

  return server;
}

/**
 * Start the client dev server
 */
function startClient() {
  const client = spawnManaged(pnpmBin, ["--filter", "client", "dev"], {
    cwd: rootDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    ...shellOption,
  });

  forwardWithLineFilter(
    client.stdout,
    process.stdout,
    isSuppressedViteBannerLine,
  );
  forwardWithLineFilter(
    client.stderr,
    process.stderr,
    isSuppressedViteBannerLine,
  );

  clientChild = client;

  client.on("exit", (code, signal) => {
    if (wrapperState === "shutting-down") return;
    if (code !== null && code !== 0) {
      console.error(`Client exited with code ${code}`);
    }
    void shutdownWrapper(
      `Vite exited unexpectedly (code=${code}, signal=${signal})`,
      code === 0 ? 0 : 1,
    );
  });

  return client;
}

try {
  await startRuntimeHost();
  await startWrapperControlServer();
  startServer();
  startClient();
  wrapperState = "running";
} catch (error) {
  console.error(`[Startup] ${errorMessage(error)}`);
  await shutdownWrapper("Startup failed", 1);
}
