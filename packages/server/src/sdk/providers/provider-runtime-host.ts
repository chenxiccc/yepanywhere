import { createConnection, type Socket } from "node:net";
import type {
  PermissionMode,
  ThinkingConfig,
  EffortLevel,
} from "@yep-anywhere/shared";
import type { AgentMessageQueue } from "../messageQueue.js";
import type {
  ProviderActivitySnapshot,
  ProviderRetentionSnapshot,
  SDKMessage,
  ToolApprovalResult,
  UserMessage,
} from "../types.js";
import { getModuleEnv } from "../../yaModuleEnv.js";
import type {
  AgentSession,
  ProviderName,
  StartSessionOptions,
} from "./types.js";
import type { ProviderRuntimeSnapshot } from "./index.js";

const HOST_REQUEST_TIMEOUT_MS = 15_000;
const WORKER_RPC_TIMEOUT_MS = 30_000;
const HOST_PROTOCOL_VERSION = 1;
const WORKER_PROTOCOL_VERSION = 1;
// The host's default attach deadline is 30 seconds. Keep launch routing pinned
// until that owner has either been reclaimed or reaped.
const RUNTIME_OWNER_LOSS_GRACE_MS = 31_000;

interface HostResponse<T> {
  id?: number;
  ok: boolean;
  result?: T;
  error?: string;
}

interface WorkerCapabilities {
  probeLiveness: boolean;
  getProviderActivity: boolean;
  getProviderRetention: boolean;
  refreshPromptCache: boolean;
  publishAgentctlSessionId: boolean;
  steer: boolean;
  setMaxThinkingTokens: boolean;
  setEffort: boolean;
  interrupt: boolean;
  supportedModels: boolean;
  supportedCommands: boolean;
  setModel: boolean;
  runProviderCommand: boolean;
}

interface WorkerMetadata {
  sessionId?: string;
  queueDepth: number;
  providerActivity?: ProviderActivitySnapshot;
  providerRetention?: ProviderRetentionSnapshot;
  capabilities: WorkerCapabilities;
}

export interface HostedProviderReattachSpec {
  permissionMode?: PermissionMode;
  model?: string;
  serviceTier?: string;
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
  clientName?: string;
  executor?: string;
  sandboxLevel?: StartSessionOptions["sessionSandboxOptions"] extends infer T
    ? T extends { level: infer L }
      ? L
      : never
    : never;
  sandboxStateKey?: string;
}

export interface HostedProviderRuntimeInfo {
  hostProtocolVersion: number;
  runtimeId: string;
  sessionId?: string;
  providerName: ProviderName;
  projectPath: string;
  socketPath: string;
  pid: number;
  processGroupId: number;
  providerProcessGroupIds: number[];
  state: "starting" | "attached" | "detached" | "closing";
  attachedServerGeneration?: string;
  startedAt: string;
  detachedAt?: string;
  reattach: HostedProviderReattachSpec;
  worker: WorkerMetadata;
}

interface RuntimeHostEnvironment {
  socketPath: string;
  token: string;
  generation: string;
}

let registrationSocket: Socket | null = null;
let registrationPromise: Promise<boolean> | null = null;
let registered = false;
let nextRequestId = 1;
const hostedSessionIds = new Map<string, string>();
const hostedRuntimeForgetTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getEnvironment(): RuntimeHostEnvironment | null {
  if (process.platform !== "linux") return null;
  const runtimeEnv = getModuleEnv("provider-runtime");
  const socketPath = runtimeEnv.SOCKET?.trim();
  const token = runtimeEnv.TOKEN?.trim();
  const generation = process.env.YEP_SERVER_GENERATION?.trim();
  if (!socketPath || !token || !generation) return null;
  return { socketPath, token, generation };
}

export function isProviderRuntimeHostAvailable(): boolean {
  return getEnvironment() !== null && registered;
}

export function hasHostedProviderRuntime(sessionId: string): boolean {
  for (const knownSessionId of hostedSessionIds.values()) {
    if (knownSessionId === sessionId) return true;
  }
  return false;
}

function rememberRuntime(runtime: HostedProviderRuntimeInfo): void {
  const pendingForget = hostedRuntimeForgetTimers.get(runtime.runtimeId);
  if (pendingForget) clearTimeout(pendingForget);
  hostedRuntimeForgetTimers.delete(runtime.runtimeId);
  if (runtime.sessionId) {
    hostedSessionIds.set(runtime.runtimeId, runtime.sessionId);
  }
}

function forgetRuntime(runtimeId: string): void {
  const pendingForget = hostedRuntimeForgetTimers.get(runtimeId);
  if (pendingForget) clearTimeout(pendingForget);
  hostedRuntimeForgetTimers.delete(runtimeId);
  hostedSessionIds.delete(runtimeId);
}

function forgetRuntimeAfterOwnerLoss(runtimeId: string): void {
  if (hostedRuntimeForgetTimers.has(runtimeId)) return;
  const timer = setTimeout(() => forgetRuntime(runtimeId), RUNTIME_OWNER_LOSS_GRACE_MS);
  timer.unref?.();
  hostedRuntimeForgetTimers.set(runtimeId, timer);
}

function requestHost<T>(
  op: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const environment = getEnvironment();
  if (!environment) {
    return Promise.reject(new Error("Provider runtime host is unavailable"));
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
    const timeout = setTimeout(
      () => finish(() => reject(new Error(`Provider runtime host ${op} timed out`))),
      HOST_REQUEST_TIMEOUT_MS,
    );
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          id,
          token: environment.token,
          generation: environment.generation,
          protocolVersion: HOST_PROTOCOL_VERSION,
          op,
          ...payload,
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as HostResponse<T>;
        if (!response.ok) {
          finish(() => reject(new Error(response.error ?? `${op} failed`)));
          return;
        }
        finish(() => resolve(response.result as T));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("close", () => {
      if (!settled) finish(() => reject(new Error(`Host closed during ${op}`)));
    });
  });
}

export async function initializeProviderRuntimeHost(): Promise<boolean> {
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
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => {
      socket.destroy();
      finish(false);
    }, HOST_REQUEST_TIMEOUT_MS);
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          id: nextRequestId++,
          token: environment.token,
          generation: environment.generation,
          protocolVersion: HOST_PROTOCOL_VERSION,
          op: "registerServer",
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as HostResponse<{
          protocolVersion?: number;
        }>;
        registered =
          response.ok &&
          response.result?.protocolVersion === HOST_PROTOCOL_VERSION;
        if (!registered) socket.destroy();
        finish(registered);
      } catch {
        socket.destroy();
        finish(false);
      }
    });
    socket.on("error", () => finish(false));
    socket.on("close", () => {
      registered = false;
      registrationSocket = null;
      if (!settled) finish(false);
    });
  }).finally(() => {
    registrationPromise = null;
  });
  return await registrationPromise;
}

export function closeProviderRuntimeHostRegistration(): void {
  registered = false;
  registrationSocket?.destroy();
  registrationSocket = null;
}

export async function listHostedProviderRuntimes(): Promise<
  HostedProviderRuntimeInfo[]
> {
  if (!isProviderRuntimeHostAvailable()) return [];
  const runtimes = await requestHost<HostedProviderRuntimeInfo[]>("list");
  for (const runtime of runtimes) rememberRuntime(runtime);
  return runtimes;
}

export async function retainProviderRuntimeProcessGroup(
  processGroupId: number,
): Promise<void> {
  await requestHost("retainProcessGroup", { processGroupId });
}

function cloneableOptions(options: StartSessionOptions): Record<string, unknown> {
  const {
    onToolApproval: _onToolApproval,
    onPermissionModeApplied: _onPermissionModeApplied,
    shouldEmitLiveDeltas: _shouldEmitLiveDeltas,
    onProviderRetentionChange: _onProviderRetentionChange,
    sessionSandbox: _sessionSandbox,
    ...cloneable
  } = options;
  return cloneable;
}

function reattachSpec(options: StartSessionOptions): HostedProviderReattachSpec {
  return {
    permissionMode: options.permissionMode,
    model: options.model,
    serviceTier: options.serviceTier,
    thinking: options.thinking,
    effort: options.effort,
    clientName: options.clientName,
    executor: options.executor,
    sandboxLevel: options.sessionSandboxOptions?.level,
    sandboxStateKey: options.sessionSandboxOptions?.stateKey,
  };
}

export async function startHostedProviderSession(
  providerName: ProviderName,
  options: StartSessionOptions,
  runtimeConfig: ProviderRuntimeSnapshot,
): Promise<AgentSession> {
  if (!isProviderRuntimeHostAvailable()) {
    throw new Error("Provider runtime host is unavailable");
  }
  let runtime = options.resumeSessionId
    ? await requestHost<HostedProviderRuntimeInfo | null>("claim", {
        sessionId: options.resumeSessionId,
      })
    : null;
  if (runtime && runtime.providerName !== providerName) {
    throw new Error(
      `Retained runtime provider ${runtime.providerName} does not match ${providerName}`,
    );
  }
  if (!runtime) {
    runtime = await requestHost<HostedProviderRuntimeInfo>("launch", {
      providerName,
      projectPath: options.cwd,
      sessionId: options.resumeSessionId,
      options: cloneableOptions(options),
      runtimeConfig,
      reattach: reattachSpec(options),
    });
  }
  rememberRuntime(runtime);
  return await HostedAgentSession.connect(runtime, options);
}

class HostedMessageQueue implements AgentMessageQueue {
  private pending: UserMessage[] = [];
  private remoteDepth: number;

  constructor(
    initialDepth: number,
    private readonly send: (message: unknown) => void,
    private readonly rpc: <T>(method: string, args?: unknown[]) => Promise<T>,
  ) {
    this.remoteDepth = initialDepth;
  }

  push(message: UserMessage): number {
    this.pending.push(message);
    this.remoteDepth = Math.max(this.remoteDepth, this.pending.length);
    this.send({ type: "queuePush", message });
    return this.remoteDepth;
  }

  drain(): UserMessage[] {
    const drained = this.pending.splice(0);
    this.remoteDepth = 0;
    void this.rpc<UserMessage[]>("drainQueue").catch(() => {});
    return drained;
  }

  async drainAsync(): Promise<UserMessage[]> {
    const remote = await this.rpc<UserMessage[]>("drainQueue");
    this.pending = [];
    this.remoteDepth = 0;
    return remote;
  }

  removeByTempId(tempId: string): UserMessage[] {
    const removed = this.pending.filter(
      (message) =>
        message.tempId === tempId || message.tempIds?.includes(tempId) === true,
    );
    this.pending = this.pending.filter((message) => !removed.includes(message));
    this.send({ type: "removeQueued", tempId });
    return removed;
  }

  updateDepth(depth: number): void {
    this.remoteDepth = Math.max(0, depth);
  }

  removeAccepted(uuids: string[]): void {
    const removed = new Set(uuids);
    this.pending = this.pending.filter(
      (message) => !message.uuid || !removed.has(message.uuid),
    );
  }

  get depth(): number {
    return this.remoteDepth;
  }
}

class HostedAgentSession {
  private socket: Socket;
  private eventQueue: Array<{ sequence: number; message: SDKMessage }> = [];
  private iteratorWaiters: Array<{
    resolve: (result: IteratorResult<SDKMessage>) => void;
    reject: (error: Error) => void;
  }> = [];
  private pendingRpc = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private nextRpcId = 1;
  private lastYieldedSequence: number | null = null;
  private done = false;
  private failure: Error | null = null;
  private detaching = false;
  private providerAlive = true;
  private providerActivity: ProviderActivitySnapshot;
  private providerRetention: ProviderRetentionSnapshot;
  private handledApprovals = new Set<string>();
  private queuedApprovals = new Map<string, Record<string, unknown>>();
  private approvalControllers = new Map<string, AbortController>();
  private callbacksActive = false;
  private pendingAppliedPermissionMode: PermissionMode | undefined;
  readonly queue: HostedMessageQueue;

  private constructor(
    private readonly runtime: HostedProviderRuntimeInfo,
    private readonly options: StartSessionOptions,
    socket: Socket,
  ) {
    this.socket = socket;
    this.providerActivity = reviveActivity(runtime.worker.providerActivity);
    this.providerRetention = reviveRetention(runtime.worker.providerRetention);
    this.queue = new HostedMessageQueue(
      runtime.worker.queueDepth,
      (message) => this.send(message),
      <T>(method: string, args?: unknown[]) => this.rpc<T>(method, args),
    );
  }

  static async connect(
    runtime: HostedProviderRuntimeInfo,
    options: StartSessionOptions,
  ): Promise<AgentSession> {
    const environment = getEnvironment();
    if (!environment) throw new Error("Provider runtime host is unavailable");
    const socket = createConnection(runtime.socketPath);
    socket.setEncoding("utf8");
    const proxy = new HostedAgentSession(runtime, options, socket);
    try {
      await proxy.attach(environment);
      await requestHost("confirmAttach", { runtimeId: runtime.runtimeId });
      return proxy.toAgentSession();
    } catch (error) {
      socket.destroy();
      forgetRuntimeAfterOwnerLoss(runtime.runtimeId);
      throw error;
    }
  }

  private attach(environment: RuntimeHostEnvironment): Promise<void> {
    return new Promise((resolve, reject) => {
      let buffer = "";
      let attached = false;
      const timeout = setTimeout(() => {
        if (!attached) reject(new Error("Provider worker attach timed out"));
        this.socket.destroy();
      }, HOST_REQUEST_TIMEOUT_MS);
      this.socket.on("connect", () => {
        this.send({
          type: "attach",
          token: environment.token,
          generation: environment.generation,
          protocolVersion: WORKER_PROTOCOL_VERSION,
        });
      });
      this.socket.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const rawLine of lines) {
          if (!rawLine.trim()) continue;
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(rawLine) as Record<string, unknown>;
          } catch {
            this.fail(new Error("Provider worker sent invalid JSON"));
            continue;
          }
          if (!attached) {
            if (message.type === "attached") {
              if (message.protocolVersion !== WORKER_PROTOCOL_VERSION) {
                clearTimeout(timeout);
                reject(new Error("Provider worker protocol is incompatible"));
                this.socket.destroy();
                continue;
              }
              attached = true;
              clearTimeout(timeout);
              this.applyAttachedState(message);
              resolve();
              continue;
            }
            if (message.type === "error") {
              clearTimeout(timeout);
              reject(new Error(String(message.error)));
              this.socket.destroy();
              continue;
            }
          }
          this.handleMessage(message);
        }
      });
      this.socket.on("error", (error) => {
        if (!attached) {
          clearTimeout(timeout);
          reject(error);
        } else {
          this.providerAlive = false;
          forgetRuntimeAfterOwnerLoss(this.runtime.runtimeId);
          this.fail(
            new Error(
              `Provider worker process exited or connection failed: ${error.message}`,
            ),
          );
        }
      });
      this.socket.on("close", () => {
        clearTimeout(timeout);
        if (!attached) reject(new Error("Provider worker closed during attach"));
        if (!this.done && !this.detaching) {
          this.providerAlive = false;
          forgetRuntimeAfterOwnerLoss(this.runtime.runtimeId);
          this.fail(
            new Error("Provider worker process exited or connection closed"),
          );
        }
        this.finishIterator();
      });
    });
  }

  private applyAttachedState(message: Record<string, unknown>): void {
    this.providerAlive = message.providerAlive !== false;
    this.queue.updateDepth(Number(message.queueDepth ?? 0));
    this.providerActivity = reviveActivity(
      message.providerActivity as ProviderActivitySnapshot | undefined,
    );
    this.providerRetention = reviveRetention(
      message.providerRetention as ProviderRetentionSnapshot | undefined,
    );
    if (message.appliedPermissionMode) {
      this.pendingAppliedPermissionMode =
        message.appliedPermissionMode as PermissionMode;
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    switch (message.type) {
      case "event":
        this.providerActivity = reviveActivity(
          message.providerActivity as ProviderActivitySnapshot | undefined,
        );
        this.providerRetention = reviveRetention(
          message.providerRetention as ProviderRetentionSnapshot | undefined,
        );
        this.enqueueEvent({
          sequence: Number(message.sequence),
          message: message.message as SDKMessage,
        });
        return;
      case "queueDepth":
        this.queue.updateDepth(Number(message.depth));
        return;
      case "queueRemoved":
        this.queue.removeAccepted(
          Array.isArray(message.uuids)
            ? message.uuids.map((value) => String(value))
            : [],
        );
        return;
      case "permissionMode":
        this.pendingAppliedPermissionMode = message.mode as PermissionMode;
        if (this.callbacksActive) {
          this.options.onPermissionModeApplied?.(
            this.pendingAppliedPermissionMode,
          );
        }
        return;
      case "providerRetention":
        this.providerRetention = reviveRetention(
          message.value as ProviderRetentionSnapshot,
        );
        if (this.callbacksActive) {
          this.options.onProviderRetentionChange?.();
        }
        return;
      case "approval":
        void this.handleApproval(message);
        return;
      case "approvalCancelled":
        this.cancelApproval(String(message.requestId));
        return;
      case "rpcResult":
        this.resolveRpc(message);
        return;
      case "complete":
        this.providerAlive = false;
        forgetRuntime(this.runtime.runtimeId);
        this.done = true;
        this.finishIterator();
        return;
      case "failed":
        this.providerAlive = false;
        forgetRuntime(this.runtime.runtimeId);
        this.fail(
          new Error(
            `Provider worker process exited: ${String(
              message.error ?? "unknown failure",
            )}`,
          ),
        );
        return;
    }
  }

  private enqueueEvent(event: { sequence: number; message: SDKMessage }): void {
    const waiter = this.iteratorWaiters.shift();
    if (waiter) {
      this.lastYieldedSequence = event.sequence;
      waiter.resolve({ done: false, value: event.message });
      return;
    }
    this.eventQueue.push(event);
  }

  private iteratorNext(): Promise<IteratorResult<SDKMessage>> {
    if (this.lastYieldedSequence !== null) {
      this.send({ type: "ack", sequence: this.lastYieldedSequence });
      this.lastYieldedSequence = null;
    }
    const event = this.eventQueue.shift();
    if (event) {
      this.lastYieldedSequence = event.sequence;
      return Promise.resolve({ done: false, value: event.message });
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.done) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => {
      this.iteratorWaiters.push({ resolve, reject });
    });
  }

  private finishIterator(): void {
    const waiters = this.iteratorWaiters.splice(0);
    for (const waiter of waiters) {
      if (this.failure) waiter.reject(this.failure);
      else waiter.resolve({ done: true, value: undefined });
    }
  }

  private fail(error: Error): void {
    if (!this.failure) this.failure = error;
    this.done = true;
    for (const pending of this.pendingRpc.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRpc.clear();
    this.cancelApprovals();
    this.finishIterator();
  }

  private send(message: unknown): void {
    if (this.socket.destroyed) throw new Error("Provider worker is disconnected");
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  private rpc<T>(method: string, args: unknown[] = []): Promise<T> {
    const id = this.nextRpcId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`Provider worker ${method} timed out`));
      }, WORKER_RPC_TIMEOUT_MS);
      this.pendingRpc.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      try {
        this.send({ type: "rpc", id, method, args });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRpc.delete(id);
        reject(error);
      }
    });
  }

  private resolveRpc(message: Record<string, unknown>): void {
    const id = Number(message.id);
    const pending = this.pendingRpc.get(id);
    if (!pending) return;
    this.pendingRpc.delete(id);
    clearTimeout(pending.timeout);
    if (message.ok === false) {
      pending.reject(new Error(String(message.error ?? "Provider worker RPC failed")));
    } else {
      pending.resolve(message.result);
    }
  }

  private async handleApproval(message: Record<string, unknown>): Promise<void> {
    const requestId = String(message.requestId);
    if (this.handledApprovals.has(requestId)) return;
    if (!this.callbacksActive) {
      this.queuedApprovals.set(requestId, message);
      return;
    }
    this.handledApprovals.add(requestId);
    this.queuedApprovals.delete(requestId);
    const approval = this.options.onToolApproval;
    const controller = new AbortController();
    this.approvalControllers.set(requestId, controller);
    let result: ToolApprovalResult;
    try {
      result = approval
        ? await approval(String(message.toolName), message.input, {
            signal: controller.signal,
            permissionMode: message.permissionMode as
              | PermissionMode
              | undefined,
          })
        : { behavior: "deny", message: "No approval handler is attached" };
    } catch (error) {
      result = {
        behavior: "deny",
        message: `Approval handler failed: ${errorMessage(error)}`,
      };
    } finally {
      this.approvalControllers.delete(requestId);
    }
    if (!this.detaching && !this.socket.destroyed) {
      this.send({ type: "approvalResult", requestId, result });
    }
  }

  private cancelApproval(requestId: string): void {
    this.queuedApprovals.delete(requestId);
    this.approvalControllers.get(requestId)?.abort();
  }

  private cancelApprovals(): void {
    this.queuedApprovals.clear();
    for (const controller of this.approvalControllers.values()) {
      controller.abort();
    }
    this.approvalControllers.clear();
  }

  private async detach(): Promise<void> {
    this.detaching = true;
    this.cancelApprovals();
    await requestHost("release", { runtimeId: this.runtime.runtimeId });
    this.done = true;
    this.socket.end();
    this.finishIterator();
  }

  private activateCallbacks(): void {
    if (this.callbacksActive) return;
    this.callbacksActive = true;
    if (this.pendingAppliedPermissionMode) {
      this.options.onPermissionModeApplied?.(
        this.pendingAppliedPermissionMode,
      );
    }
    for (const approval of this.queuedApprovals.values()) {
      void this.handleApproval(approval);
    }
  }

  private async abort(): Promise<void> {
    try {
      // The host owns the bounded cooperative/TERM/KILL ladder. Going through
      // it directly prevents a hung provider abort RPC from delaying cleanup.
      await requestHost("terminate", { runtimeId: this.runtime.runtimeId });
    } finally {
      forgetRuntime(this.runtime.runtimeId);
      this.cancelApprovals();
      this.providerAlive = false;
      this.done = true;
      this.socket.destroy();
      this.finishIterator();
    }
  }

  private toAgentSession(): AgentSession {
    const iterator: AsyncIterableIterator<SDKMessage> = {
      [Symbol.asyncIterator]: () => iterator,
      next: () => this.iteratorNext(),
      return: async () => {
        this.done = true;
        this.finishIterator();
        return { done: true, value: undefined };
      },
    };
    const capabilities = this.runtime.worker.capabilities;
    return {
      iterator,
      queue: this.queue,
      abort: () => this.abort(),
      detachForServerReload: () => this.detach(),
      activateCallbacks: () => this.activateCallbacks(),
      isProcessAlive: () => this.providerAlive,
      pid: this.runtime.pid,
      sessionId: this.runtime.worker.sessionId,
      ...(capabilities.probeLiveness
        ? {
            probeLiveness: async () => {
              const result = await this.rpc<{
                status: import("@yep-anywhere/shared").SessionLivenessProbeStatus;
                source: string;
                detail?: string;
                checkedAt?: string | Date;
              }>("probeLiveness");
              return {
                ...result,
                checkedAt: result.checkedAt
                  ? new Date(result.checkedAt)
                  : undefined,
              };
            },
          }
        : {}),
      ...(capabilities.getProviderActivity
        ? { getProviderActivity: () => this.providerActivity }
        : {}),
      ...(capabilities.getProviderRetention
        ? { getProviderRetention: () => this.providerRetention }
        : {}),
      ...(capabilities.refreshPromptCache
        ? { refreshPromptCache: (arg) => this.rpc("refreshPromptCache", [arg]) }
        : {}),
      publishAgentctlSessionId: async (sessionId) => {
        // Make the routing decision synchronous with Process learning the YA
        // session id. A SIGHUP can arrive while the two remote binds await.
        hostedSessionIds.set(this.runtime.runtimeId, sessionId);
        await this.rpc("publishAgentctlSessionId", [sessionId]);
        const bound = await requestHost<HostedProviderRuntimeInfo>("bind", {
          runtimeId: this.runtime.runtimeId,
          sessionId,
        });
        rememberRuntime(bound);
      },
      ...(capabilities.steer
        ? { steer: (message) => this.rpc("steer", [message]) }
        : {}),
      ...(capabilities.setMaxThinkingTokens
        ? { setMaxThinkingTokens: (tokens) => this.rpc("setMaxThinkingTokens", [tokens]) }
        : {}),
      ...(capabilities.setEffort
        ? { setEffort: (effort) => this.rpc("setEffort", [effort]) }
        : {}),
      ...(capabilities.interrupt
        ? { interrupt: () => this.rpc("interrupt") }
        : {}),
      ...(capabilities.supportedModels
        ? { supportedModels: () => this.rpc("supportedModels") }
        : {}),
      ...(capabilities.supportedCommands
        ? { supportedCommands: () => this.rpc("supportedCommands") }
        : {}),
      ...(capabilities.setModel
        ? { setModel: (model) => this.rpc("setModel", [model]) }
        : {}),
      ...(capabilities.runProviderCommand
        ? {
            runProviderCommand: (command, argument) =>
              this.rpc("runProviderCommand", [command, argument]),
          }
        : {}),
    };
  }
}

function reviveActivity(
  value: ProviderActivitySnapshot | undefined,
): ProviderActivitySnapshot {
  return {
    lastRawProviderEventAt: value?.lastRawProviderEventAt
      ? new Date(value.lastRawProviderEventAt)
      : null,
    lastRawProviderEventSource: value?.lastRawProviderEventSource ?? null,
  };
}

function reviveRetention(
  value: ProviderRetentionSnapshot | undefined,
): ProviderRetentionSnapshot {
  return {
    retained: value?.retained ?? false,
    reasons: value?.reasons ?? [],
    backgroundTaskCount: value?.backgroundTaskCount,
    sessionCronCount: value?.sessionCronCount,
    liveTaskCount: value?.liveTaskCount,
    lastUpdatedAt: value?.lastUpdatedAt
      ? new Date(value.lastUpdatedAt)
      : null,
  };
}

export function providerRuntimeErrorMessage(error: unknown): string {
  return errorMessage(error);
}
