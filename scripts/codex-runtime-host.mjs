#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_PROTOCOL_VERSION = 1;
const SOCKET_READY_TIMEOUT_MS = 5_000;
const SOCKET_READY_POLL_MS = 25;
const FIRST_TERM_GRACE_MS = 1_500;
const SECOND_TERM_GRACE_MS = 500;
const KILL_VERIFY_MS = 1_000;
const DEFAULT_ATTACH_TIMEOUT_MS = 30_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function removePathIfPresent(path) {
  if (!existsSync(path)) return;
  try {
    rmSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function removeTreeIfPresent(path) {
  if (!existsSync(path)) return;
  try {
    rmSync(path, { recursive: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function parseCleanupPaths(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("cleanupPaths must be an array");
  }
  return value.map((path) => {
    if (
      typeof path !== "string" ||
      dirname(path) !== tmpdir() ||
      !basename(path).startsWith("ya-agentctl-session-")
    ) {
      throw new Error("Invalid Codex runtime cleanup path");
    }
    return path;
  });
}

function isProcessGroupAlive(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessGroupExit(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessGroupAlive(processGroupId)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    await delay(Math.min(25, remainingMs));
  }
  return true;
}

function signalProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function terminateProcessGroup(processGroupId) {
  if (!isProcessGroupAlive(processGroupId)) return;

  signalProcessGroup(processGroupId, "SIGTERM");
  if (await waitForProcessGroupExit(processGroupId, FIRST_TERM_GRACE_MS)) {
    return;
  }

  signalProcessGroup(processGroupId, "SIGTERM");
  if (await waitForProcessGroupExit(processGroupId, SECOND_TERM_GRACE_MS)) {
    return;
  }

  signalProcessGroup(processGroupId, "SIGKILL");
  if (!(await waitForProcessGroupExit(processGroupId, KILL_VERIFY_MS))) {
    throw new Error(
      `Codex runtime process group ${processGroupId} survived SIGKILL`,
    );
  }
}

function isSocket(path) {
  try {
    return lstatSync(path).isSocket();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function waitForSocket(path, child) {
  const deadline = Date.now() + SOCKET_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isSocket(path)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Codex app-server exited before creating its socket");
    }
    await delay(SOCKET_READY_POLL_MS);
  }
  throw new Error(`Timed out waiting for Codex app-server socket ${path}`);
}

function publicRuntimeEntry(entry) {
  return {
    hostProtocolVersion: HOST_PROTOCOL_VERSION,
    runtimeId: entry.runtimeId,
    sessionId: entry.sessionId,
    projectPath: entry.projectPath,
    socketPath: entry.socketPath,
    pid: entry.pid,
    processGroupId: entry.processGroupId,
    state: entry.state,
    attachedServerGeneration: entry.attachedServerGeneration,
    startedAt: entry.startedAt,
    unviewedSince: entry.unviewedSince,
    lifecycleCapabilities: { viewerPresence: true },
    detachedAt: entry.detachedAt,
    reattach: entry.reattach,
  };
}

export class CodexRuntimeHost {
  constructor({
    runtimeDir,
    controlSocketPath,
    token,
    attachTimeoutMs = DEFAULT_ATTACH_TIMEOUT_MS,
    notifyWrapper = () => {},
  }) {
    this.runtimeDir = runtimeDir;
    this.controlSocketPath = controlSocketPath;
    this.token = token;
    this.attachTimeoutMs = attachTimeoutMs;
    this.sendToWrapper = notifyWrapper;
    this.runtimes = new Map();
    this.registeredServers = new Map();
    this.connections = new Set();
    this.server = null;
    this.shuttingDown = null;
  }

  notifyWrapper(message) {
    try {
      this.sendToWrapper(message);
    } catch {
      // Wrapper loss is handled by the IPC disconnect path.
    }
  }

  async start() {
    removePathIfPresent(this.controlSocketPath);
    this.server = createServer((socket) => this.handleConnection(socket));
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server?.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.controlSocketPath);
    });
    chmodSync(this.controlSocketPath, 0o600);
    this.notifyWrapper({
      type: "ready",
      protocolVersion: HOST_PROTOCOL_VERSION,
      controlSocketPath: this.controlSocketPath,
    });
  }

  handleConnection(socket) {
    this.connections.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let registeredGeneration = null;

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
          socket.write(
            `${JSON.stringify({ ok: false, error: "Invalid JSON request" })}\n`,
          );
          continue;
        }
        void this.handleRequest(request, socket)
          .then((result) => {
            if (request.op === "registerServer" && result?.generation) {
              registeredGeneration = result.generation;
              this.registeredServers.set(result.generation, socket);
            }
            socket.write(
              `${JSON.stringify({ id: request.id, ok: true, result })}\n`,
            );
          })
          .catch((error) => {
            socket.write(
              `${JSON.stringify({
                id: request.id,
                ok: false,
                error: errorMessage(error),
              })}\n`,
            );
          });
      }
    });

    socket.on("close", () => {
      this.connections.delete(socket);
      if (!registeredGeneration) return;
      if (this.registeredServers.get(registeredGeneration) === socket) {
        this.registeredServers.delete(registeredGeneration);
      }
      this.detachGeneration(registeredGeneration);
    });
    socket.on("error", () => {
      // close performs generation cleanup.
    });
  }

  async handleRequest(request, socket) {
    if (request?.token !== this.token) {
      throw new Error("Unauthorized Codex runtime host request");
    }
    if (typeof request?.op !== "string") {
      throw new Error("Missing Codex runtime host operation");
    }

    switch (request.op) {
      case "status":
        return {
          protocolVersion: HOST_PROTOCOL_VERSION,
          runtimeCount: this.runtimes.size,
          shuttingDown: this.shuttingDown !== null,
        };
      case "registerServer": {
        const generation = this.requireString(request.generation, "generation");
        const current = this.registeredServers.get(generation);
        if (current && current !== socket) {
          throw new Error(
            `Server generation ${generation} is already registered`,
          );
        }
        return { generation, protocolVersion: HOST_PROTOCOL_VERSION };
      }
      case "launch":
        return await this.launch(request);
      case "bind":
        return this.bind(request);
      case "list":
        return [...this.runtimes.values()]
          .filter((entry) => entry.sessionId && this.isRuntimeAlive(entry))
          .map(publicRuntimeEntry);
      case "claim":
        return this.claim(request);
      case "setViewerPresence":
        return this.setViewerPresence(request);
      case "release":
        return this.release(request);
      case "terminate":
        await this.terminateRuntime(
          this.requireString(request.runtimeId, "runtimeId"),
          "server request",
        );
        return {};
      default:
        throw new Error(`Unknown Codex runtime host operation: ${request.op}`);
    }
  }

  requireString(value, name) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Missing ${name}`);
    }
    return value;
  }

  isRuntimeAlive(entry) {
    return isProcessGroupAlive(entry.processGroupId);
  }

  async launch(request) {
    if (this.shuttingDown) {
      throw new Error("Codex runtime host is shutting down");
    }
    const generation = this.requireString(request.generation, "generation");
    if (!this.registeredServers.has(generation)) {
      throw new Error(`Server generation ${generation} is not registered`);
    }
    const command = this.requireString(request.command, "command");
    const projectPath = this.requireString(request.projectPath, "projectPath");
    const runtimeId = randomUUID();
    const socketPath = join(
      this.runtimeDir,
      `codex-${runtimeId.replaceAll("-", "").slice(0, 16)}.sock`,
    );
    removePathIfPresent(socketPath);

    const child = spawn(
      command,
      ["app-server", "--listen", `unix://${socketPath}`],
      {
        cwd: projectPath,
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
        env:
          request.env && typeof request.env === "object"
            ? request.env
            : process.env,
        shell: false,
      },
    );
    if (!child.pid) {
      // A failed spawn reports asynchronously; consume that event after
      // returning the synchronous launch error below.
      child.once("error", () => {});
      throw new Error("Codex app-server launch returned no PID");
    }

    const startedAt = new Date().toISOString();
    const entry = {
      runtimeId,
      sessionId: undefined,
      projectPath,
      socketPath,
      pid: child.pid,
      processGroupId: child.pid,
      child,
      state: "starting",
      attachedServerGeneration: generation,
      startedAt,
      unviewedSince: startedAt,
      viewerAttached: false,
      detachedAt: undefined,
      reattach:
        request.reattach && typeof request.reattach === "object"
          ? request.reattach
          : {},
      cleanupPaths: parseCleanupPaths(request.cleanupPaths),
      attachTimer: null,
      terminationPromise: null,
    };
    this.runtimes.set(runtimeId, entry);
    this.notifyWrapper({
      type: "runtimeLaunched",
      runtimeId,
      pid: entry.pid,
      processGroupId: entry.processGroupId,
      socketPath,
    });

    child.stderr?.on("data", (chunk) => {
      process.stderr.write(
        `[CodexRuntime ${runtimeId.slice(0, 8)}] ${chunk.toString()}`,
      );
    });
    child.on("error", (error) => {
      process.stderr.write(
        `[CodexRuntime ${runtimeId.slice(0, 8)}] ${errorMessage(error)}\n`,
      );
    });
    child.on("exit", () => {
      void this.handleRuntimeExit(runtimeId);
    });

    try {
      await waitForSocket(socketPath, child);
      entry.state = "attached";
      this.armAttachDeadline(entry, "runtime identity was not bound");
      return publicRuntimeEntry(entry);
    } catch (error) {
      await this.terminateRuntime(runtimeId, "launch failure").catch(() => {});
      throw error;
    }
  }

  bind(request) {
    const runtimeId = this.requireString(request.runtimeId, "runtimeId");
    const sessionId = this.requireString(request.sessionId, "sessionId");
    const entry = this.runtimes.get(runtimeId);
    if (!entry || !this.isRuntimeAlive(entry)) {
      throw new Error(`Unknown or dead Codex runtime ${runtimeId}`);
    }
    if (entry.sessionId && entry.sessionId !== sessionId) {
      throw new Error(`Codex runtime ${runtimeId} is already bound`);
    }
    const duplicate = [...this.runtimes.values()].find(
      (candidate) =>
        candidate.runtimeId !== runtimeId && candidate.sessionId === sessionId,
    );
    if (duplicate) {
      throw new Error(`Codex session ${sessionId} already has a runtime`);
    }
    entry.sessionId = sessionId;
    entry.state = "attached";
    this.clearAttachDeadline(entry);
    return publicRuntimeEntry(entry);
  }

  claim(request) {
    const generation = this.requireString(request.generation, "generation");
    const sessionId = this.requireString(request.sessionId, "sessionId");
    if (!this.registeredServers.has(generation)) {
      throw new Error(`Server generation ${generation} is not registered`);
    }
    const entry = [...this.runtimes.values()].find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (!entry || !this.isRuntimeAlive(entry)) return null;
    const currentGeneration = entry.attachedServerGeneration;
    if (
      currentGeneration &&
      currentGeneration !== generation &&
      this.registeredServers.has(currentGeneration)
    ) {
      throw new Error(
        `Codex runtime ${entry.runtimeId} is controlled by server generation ${currentGeneration}`,
      );
    }
    this.markViewerDetached(entry);
    entry.attachedServerGeneration = generation;
    entry.state = "attached";
    entry.detachedAt = undefined;
    this.clearAttachDeadline(entry);
    return publicRuntimeEntry(entry);
  }

  setViewerPresence(request) {
    const runtimeId = this.requireString(request.runtimeId, "runtimeId");
    const generation = this.requireString(request.generation, "generation");
    if (typeof request.hasViewers !== "boolean") {
      throw new Error("Invalid hasViewers");
    }
    const entry = this.runtimes.get(runtimeId);
    if (
      !entry ||
      !this.isRuntimeAlive(entry) ||
      entry.attachedServerGeneration !== generation
    ) {
      throw new Error(
        `Codex runtime ${runtimeId} is not controlled by ${generation}`,
      );
    }
    if (request.hasViewers) {
      entry.viewerAttached = true;
      entry.unviewedSince = undefined;
    } else {
      entry.viewerAttached = false;
      entry.unviewedSince = new Date().toISOString();
    }
    return publicRuntimeEntry(entry);
  }

  markViewerDetached(entry) {
    if (entry.viewerAttached || !entry.unviewedSince) {
      entry.unviewedSince = new Date().toISOString();
    }
    entry.viewerAttached = false;
  }

  release(request) {
    const runtimeId = this.requireString(request.runtimeId, "runtimeId");
    const generation = this.requireString(request.generation, "generation");
    const entry = this.runtimes.get(runtimeId);
    if (!entry) return {};
    if (
      entry.attachedServerGeneration &&
      entry.attachedServerGeneration !== generation
    ) {
      return {};
    }
    this.markViewerDetached(entry);
    entry.attachedServerGeneration = undefined;
    entry.state = "detached";
    entry.detachedAt = new Date().toISOString();
    this.armAttachDeadline(entry, "replacement server did not attach");
    return {};
  }

  detachGeneration(generation) {
    for (const entry of this.runtimes.values()) {
      if (entry.attachedServerGeneration !== generation) continue;
      this.markViewerDetached(entry);
      entry.attachedServerGeneration = undefined;
      entry.state = "detached";
      entry.detachedAt = new Date().toISOString();
      this.armAttachDeadline(entry, "server owner disconnected");
    }
  }

  clearAttachDeadline(entry) {
    if (entry.attachTimer) clearTimeout(entry.attachTimer);
    entry.attachTimer = null;
  }

  armAttachDeadline(entry, reason) {
    this.clearAttachDeadline(entry);
    entry.attachTimer = setTimeout(() => {
      void this.terminateRuntime(entry.runtimeId, reason).catch((error) => {
        process.stderr.write(
          `[CodexRuntimeHost] Failed to reap ${entry.runtimeId}: ${errorMessage(error)}\n`,
        );
      });
    }, this.attachTimeoutMs);
  }

  async handleRuntimeExit(runtimeId) {
    try {
      await this.terminateRuntime(runtimeId, "app-server exited");
    } catch (error) {
      process.stderr.write(
        `[CodexRuntimeHost] Exit cleanup failed for ${runtimeId}: ${errorMessage(error)}\n`,
      );
    }
  }

  async terminateRuntime(runtimeId, reason) {
    const entry = this.runtimes.get(runtimeId);
    if (!entry) return;
    if (entry.terminationPromise) return await entry.terminationPromise;
    entry.state = "closing";
    this.clearAttachDeadline(entry);
    entry.terminationPromise = (async () => {
      await terminateProcessGroup(entry.processGroupId);
      this.finishRuntimeRemoval(entry, reason);
    })();
    return await entry.terminationPromise;
  }

  finishRuntimeRemoval(entry, reason = "app-server exited") {
    this.clearAttachDeadline(entry);
    this.runtimes.delete(entry.runtimeId);
    removePathIfPresent(entry.socketPath);
    for (const path of entry.cleanupPaths) removeTreeIfPresent(path);
    this.notifyWrapper({
      type: "runtimeExited",
      runtimeId: entry.runtimeId,
      processGroupId: entry.processGroupId,
      reason,
    });
  }

  async shutdown(reason = "wrapper shutdown") {
    if (this.shuttingDown) return await this.shuttingDown;
    this.shuttingDown = (async () => {
      for (const socket of this.registeredServers.values()) {
        socket.destroy();
      }
      this.registeredServers.clear();

      const results = await Promise.allSettled(
        [...this.runtimes.keys()].map((runtimeId) =>
          this.terminateRuntime(runtimeId, reason),
        ),
      );
      const failures = results.filter((result) => result.status === "rejected");

      for (const socket of this.connections) socket.destroy();
      this.connections.clear();

      if (this.server) {
        await new Promise((resolve) => this.server.close(() => resolve()));
        this.server = null;
      }
      removePathIfPresent(this.controlSocketPath);
      this.notifyWrapper({
        type: "shutdownComplete",
        ok: failures.length === 0,
        failures: failures.map((failure) => errorMessage(failure.reason)),
      });
      if (failures.length > 0) {
        throw new Error(
          `${failures.length} Codex runtime process group(s) survived shutdown`,
        );
      }
    })();
    return await this.shuttingDown;
  }
}

async function main() {
  const runtimeDir = process.env.YEP_CODEX_RUNTIME_DIR;
  const controlSocketPath = process.env.YEP_CODEX_RUNTIME_SOCKET;
  const token = process.env.YEP_CODEX_RUNTIME_TOKEN;
  if (!runtimeDir || !controlSocketPath || !token) {
    throw new Error(
      "YEP_CODEX_RUNTIME_DIR, YEP_CODEX_RUNTIME_SOCKET, and YEP_CODEX_RUNTIME_TOKEN are required",
    );
  }

  const host = new CodexRuntimeHost({
    runtimeDir,
    controlSocketPath,
    token,
    notifyWrapper(message) {
      if (typeof process.send === "function" && process.connected) {
        process.send(message);
      }
    },
  });
  process.on("message", (message) => {
    if (message?.type === "shutdown") {
      void host
        .shutdown(message.reason)
        .then(() => process.exit(0))
        .catch((error) => {
          process.stderr.write(`[CodexRuntimeHost] ${errorMessage(error)}\n`);
          process.exit(1);
        });
    }
  });
  process.on("disconnect", () => {
    void host
      .shutdown("wrapper IPC closed")
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
  process.on("SIGINT", () => {
    void host
      .shutdown("SIGINT")
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
  process.on("SIGTERM", () => {
    void host
      .shutdown("SIGTERM")
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });

  await host.start();
  process.stdout.write(
    `[CodexRuntimeHost] Listening at ${basename(controlSocketPath)}\n`,
  );
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`[CodexRuntimeHost] ${errorMessage(error)}\n`);
    process.exit(1);
  });
}
