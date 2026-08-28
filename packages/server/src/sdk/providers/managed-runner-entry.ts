#!/usr/bin/env node

import "../../startupEnv.js";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CODEX_REASONING_SUMMARY,
  DEFAULT_SUBAGENT_MAX_DEPTH,
  type CodexReasoningSummary,
  type SubagentMaxDepth,
} from "@yep-anywhere/shared";
import { prepareSessionSandbox } from "../../session-sandbox.js";
import { CodexProvider } from "./codex.js";
import { startFakeProviderSession } from "./provider-runtime-fake.js";
import type { ProviderSessionStartResult } from "./provider-session-owner.js";
import {
  type ManagedRunnerLaunchRequest,
  type ManagedRunnerControllerBridge,
  runManagedStdioRunner,
} from "./provider-runtime-stdio.js";

interface ManagedRunnerRuntimeConfig {
  codexReasoningSummary?: CodexReasoningSummary;
  subagentMaxDepth?: SubagentMaxDepth;
}

function runtimeConfig(
  request: ManagedRunnerLaunchRequest,
): ManagedRunnerRuntimeConfig {
  const value = request.runtimeConfig;
  return value && typeof value === "object"
    ? (value as ManagedRunnerRuntimeConfig)
    : {};
}

async function createSession(
  request: ManagedRunnerLaunchRequest,
  hooks: Parameters<typeof startFakeProviderSession>[1],
  controller: ManagedRunnerControllerBridge,
): Promise<ProviderSessionStartResult> {
  if (request.provider === "fake") {
    if (process.env.YEP_MANAGED_RUNNER_ALLOW_FAKE !== "1") {
      throw new Error("Fake provider is disabled in this managed runner");
    }
    return {
      session: await startFakeProviderSession(
        {
          sessionId: request.options.resumeSessionId,
          initialMessage: request.options.initialMessage,
          failOnStart: request.runtimeConfig?.failOnStart === true,
        },
        hooks,
      ),
    };
  }
  if (request.provider !== "codex") {
    throw new Error(`Unsupported managed runner provider ${request.provider}`);
  }

  const config = runtimeConfig(request);
  const auth = request.codexAuth;
  if (!auth) {
    throw new Error("Managed Codex requires controller-owned authentication");
  }
  const codexHome = await prepareManagedCodexHome(
    request.options.cwd,
    auth.codexHome,
  );
  const codexVersion = await inspectCodexVersion(auth.expectedCodexVersion);
  const provider = new CodexProvider({
    codexHome,
    externalChatgptAuth: {
      initialProjection: auth.initialProjection,
      refresh: (refreshRequest) => controller.refreshCodexAuth(refreshRequest),
    },
  });
  provider.setReasoningSummaryGetter(
    () => config.codexReasoningSummary ?? DEFAULT_CODEX_REASONING_SUMMARY,
  );
  provider.setSubagentMaxDepthGetter(
    () => config.subagentMaxDepth ?? DEFAULT_SUBAGENT_MAX_DEPTH,
  );
  const {
    browserDebugEnvironment: _browserDebugEnvironment,
    sessionSandboxOptions,
    ...providerOptions
  } = request.options;
  if (sessionSandboxOptions?.provider !== "codex") {
    if (sessionSandboxOptions) {
      throw new Error("Managed Codex sandbox request has the wrong provider");
    }
  }
  const sessionSandbox = sessionSandboxOptions
    ? await prepareSessionSandbox(sessionSandboxOptions)
    : undefined;
  const session = await provider.startSession({
    ...providerOptions,
    getSessionChildEnv: () => hooks.getBrowserDebugEnvironment(),
    sessionSandbox,
    sessionSandboxOptions: undefined,
    onToolApproval: hooks.onToolApproval,
    shouldEmitLiveDeltas: hooks.shouldEmitLiveDeltas,
    onPermissionModeApplied: hooks.onPermissionModeApplied,
    onProviderRetentionChange: hooks.onProviderRetentionChange,
  });
  return {
    session,
    diagnostics: {
      codex: {
        available: true,
        version: codexVersion,
        compatible: true,
        authMode: "controller-chatgpt-access-token",
        state: "target-native-rollout",
      },
    },
    sandbox: sessionSandbox
      ? {
          enforcement: sessionSandbox.enforcement,
          stateKey: sessionSandbox.stateKey,
          projectPath: sessionSandbox.projectPath,
        }
      : undefined,
  };
}

async function prepareManagedCodexHome(
  cwd: string,
  requestedCodexHome: string,
): Promise<string> {
  if (!isAbsolute(cwd) || !isAbsolute(requestedCodexHome)) {
    throw new Error("Managed Codex paths must be absolute");
  }
  const normalizedCwd = resolve(cwd);
  const normalizedCodexHome = resolve(requestedCodexHome);
  if (dirname(normalizedCwd) !== dirname(normalizedCodexHome)) {
    throw new Error("Managed Codex state must stay beside its owned worktree");
  }
  await mkdir(normalizedCodexHome, { recursive: true, mode: 0o700 });
  const info = await lstat(normalizedCodexHome);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Managed Codex state root is not a private directory");
  }
  if ((await realpath(normalizedCodexHome)) !== normalizedCodexHome) {
    throw new Error("Managed Codex state root must not traverse symlinks");
  }
  await chmod(normalizedCodexHome, 0o700);
  return normalizedCodexHome;
}

async function inspectCodexVersion(expectedVersion: string): Promise<string> {
  if (!/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
    throw new Error("Managed Codex requires an exact expected version");
  }
  const child = spawn("codex", ["--version"], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    if (Buffer.byteLength(stdout) < 1024) stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    if (Buffer.byteLength(stderr) < 4096) stderr += String(chunk);
  });
  const version = await new Promise<string>((resolveVersion, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Target Codex version probe timed out"));
    }, 5_000);
    timeout.unref?.();
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0 || signal !== null) {
        reject(
          new Error(
            `Target Codex is unavailable${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
          ),
        );
        return;
      }
      const match = /^codex-cli\s+(\d+\.\d+\.\d+)$/.exec(stdout.trim());
      if (!match?.[1]) {
        reject(new Error("Target Codex version output is incompatible"));
        return;
      }
      resolveVersion(match[1]);
    });
  });
  if (version !== expectedVersion) {
    throw new Error(
      `Target Codex CLI ${version} is incompatible; expected ${expectedVersion}`,
    );
  }
  return version;
}

async function verifyArtifact(expectedSha256: string): Promise<number> {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error("Expected artifact digest must be lowercase SHA-256");
  }
  const path = fileURLToPath(import.meta.url);
  const actualSha256 = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error("Managed runner artifact digest mismatch");
  }
  process.stdout.write(
    `${JSON.stringify({ type: "artifactVerified", sha256: actualSha256 })}\n`,
  );
  return 0;
}

async function releaseManagedRunnerLease(): Promise<void> {
  const leaseDirectory = process.env.YEP_MANAGED_RUNNER_LEASE_DIRECTORY;
  const leaseId = process.env.YEP_MANAGED_RUNNER_LEASE_ID;
  if (!leaseDirectory && !leaseId) return;
  if (
    !leaseDirectory ||
    !leaseId ||
    !isAbsolute(leaseDirectory) ||
    resolve(leaseDirectory) !== leaseDirectory ||
    basename(leaseDirectory) !== "active-runner-lease" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(leaseId)
  ) {
    throw new Error("Managed runner lease environment is invalid");
  }
  const info = await lstat(leaseDirectory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(leaseDirectory)) !== leaseDirectory
  ) {
    throw new Error("Managed runner lease directory is invalid");
  }
  const ownerPath = join(leaseDirectory, "owner");
  if ((await readFile(ownerPath, "utf8")).trim() !== leaseId) {
    throw new Error("Managed runner lease ownership changed");
  }
  await unlink(ownerPath);
  await rmdir(leaseDirectory);
}

async function main(): Promise<number> {
  const verifyIndex = process.argv.indexOf("--verify-artifact");
  if (verifyIndex !== -1) {
    return await verifyArtifact(String(process.argv[verifyIndex + 1] ?? ""));
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => process.stdin.destroy());
  }
  return await runManagedStdioRunner({
    input: process.stdin,
    output: process.stdout,
    stderr: process.stderr,
    runtimeId:
      process.env.YEP_MANAGED_RUNNER_RUNTIME_ID ??
      `managed-runner-${randomUUID()}`,
    createSession,
    onOwnershipRelease: releaseManagedRunnerLease,
  });
}

void main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(
      `[ManagedRunner] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
