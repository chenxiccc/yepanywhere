import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ManagedCodexAuthBroker,
  ManagedCodexAuthProjection,
} from "../../../src/sdk/providers/managed-codex-auth.js";
import { startManagedSshCodexSession } from "../../../src/sdk/providers/managed-ssh-agent-session.js";
import {
  type ManagedRunnerArtifactManifest,
  type ManagedSshInspection,
  ManagedSshTarget,
} from "../../../src/sdk/providers/managed-ssh-target.js";
import type { ManagedSshWorkspace } from "../../../src/sdk/providers/managed-ssh-workspace.js";

const fakeSshPath = new URL("./fixtures/fake-managed-ssh.mjs", import.meta.url)
  .pathname;
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === "win32")(
  "managed SSH AgentSession proxy",
  () => {
    it("preserves YA/provider identity, auth callbacks, approvals, RPC, and clean shutdown", async () => {
      const fixture = await mkdtemp(join(tmpdir(), "managed-agent-session-"));
      temporaryPaths.push(fixture);
      const remoteRoot = join(fixture, "remote");
      const remoteDirectory = join(remoteRoot, "workspaces", "workspace-one");
      const worktree = join(remoteDirectory, "worktree");
      await mkdir(worktree, { recursive: true, mode: 0o700 });
      const recordPath = join(fixture, "runner-record.jsonl");
      const { artifactPath, manifest } = await createRunnerArtifact(
        fixture,
        recordPath,
      );
      const target = new ManagedSshTarget({
        hostAlias: "fixture-linux",
        remoteRoot,
        sshCommand: fakeSshPath,
        nodeCommand: process.execPath,
        terminationGraceMs: 100,
      });
      const inspection = targetInspection();
      await target.installRunnerArtifact(artifactPath, manifest, {
        inspection,
      });
      let preflightCount = 0;
      let refreshCount = 0;
      const authOwner: ManagedCodexAuthBroker = {
        async preflight() {
          preflightCount += 1;
          return projection("initial-access-token");
        },
        async refresh(accountId) {
          refreshCount += 1;
          expect(accountId).toBe("account-one");
          return projection("refreshed-access-token");
        },
      };
      const approvals: string[] = [];
      const result = await startManagedSshCodexSession({
        targetId: "fixture-linux",
        target,
        inspection,
        workspace: workspace(remoteDirectory, worktree),
        artifact: manifest,
        authOwner,
        expectedCodexVersion: "0.149.0",
        options: {
          permissionMode: "default",
          effort: "low",
          model: "gpt-fixture",
          onToolApproval: async (toolName) => {
            approvals.push(toolName);
            return { behavior: "allow" };
          },
        },
      });
      result.session.activateCallbacks?.();

      const init = await result.session.iterator.next();
      expect(init.value).toMatchObject({
        type: "system",
        subtype: "init",
        session_id: "thread-target-native",
        cwd: worktree,
      });
      expect(result.providerSessionId()).toBe("thread-target-native");
      expect(result.execution).toMatchObject({
        kind: "managed-ssh",
        targetId: "fixture-linux",
        workspaceId: "workspace-one",
      });
      expect(preflightCount).toBe(1);
      await expect(
        startManagedSshCodexSession({
          targetId: "fixture-linux",
          target,
          inspection,
          workspace: workspace(remoteDirectory, worktree),
          artifact: manifest,
          authOwner,
          expectedCodexVersion: "0.149.0",
          options: {
            permissionMode: "default",
            resumeSessionId: "thread-target-native",
          },
        }),
      ).rejects.toThrow("already has an active runner");
      expect(preflightCount).toBe(2);

      await result.session.publishAgentctlSessionId?.("ya-session-one", {
        SECRET_ENV: "must-not-cross",
      });
      result.session.queue.push({
        text: "approval turn",
        uuid: "turn-one",
        tempId: "temp-one",
      });
      const assistant = await result.session.iterator.next();
      expect(assistant.value).toMatchObject({
        type: "assistant",
        message: { content: "approved target turn" },
      });
      expect(approvals).toEqual(["Bash"]);
      await waitFor(() => refreshCount === 1);
      await expect(result.session.interrupt?.()).resolves.toBe(true);

      await result.session.abort();
      expect(result.diagnostics()).toMatchObject({
        providerSessionId: "thread-target-native",
        transportState: "closed",
        terminal: { classification: "clean" },
      });
      const records = (await readFile(recordPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(
        records.some((record) =>
          JSON.stringify(record).includes("must-not-cross"),
        ),
      ).toBe(false);
      expect(
        records.some((record) =>
          JSON.stringify(record).includes("refreshed-access-token"),
        ),
      ).toBe(true);
    });

    it("fails unsupported target, version, and controller-path projections before launch", async () => {
      const fixture = await mkdtemp(
        join(tmpdir(), "managed-agent-session-preflight-"),
      );
      temporaryPaths.push(fixture);
      const remoteRoot = join(fixture, "remote");
      const remoteDirectory = join(remoteRoot, "workspaces", "workspace-one");
      const worktree = join(remoteDirectory, "worktree");
      await mkdir(worktree, { recursive: true });
      const target = new ManagedSshTarget({
        hostAlias: "fixture-linux",
        remoteRoot,
        sshCommand: fakeSshPath,
        nodeCommand: process.execPath,
      });
      const { manifest } = await createRunnerArtifact(
        fixture,
        join(fixture, "unused.jsonl"),
      );
      const base = {
        targetId: "fixture-linux",
        target,
        workspace: workspace(remoteDirectory, worktree),
        artifact: manifest,
        authOwner: {
          preflight: async () => projection("initial"),
          refresh: async () => projection("refresh"),
        },
        expectedCodexVersion: "0.149.0",
      };

      await expect(
        startManagedSshCodexSession({
          ...base,
          inspection: {
            ...targetInspection(),
            codex: { available: false },
          },
          options: {},
        }),
      ).rejects.toThrow("target CLI is unavailable");
      await expect(
        startManagedSshCodexSession({
          ...base,
          inspection: {
            ...targetInspection(),
            codex: { available: true, version: "codex-cli 0.148.0" },
          },
          options: {},
        }),
      ).rejects.toThrow("0.148.0 is incompatible");
      await expect(
        startManagedSshCodexSession({
          ...base,
          inspection: targetInspection(),
          options: { globalInstructions: "controller setting" },
        }),
      ).rejects.toThrow("does not project controller settings");
    });
  },
);

function targetInspection(): ManagedSshInspection {
  return {
    platform: "Linux",
    architecture: process.arch === "arm64" ? "aarch64" : "x86_64",
    node: { available: true, version: process.version, compatible: true },
    git: { available: true, version: "git version fixture" },
    codex: { available: true, version: "codex-cli 0.149.0" },
    managedRootState: "private-writable",
    runnerCacheState: "absent",
  };
}

function workspace(
  remoteDirectory: string,
  worktree: string,
): ManagedSshWorkspace {
  return {
    workspaceId: "workspace-one",
    repositoryIdentity: "repository-one",
    baseCommit: "a".repeat(40),
    branchRef: "refs/heads/ya-managed/workspace-one",
    remoteDirectory,
    remoteAnchorPath: join(remoteDirectory, "anchor.git"),
    remoteWorktreePath: worktree,
    source: {
      baseCommit: "a".repeat(40),
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      branch: "refs/heads/main",
    },
  };
}

function projection(accessToken: string): ManagedCodexAuthProjection {
  return {
    accessToken,
    chatgptAccountId: "account-one",
    chatgptPlanType: "plus",
  };
}

async function createRunnerArtifact(
  directory: string,
  recordPath: string,
): Promise<{
  artifactPath: string;
  manifest: ManagedRunnerArtifactManifest;
}> {
  const artifactPath = join(directory, "fixture-managed-codex-runner.mjs");
  const source = `#!/usr/bin/env node
import { appendFileSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
const recordPath = ${JSON.stringify(recordPath)};
let buffer = "";
let leaseId = "";
let sequence = 0;
let authRequestId = "auth-one";
const send = (value) => process.stdout.write(JSON.stringify({ ...value, leaseId }) + "\\n");
const record = (value) => appendFileSync(recordPath, JSON.stringify(value) + "\\n");
const releaseLease = () => {
  const directory = process.env.YEP_MANAGED_RUNNER_LEASE_DIRECTORY;
  const currentLeaseId = process.env.YEP_MANAGED_RUNNER_LEASE_ID;
  if (!directory || !currentLeaseId) return;
  const owner = directory + "/owner";
  if (readFileSync(owner, "utf8").trim() !== currentLeaseId) throw new Error("lease changed");
  unlinkSync(owner);
  rmdirSync(directory);
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line) continue;
    const frame = JSON.parse(line);
    record(frame);
    leaseId = frame.leaseId || leaseId;
    if (frame.type === "hello") {
      send({ type: "helloAck", protocolVersion: 2, capabilities: ["codex-external-auth-v1"] });
    } else if (frame.type === "launch") {
      const version = frame.codexAuth.expectedCodexVersion;
      send({
        type: "launchAccepted",
        metadata: {
          queueDepth: 0,
          providerActivity: {},
          providerRetention: { retained: false, reasons: [] },
          capabilities: {
            probeLiveness: true,
            getProviderActivity: true,
            getProviderRetention: true,
            publishAgentctlSessionId: true,
            steer: true,
            setMaxThinkingTokens: false,
            setEffort: true,
            setSessionOptions: true,
            interrupt: true,
            supportedModels: true,
            supportedCommands: true,
            setModel: true,
            runProviderCommand: true
          },
          diagnostics: {
            codex: {
              available: true,
              version,
              compatible: true,
              authMode: "controller-chatgpt-access-token",
              state: "target-native-rollout"
            }
          }
        }
      });
      send({
        type: "event",
        sequence: ++sequence,
        message: {
          type: "system",
          subtype: "init",
          session_id: "thread-target-native",
          cwd: frame.options.cwd
        },
        providerActivity: {},
        providerRetention: { retained: false, reasons: [] }
      });
      send({
        type: "codexAuthRefresh",
        authRequestId,
        reason: "unauthorized",
        previousAccountId: "account-one"
      });
    } else if (frame.type === "codexAuthProjection") {
      record({ receivedProjection: frame.projection });
    } else if (frame.type === "queuePush") {
      send({ type: "queueYielded", uuids: [frame.message.uuid] });
      send({
        type: "approval",
        requestId: "approval-one",
        toolName: "Bash",
        input: { command: "pwd" },
        permissionMode: "default"
      });
    } else if (frame.type === "approvalResult") {
      send({
        type: "event",
        sequence: ++sequence,
        message: {
          type: "assistant",
          session_id: "thread-target-native",
          message: { content: "approved target turn" }
        },
        providerActivity: {},
        providerRetention: { retained: false, reasons: [] }
      });
    } else if (frame.type === "rpc") {
      send({ type: "rpcResult", id: frame.id, ok: true, result: frame.method === "interrupt" ? true : undefined });
    } else if (frame.type === "shutdown") {
      releaseLease();
      send({ type: "shutdownComplete" });
      process.stdin.destroy();
    }
  }
});
process.stdin.on("close", () => { process.exitCode = 0; });
`;
  await writeFile(artifactPath, source, { mode: 0o700 });
  const bytes = await readFile(artifactPath);
  return {
    artifactPath,
    manifest: {
      artifactFormatVersion: 1,
      runnerProtocolVersion: 2,
      providerSessionProtocolVersion: 1,
      entrypoint: "runner.mjs",
      target: {
        os: "linux",
        architecture: process.arch === "arm64" ? "arm64" : "x64",
      },
      node: { range: ">=20.12" },
      artifact: {
        byteSize: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
