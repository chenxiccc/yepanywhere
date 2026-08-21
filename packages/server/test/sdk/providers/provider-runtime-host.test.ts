import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
  consumeProviderHostRecentRuntimes,
  createProviderHostSourceIdentity,
  createProviderHostToken,
  discoverProviderHost,
  readLinuxProcessStartTime,
  readProviderHostReceipts,
  recoverProviderHost,
  requestProviderHost,
  resolveProviderHostPaths,
  writeProviderHostDescriptor,
  writeProviderHostRecentRuntimes,
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
const projectRoot = join(dirname(providerHostEntrypoint), "..");
const expectedProviderHostIdentity = createProviderHostSourceIdentity({
  projectRoot,
  launcherPath: join(projectRoot, "scripts/dev.js"),
  hostPath: providerHostEntrypoint,
  workerPath: fixtureWorker,
});

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
          AGENT_LAUNCHER: "someone-else",
          AGENT_LAUNCH_HARNESS: "codex",
          AGENT_LAUNCH_MODEL: "ambient-model",
          AGENT_LAUNCH_EFFORT: "ambient-effort",
        },
      ),
    ).toEqual({
      KEEP_ME: "yes",
      AGENT_LAUNCHER: "yepanywhere",
      AGENT_LAUNCH_HARNESS: "claude",
      AGENT_LAUNCH_MODEL: "gpt-5.6-sol",
      AGENT_LAUNCH_EFFORT: "high",
    });
  });

  it("removes unavailable optional launch facts", () => {
    expect(
      withAgentLaunchEnvironment(
        "pi",
        {},
        {
          AGENT_LAUNCH_MODEL: "ambient-model",
          AGENT_LAUNCH_EFFORT: "ambient-effort",
        },
      ),
    ).toEqual({ AGENT_LAUNCHER: "yepanywhere", AGENT_LAUNCH_HARNESS: "pi" });
  });

  it("removes the markers' pre-rename names so a nested launch cannot lie", () => {
    expect(
      withAgentLaunchEnvironment(
        "pi",
        {},
        {
          YEP_AGENT_HARNESS: "codex",
          YEP_AGENT_INITIAL_MODEL: "ambient-model",
          YEP_AGENT_INITIAL_EFFORT: "ambient-effort",
        },
      ),
    ).toEqual({ AGENT_LAUNCHER: "yepanywhere", AGENT_LAUNCH_HARNESS: "pi" });
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
    const discovery = await discoverProviderHost(paths, {
      expectedIdentity: expectedProviderHostIdentity,
      timeoutMs: 250,
    });
    if (discovery.state === "available") return discovery;
    if (Date.now() >= deadline) {
      throw new Error(`provider host stayed ${discovery.state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("provider host source identity", () => {
  it("distinguishes checkouts and hashes imported source changes", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "provider-source-first-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "provider-source-second-"));
    temporaryPaths.push(firstRoot, secondRoot);
    const writeFixture = async (root: string) => {
      await Promise.all([
        writeFile(join(root, "package.json"), '{"version":"1.0.0"}\n'),
        writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n"),
        writeFile(join(root, "launcher.mjs"), 'import "./host.mjs";\n'),
        writeFile(join(root, "host.mjs"), 'import "./host-helper.mjs";\n'),
        writeFile(join(root, "host-helper.mjs"), "export const host = 1;\n"),
        writeFile(join(root, "worker.ts"), 'import "./worker-helper.js";\n'),
        writeFile(join(root, "worker-helper.ts"), "export const worker = 1;\n"),
      ]);
    };
    await writeFixture(firstRoot);
    await writeFixture(secondRoot);
    const identityFor = (root: string) =>
      createProviderHostSourceIdentity({
        projectRoot: root,
        launcherPath: join(root, "launcher.mjs"),
        hostPath: join(root, "host.mjs"),
        workerPath: join(root, "worker.ts"),
      });

    const first = identityFor(firstRoot);
    const second = identityFor(secondRoot);
    expect(first.sourceIdentity.projectRoot).not.toBe(
      second.sourceIdentity.projectRoot,
    );
    expect(first.sourceIdentity.dependencySha256).toBe(
      second.sourceIdentity.dependencySha256,
    );

    await writeFile(
      join(firstRoot, "worker-helper.ts"),
      "export const worker = 2;\n",
    );
    const changedImport = identityFor(firstRoot);
    expect(changedImport.sourceIdentity.workerSha256).toBe(
      first.sourceIdentity.workerSha256,
    );
    expect(changedImport.sourceIdentity.dependencySha256).not.toBe(
      first.sourceIdentity.dependencySha256,
    );

    await writeFile(
      join(firstRoot, "unimported.ts"),
      "export const value = 1;\n",
    );
    expect(identityFor(firstRoot).sourceIdentity.dependencySha256).toBe(
      changedImport.sourceIdentity.dependencySha256,
    );
  });
});

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

async function collectProviderHostUntilAccepted(
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
      reject(new Error("provider host acceptance timed out"));
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
        if (record.type === "accepted") {
          clearTimeout(timeout);
          socket.destroy();
          resolve([...records]);
          return;
        } else if (record.type === "error") {
          clearTimeout(timeout);
          socket.destroy();
          reject(new Error(String(record.error)));
          return;
        }
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
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
        hostProtocolVersion: 3,
        features: [
          "runtime-control",
          "session-turn",
          "session-turn-await",
          "recent-runtime-recovery",
          "provider-session-options",
        ],
        controlSocketPath: paths.controlSocketPath,
        tokenFilePath: paths.tokenPath,
        owner: {
          pid: host.pid,
          startTime: expect.any(String),
        },
        sourceIdentity: {
          version: 1,
          projectRoot: expect.any(String),
          launcherSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          hostSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          workerSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          dependencySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          dependencyCount: expect.any(Number),
        },
        buildIdentity: expect.any(String),
      });
      const differentCheckoutIdentity = structuredClone(
        expectedProviderHostIdentity,
      );
      differentCheckoutIdentity.sourceIdentity.projectRoot = `${projectRoot}-other`;
      await expect(
        discoverProviderHost(paths, {
          expectedIdentity: differentCheckoutIdentity,
          timeoutMs: 250,
        }),
      ).resolves.toMatchObject({
        state: "incompatible",
        incompatibility: "source-identity",
      });
      const changedImportIdentity = structuredClone(
        expectedProviderHostIdentity,
      );
      changedImportIdentity.sourceIdentity.dependencySha256 = "0".repeat(64);
      await expect(
        discoverProviderHost(paths, {
          expectedIdentity: changedImportIdentity,
          timeoutMs: 250,
        }),
      ).resolves.toMatchObject({
        state: "incompatible",
        incompatibility: "source-identity",
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

  it("consumes only fresh private recent-runtime recovery state", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-host-recent-"));
    temporaryPaths.push(runtimeRoot);
    const paths = resolveProviderHostPaths({
      YEP_PROVIDER_HOST_RUNTIME_DIR: runtimeRoot,
    });
    if (!paths) throw new Error("expected Linux provider host paths");
    const candidate = {
      target: {
        harness: "claude",
        providerSessionId: "recent-provider-session",
        yaSessionId: "recent-ya-session",
      },
      launch: {
        providerName: "claude",
        projectPath: runtimeRoot,
        options: { model: "recent-model", effort: "high" },
        runtimeConfig: {},
        reattach: { model: "recent-model", effort: "high" },
      },
    };

    writeProviderHostRecentRuntimes(paths, [candidate]);
    expect((await stat(paths.recentRuntimePath)).mode & 0o077).toBe(0);
    expect(consumeProviderHostRecentRuntimes(paths)).toEqual([
      { ...candidate, expiresAt: expect.any(String) },
    ]);
    expect(existsSync(paths.recentRuntimePath)).toBe(false);

    const writeRaw = async (stoppedAt: string) => {
      await writeFile(
        paths.recentRuntimePath,
        `${JSON.stringify({ version: 1, stoppedAt, candidates: [candidate] })}\n`,
        { mode: 0o600 },
      );
      await chmod(paths.recentRuntimePath, 0o600);
    };
    await writeRaw(new Date(Date.now() - 5 * 60_000 - 1).toISOString());
    expect(consumeProviderHostRecentRuntimes(paths)).toEqual([]);
    await writeRaw(new Date(Date.now() + 1_000).toISOString());
    expect(consumeProviderHostRecentRuntimes(paths)).toEqual([]);

    await writeFile(paths.recentRuntimePath, "{}\n", { mode: 0o600 });
    await chmod(paths.recentRuntimePath, 0o600);
    expect(() => consumeProviderHostRecentRuntimes(paths)).toThrow(
      "recent runtime store version",
    );
    expect(existsSync(paths.recentRuntimePath)).toBe(false);

    writeProviderHostRecentRuntimes(paths, [candidate]);
    await chmod(paths.recentRuntimePath, 0o644);
    expect(() => consumeProviderHostRecentRuntimes(paths)).toThrow(
      "is not private",
    );
    expect(existsSync(paths.recentRuntimePath)).toBe(false);
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
        sessionOptionsResult: {
          automaticTitle: { requested: false, status: "applied" },
          automaticRecaps: { requested: false, status: "applied" },
          agentProgressSummaries: { requested: false, status: "applied" },
          promptSuggestions: { requested: false, status: "applied" },
        },
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
      const recoveryPreferenceConflict = await collectProviderHostStream(
        connection,
        {
          ...request,
          resumeRecentRuntime: true,
        },
      );
      expect(recoveryPreferenceConflict.at(-1)).toMatchObject({
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

  it("detaches after acceptance and resumes one turn from a record cursor", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-host-await-"));
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
      const submissionId = "detached-turn-1";
      const accepted = await collectProviderHostUntilAccepted(connection, {
        op: "sessionTurn",
        submissionId,
        target: {
          harness: "claude",
          providerSessionId: "detached-provider-session",
        },
        message: { text: "finish after the first observer detaches" },
        launch: {
          providerName: "claude",
          projectPath: runtimeRoot,
          options: {},
          runtimeConfig: {},
        },
      });
      expect(accepted).toEqual([
        expect.objectContaining({
          type: "accepted",
          submissionId,
          cursor: 1,
        }),
      ]);

      const resumed = await collectProviderHostStream(connection, {
        op: "awaitSessionTurn",
        submissionId,
        afterCursor: 1,
      });
      expect(resumed.map((record) => record.type)).toEqual([
        "providerEvent",
        "providerEvent",
        "providerEvent",
        "terminal",
      ]);
      expect(resumed.map((record) => record.cursor)).toEqual([2, 3, 4, 5]);

      const alreadyTerminal = await collectProviderHostStream(connection, {
        op: "awaitSessionTurn",
        submissionId,
        afterCursor: 5,
      });
      expect(alreadyTerminal).toEqual([
        expect.objectContaining({
          type: "terminal",
          submissionId,
          cursor: 5,
          replay: "terminal-status",
        }),
      ]);
      const beyondRetainedRecords = await collectProviderHostStream(
        connection,
        {
          op: "awaitSessionTurn",
          submissionId,
          afterCursor: 6,
        },
      );
      expect(beyondRetainedRecords).toEqual([
        expect.objectContaining({
          type: "error",
          outcome: "invalid-cursor",
          accepted: false,
        }),
      ]);
    } finally {
      if (host.exitCode === null && host.signalCode === null) {
        host.kill("SIGTERM");
      }
      await waitForChildExit(host).catch(() => host.kill("SIGKILL"));
    }
  });

  it("lazily resumes a cleanly stopped runtime for a later turn", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-host-restart-"));
    temporaryPaths.push(runtimeRoot);
    const paths = resolveProviderHostPaths({
      YEP_PROVIDER_HOST_RUNTIME_DIR: runtimeRoot,
    });
    if (!paths) throw new Error("expected Linux provider host paths");
    const startHost = () =>
      spawn(process.execPath, [providerHostEntrypoint, "--headless"], {
        cwd: dirname(providerHostEntrypoint),
        env: {
          ...process.env,
          YEP_PROVIDER_HOST_RUNTIME_DIR: runtimeRoot,
          YEP_PROVIDER_RUNTIME_WORKER_PATH: fixtureWorker,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    let host = startHost();
    const target = {
      harness: "claude",
      providerSessionId: "restart-provider-session",
      yaSessionId: "restart-ya-session",
    };

    try {
      const firstConnection = await waitForAvailableHost(paths);
      const first = await collectProviderHostStream(firstConnection, {
        op: "sessionTurn",
        submissionId: "before-clean-restart",
        target,
        message: { text: "establish the hosted runtime" },
        launch: {
          providerName: "claude",
          projectPath: runtimeRoot,
          options: { model: "restart-model", effort: "high" },
          runtimeConfig: {},
        },
      });
      expect(first.at(-1)).toMatchObject({
        type: "terminal",
        outcome: "completed",
      });

      host.kill("SIGTERM");
      expect((await waitForChildExit(host)).code).toBe(0);
      expect(existsSync(paths.recentRuntimePath)).toBe(true);
      expect((await stat(paths.recentRuntimePath)).mode & 0o077).toBe(0);

      host = startHost();
      const replacementConnection = await waitForAvailableHost(paths);
      expect(existsSync(paths.recentRuntimePath)).toBe(false);
      const receiptOnlyReplay = await collectProviderHostStream(
        replacementConnection,
        {
          op: "awaitSessionTurn",
          submissionId: "before-clean-restart",
        },
      );
      expect(receiptOnlyReplay).toEqual([
        expect.objectContaining({
          type: "terminal",
          submissionId: "before-clean-restart",
          cursor: null,
          replay: "receipt-only",
          outcome: "completed",
        }),
      ]);
      const ownershipMismatch = await collectProviderHostStream(
        replacementConnection,
        {
          op: "sessionTurn",
          submissionId: "after-clean-restart-owner-mismatch",
          target: { ...target, yaSessionId: "not-the-owning-session" },
          message: { text: "do not use a mismatched recovery recipe" },
          resumeRecentRuntime: true,
        },
      );
      expect(ownershipMismatch).toEqual([
        expect.objectContaining({
          type: "error",
          outcome: "ownership-unknown",
          accepted: false,
        }),
      ]);
      const resumed = await collectProviderHostStream(replacementConnection, {
        op: "sessionTurn",
        submissionId: "after-clean-restart",
        target: {
          harness: target.harness,
          providerSessionId: target.providerSessionId,
        },
        message: { text: "resume through the replacement host" },
        resumeRecentRuntime: true,
      });

      expect(resumed.map((record) => record.type)).toEqual([
        "accepted",
        "providerEvent",
        "providerEvent",
        "providerEvent",
        "terminal",
      ]);
      expect(resumed[0]).toMatchObject({
        providerSessionId: target.providerSessionId,
        yaSessionId: target.yaSessionId,
      });
      expect(resumed.at(-1)).toMatchObject({
        outcome: "completed",
        receipt: { providerSessionId: target.providerSessionId },
      });
      const inventory = (await requestProviderHost(
        {
          controlSocketPath: replacementConnection.descriptor.controlSocketPath,
          token: replacementConnection.token,
          protocolVersion: replacementConnection.descriptor.hostProtocolVersion,
        },
        { op: "inventory" },
      )) as Array<{
        providerSessionId: string;
        yaSessionId: string;
        worker: {
          agentLaunchEnvironment: { model: string; effort: string };
        };
      }>;
      expect(inventory).toEqual([
        expect.objectContaining({
          providerSessionId: target.providerSessionId,
          yaSessionId: target.yaSessionId,
          worker: expect.objectContaining({
            agentLaunchEnvironment: expect.objectContaining({
              model: "restart-model",
              effort: "high",
            }),
          }),
        }),
      ]);
    } finally {
      if (host.exitCode === null && host.signalCode === null) {
        host.kill("SIGTERM");
      }
      await waitForChildExit(host).catch(() => host.kill("SIGKILL"));
    }
  }, 15_000);

  it("does not report acceptance before its recovery receipt is durable", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-host-receipt-"));
    temporaryPaths.push(runtimeRoot);
    const controlSocketPath = join(runtimeRoot, "host.sock");
    const host = new ProviderRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath,
      token: "receipt-token",
      workerPath: fixtureWorker,
      publishTurnReceipts: () => {
        throw new Error("receipt disk unavailable");
      },
    });
    await host.start();

    const records = await collectProviderHostStream(
      {
        descriptor: { controlSocketPath, hostProtocolVersion: 3 },
        token: "receipt-token",
      },
      {
        op: "sessionTurn",
        submissionId: "receipt-failure",
        target: {
          harness: "claude",
          providerSessionId: "receipt-provider-session",
        },
        message: { text: "require durable acceptance" },
        launch: {
          providerName: "claude",
          projectPath: runtimeRoot,
          options: {},
          runtimeConfig: {},
        },
      },
    );

    expect(records).toEqual([
      expect.objectContaining({
        type: "error",
        outcome: "uncertain-after-acceptance",
        accepted: true,
        error: expect.stringContaining("acceptance receipt"),
      }),
    ]);
    await waitUntil(() => host.runtimes.size === 0);
    await host.shutdown("receipt failure test complete");
  });

  it("reports uncertainty when the terminal receipt cannot be persisted", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-host-receipt-"));
    temporaryPaths.push(runtimeRoot);
    const controlSocketPath = join(runtimeRoot, "host.sock");
    let receiptWrites = 0;
    const host = new ProviderRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath,
      token: "terminal-receipt-token",
      workerPath: fixtureWorker,
      publishTurnReceipts: () => {
        receiptWrites += 1;
        if (receiptWrites === 2) throw new Error("receipt disk unavailable");
      },
    });
    await host.start();

    const records = await collectProviderHostStream(
      {
        descriptor: { controlSocketPath, hostProtocolVersion: 3 },
        token: "terminal-receipt-token",
      },
      {
        op: "sessionTurn",
        submissionId: "terminal-receipt-failure",
        target: {
          harness: "claude",
          providerSessionId: "terminal-receipt-provider-session",
        },
        message: { text: "require a durable terminal receipt" },
        launch: {
          providerName: "claude",
          projectPath: runtimeRoot,
          options: {},
          runtimeConfig: {},
        },
      },
    );

    expect(records.map((record) => record.type)).toEqual([
      "accepted",
      "providerEvent",
      "providerEvent",
      "providerEvent",
      "error",
    ]);
    expect(records.at(-1)).toMatchObject({
      outcome: "uncertain-after-acceptance",
      accepted: true,
      error: expect.stringContaining("terminal receipt"),
    });
    await waitUntil(() => host.runtimes.size === 0);
    await host.shutdown("terminal receipt failure test complete");
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
        hostProtocolVersion: 3,
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
      writeProviderHostRecentRuntimes(paths, [
        {
          target: {
            harness: "claude",
            providerSessionId: "must-not-recover-after-crash",
          },
          launch: {
            providerName: "claude",
            projectPath: runtimeRoot,
            options: {},
            runtimeConfig: {},
            reattach: {},
          },
        },
      ]);
      const discovery = await discoverProviderHost(paths, {
        expectedIdentity: {
          sourceIdentity: { projectRoot: runtimeRoot },
          buildIdentity: "test",
        },
        timeoutMs: 50,
      });
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
      expect(existsSync(paths.recentRuntimePath)).toBe(false);
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
        hostProtocolVersion: 3,
        features: ["runtime-control"],
        controlSocketPath: paths.controlSocketPath,
        tokenFilePath: paths.tokenPath,
        owner: { pid: owner.pid, startTime: "not-the-current-process" },
        startedAt: new Date().toISOString(),
        sourceIdentity: { projectRoot: runtimeRoot },
        buildIdentity: "test",
        processGroups: [],
      });
      const discovery = await discoverProviderHost(paths, {
        expectedIdentity: {
          sourceIdentity: { projectRoot: runtimeRoot },
          buildIdentity: "test",
        },
        timeoutMs: 50,
      });
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
        protocolVersion: 3,
        op: "launch",
        generation: "one",
        providerName: "claude-gateway",
        projectPath: runtimeRoot,
        options: {
          cwd: runtimeRoot,
          model: "gpt-5.6-sol",
          effort: "high",
          remoteEnv: { REMOTE_KEEP_ME: "yes" },
          staticAgentEnvironment: {
            YEP_BROWSER_DEBUG_AGENT_URL: "http://127.0.0.1/browser-debug/v1",
            YEP_BROWSER_DEBUG_CALLER_TOKEN: "boot-token",
          },
        },
      },
      owner,
    );

    expect(launched.worker.agentLaunchEnvironment).toEqual({
      harness: "claude",
      model: "gpt-5.6-sol",
      effort: "high",
      browserDebugUrl: "http://127.0.0.1/browser-debug/v1",
      browserDebugCallerToken: "boot-token",
    });
    expect(launched.worker.remoteAgentLaunchEnvironment).toEqual({
      REMOTE_KEEP_ME: "yes",
      AGENT_LAUNCHER: "yepanywhere",
      AGENT_LAUNCH_HARNESS: "claude",
      AGENT_LAUNCH_MODEL: "gpt-5.6-sol",
      AGENT_LAUNCH_EFFORT: "high",
      YEP_BROWSER_DEBUG_AGENT_URL: "http://127.0.0.1/browser-debug/v1",
      YEP_BROWSER_DEBUG_CALLER_TOKEN: "boot-token",
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
        protocolVersion: 3,
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
        protocolVersion: 3,
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
      protocolVersion: 3,
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
        protocolVersion: 3,
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
        protocolVersion: 3,
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
      protocolVersion: 3,
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
        protocolVersion: 3,
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
          protocolVersion: 3,
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

  it("resolves hosted child environment for the selected executor", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-proxy-test-"));
    temporaryPaths.push(runtimeRoot);
    const controlSocketPath = join(runtimeRoot, "host.sock");
    const host = new ProviderRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath,
      token: "executor-environment-token",
      workerPath: fixtureWorker,
    });
    await host.start();
    process.env.YEP_PROVIDER_RUNTIME_SOCKET = controlSocketPath;
    process.env.YEP_PROVIDER_RUNTIME_TOKEN = "executor-environment-token";
    process.env.YEP_SERVER_GENERATION = "executor-environment";
    expect(await initializeProviderRuntimeHost()).toBe(true);
    const getSessionChildEnv = vi.fn(() => ({}));

    const session = await startHostedProviderSession(
      "claude",
      {
        cwd: runtimeRoot,
        executor: "remote-shell",
        getSessionChildEnv,
      },
      {},
    );

    expect(getSessionChildEnv).toHaveBeenCalledWith("", "remote-shell");
    await session.abort();
    await host.shutdown("executor environment test complete");
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
      {
        cwd: runtimeRoot,
        resumeSessionId: "canonical-session",
        getSessionChildEnv: () => ({
          YEP_BROWSER_DEBUG_AGENT_URL: "http://127.0.0.1/browser-debug/v1",
          YEP_BROWSER_DEBUG_CALLER_TOKEN: "second-boot-token",
          UNRELATED_SECRET: "must-not-pass",
        }),
      },
      {},
    );
    const secondEvent = await second.iterator.next();
    expect(secondEvent.value?.session_id).toBe("fake-session-2");
    const environmentEvent = await second.iterator.next();
    expect(environmentEvent.value).toMatchObject({
      status: "browser-debug-environment-published",
      browserDebugEnvironment: {
        YEP_BROWSER_DEBUG_AGENT_URL: "http://127.0.0.1/browser-debug/v1",
        YEP_BROWSER_DEBUG_CALLER_TOKEN: "second-boot-token",
      },
    });
    expect(environmentEvent.value).not.toHaveProperty(
      "browserDebugEnvironment.UNRELATED_SECRET",
    );
    expect(second.getRuntimeUnviewedSince?.()?.toISOString()).toBe(
      unviewedSince,
    );
    expect(host.runtimes.size).toBe(1);

    await second.abort();
    await waitUntil(() => host.runtimes.size === 0);
    await host.shutdown("proxy test complete");
  });
});
