#!/usr/bin/env node

import "../../startupEnv.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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
  runManagedStdioRunner,
} from "./provider-runtime-stdio.js";

interface ManagedRunnerRuntimeConfig {
  codexCliPath?: string;
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
  const provider = new CodexProvider({ codexPath: config.codexCliPath });
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
    sandbox: sessionSandbox
      ? {
          enforcement: sessionSandbox.enforcement,
          stateKey: sessionSandbox.stateKey,
          projectPath: sessionSandbox.projectPath,
        }
      : undefined,
  };
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
