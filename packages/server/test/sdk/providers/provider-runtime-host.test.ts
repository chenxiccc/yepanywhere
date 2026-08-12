import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error The wrapper lifecycle host intentionally runs as plain ESM.
import {
  ProviderRuntimeHost,
  resolveProviderRuntimeWorkerPath,
  withAgentLaunchEnvironment,
} from "../../../../../scripts/provider-runtime-host.mjs";
// @ts-expect-error Stable discovery intentionally runs as plain Node ESM.
import {
  captureProcessIdentity,
  createProviderHostToken,
  discoverProviderHost,
  readLinuxProcessStartTime,
  readProviderHostReceipts,
  recoverProviderHost,
  requestProviderHost,
  resolveProviderHostPaths,
  writeProviderHostDescriptor,
  writeProviderHostReceipts,
} from "../../../../../scripts/provider-runtime-discovery.mjs";
import {
  closeProviderRuntimeHostRegistration,
  initializeProviderRuntimeHost,
  startHostedProviderSession,
} from "../../../src/sdk/providers/provider-runtime-host.js";

const temporaryPaths: string[] = [];
const fixtureWorker = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/fake-provider-runtime-worker.mjs",
);
const providerHostEntrypoint = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../scripts/provider-runtime-host.mjs",
);

describe("resolveProviderRuntimeWorkerPath", () => {
  it("uses an explicit absolute worker path for harness-controlled runtimes", () => {
    expect(
      resolveProviderRuntimeWorkerPath({
        YEP_PROVIDER_RUNTIME_WORKER_PATH: fixtureWorker,
      }),
    ).toBe(fixtureWorker);
  });

  it("keeps the production worker as the default", () => {
    expect(resolveProviderRuntimeWorkerPath({})).toMatch(
      /provider-runtime-worker\.ts$/,
    );
  });
});

describe("withAgentLaunchEnvironment", () => {
  it("replaces inherited markers with the provider launch facts", () => {
    expect(
      withAgentLaunchEnvironment(
        "claude-gateway",
        { model: "gpt-5.6-sol", effort: "high" },
        {
          KEEP_ME: "yes",
          YEP_AGENT_HARNESS: "codex",
          YEP_AGENT_INITIAL_MODEL: "ambient-model",
          YEP_AGENT_INITIAL_EFFORT: "ambient-effort",
        },
      ),
    ).toEqual({
      KEEP_ME: "yes",
      YEP_AGENT_HARNESS: "claude",
      YEP_AGENT_INITIAL_MODEL: "gpt-5.6-sol",
      YEP_AGENT_INITIAL_EFFORT: "high",
    });
  });

  it("removes unavailable optional launch facts", () => {
    expect(
      withAgentLaunchEnvironment(
        "pi",
        {},
        {
          YEP_AGENT_INITIAL_MODEL: "ambient-model",
          YEP_AGENT_INITIAL_EFFORT: "ambient-effort",
        },
      ),
    ).toEqual({ YEP_AGENT_HARNESS: "pi" });
  });
});

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs = 3_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("child exit timed out"));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

async function waitForAvailableHost(
  paths: NonNullable<ReturnType<typeof resolveProviderHostPaths>>,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const discovery = await discoverProviderHost(paths, { timeoutMs: 250 });
    if (discovery.state === "available") return discovery;
    if (Date.now() >= deadline) {
      throw new Error(`provider host stayed ${discovery.state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function collectProviderHostStream(
  connection: {
    descriptor: { controlSocketPath: string; hostProtocolVersion: number };
    token: string;
  },
  request: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const socket = createConnection(connection.descriptor.controlSocketPath);
  socket.setEncoding("utf8");
  let buffer = "";
  const records: Array<Record<string, unknown>> = [];
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("provider host stream timed out"));
    }, 5_000);
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          id: "test-request",
          token: connection.token,
          protocolVersion: connection.descriptor.hostProtocolVersion,
          ...request,
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as Record<string, unknown>;
        records.push(record);
        if (record.type === "terminal" || record.type === "error") {
          clearTimeout(timeout);
          socket.destroy();
          resolve(records);
        }
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.on("close", () => {
      if (
        records.some(
          (record) => record.type === "terminal" || record.type === "error",
        )
      ) {
        return;
      }
      clearTimeout(timeout);
      reject(new Error("provider host stream closed before a terminal record"));
    });
  });
}

function processGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

afterEach(async () => {
  closeProviderRuntimeHostRegistration();
  vi.restoreAllMocks();
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform !== "linux")("ProviderRuntimeHost", () => {
  it("publishes one private stable descriptor for a foreground host", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-host-stable-"));
    temporaryPaths.push(runtimeRoot);
    const paths = resolveProviderHostPaths({
      YEP_PROVIDER_HOST_RUNTIME_DIR: runtimeRoot,
    });
    if (!paths) throw new Error("expected Linux provider host paths");
    const host = spawn(
      process.execPath,
      [providerHostEntrypoint, "--headless"],
      {
        cwd: dirname(providerHostEntrypoint),
        env: {
          ...process.env,
          YEP_PROVIDER_HOST_RUNTIME_DIR: runtimeRoot,
          YEP_PROVIDER_RUNTIME_WORKER_PATH: fixtureWorker,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    try {
      const connection = await waitForAvailableHost(paths);
      expect(connection.descriptor).toMatchObject({
        descriptorVersion: 1,
        hostProtocolVersion: 2,
        features: ["runtime-control", "session-turn"],
        controlSocketPath: paths.controlSocketPath,
        tokenFilePath: paths.tokenPath,
        owner: {
          pid: host.pid,
          startTime: expect.any(String),
        },
        sourceIdentity: {
          projectRoot: expect.any(String),
          hostSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          workerSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        buildIdentity: expect.any(String),
      });
      for (const path of [
        paths.descriptorPath,
        paths.tokenPath,
        paths.controlSocketPath,
      ]) {
        expect((await stat(path)).mode & 0o077).toBe(0);
      }

      const duplicate = spawn(
        process.execPath,
        [providerHostEntrypoint, "--headless"],
        {
          cwd: dirname(providerHostEntrypoint),
          env: {
            ...process.env,
            YEP_PROVIDER_HOST_RUNTIME_DIR: runtimeRoot,
            YEP_PROVIDER_RUNTIME_WORKER_PATH: fixtureWorker,
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      const duplicateError: Buffer[] = [];
      duplicate.stderr?.on("data", (chunk: Buffer) => {
        duplicateError.push(chunk);
      });
      expect((await waitForChildExit(duplicate)).code).toBe(1);
      expect(Buffer.concat(duplicateError).toString("utf8")).toContain(
        "already starting or running",
      );
    } finally {
      if (host.exitCode === null && host.signalCode === null) {
        host.kill("SIGTERM");
      }
      await waitForChildExit(host).catch(() => {
        host.kill("SIGKILL");
      });
    }

    await waitUntil(() => !existsSync(paths.descriptorPath));
    expect(existsSync(paths.controlSocketPath)).toBe(false);
    expect(existsSync(paths.tokenPath)).toBe(false);
    expect(existsSync(paths.lockPath)).toBe(false);
  });

  it("launches and exchanges a bounded turn without Hono", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-host-turn-"));
    temporaryPaths.push(runtimeRoot);
    const paths = resolveProviderHostPaths({
      YEP_PROVIDER_HOST_RUNTIME_DIR: runtimeRoot,
    });
    if (!paths) throw new Error("expected Linux provider host paths");
    const host = spawn(
      process.execPath,
      [providerHostEntrypoint, "--headless"],
      {
        cwd: dirname(providerHostEntrypoint),
        env: {
          ...process.env,
          YEP_PROVIDER_HOST_RUNTIME_DIR: runtimeRoot,
          YEP_PROVIDER_RUNTIME_WORKER_PATH: fixtureWorker,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    try {
      const connection = await waitForAvailableHost(paths);
      const request = {
        op: "sessionTurn",
        submissionId: "headless-turn-1",
        target: {
          harness: "claude",
          providerSessionId: "durable-provider-session",
          yaSessionId: "canonical-ya-session",
        },
        message: { text: "answer from the incumbent worker" },
        launch: {
          providerName: "claude",
          projectPath: runtimeRoot,
          options: {},
          runtimeConfig: {},
        },
      };
      const records = await collectProviderHostStream(connection, request);
      expect(records.map((record) => record.type)).toEqual([
        "accepted",
        "providerEvent",
        "providerEvent",
        "providerEvent",
        "terminal",
      ]);
      expect(records[0]).toMatchObject({
        submissionId: "headless-turn-1",
        harness: "claude",
        providerSessionId: "durable-provider-session",
        yaSessionId: "canonical-ya-session",
      });
      expect(records.at(-1)).toMatchObject({
        outcome: "completed",
        receipt: {
          providerSessionId: "durable-provider-session",
          lastProviderEventSequence: 3,
        },
      });

      const replay = await collectProviderHostStream(connection, request);
      expect(replay).toEqual(records);
      await expect(
        requestProviderHost(
          {
            controlSocketPath: connection.descriptor.controlSocketPath,
            token: connection.token,
            protocolVersion: connection.descriptor.hostProtocolVersion,
          },
          { op: "inventory" },
        ),
      ).resolves.toHaveLength(1);
      const conflict = await collectProviderHostStream(connection, {
        ...request,
        message: { text: "a different request with the same id" },
      });
      expect(conflict.at(-1)).toMatchObject({
        type: "error",
        outcome: "submission-id-conflict",
        accepted: false,
      });
      const ownershipMismatch = await collectProviderHostStream(connection, {
        ...request,
        submissionId: "headless-turn-owner-mismatch",
        target: {
          ...request.target,
          yaSessionId: "not-the-owning-ya-session",
        },
      });
      expect(ownershipMismatch.at(-1)).toMatchObject({
        type: "error",
        outcome: "ownership-unknown",
        accepted: false,
      });
      const incompatible = await collectProviderHostStream(connection, {
        ...request,
        submissionId: "headless-turn-incompatible",
        protocolVersion: 999,
      });
      expect(incompatible.at(-1)).toMatchObject({
        type: "error",
        outcome: "incompatible",
        accepted: false,
      });

      const codexRecords = await collectProviderHostStream(connection, {
        op: "sessionTurn",
        submissionId: "headless-codex-turn",
        target: {
          harness: "codex",
          providerSessionId: "durable-codex-session",
        },
        message: { text: "use the same provider-neutral host path" },
        launch: {
          providerName: "codex",
          projectPath: runtimeRoot,
          options: {},
          runtimeConfig: {},
        },
      });
      expect(codexRecords.at(-1)).toMatchObject({
        type: "terminal",
        outcome: "completed",
        receipt: { providerSessionId: "durable-codex-session" },
      });
    } finally {
      if (host.exitCode === null && host.signalCode === null) {
        host.kill("SIGTERM");
      }
      await waitForChildExit(host).catch(() => host.kill("SIGKILL"));
    }
  });

  it("recovers only a stale host with verified process identities", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-host-stale-"));
    temporaryPaths.push(runtimeRoot);
    const paths = resolveProviderHostPaths({
      YEP_PROVIDER_HOST_RUNTIME_DIR: runtimeRoot,
    });
    if (!paths) throw new Error("expected Linux provider host paths");
    const owner = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        stdio: "ignore",
      },
    );
    const worker = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { detached: true, stdio: "ignore" },
    );
    if (!owner.pid || !worker.pid)
      throw new Error("fixture process did not start");

    try {
      await waitUntil(
        () =>
          readLinuxProcessStartTime(owner.pid ?? 0) !== null &&
          readLinuxProcessStartTime(worker.pid ?? 0) !== null,
      );
      const ownerIdentity = captureProcessIdentity(owner.pid);
      const workerStartTime = readLinuxProcessStartTime(worker.pid);
      if (!workerStartTime) throw new Error("worker identity unavailable");
      createProviderHostToken(paths.tokenPath);
      writeProviderHostDescriptor(paths, {
        descriptorId: "stale-host",
        hostProtocolVersion: 2,
        features: ["runtime-control"],
        controlSocketPath: paths.controlSocketPath,
        tokenFilePath: paths.tokenPath,
        owner: ownerIdentity,
        startedAt: new Date().toISOString(),
        sourceIdentity: { projectRoot: runtimeRoot },
        buildIdentity: "test",
        processGroups: [
          {
            processGroupId: worker.pid,
            leaderStartTime: workerStartTime,
          },
        ],
      });
      await writeFile(paths.lockPath, `${JSON.stringify(ownerIdentity)}\n`, {
        mode: 0o600,
      });
      writeProviderHostReceipts(paths, [
        {
          submissionId: "accepted-before-recovery",
          state: "accepted",
          accepted: true,
          acceptedAt: "2026-08-12T00:00:00.000Z",
        },
      ]);
      const discovery = await discoverProviderHost(paths, { timeoutMs: 50 });
      expect(discovery.state).toBe("unresponsive");
      if (discovery.state !== "unresponsive") return;

      await expect(
        recoverProviderHost(paths, discovery.descriptor),
      ).resolves.toEqual({
        outcome: "interrupted-by-host-recovery",
        descriptorId: "stale-host",
        processGroupCount: 1,
        interruptedSubmissionIds: ["accepted-before-recovery"],
      });

      await waitUntil(() => !processGroupAlive(worker.pid ?? 0));
      expect(readLinuxProcessStartTime(owner.pid)).toBeNull();
      expect(existsSync(paths.descriptorPath)).toBe(false);
      expect(existsSync(paths.tokenPath)).toBe(false);
      expect(existsSync(paths.lockPath)).toBe(false);
      expect(readProviderHostReceipts(paths)).toEqual([
        expect.objectContaining({
          submissionId: "accepted-before-recovery",
          state: "terminal",
          outcome: "interrupted-by-host-recovery",
        }),
      ]);
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) {
        owner.kill("SIGKILL");
      }
      if (processGroupAlive(worker.pid)) process.kill(-worker.pid, "SIGKILL");
    }
  });

  it("fails closed when a stale descriptor PID identity is ambiguous", async () => {
    const runtimeRoot = await mkdtemp(
      join(tmpdir(), "provider-host-ambiguous-"),
    );
    temporaryPaths.push(runtimeRoot);
    const paths = resolveProviderHostPaths({
      YEP_PROVIDER_HOST_RUNTIME_DIR: runtimeRoot,
    });
    if (!paths) throw new Error("expected Linux provider host paths");
    const owner = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        stdio: "ignore",
      },
    );
    if (!owner.pid) throw new Error("fixture process did not start");

    try {
      createProviderHostToken(paths.tokenPath);
      writeProviderHostDescriptor(paths, {
        descriptorId: "ambiguous-host",
        hostProtocolVersion: 2,
        features: ["runtime-control"],
        controlSocketPath: paths.controlSocketPath,
        tokenFilePath: paths.tokenPath,
        owner: { pid: owner.pid, startTime: "not-the-current-process" },
        startedAt: new Date().toISOString(),
        sourceIdentity: { projectRoot: runtimeRoot },
        buildIdentity: "test",
        processGroups: [],
      });
      const discovery = await discoverProviderHost(paths, { timeoutMs: 50 });
      expect(discovery.state).toBe("unresponsive");
      if (discovery.state !== "unresponsive") return;

      await expect(
        recoverProviderHost(paths, discovery.descriptor),
      ).rejects.toThrow("PID identity is ambiguous");
      expect(readLinuxProcessStartTime(owner.pid)).not.toBeNull();
      expect(existsSync(paths.descriptorPath)).toBe(true);
    } finally {
      owner.kill("SIGKILL");
    }
  });

  it("injects the same launch identity locally and remotely", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-host-test-"));
    temporaryPaths.push(runtimeRoot);
    const host = new ProviderRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath: join(runtimeRoot, "host.sock"),
      token: "test-token",
      workerPath: fixtureWorker,
    });
    await host.start();
    const owner = { destroy() {} };
    host.registeredServers.set("one", owner);

    const launched = await host.handleRequest(
      {
        token: "test-token",
        protocolVersion: 2,
        op: "launch",
        generation: "one",
        providerName: "claude-gateway",
        projectPath: runtimeRoot,
        options: {
          cwd: runtimeRoot,
          model: "gpt-5.6-sol",
          effort: "high",
          remoteEnv: { REMOTE_KEEP_ME: "yes" },
        },
      },
      owner,
    );

    expect(launched.worker.agentLaunchEnvironment).toEqual({
      harness: "claude",
      model: "gpt-5.6-sol",
      effort: "high",
    });
    expect(launched.worker.remoteAgentLaunchEnvironment).toEqual({
      REMOTE_KEEP_ME: "yes",
      YEP_AGENT_HARNESS: "claude",
      YEP_AGENT_INITIAL_MODEL: "gpt-5.6-sol",
      YEP_AGENT_INITIAL_EFFORT: "high",
    });

    await host.shutdown("launch environment test complete");
  });

  it("retains a worker for replacement and reaps it after attach timeout", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-host-test-"));
    temporaryPaths.push(runtimeRoot);
    const host = new ProviderRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath: join(runtimeRoot, "host.sock"),
      token: "test-token",
      attachTimeoutMs: 150,
      workerPath: fixtureWorker,
    });
    await host.start();
    const owner = { destroy() {} };
    host.registeredServers.set("one", owner);

    const launched = await host.handleRequest(
      {
        token: "test-token",
        protocolVersion: 2,
        op: "launch",
        generation: "one",
        providerName: "claude",
        projectPath: runtimeRoot,
        options: { cwd: runtimeRoot },
      },
      owner,
    );
    await host.bind({ runtimeId: launched.runtimeId, sessionId: "session-1" });
    host.confirmAttach({ runtimeId: launched.runtimeId, generation: "one" });
    expect(processGroupAlive(launched.processGroupId)).toBe(true);

    host.detachGeneration("one");
    host.registeredServers.delete("one");
    host.registeredServers.set("two", owner);
    const reclaimed = host.claim({
      generation: "two",
      sessionId: "session-1",
    });
    expect(reclaimed?.runtimeId).toBe(launched.runtimeId);
    host.confirmAttach({ runtimeId: launched.runtimeId, generation: "two" });

    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(processGroupAlive(launched.processGroupId)).toBe(true);

    host.release({ runtimeId: launched.runtimeId, generation: "two" });
    await waitUntil(() => !processGroupAlive(launched.processGroupId));
    await waitUntil(() => !host.runtimes.has(launched.runtimeId));
    expect(host.runtimes.size).toBe(0);
    await host.shutdown("test complete");
  });

  it("reaps all workers on terminal host shutdown", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-host-test-"));
    temporaryPaths.push(runtimeRoot);
    const host = new ProviderRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath: join(runtimeRoot, "host.sock"),
      token: "test-token",
      workerPath: fixtureWorker,
    });
    await host.start();
    const owner = { destroy() {} };
    host.registeredServers.set("one", owner);
    const launched = await host.handleRequest(
      {
        token: "test-token",
        protocolVersion: 2,
        op: "launch",
        generation: "one",
        providerName: "pi",
        projectPath: runtimeRoot,
        options: { cwd: runtimeRoot },
      },
      owner,
    );

    await host.shutdown("terminal test");

    expect(processGroupAlive(launched.processGroupId)).toBe(false);
    expect(host.runtimes.size).toBe(0);
  });

  it("refuses to launch a second live runtime for one session", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-host-test-"));
    temporaryPaths.push(runtimeRoot);
    const host = new ProviderRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath: join(runtimeRoot, "host.sock"),
      token: "test-token",
      workerPath: fixtureWorker,
    });
    await host.start();
    const owner = { destroy() {} };
    host.registeredServers.set("one", owner);
    const launchRequest = {
      token: "test-token",
      protocolVersion: 2,
      op: "launch",
      generation: "one",
      providerName: "claude",
      projectPath: runtimeRoot,
      sessionId: "one-session",
      options: { cwd: runtimeRoot },
    };
    const first = await host.handleRequest(launchRequest, owner);
    host.confirmAttach({ runtimeId: first.runtimeId, generation: "one" });

    await expect(host.handleRequest(launchRequest, owner)).rejects.toThrow(
      "Provider session one-session already has a runtime",
    );
    expect(host.runtimes.size).toBe(1);

    await host.shutdown("duplicate launch test complete");
  });

  it("retries failed cleanup before rebinding a closing session", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-host-test-"));
    temporaryPaths.push(runtimeRoot);
    let cleanupAttempts = 0;
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const host = new ProviderRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath: join(runtimeRoot, "host.sock"),
      token: "test-token",
      workerPath: fixtureWorker,
      terminateGroup: async () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) {
          throw new Error("simulated cleanup failure");
        }
      },
    });
    await host.start();
    const owner = { destroy() {} };
    host.registeredServers.set("one", owner);
    const first = await host.handleRequest(
      {
        token: "test-token",
        protocolVersion: 2,
        op: "launch",
        generation: "one",
        providerName: "claude",
        projectPath: runtimeRoot,
        sessionId: "recover-session",
        options: { cwd: runtimeRoot },
      },
      owner,
    );
    host.confirmAttach({ runtimeId: first.runtimeId, generation: "one" });

    await expect(
      host.terminateRuntime(first.runtimeId, "simulated failure"),
    ).rejects.toThrow("survived cleanup");
    expect(host.runtimes.get(first.runtimeId)?.state).toBe("closing");
    expect(host.runtimes.get(first.runtimeId)?.terminationPromise).toBeNull();
    expect(
      host.claim({ generation: "one", sessionId: "recover-session" }),
    ).toBeNull();

    const second = await host.handleRequest(
      {
        token: "test-token",
        protocolVersion: 2,
        op: "launch",
        generation: "one",
        providerName: "claude",
        projectPath: runtimeRoot,
        options: { cwd: runtimeRoot },
      },
      owner,
    );
    await host.bind({
      runtimeId: second.runtimeId,
      sessionId: "recover-session",
    });
    host.confirmAttach({ runtimeId: second.runtimeId, generation: "one" });

    expect(host.runtimes.has(first.runtimeId)).toBe(false);
    expect(
      host.claim({ generation: "one", sessionId: "recover-session" })
        ?.runtimeId,
    ).toBe(second.runtimeId);
    expect(cleanupAttempts).toBe(2);

    await host.shutdown("cleanup retry test complete");
  });

  it("serializes concurrent launches after stale cleanup", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-host-test-"));
    temporaryPaths.push(runtimeRoot);
    let cleanupAttempts = 0;
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const host = new ProviderRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath: join(runtimeRoot, "host.sock"),
      token: "test-token",
      workerPath: fixtureWorker,
      terminateGroup: async () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) {
          throw new Error("simulated cleanup failure");
        }
      },
    });
    await host.start();
    const owner = { destroy() {} };
    host.registeredServers.set("one", owner);
    const launchRequest = {
      token: "test-token",
      protocolVersion: 2,
      op: "launch",
      generation: "one",
      providerName: "claude",
      projectPath: runtimeRoot,
      sessionId: "replacement-session",
      options: { cwd: runtimeRoot },
    };
    const first = await host.handleRequest(launchRequest, owner);
    host.confirmAttach({ runtimeId: first.runtimeId, generation: "one" });
    await expect(
      host.terminateRuntime(first.runtimeId, "simulated failure"),
    ).rejects.toThrow("survived cleanup");

    const replacements = await Promise.allSettled([
      host.handleRequest(launchRequest, owner),
      host.handleRequest(launchRequest, owner),
    ]);

    expect(
      replacements.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      replacements.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(host.runtimes.size).toBe(1);
    expect(cleanupAttempts).toBe(2);

    await host.shutdown("concurrent replacement test complete");
  });

  it("reaps a claimed runtime when its controller never attaches", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-host-test-"));
    temporaryPaths.push(runtimeRoot);
    const host = new ProviderRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath: join(runtimeRoot, "host.sock"),
      token: "test-token",
      attachTimeoutMs: 100,
      workerPath: fixtureWorker,
    });
    await host.start();
    const owner = { destroy() {} };
    host.registeredServers.set("one", owner);
    const launched = await host.handleRequest(
      {
        token: "test-token",
        protocolVersion: 2,
        op: "launch",
        generation: "one",
        providerName: "claude",
        projectPath: runtimeRoot,
        sessionId: "unattached-session",
        options: { cwd: runtimeRoot },
      },
      owner,
    );

    await waitUntil(() => !processGroupAlive(launched.processGroupId));
    await waitUntil(() => !host.runtimes.has(launched.runtimeId));
    await host.shutdown("unattached test complete");
  });

  it("reaps wrapper-lifetime provider resources on terminal shutdown", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-host-test-"));
    temporaryPaths.push(runtimeRoot);
    const host = new ProviderRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath: join(runtimeRoot, "host.sock"),
      token: "test-token",
      workerPath: fixtureWorker,
    });
    await host.start();
    const owner = { destroy() {} };
    host.registeredServers.set("one", owner);
    const resource = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { detached: true, stdio: "ignore" },
    );
    if (!resource.pid) throw new Error("resource process did not start");

    try {
      await host.handleRequest(
        {
          token: "test-token",
          protocolVersion: 2,
          op: "retainProcessGroup",
          generation: "one",
          processGroupId: resource.pid,
        },
        owner,
      );
      expect(processGroupAlive(resource.pid)).toBe(true);

      await host.shutdown("terminal resource test");

      expect(processGroupAlive(resource.pid)).toBe(false);
    } finally {
      if (processGroupAlive(resource.pid)) {
        process.kill(-resource.pid, "SIGKILL");
      }
    }
  });

  it("does not signal a process group whose Linux identity changed", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-host-test-"));
    temporaryPaths.push(runtimeRoot);
    const host = new ProviderRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath: join(runtimeRoot, "host.sock"),
      token: "test-token",
      workerPath: fixtureWorker,
    });
    await host.start();
    const resource = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { detached: true, stdio: "ignore" },
    );
    if (!resource.pid) throw new Error("resource process did not start");
    host.retainedProcessGroups.set(resource.pid, {
      processGroupId: resource.pid,
      leaderStartTime: "not-the-current-process",
    });

    try {
      await host.shutdown("stale identity test");
      expect(processGroupAlive(resource.pid)).toBe(true);
    } finally {
      if (processGroupAlive(resource.pid)) {
        process.kill(-resource.pid, "SIGKILL");
      }
    }
  });

  it("holds replayed callbacks until Process installs its handlers", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-proxy-test-"));
    temporaryPaths.push(runtimeRoot);
    const controlSocketPath = join(runtimeRoot, "host.sock");
    const host = new ProviderRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath,
      token: "callback-token",
      workerPath: fixtureWorker,
    });
    await host.start();
    process.env.YEP_PROVIDER_RUNTIME_SOCKET = controlSocketPath;
    process.env.YEP_PROVIDER_RUNTIME_TOKEN = "callback-token";
    process.env.YEP_SERVER_GENERATION = "callbacks";
    expect(await initializeProviderRuntimeHost()).toBe(true);
    let approvalCount = 0;
    const session = await startHostedProviderSession(
      "claude",
      {
        cwd: runtimeRoot,
        onToolApproval: async () => {
          approvalCount += 1;
          return { behavior: "allow" };
        },
      },
      {},
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(approvalCount).toBe(0);
    session.activateCallbacks?.();
    await waitUntil(() => approvalCount === 1);

    await session.abort();
    await host.shutdown("callback test complete");
  });

  it("propagates provider approval cancellation to the active callback", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-proxy-test-"));
    temporaryPaths.push(runtimeRoot);
    const controlSocketPath = join(runtimeRoot, "host.sock");
    const host = new ProviderRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath,
      token: "approval-cancel-token",
      workerPath: fixtureWorker,
    });
    await host.start();
    process.env.YEP_PROVIDER_RUNTIME_SOCKET = controlSocketPath;
    process.env.YEP_PROVIDER_RUNTIME_TOKEN = "approval-cancel-token";
    process.env.YEP_SERVER_GENERATION = "approval-cancel";
    expect(await initializeProviderRuntimeHost()).toBe(true);
    let callbackStarted = false;
    let callbackAborted = false;
    const session = await startHostedProviderSession(
      "pi",
      {
        cwd: runtimeRoot,
        onToolApproval: async (_toolName, _input, options) => {
          callbackStarted = true;
          return await new Promise((resolve) => {
            options.signal.addEventListener(
              "abort",
              () => {
                callbackAborted = true;
                resolve({ behavior: "deny", message: "cancelled" });
              },
              { once: true },
            );
          });
        },
      },
      {},
    );
    session.activateCallbacks?.();

    await waitUntil(() => callbackStarted && callbackAborted);

    await session.abort();
    await host.shutdown("approval cancellation test complete");
  });

  it("reattaches the AgentSession proxy to the same worker", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-proxy-test-"));
    temporaryPaths.push(runtimeRoot);
    const controlSocketPath = join(runtimeRoot, "host.sock");
    const host = new ProviderRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath,
      token: "proxy-token",
      workerPath: fixtureWorker,
    });
    await host.start();
    process.env.YEP_PROVIDER_RUNTIME_SOCKET = controlSocketPath;
    process.env.YEP_PROVIDER_RUNTIME_TOKEN = "proxy-token";
    process.env.YEP_SERVER_GENERATION = "one";
    expect(await initializeProviderRuntimeHost()).toBe(true);

    const first = await startHostedProviderSession(
      "claude",
      { cwd: runtimeRoot },
      {},
    );
    const firstEvent = await first.iterator.next();
    expect(firstEvent.value?.session_id).toBe("fake-session-1");
    expect(first.getRuntimeUnviewedSince?.()).toBeInstanceOf(Date);
    await first.setRuntimeViewerPresence?.(true);
    expect(first.getRuntimeUnviewedSince?.()).toBeUndefined();
    await first.setRuntimeViewerPresence?.(false);
    const unviewedSince = first.getRuntimeUnviewedSince?.()?.toISOString();
    expect(unviewedSince).toBeDefined();
    const waitingForMore = first.iterator.next();
    await first.publishAgentctlSessionId?.("canonical-session");
    await first.detachForServerReload?.();
    await expect(waitingForMore).resolves.toEqual({
      done: true,
      value: undefined,
    });

    closeProviderRuntimeHostRegistration();
    process.env.YEP_SERVER_GENERATION = "two";
    expect(await initializeProviderRuntimeHost()).toBe(true);
    const second = await startHostedProviderSession(
      "claude",
      { cwd: runtimeRoot, resumeSessionId: "canonical-session" },
      {},
    );
    const secondEvent = await second.iterator.next();
    expect(secondEvent.value?.session_id).toBe("fake-session-2");
    expect(second.getRuntimeUnviewedSince?.()?.toISOString()).toBe(
      unviewedSince,
    );
    expect(host.runtimes.size).toBe(1);

    await second.abort();
    await waitUntil(() => host.runtimes.size === 0);
    await host.shutdown("proxy test complete");
  });
});
