#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_PROTOCOL_VERSION = 1;
const WORKER_READY_TIMEOUT_MS = 30_000;
const COOPERATIVE_STOP_MS = 5_000;
const TERM_GRACE_MS = 1_500;
const KILL_VERIFY_MS = 1_000;
const DEFAULT_ATTACH_TIMEOUT_MS = 30_000;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(scriptDir, "..");
const workerEntrypoint = join(
  rootDir,
  "packages/server/src/sdk/providers/provider-runtime-worker.ts",
);

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

function readProcessStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return null;
    throw error;
  }
}

function captureProcessGroup(processGroupId) {
  const leaderStartTime = readProcessStartTime(processGroupId);
  if (!leaderStartTime) {
    throw new Error(
      `Cannot capture provider process group ${processGroupId} identity`,
    );
  }
  return { processGroupId, leaderStartTime };
}

function isOwnedProcessGroupAlive(target) {
  if (!isProcessGroupAlive(target.processGroupId)) return false;
  const currentStartTime = readProcessStartTime(target.processGroupId);
  return (
    currentStartTime === null || currentStartTime === target.leaderStartTime
  );
}

async function waitForProcessGroupExit(target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isOwnedProcessGroupAlive(target)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(25, remaining));
  }
  return true;
}

function signalProcessGroup(target, signal) {
  if (!isOwnedProcessGroupAlive(target)) return;
  try {
    process.kill(-target.processGroupId, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function terminateProcessGroup(target) {
  if (!isOwnedProcessGroupAlive(target)) return;
  signalProcessGroup(target, "SIGTERM");
  if (await waitForProcessGroupExit(target, TERM_GRACE_MS)) return;
  signalProcessGroup(target, "SIGKILL");
  if (!(await waitForProcessGroupExit(target, KILL_VERIFY_MS))) {
    throw new Error(
      `Provider runtime process group ${target.processGroupId} survived SIGKILL`,
    );
  }
}

function publicRuntimeEntry(entry) {
  return {
    hostProtocolVersion: HOST_PROTOCOL_VERSION,
    runtimeId: entry.runtimeId,
    sessionId: entry.sessionId,
    providerName: entry.providerName,
    projectPath: entry.projectPath,
    socketPath: entry.socketPath,
    pid: entry.pid,
    processGroupId: entry.processGroupId,
    providerProcessGroupIds: [...entry.providerProcessGroups.keys()],
    state: entry.state,
    attachedServerGeneration: entry.attachedServerGeneration,
    startedAt: entry.startedAt,
    detachedAt: entry.detachedAt,
    reattach: entry.reattach,
    worker: entry.workerMetadata,
  };
}

export class ProviderRuntimeHost {
  constructor({
    runtimeDir,
    controlSocketPath,
    token,
    attachTimeoutMs = DEFAULT_ATTACH_TIMEOUT_MS,
    notifyWrapper = () => {},
    workerPath = workerEntrypoint,
  }) {
    this.runtimeDir = runtimeDir;
    this.controlSocketPath = controlSocketPath;
    this.token = token;
    this.attachTimeoutMs = attachTimeoutMs;
    this.sendToWrapper = notifyWrapper;
    this.workerPath = workerPath;
    this.runtimes = new Map();
    this.retainedProcessGroups = new Map();
    this.registeredServers = new Map();
    this.connections = new Set();
    this.server = null;
    this.shuttingDown = null;
  }

  notifyWrapper(message) {
    try {
      this.sendToWrapper(message);
    } catch {
      // Wrapper loss is handled by the inherited IPC disconnect.
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
    socket.on("error", () => {});
  }

  async handleRequest(request, socket) {
    if (request?.token !== this.token) {
      throw new Error("Unauthorized provider runtime host request");
    }
    if (typeof request?.op !== "string") {
      throw new Error("Missing provider runtime host operation");
    }
    if (request.protocolVersion !== HOST_PROTOCOL_VERSION) {
      throw new Error("Incompatible provider runtime host protocol");
    }

    switch (request.op) {
      case "status":
        return {
          protocolVersion: HOST_PROTOCOL_VERSION,
          runtimeCount: this.runtimes.size,
          retainedProcessGroupCount: this.retainedProcessGroups.size,
          shuttingDown: this.shuttingDown !== null,
        };
      case "registerServer": {
        const generation = this.requireString(request.generation, "generation");
        const current = this.registeredServers.get(generation);
        if (current && current !== socket) {
          throw new Error(`Server generation ${generation} is already registered`);
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
      case "confirmAttach":
        return this.confirmAttach(request);
      case "release":
        return this.release(request);
      case "retainProcessGroup":
        return this.retainProcessGroup(request);
      case "terminate":
        await this.terminateRuntime(
          this.requireString(request.runtimeId, "runtimeId"),
          "server request",
        );
        return {};
      default:
        throw new Error(`Unknown provider runtime host operation: ${request.op}`);
    }
  }

  requireString(value, name) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Missing ${name}`);
    }
    return value;
  }

  isRuntimeAlive(entry) {
    return isOwnedProcessGroupAlive(entry.processGroup);
  }

  async launch(request) {
    if (this.shuttingDown) {
      throw new Error("Provider runtime host is shutting down");
    }
    const generation = this.requireString(request.generation, "generation");
    if (!this.registeredServers.has(generation)) {
      throw new Error(`Server generation ${generation} is not registered`);
    }
    const providerName = this.requireString(request.providerName, "providerName");
    const projectPath = this.requireString(request.projectPath, "projectPath");
    const runtimeId = randomUUID();
    const socketPath = join(
      this.runtimeDir,
      `provider-${runtimeId.replaceAll("-", "").slice(0, 16)}.sock`,
    );
    removePathIfPresent(socketPath);

    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--conditions", "source", this.workerPath],
      {
        cwd: rootDir,
        detached: true,
        stdio: ["pipe", "inherit", "inherit", "ipc"],
        env: {
          ...process.env,
          YEP_PROVIDER_WORKER_SOCKET: socketPath,
          YEP_PROVIDER_WORKER_TOKEN: this.token,
          YEP_PROVIDER_WORKER_RUNTIME_ID: runtimeId,
        },
        shell: false,
      },
    );
    if (!child.pid || !child.stdin) {
      child.once("error", () => {});
      throw new Error("Provider worker launch returned no PID or input pipe");
    }

    const entry = {
      runtimeId,
      sessionId:
        typeof request.sessionId === "string" && request.sessionId
          ? request.sessionId
          : undefined,
      providerName,
      projectPath,
      socketPath,
      pid: child.pid,
      processGroupId: child.pid,
      processGroup: captureProcessGroup(child.pid),
      providerProcessGroups: new Map(),
      child,
      state: "starting",
      attachedServerGeneration: generation,
      controllerAttached: false,
      startedAt: new Date().toISOString(),
      detachedAt: undefined,
      reattach:
        request.reattach && typeof request.reattach === "object"
          ? request.reattach
          : {},
      workerMetadata: undefined,
      attachTimer: null,
      terminationPromise: null,
    };
    this.runtimes.set(runtimeId, entry);
    this.notifyWrapper({
      type: "runtimeLaunched",
      runtimeId,
      pid: entry.pid,
      processGroupId: entry.processGroupId,
      processGroups: [entry.processGroup],
      providerName,
    });

    child.on("message", (message) => {
      try {
        this.handleWorkerMessage(entry, message);
      } catch (error) {
        process.stderr.write(
          `[ProviderRuntimeHost] Worker ${runtimeId} sent an invalid lifecycle update: ${errorMessage(error)}\n`,
        );
        void this.terminateRuntime(runtimeId, "invalid worker lifecycle update").catch(
          (terminationError) => {
            process.stderr.write(
              `[ProviderRuntimeHost] Failed to reap ${runtimeId}: ${errorMessage(terminationError)}\n`,
            );
          },
        );
      }
    });
    child.on("error", (error) => {
      process.stderr.write(
        `[ProviderRuntime ${runtimeId.slice(0, 8)}] ${errorMessage(error)}\n`,
      );
    });
    child.on("exit", () => {
      void this.handleRuntimeExit(runtimeId);
    });

    const ready = new Promise((resolve, reject) => {
      const finish = (fn) => {
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("exit", onExit);
        fn();
      };
      const onMessage = (message) => {
        if (message?.type === "ready") finish(() => resolve(message));
        if (message?.type === "startupError") {
          finish(() => reject(new Error(message.error)));
        }
      };
      const onExit = (code, signal) =>
        finish(() =>
          reject(
            new Error(
              `Provider worker exited before ready (code=${code}, signal=${signal})`,
            ),
          ),
        );
      const timeout = setTimeout(
        () => finish(() => reject(new Error("Provider worker startup timed out"))),
        WORKER_READY_TIMEOUT_MS,
      );
      child.on("message", onMessage);
      child.once("exit", onExit);
    });

    child.stdin.end(
      JSON.stringify({
        providerName,
        options: request.options ?? {},
        runtimeConfig: request.runtimeConfig ?? {},
      }),
    );

    try {
      const readyMessage = await ready;
      entry.workerMetadata = readyMessage.metadata;
      if (Number.isInteger(readyMessage.providerPid) && readyMessage.providerPid > 1) {
        this.rememberProviderProcessGroup(entry, readyMessage.providerPid);
      }
      this.armAttachDeadline(
        entry,
        entry.sessionId
          ? "provider runtime controller did not attach"
          : "provider runtime identity was not bound",
      );
      return publicRuntimeEntry(entry);
    } catch (error) {
      await this.terminateRuntime(runtimeId, "launch failure").catch(() => {});
      throw error;
    }
  }

  handleWorkerMessage(entry, message) {
    if (
      message?.type === "retainedProcessGroup" &&
      Number.isInteger(message.processGroupId) &&
      message.processGroupId > 1 &&
      isProcessGroupAlive(message.processGroupId)
    ) {
      const target = captureProcessGroup(message.processGroupId);
      this.retainedProcessGroups.set(message.processGroupId, target);
      this.notifyWrapper({
        type: "runtimeTargets",
        runtimeId: `provider-resource-${message.processGroupId}`,
        processGroupIds: [message.processGroupId],
        processGroups: [target],
      });
      return;
    }
    if (message?.type === "bound" && typeof message.sessionId === "string") {
      this.bind({ runtimeId: entry.runtimeId, sessionId: message.sessionId });
      return;
    }
    if (
      message?.type === "controllerDetached" &&
      typeof message.generation === "string" &&
      entry.attachedServerGeneration === message.generation
    ) {
      this.release({
        runtimeId: entry.runtimeId,
        generation: message.generation,
      });
      return;
    }
    if (
      message?.type === "providerPid" &&
      Number.isInteger(message.pid) &&
      message.pid > 1
    ) {
      this.rememberProviderProcessGroup(entry, message.pid);
    }
  }

  rememberProviderProcessGroup(entry, processGroupId) {
    try {
      entry.providerProcessGroups.set(
        processGroupId,
        captureProcessGroup(processGroupId),
      );
      this.notifyRuntimeTargets(entry);
    } catch (error) {
      if (isProcessGroupAlive(processGroupId)) throw error;
    }
  }

  notifyRuntimeTargets(entry) {
    this.notifyWrapper({
      type: "runtimeTargets",
      runtimeId: entry.runtimeId,
      processGroupIds: [
        entry.processGroupId,
        ...entry.providerProcessGroups.keys(),
      ],
      processGroups: [
        entry.processGroup,
        ...entry.providerProcessGroups.values(),
      ],
    });
  }

  bind(request) {
    const runtimeId = this.requireString(request.runtimeId, "runtimeId");
    const sessionId = this.requireString(request.sessionId, "sessionId");
    const entry = this.runtimes.get(runtimeId);
    if (!entry || !this.isRuntimeAlive(entry)) {
      throw new Error(`Unknown or dead provider runtime ${runtimeId}`);
    }
    if (entry.sessionId && entry.sessionId !== sessionId) {
      throw new Error(`Provider runtime ${runtimeId} is already bound`);
    }
    const duplicate = [...this.runtimes.values()].find(
      (candidate) =>
        candidate.runtimeId !== runtimeId && candidate.sessionId === sessionId,
    );
    if (duplicate) {
      throw new Error(`Provider session ${sessionId} already has a runtime`);
    }
    entry.sessionId = sessionId;
    if (entry.controllerAttached) {
      entry.state = "attached";
      this.clearAttachDeadline(entry);
    } else {
      entry.state = "starting";
      this.armAttachDeadline(entry, "provider runtime controller did not attach");
    }
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
        `Provider runtime ${entry.runtimeId} is controlled by ${currentGeneration}`,
      );
    }
    entry.attachedServerGeneration = generation;
    entry.controllerAttached = false;
    entry.state = "starting";
    entry.detachedAt = undefined;
    this.armAttachDeadline(entry, "claimed provider runtime did not attach");
    return publicRuntimeEntry(entry);
  }

  confirmAttach(request) {
    const runtimeId = this.requireString(request.runtimeId, "runtimeId");
    const generation = this.requireString(request.generation, "generation");
    const entry = this.runtimes.get(runtimeId);
    if (
      !entry ||
      !this.isRuntimeAlive(entry) ||
      entry.attachedServerGeneration !== generation
    ) {
      throw new Error(`Provider runtime ${runtimeId} is not claimed by ${generation}`);
    }
    entry.controllerAttached = true;
    if (entry.sessionId) {
      entry.state = "attached";
      this.clearAttachDeadline(entry);
    } else {
      entry.state = "starting";
      this.armAttachDeadline(entry, "provider runtime identity was not bound");
    }
    return publicRuntimeEntry(entry);
  }

  release(request) {
    const runtimeId = this.requireString(request.runtimeId, "runtimeId");
    const generation = this.requireString(request.generation, "generation");
    const entry = this.runtimes.get(runtimeId);
    if (!entry || entry.attachedServerGeneration !== generation) return {};
    if (entry.state === "closing") return {};
    entry.attachedServerGeneration = undefined;
    entry.controllerAttached = false;
    entry.state = "detached";
    entry.detachedAt = new Date().toISOString();
    this.armAttachDeadline(entry, "replacement server did not attach");
    return {};
  }

  retainProcessGroup(request) {
    const generation = this.requireString(request.generation, "generation");
    if (!this.registeredServers.has(generation)) {
      throw new Error(`Server generation ${generation} is not registered`);
    }
    const processGroupId = Number(request.processGroupId);
    if (!Number.isInteger(processGroupId) || processGroupId <= 1) {
      throw new Error("Invalid retained process group");
    }
    if (!isProcessGroupAlive(processGroupId)) {
      throw new Error(`Process group ${processGroupId} is not alive`);
    }
    const target = captureProcessGroup(processGroupId);
    this.retainedProcessGroups.set(processGroupId, target);
    this.notifyWrapper({
      type: "runtimeTargets",
      runtimeId: `provider-resource-${processGroupId}`,
      processGroupIds: [processGroupId],
      processGroups: [target],
    });
    return { processGroupId };
  }

  detachGeneration(generation) {
    for (const entry of this.runtimes.values()) {
      if (entry.attachedServerGeneration !== generation) continue;
      entry.attachedServerGeneration = undefined;
      entry.controllerAttached = false;
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
          `[ProviderRuntimeHost] Failed to reap ${entry.runtimeId}: ${errorMessage(error)}\n`,
        );
      });
    }, this.attachTimeoutMs);
  }

  async handleRuntimeExit(runtimeId) {
    try {
      await this.terminateRuntime(runtimeId, "provider worker exited");
    } catch (error) {
      process.stderr.write(
        `[ProviderRuntimeHost] Exit cleanup failed for ${runtimeId}: ${errorMessage(error)}\n`,
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
      if (entry.child.connected) {
        try {
          entry.child.send({ type: "shutdown", reason });
        } catch {}
      }
      const cooperativeDeadline = Date.now() + COOPERATIVE_STOP_MS;
      while (
        entry.child.exitCode === null &&
        entry.child.signalCode === null &&
        Date.now() < cooperativeDeadline
      ) {
        await delay(25);
      }
      const targets = new Map(entry.providerProcessGroups);
      targets.set(entry.processGroupId, entry.processGroup);
      const results = await Promise.allSettled(
        [...targets.values()].map(terminateProcessGroup),
      );
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length > 0) {
        throw new Error(
          `${failures.length} provider runtime process group(s) survived cleanup`,
        );
      }
      this.finishRuntimeRemoval(entry, reason);
    })();
    return await entry.terminationPromise;
  }

  finishRuntimeRemoval(entry, reason) {
    this.clearAttachDeadline(entry);
    this.runtimes.delete(entry.runtimeId);
    removePathIfPresent(entry.socketPath);
    this.notifyWrapper({
      type: "runtimeExited",
      runtimeId: entry.runtimeId,
      processGroupIds: [
        entry.processGroupId,
        ...entry.providerProcessGroups.keys(),
      ],
      processGroups: [
        entry.processGroup,
        ...entry.providerProcessGroups.values(),
      ],
      reason,
    });
  }

  async shutdown(reason = "wrapper shutdown") {
    if (this.shuttingDown) return await this.shuttingDown;
    this.shuttingDown = (async () => {
      for (const socket of this.registeredServers.values()) socket.destroy();
      this.registeredServers.clear();
      const results = await Promise.allSettled(
        [...this.runtimes.keys()].map((runtimeId) =>
          this.terminateRuntime(runtimeId, reason),
        ),
      );
      const failures = results.filter((result) => result.status === "rejected");
      const retainedResults = await Promise.allSettled(
        [...this.retainedProcessGroups.values()].map(terminateProcessGroup),
      );
      this.retainedProcessGroups.clear();
      failures.push(
        ...retainedResults.filter((result) => result.status === "rejected"),
      );
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
          `${failures.length} provider runtime(s) survived shutdown`,
        );
      }
    })();
    return await this.shuttingDown;
  }
}

async function main() {
  const runtimeDir = process.env.YEP_PROVIDER_RUNTIME_DIR;
  const controlSocketPath = process.env.YEP_PROVIDER_RUNTIME_SOCKET;
  const token = process.env.YEP_PROVIDER_RUNTIME_TOKEN;
  if (!runtimeDir || !controlSocketPath || !token) {
    throw new Error(
      "YEP_PROVIDER_RUNTIME_DIR, YEP_PROVIDER_RUNTIME_SOCKET, and YEP_PROVIDER_RUNTIME_TOKEN are required",
    );
  }
  const host = new ProviderRuntimeHost({
    runtimeDir,
    controlSocketPath,
    token,
    notifyWrapper(message) {
      if (typeof process.send === "function" && process.connected) {
        process.send(message);
      }
    },
  });
  const shutdown = (reason) => {
    void host
      .shutdown(reason)
      .then(() => process.exit(0))
      .catch((error) => {
        process.stderr.write(`[ProviderRuntimeHost] ${errorMessage(error)}\n`);
        process.exit(1);
      });
  };
  process.on("message", (message) => {
    if (message?.type === "shutdown") shutdown(message.reason);
  });
  process.on("disconnect", () => shutdown("wrapper IPC closed"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  await host.start();
  process.stdout.write(
    `[ProviderRuntimeHost] Listening at ${basename(controlSocketPath)}\n`,
  );
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`[ProviderRuntimeHost] ${errorMessage(error)}\n`);
    process.exit(1);
  });
}
