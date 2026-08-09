import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentctlSessionEnvBridge } from "../../../src/sdk/providers/agentctl-session-env.js";

function runBash(env: NodeJS.ProcessEnv): string {
  return execFileSync(
    "bash",
    [
      "-c",
      `printf "original=%s agentctl=%s wake_url=%s wake_token=%s" "\${YA_ORIGINAL_BASH_ENV_MARKER-}" "\${AGENTCTL_SESSION_ID-}" "\${YEP_SESSION_WAKE_URL-}" "\${YEP_SESSION_WAKE_TOKEN-}"`,
    ],
    {
      encoding: "utf-8",
      env,
      // Vitest's worker stdin is socket-backed, which can make Bash select its
      // remote-shell startup path and skip BASH_ENV. Model an ordinary
      // non-interactive provider tool shell explicitly.
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function isBashAvailable(): boolean {
  try {
    execFileSync("bash", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function bridgeTestEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  delete env.AGENTCTL_SESSION_ID;
  delete env.YA_ORIGINAL_BASH_ENV_MARKER;
  delete env.YEP_ORIGINAL_BASH_ENV;
  delete env.YEP_SESSION_WAKE_TOKEN;
  delete env.YEP_SESSION_WAKE_URL;
  // Scrub any inherited BASH_ENV so these tests stay hermetic when run from a
  // shell that already has the agentctl session-env bridge installed (e.g.
  // dogfooding YA). Callers that need an "original" BASH_ENV pass it via
  // overrides.
  delete env.BASH_ENV;
  return env;
}

const bashIt = process.platform !== "win32" && isBashAvailable() ? it : it.skip;

describe("agentctl session env bridge", () => {
  bashIt("publishes AGENTCTL_SESSION_ID to later Bash shells", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ya-agentctl-env-test-"));
    const originalBashEnvPath = join(tempDir, "original-bash-env.sh");
    writeFileSync(
      originalBashEnvPath,
      "export YA_ORIGINAL_BASH_ENV_MARKER=kept\n",
      "utf-8",
    );
    const bridge = createAgentctlSessionEnvBridge();

    try {
      const sourceEnv = bridgeTestEnv();
      sourceEnv.YEP_SESSION_WAKE_URL = "http://stale.invalid/";
      sourceEnv.YEP_SESSION_WAKE_TOKEN = "stale-token";
      const env = bridge.extendEnv({
        ...sourceEnv,
        BASH_ENV: originalBashEnvPath,
      });

      expect(runBash(env)).toBe(
        "original=kept agentctl= wake_url= wake_token=",
      );

      bridge.publishSessionId("sess-'quoted");

      expect(runBash(env)).toBe(
        "original=kept agentctl=sess-'quoted wake_url= wake_token=",
      );
    } finally {
      bridge.cleanup();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  bashIt("seeds a known resume session id before provider startup", () => {
    const bridge = createAgentctlSessionEnvBridge(
      "sess-resume",
      (sessionId) => ({
        YEP_SESSION_WAKE_URL: `http://127.0.0.1/session-wake/${sessionId}`,
        YEP_SESSION_WAKE_TOKEN: "wake-'token",
      }),
    );

    try {
      expect(runBash(bridge.extendEnv(bridgeTestEnv()))).toBe(
        "original= agentctl=sess-resume wake_url=http://127.0.0.1/session-wake/sess-resume wake_token=wake-'token",
      );
    } finally {
      bridge.cleanup();
    }
  });
});
