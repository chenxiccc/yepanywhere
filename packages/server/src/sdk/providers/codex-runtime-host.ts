import { createConnection, type Socket } from "node:net";
import type {
  EffortLevel,
  PermissionMode,
  ThinkingConfig,
} from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import { getModuleEnv } from "../../yaModuleEnv.js";

const HOST_PROTOCOL_VERSION = 1;
const HOST_REQUEST_TIMEOUT_MS = 7_000;
const log = getLogger().child({ component: "codex-runtime-host-client" });

interface HostResponse<T> {
  id?: number;
  ok: boolean;
  result?: T;
  error?: string;
}

export interface ReloadSafeCodexReattachSpec {
  permissionMode?: PermissionMode;
  model?: string;
  serviceTier?: string;
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
  clientName?: string;
}

export interface ReloadSafeCodexRuntimeInfo {
  hostProtocolVersion: number;
  runtimeId: string;
  sessionId?: string;
  projectPath: string;
  socketPath: string;
  pid: number;
  processGroupId: number;
  state: "starting" | "attached" | "detached" | "closing";
  attachedServerGeneration?: string;
  startedAt: string;
  detachedAt?: string;
  reattach: ReloadSafeCodexReattachSpec;
}

interface RuntimeHostEnvironment {
  socketPath: string;
  token: string;
  generation: string;
}

let registrationSocket: Socket | null = null;
let registrationPromise: Promise<boolean> | null = null;
let registered = false;
let serverReloading = false;
let reloadableSessionIds = new Set<string>();
const runtimeSessionIds = new Map<string, string>();
let nextRequestId = 1;

function getEnvironment(): RuntimeHostEnvironment | null {
  if (process.platform !== "linux") return null;
  const runtimeEnv = getModuleEnv("codex-runtime");
  const socketPath = runtimeEnv.SOCKET?.trim();
  const token = runtimeEnv.TOKEN?.trim();
  const generation = process.env.YEP_SERVER_GENERATION?.trim();
  if (!socketPath || !token || !generation) return null;
  return { socketPath, token, generation };
}

export function isCodexRuntimeHostConfigured(): boolean {
  return getEnvironment() !== null;
}

export function isCodexRuntimeHostAvailable(): boolean {
  return getEnvironment() !== null && registered;
}

export function isCodexRuntimeServerReloading(): boolean {
  return serverReloading;
}

export function markCodexRuntimeServerReloading(
  sessionIds: Iterable<string>,
): void {
  serverReloading = true;
  reloadableSessionIds = new Set(sessionIds);
}

export function shouldReleaseCodexRuntimeForReload(
  sessionId: string | undefined,
): boolean {
  return Boolean(
    serverReloading && sessionId && reloadableSessionIds.has(sessionId),
  );
}

export function hasReloadSafeCodexRuntime(sessionId: string): boolean {
  for (const knownSessionId of runtimeSessionIds.values()) {
    if (knownSessionId === sessionId) return true;
  }
  return false;
}

function rememberRuntime(runtime: ReloadSafeCodexRuntimeInfo): void {
  if (runtime.sessionId) {
    runtimeSessionIds.set(runtime.runtimeId, runtime.sessionId);
  }
}

function forgetRuntime(runtimeId: string): void {
  runtimeSessionIds.delete(runtimeId);
}

function parseResponseLine<T>(line: string): HostResponse<T> {
  const parsed = JSON.parse(line) as HostResponse<T>;
  if (!parsed || typeof parsed.ok !== "boolean") {
    throw new Error("Invalid Codex runtime host response");
  }
  return parsed;
}

function requestHost<T>(
  op: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const environment = getEnvironment();
  if (!environment) {
    return Promise.reject(new Error("Codex runtime host is unavailable"));
  }
  const id = nextRequestId++;

  return new Promise<T>((resolve, reject) => {
    const socket = createConnection(environment.socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      fn();
    };
    const timeout = setTimeout(() => {
      finish(() => reject(new Error(`Codex runtime host ${op} timed out`)));
    }, HOST_REQUEST_TIMEOUT_MS);

    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          id,
          token: environment.token,
          op,
          generation: environment.generation,
          ...payload,
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = parseResponseLine<T>(buffer.slice(0, newline));
        if (!response.ok) {
          finish(() =>
            reject(
              new Error(response.error ?? `Codex runtime host ${op} failed`),
            ),
          );
          return;
        }
        finish(() => resolve(response.result as T));
      } catch (error) {
        finish(() =>
          reject(
            error instanceof Error
              ? error
              : new Error("Invalid Codex runtime host response"),
          ),
        );
      }
    });
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("close", () => {
      if (!settled) {
        finish(() =>
          reject(new Error(`Codex runtime host closed during ${op}`)),
        );
      }
    });
  });
}

export async function initializeCodexRuntimeHost(): Promise<boolean> {
  if (registered) return true;
  if (registrationPromise) return await registrationPromise;
  const environment = getEnvironment();
  if (!environment) return false;

  registrationPromise = new Promise<boolean>((resolve) => {
    const socket = createConnection(environment.socketPath);
    registrationSocket = socket;
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    const finishInitial = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => {
      socket.destroy();
      finishInitial(false);
    }, HOST_REQUEST_TIMEOUT_MS);

    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          id: nextRequestId++,
          token: environment.token,
          op: "registerServer",
          generation: environment.generation,
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = parseResponseLine<{
          generation: string;
          protocolVersion: number;
        }>(buffer.slice(0, newline));
        if (
          response.ok &&
          response.result?.protocolVersion === HOST_PROTOCOL_VERSION
        ) {
          registered = true;
          finishInitial(true);
          return;
        }
        log.warn(
          { error: response.error ?? "protocol mismatch" },
          "Codex runtime host registration failed",
        );
      } catch (error) {
        log.warn({ error }, "Invalid Codex runtime host registration response");
      }
      socket.destroy();
      finishInitial(false);
    });
    socket.on("error", (error) => {
      log.warn({ error }, "Codex runtime host connection failed");
      finishInitial(false);
    });
    socket.on("close", () => {
      registered = false;
      if (registrationSocket === socket) registrationSocket = null;
      finishInitial(false);
    });
  }).finally(() => {
    registrationPromise = null;
  });

  return await registrationPromise;
}

export function closeCodexRuntimeHostRegistration(): void {
  registered = false;
  registrationSocket?.destroy();
  registrationSocket = null;
}

export async function launchReloadSafeCodexRuntime(options: {
  command: string;
  projectPath: string;
  env: NodeJS.ProcessEnv;
  reattach: ReloadSafeCodexReattachSpec;
  cleanupPaths?: string[];
}): Promise<ReloadSafeCodexRuntimeInfo> {
  const env = Object.fromEntries(
    Object.entries(options.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  return await requestHost<ReloadSafeCodexRuntimeInfo>("launch", {
    command: options.command,
    projectPath: options.projectPath,
    env,
    reattach: options.reattach,
    cleanupPaths: options.cleanupPaths,
  });
}

export async function bindReloadSafeCodexRuntime(
  runtimeId: string,
  sessionId: string,
): Promise<ReloadSafeCodexRuntimeInfo> {
  const runtime = await requestHost<ReloadSafeCodexRuntimeInfo>("bind", {
    runtimeId,
    sessionId,
  });
  rememberRuntime(runtime);
  return runtime;
}

export async function claimReloadSafeCodexRuntime(
  sessionId: string,
): Promise<ReloadSafeCodexRuntimeInfo | null> {
  const runtime = await requestHost<ReloadSafeCodexRuntimeInfo | null>(
    "claim",
    {
      sessionId,
    },
  );
  if (runtime) rememberRuntime(runtime);
  return runtime;
}

export async function listReloadSafeCodexRuntimes(): Promise<
  ReloadSafeCodexRuntimeInfo[]
> {
  if (!isCodexRuntimeHostAvailable()) return [];
  const runtimes = await requestHost<ReloadSafeCodexRuntimeInfo[]>("list");
  for (const runtime of runtimes) rememberRuntime(runtime);
  return runtimes;
}

export async function releaseReloadSafeCodexRuntime(
  runtimeId: string,
): Promise<void> {
  try {
    await requestHost("release", { runtimeId });
  } finally {
    forgetRuntime(runtimeId);
  }
}

export async function terminateReloadSafeCodexRuntime(
  runtimeId: string,
): Promise<void> {
  try {
    await requestHost("terminate", { runtimeId });
  } finally {
    forgetRuntime(runtimeId);
  }
}
