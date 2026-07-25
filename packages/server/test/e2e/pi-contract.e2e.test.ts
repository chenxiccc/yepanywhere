import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { homedir } from "node:os";
import { promisify, stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import {
  PiRpcClient,
  type PiRpcResponse,
} from "../../src/sdk/providers/pi-rpc-client.js";
import { piVersionUsesAgentSettled } from "../../src/sdk/providers/pi.js";

const execFileAsync = promisify(execFile);
const describePiContract =
  process.env.PI_CONTRACT_TEST === "true" ? describe : describe.skip;
const PI_EXECUTABLE = "pi";
const RPC_TIMEOUT_MS = 10_000;
const EXIT_TIMEOUT_MS = 5_000;
const UPDATE_NOTICE =
  /\b(?:update|updates)\s+available\b|\bnew version\b[^\r\n]{0,160}\bavailable\b/i;

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function assertModel(model: unknown, label: string): void {
  const value = asRecord(model, label);
  expect(value.provider, `${label}.provider`).toEqual(expect.any(String));
  expect((value.provider as string).trim(), `${label}.provider`).not.toBe("");
  expect(value.id, `${label}.id`).toEqual(expect.any(String));
  expect((value.id as string).trim(), `${label}.id`).not.toBe("");
  if (value.name !== undefined) {
    expect(value.name, `${label}.name`).toEqual(expect.any(String));
  }
}

function assertNoUpdateNotice(output: string): void {
  const plainOutput = stripVTControlCharacters(output);
  const match = UPDATE_NOTICE.exec(plainOutput);
  if (!match) return;
  const start = Math.max(0, match.index - 120);
  const end = Math.min(plainOutput.length, match.index + match[0].length + 200);
  throw new Error(
    `Pi reported an available update during its contract test:\n${plainOutput
      .slice(start, end)
      .trim()}`,
  );
}

function waitForExit(proc: ChildProcess): Promise<ProcessExit> {
  return once(proc, "exit").then(([code, signal]) => ({
    code: code as number | null,
    signal: signal as NodeJS.Signals | null,
  }));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function terminateIfRunning(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = waitForExit(proc);
  proc.kill("SIGTERM");
  try {
    await withTimeout(exited, EXIT_TIMEOUT_MS, "Pi ignored SIGTERM");
  } catch {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
    }
    await withTimeout(exited, EXIT_TIMEOUT_MS, "Pi did not exit after SIGKILL");
  }
}

function assertSuccessfulResponse(
  response: PiRpcResponse,
  command: string,
): Record<string, unknown> {
  expect(response.command).toBe(command);
  expect(response.success, response.error).toBe(true);
  return asRecord(response.data, `${command} response data`);
}

describePiContract("installed Pi RPC contract", () => {
  it("recognizes the version and serves YA's zero-token session state", async () => {
    const versionResult = await execFileAsync(PI_EXECUTABLE, ["--version"], {
      encoding: "utf8",
      timeout: RPC_TIMEOUT_MS,
      windowsHide: true,
    });
    const versionOutput = `${versionResult.stdout}\n${versionResult.stderr}`;
    assertNoUpdateNotice(versionOutput);
    expect(
      piVersionUsesAgentSettled(versionResult.stdout),
      `Unrecognized Pi version output: ${versionResult.stdout.trim()}`,
    ).not.toBeNull();

    const proc = spawn(PI_EXECUTABLE, ["--mode", "rpc", "--no-session"], {
      cwd: homedir(),
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let rpcOutput = "";
    const extensionRequests: string[] = [];
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      rpcOutput += chunk;
    });
    proc.stderr.on("data", (chunk: string) => {
      rpcOutput += chunk;
    });

    try {
      const client = new PiRpcClient(proc);
      client.onExtensionRequest((request) => {
        extensionRequests.push(JSON.stringify(request));
      });

      const state = assertSuccessfulResponse(
        await client.request({ type: "get_state" }, RPC_TIMEOUT_MS),
        "get_state",
      );
      expect(state.sessionId).toEqual(expect.any(String));
      expect(
        (state.sessionId as string).trim(),
        "get_state sessionId",
      ).not.toBe("");
      expect(state.isStreaming).toBe(false);
      if (state.model !== null && state.model !== undefined) {
        assertModel(state.model, "get_state model");
      }

      const availableModels = assertSuccessfulResponse(
        await client.request({ type: "get_available_models" }, RPC_TIMEOUT_MS),
        "get_available_models",
      );
      expect(Array.isArray(availableModels.models)).toBe(true);
      const models = availableModels.models as unknown[];
      expect(models.length).toBeGreaterThan(0);
      models.forEach((model, index) => {
        assertModel(model, `get_available_models models[${index}]`);
      });

      const exited = waitForExit(proc);
      proc.stdin?.end();
      const result = await withTimeout(
        exited,
        EXIT_TIMEOUT_MS,
        "Pi did not exit after its RPC input closed",
      );
      expect(result).toEqual({ code: 0, signal: null });
    } finally {
      await terminateIfRunning(proc);
      assertNoUpdateNotice([rpcOutput, ...extensionRequests].join("\n"));
    }
  }, 30_000);
});
