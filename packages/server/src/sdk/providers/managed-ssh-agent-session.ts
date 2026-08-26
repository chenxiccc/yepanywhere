import { randomUUID } from "node:crypto";
import type { AgentMessageQueue } from "../messageQueue.js";
import type {
  ProviderActivitySnapshot,
  ProviderRetentionSnapshot,
  SDKMessage,
  ToolApprovalResult,
  UserMessage,
} from "../types.js";
import type {
  AgentSession,
  ProviderSessionOptions,
  ProviderSessionOptionsUpdateResult,
  SessionExecution,
  StartSessionOptions,
} from "./types.js";
import type {
  ManagedCodexAuthBroker,
  ManagedCodexAuthProjection,
} from "./managed-codex-auth.js";
import type {
  ManagedRunnerArtifactManifest,
  ManagedRunnerTerminal,
  ManagedSshInspection,
  ManagedSshRunnerLaunch,
  ManagedSshTarget,
} from "./managed-ssh-target.js";
import type { ManagedSshWorkspace } from "./managed-ssh-workspace.js";
import { MANAGED_RUNNER_PROTOCOL_VERSION } from "./provider-runtime-stdio.js";

const HANDSHAKE_TIMEOUT_MS = 15_000;
const RPC_TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export type ManagedSshSessionExecution = Extract<
  SessionExecution,
  { kind: "managed-ssh" }
>;

export interface ManagedSshCodexSessionOptions {
  targetId: string;
  target: ManagedSshTarget;
  inspection: ManagedSshInspection;
  workspace: ManagedSshWorkspace;
  artifact: ManagedRunnerArtifactManifest;
  authOwner: ManagedCodexAuthBroker;
  expectedCodexVersion: string;
  options: Omit<StartSessionOptions, "cwd" | "executor" | "remoteEnv">;
}

export interface ManagedSshCodexSessionResult {
  session: AgentSession;
  execution: ManagedSshSessionExecution;
  providerSessionId: () => string | undefined;
  diagnostics: () => ManagedSshCodexDiagnostics;
}

export interface ManagedSshCodexDiagnostics {
  target: {
    platform: string;
    architecture: string;
    codexVersion: string;
  };
  runnerGeneration: string;
  providerSessionId?: string;
  transportState: "starting" | "active" | "stopping" | "closed" | "failed";
  terminal?: ManagedRunnerTerminal;
}

interface RunnerMetadata {
  sessionId?: string;
  queueDepth: number;
  providerActivity?: ProviderActivitySnapshot;
  providerRetention?: ProviderRetentionSnapshot;
  capabilities: Record<string, boolean>;
  diagnostics?: Record<string, unknown>;
}

export async function startManagedSshCodexSession(
  options: ManagedSshCodexSessionOptions,
): Promise<ManagedSshCodexSessionResult> {
  assertTargetPreflight(options);
  const projection = await options.authOwner.preflight();
  const runnerGeneration = randomUUID();
  const execution: ManagedSshSessionExecution = {
    kind: "managed-ssh",
    targetId: options.targetId,
    workspaceId: options.workspace.workspaceId,
    runnerGeneration,
  };
  const launch = options.target.launchRunner({
    manifest: options.artifact,
    cwd: options.workspace.remoteWorktreePath,
    workspaceLease: {
      workspaceDirectory: options.workspace.remoteDirectory,
      leaseId: runnerGeneration,
    },
  });
  const proxy = new RemoteAgentSession(launch, execution, options, projection);
  try {
    await proxy.start();
  } catch (error) {
    await launch.terminate().catch(() => {});
    throw error;
  }
  return {
    session: proxy.toAgentSession(),
    execution,
    providerSessionId: () => proxy.providerSessionId,
    diagnostics: () => proxy.diagnostics(),
  };
}

class RemoteMessageQueue implements AgentMessageQueue {
  private pending: UserMessage[] = [];
  private remoteDepth: number;
  private yieldedListeners = new Set<(messages: UserMessage[]) => void>();

  constructor(
    initialDepth: number,
    private readonly send: (message: Record<string, unknown>) => void,
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

  notifyYielded(uuids: string[]): void {
    const yielded = new Set(uuids);
    const messages = this.pending.filter(
      (message) => message.uuid && yielded.has(message.uuid),
    );
    if (messages.length === 0) return;
    for (const listener of this.yieldedListeners) listener(messages);
  }

  subscribeYielded(listener: (messages: UserMessage[]) => void): () => void {
    this.yieldedListeners.add(listener);
    return () => this.yieldedListeners.delete(listener);
  }

  get depth(): number {
    return this.remoteDepth;
  }
}

class RemoteAgentSession {
  private frames: Record<string, unknown>[] = [];
  private frameWaiters = new Set<() => void>();
  private outputBuffer = "";
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
      timeout: NodeJS.Timeout;
    }
  >();
  private nextRpcId = 1;
  private nextControlId = 1;
  private lastYieldedSequence: number | null = null;
  private done = false;
  private failure: Error | null = null;
  private callbacksActive = false;
  private pendingPermissionMode: StartSessionOptions["permissionMode"];
  private queuedApprovals = new Map<string, Record<string, unknown>>();
  private handledApprovals = new Set<string>();
  private approvalControllers = new Map<string, AbortController>();
  private providerAlive = true;
  private providerActivity: ProviderActivitySnapshot = {};
  private providerRetention: ProviderRetentionSnapshot = {
    retained: false,
    reasons: [],
  };
  private state: ManagedSshCodexDiagnostics["transportState"] = "starting";
  private terminalState: ManagedRunnerTerminal | undefined;
  private metadata: RunnerMetadata | null = null;
  private initialAccountId: string;
  private shutdownPromise: Promise<ManagedRunnerTerminal> | null = null;
  readonly queue: RemoteMessageQueue;
  providerSessionId: string | undefined;

  constructor(
    private readonly launch: ManagedSshRunnerLaunch,
    private readonly execution: ManagedSshSessionExecution,
    private readonly launchOptions: ManagedSshCodexSessionOptions,
    initialProjection: ManagedCodexAuthProjection,
  ) {
    this.initialAccountId = initialProjection.chatgptAccountId;
    this.queue = new RemoteMessageQueue(
      0,
      (message) => this.send(message),
      <T>(method: string, args?: unknown[]) => this.rpc<T>(method, args),
    );
    launch.output.setEncoding("utf8");
    launch.output.on("data", (chunk: string) => this.handleOutput(chunk));
    launch.output.once("error", (error) => this.fail(error));
    void launch.terminal.then((terminal) => {
      this.terminalState = terminal;
      if (terminal.classification !== "clean" && !this.failure) {
        this.fail(
          new Error(
            terminal.classification === "uncertain-after-acceptance"
              ? "Managed SSH transport ended with uncertain target state"
              : `Managed SSH runner failed before launch acceptance${terminal.stderr.trim() ? `: ${terminal.stderr.trim()}` : ""}`,
          ),
        );
      }
      if (this.state === "stopping" && terminal.classification === "clean") {
        this.state = "closed";
        this.done = true;
        this.finishIterator();
      }
    });
    this.frames.push({
      type: "initialProjection",
      projection: initialProjection,
    });
  }

  async start(): Promise<void> {
    const initialFrame = this.frames.shift();
    const projection = initialFrame?.projection as ManagedCodexAuthProjection;
    this.sendRaw({
      type: "hello",
      protocolVersion: MANAGED_RUNNER_PROTOCOL_VERSION,
      leaseId: this.execution.runnerGeneration,
    });
    const hello = await this.waitForFrame(
      (frame) => frame.type === "helloAck",
      HANDSHAKE_TIMEOUT_MS,
      "Managed SSH runner hello",
    );
    if (
      hello.protocolVersion !== MANAGED_RUNNER_PROTOCOL_VERSION ||
      !Array.isArray(hello.capabilities) ||
      !hello.capabilities.includes("codex-external-auth-v1")
    ) {
      await this.launch.terminate();
      throw new Error(
        "Managed SSH runner external-auth protocol is incompatible",
      );
    }
    this.send({
      type: "launch",
      provider: "codex",
      options: cloneManagedCodexOptions(
        this.launchOptions.options,
        this.launchOptions.workspace.remoteWorktreePath,
      ),
      runtimeConfig: {},
      codexAuth: {
        initialProjection: projection,
        codexHome: `${this.launchOptions.workspace.remoteDirectory}/codex-home`,
        expectedCodexVersion: this.launchOptions.expectedCodexVersion,
      },
    });
    const accepted = await this.waitForFrame(
      (frame) =>
        frame.type === "launchAccepted" || frame.type === "launchFailed",
      HANDSHAKE_TIMEOUT_MS,
      "Managed SSH Codex launch",
    );
    if (accepted.type === "launchFailed") {
      await this.launch.terminate();
      throw new Error(
        typeof accepted.error === "string"
          ? accepted.error
          : "Managed SSH Codex launch failed",
      );
    }
    this.launch.markLaunchAccepted();
    this.metadata = parseRunnerMetadata(accepted.metadata);
    assertRunnerCodexDiagnostics(
      this.metadata.diagnostics,
      this.launchOptions.expectedCodexVersion,
    );
    this.queue.updateDepth(this.metadata.queueDepth);
    this.providerActivity = reviveActivity(this.metadata.providerActivity);
    this.providerRetention = reviveRetention(this.metadata.providerRetention);
    this.providerSessionId = this.metadata.sessionId ?? this.providerSessionId;
    this.state = "active";
  }

  diagnostics(): ManagedSshCodexDiagnostics {
    return {
      target: {
        platform: this.launchOptions.inspection.platform,
        architecture: this.launchOptions.inspection.architecture,
        codexVersion: this.launchOptions.expectedCodexVersion,
      },
      runnerGeneration: this.execution.runnerGeneration,
      providerSessionId: this.providerSessionId,
      transportState: this.state,
      terminal: this.terminalState,
    };
  }

  toAgentSession(): AgentSession {
    const iterator: AsyncIterableIterator<SDKMessage> = {
      [Symbol.asyncIterator]: () => iterator,
      next: () => this.iteratorNext(),
      return: async () => {
        this.done = true;
        this.finishIterator();
        return { done: true, value: undefined };
      },
    };
    const capabilities = this.metadata?.capabilities ?? {};
    return {
      iterator,
      queue: this.queue,
      execution: this.execution,
      abort: () => this.shutdown(),
      activateCallbacks: () => this.activateCallbacks(),
      isProcessAlive: () => this.providerAlive && this.state === "active",
      sessionId: this.providerSessionId,
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
      ...(capabilities.publishAgentctlSessionId
        ? {
            publishAgentctlSessionId: (sessionId) =>
              this.rpc("publishAgentctlSessionId", [sessionId]),
          }
        : {}),
      ...(capabilities.steer
        ? { steer: (message) => this.rpc("steer", [message]) }
        : {}),
      ...(capabilities.setMaxThinkingTokens
        ? {
            setMaxThinkingTokens: (tokens) =>
              this.rpc("setMaxThinkingTokens", [tokens]),
          }
        : {}),
      ...(capabilities.setEffort
        ? { setEffort: (effort) => this.rpc("setEffort", [effort]) }
        : {}),
      ...(capabilities.setSessionOptions
        ? {
            setSessionOptions: (sessionOptions: ProviderSessionOptions) =>
              this.rpc<ProviderSessionOptionsUpdateResult>(
                "setSessionOptions",
                [sessionOptions],
              ),
          }
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

  private handleOutput(chunk: string): void {
    this.outputBuffer += chunk;
    if (Buffer.byteLength(this.outputBuffer) > MAX_FRAME_BYTES) {
      this.fail(
        new Error("Managed SSH runner output frame exceeded its bound"),
      );
      void this.launch.terminate();
      return;
    }
    const lines = this.outputBuffer.split("\n");
    this.outputBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.fail(new Error("Managed SSH runner sent malformed JSON"));
        void this.launch.terminate();
        return;
      }
      if (
        frame.leaseId !== undefined &&
        frame.leaseId !== this.execution.runnerGeneration
      ) {
        this.fail(new Error("Managed SSH runner lease identity changed"));
        void this.launch.terminate();
        return;
      }
      this.frames.push(frame);
      if (this.frames.length > 128) this.frames.shift();
      for (const wake of this.frameWaiters) wake();
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: Record<string, unknown>): void {
    switch (frame.type) {
      case "codexAuthRefresh":
        void this.handleAuthRefresh(frame);
        return;
      case "event": {
        this.providerActivity = reviveActivity(
          frame.providerActivity as ProviderActivitySnapshot | undefined,
        );
        this.providerRetention = reviveRetention(
          frame.providerRetention as ProviderRetentionSnapshot | undefined,
        );
        const message = frame.message as SDKMessage;
        this.observeProviderSessionId(message);
        this.enqueueEvent({ sequence: Number(frame.sequence), message });
        return;
      }
      case "queueDepth":
        this.queue.updateDepth(Number(frame.depth));
        return;
      case "queueRemoved":
        this.queue.removeAccepted(stringArray(frame.uuids));
        return;
      case "queueYielded":
        this.queue.notifyYielded(stringArray(frame.uuids));
        return;
      case "permissionMode":
        this.pendingPermissionMode =
          frame.mode as StartSessionOptions["permissionMode"];
        if (this.callbacksActive && this.pendingPermissionMode) {
          this.launchOptions.options.onPermissionModeApplied?.(
            this.pendingPermissionMode,
          );
        }
        return;
      case "providerRetention":
        this.providerRetention = reviveRetention(
          frame.value as ProviderRetentionSnapshot | undefined,
        );
        if (this.callbacksActive) {
          this.launchOptions.options.onProviderRetentionChange?.();
        }
        return;
      case "approval":
        void this.handleApproval(frame);
        return;
      case "approvalCancelled":
        this.cancelApproval(String(frame.requestId));
        return;
      case "rpcResult":
        this.resolveRpc(frame);
        return;
      case "shutdownComplete":
        this.launch.markCooperativeCompletion();
        return;
      case "complete":
        this.providerAlive = false;
        this.done = true;
        this.finishIterator();
        return;
      case "failed":
      case "runnerFailed":
      case "controllerLost":
        this.providerAlive = false;
        this.fail(
          new Error(
            typeof frame.error === "string"
              ? frame.error
              : "Managed SSH Codex session failed",
          ),
        );
        return;
    }
  }

  private async handleAuthRefresh(
    frame: Record<string, unknown>,
  ): Promise<void> {
    const authRequestId =
      typeof frame.authRequestId === "string" ? frame.authRequestId : "";
    const previousAccountId =
      typeof frame.previousAccountId === "string"
        ? frame.previousAccountId
        : "";
    if (!authRequestId || previousAccountId !== this.initialAccountId) {
      this.send({
        type: "codexAuthFailure",
        authRequestId,
        error: "Managed Codex auth callback account mismatch",
      });
      return;
    }
    try {
      const projection =
        await this.launchOptions.authOwner.refresh(previousAccountId);
      this.send({ type: "codexAuthProjection", authRequestId, projection });
    } catch (error) {
      this.send({
        type: "codexAuthFailure",
        authRequestId,
        error: error instanceof Error ? error.message : "Authentication failed",
      });
    }
  }

  private observeProviderSessionId(message: SDKMessage): void {
    if (
      message.type === "system" &&
      message.subtype === "init" &&
      typeof message.session_id === "string"
    ) {
      if (
        this.providerSessionId &&
        this.providerSessionId !== message.session_id
      ) {
        this.fail(new Error("Managed Codex provider session identity changed"));
        void this.shutdown();
        return;
      }
      this.providerSessionId = message.session_id;
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

  private activateCallbacks(): void {
    if (this.callbacksActive) return;
    this.callbacksActive = true;
    if (this.pendingPermissionMode) {
      this.launchOptions.options.onPermissionModeApplied?.(
        this.pendingPermissionMode,
      );
    }
    for (const approval of this.queuedApprovals.values()) {
      void this.handleApproval(approval);
    }
  }

  private async handleApproval(frame: Record<string, unknown>): Promise<void> {
    const requestId = String(frame.requestId ?? "");
    if (!requestId || this.handledApprovals.has(requestId)) return;
    if (!this.callbacksActive) {
      this.queuedApprovals.set(requestId, frame);
      return;
    }
    this.handledApprovals.add(requestId);
    this.queuedApprovals.delete(requestId);
    const controller = new AbortController();
    this.approvalControllers.set(requestId, controller);
    let result: ToolApprovalResult;
    try {
      result = this.launchOptions.options.onToolApproval
        ? await this.launchOptions.options.onToolApproval(
            String(frame.toolName),
            frame.input,
            {
              signal: controller.signal,
              permissionMode: frame.permissionMode as
                | import("@yep-anywhere/shared").PermissionMode
                | undefined,
            },
          )
        : { behavior: "deny", message: "No approval handler is attached" };
    } catch (error) {
      result = {
        behavior: "deny",
        message: `Approval handler failed: ${errorMessage(error)}`,
      };
    } finally {
      this.approvalControllers.delete(requestId);
    }
    if (!this.done) {
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

  private rpc<T>(method: string, args: unknown[] = []): Promise<T> {
    if (this.state !== "active") {
      return Promise.reject(
        new Error("Managed SSH Codex session is not active"),
      );
    }
    const id = this.nextRpcId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`Managed SSH Codex ${method} timed out`));
      }, RPC_TIMEOUT_MS);
      timeout.unref?.();
      this.pendingRpc.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      this.send({ type: "rpc", id, method, args });
    });
  }

  private resolveRpc(frame: Record<string, unknown>): void {
    const id = Number(frame.id);
    const pending = this.pendingRpc.get(id);
    if (!pending) return;
    this.pendingRpc.delete(id);
    clearTimeout(pending.timeout);
    if (frame.ok === false) {
      pending.reject(
        new Error(
          typeof frame.error === "string"
            ? frame.error
            : "Managed SSH Codex RPC failed",
        ),
      );
    } else {
      pending.resolve(frame.result);
    }
  }

  private async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return;
    }
    this.state = "stopping";
    this.cancelApprovals();
    for (const pending of this.pendingRpc.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Managed SSH Codex session is shutting down"));
    }
    this.pendingRpc.clear();
    this.shutdownPromise = (async () => {
      try {
        this.send({ type: "shutdown" });
        await this.waitForFrame(
          (frame) => frame.type === "shutdownComplete",
          HANDSHAKE_TIMEOUT_MS,
          "Managed SSH Codex shutdown",
        );
        this.launch.markCooperativeCompletion();
        if (!this.launch.input.destroyed) this.launch.input.end();
        return await this.launch.terminal;
      } catch (error) {
        await this.launch.terminate().catch(() => {});
        throw error;
      }
    })();
    const terminal = await this.shutdownPromise;
    this.terminalState = terminal;
    this.providerAlive = false;
    this.done = true;
    this.state = terminal.classification === "clean" ? "closed" : "failed";
    this.finishIterator();
  }

  private send(message: Record<string, unknown>): void {
    this.sendRaw({
      ...message,
      leaseId: this.execution.runnerGeneration,
      controlId: `${this.execution.runnerGeneration}:${this.nextControlId++}`,
    });
  }

  private sendRaw(message: unknown): void {
    if (this.launch.input.destroyed || !this.launch.input.writable) {
      throw new Error("Managed SSH runner input is closed");
    }
    this.launch.input.write(`${JSON.stringify(message)}\n`);
  }

  private async waitForFrame(
    predicate: (frame: Record<string, unknown>) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<Record<string, unknown>> {
    const existing = this.frames.find(predicate);
    if (existing) return existing;
    return await new Promise((resolve, reject) => {
      const wake = () => {
        const frame = this.frames.find(predicate);
        if (!frame) {
          if (!this.failure) return;
          cleanup();
          reject(this.failure);
          return;
        }
        cleanup();
        resolve(frame);
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`${label} timed out`));
      }, timeoutMs);
      timeout.unref?.();
      const cleanup = () => {
        clearTimeout(timeout);
        this.frameWaiters.delete(wake);
      };
      this.frameWaiters.add(wake);
      wake();
    });
  }

  private fail(error: Error): void {
    if (!this.failure) this.failure = error;
    this.state = "failed";
    this.done = true;
    this.cancelApprovals();
    for (const pending of this.pendingRpc.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRpc.clear();
    for (const wake of this.frameWaiters) wake();
    this.finishIterator();
  }

  private finishIterator(): void {
    const waiters = this.iteratorWaiters.splice(0);
    for (const waiter of waiters) {
      if (this.failure) waiter.reject(this.failure);
      else waiter.resolve({ done: true, value: undefined });
    }
  }
}

function assertTargetPreflight(options: ManagedSshCodexSessionOptions): void {
  if (options.inspection.platform !== "Linux") {
    throw new Error("Managed Codex currently requires a Linux target");
  }
  if (!options.inspection.node.compatible) {
    throw new Error("Managed Codex target requires Node.js >=20.12");
  }
  if (!options.inspection.git.available) {
    throw new Error("Managed Codex target requires Git");
  }
  if (!options.inspection.codex.available) {
    throw new Error("Managed Codex target CLI is unavailable");
  }
  const observedVersion = parseCodexVersion(options.inspection.codex.version);
  if (observedVersion !== options.expectedCodexVersion) {
    throw new Error(
      `Managed Codex target CLI ${observedVersion ?? "unknown"} is incompatible; expected ${options.expectedCodexVersion}`,
    );
  }
  if (
    options.artifact.runnerProtocolVersion !== MANAGED_RUNNER_PROTOCOL_VERSION
  ) {
    throw new Error("Managed SSH runner artifact protocol is incompatible");
  }
  if (options.options.resumeSessionAt) {
    throw new Error(
      "Managed Codex prefix resume is unavailable; resume the complete target-native thread",
    );
  }
  if (options.options.launchCompactPercentOverride !== undefined) {
    throw new Error(
      "Managed Codex launch compact percentage override is unavailable",
    );
  }
  if (options.options.claudeSteerBackgroundBash) {
    throw new Error(
      "Claude-only launch options are unavailable on managed Codex",
    );
  }
  if (
    options.options.globalInstructions ||
    options.options.getSessionChildEnv ||
    options.options.sessionSandbox ||
    options.options.sessionSandboxOptions
  ) {
    throw new Error(
      "Managed Codex does not project controller settings, environment, or sandbox paths",
    );
  }
  const message = options.options.initialMessage;
  if (
    message &&
    ((message.images?.length ?? 0) > 0 ||
      (message.documents?.length ?? 0) > 0 ||
      (message.attachments?.length ?? 0) > 0)
  ) {
    throw new Error(
      "Managed Codex diagnostic does not yet project controller-local attachments",
    );
  }
}

function cloneManagedCodexOptions(
  source: ManagedSshCodexSessionOptions["options"],
  cwd: string,
): StartSessionOptions {
  return {
    cwd,
    initialMessage: source.initialMessage,
    resumeSessionId: source.resumeSessionId,
    clientName: source.clientName,
    permissionMode: source.permissionMode,
    model: source.model,
    serviceTier: source.serviceTier,
    thinking: source.thinking,
    effort: source.effort,
    compactAtContextTokenLimit: source.compactAtContextTokenLimit,
    sessionOptions: source.sessionOptions,
  };
}

function parseRunnerMetadata(value: unknown): RunnerMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Managed SSH runner launch metadata is invalid");
  }
  const metadata = value as Record<string, unknown>;
  const capabilities =
    metadata.capabilities &&
    typeof metadata.capabilities === "object" &&
    !Array.isArray(metadata.capabilities)
      ? (metadata.capabilities as Record<string, boolean>)
      : null;
  if (!capabilities || !Number.isSafeInteger(Number(metadata.queueDepth))) {
    throw new Error("Managed SSH runner launch metadata is invalid");
  }
  return {
    sessionId:
      typeof metadata.sessionId === "string" ? metadata.sessionId : undefined,
    queueDepth: Number(metadata.queueDepth),
    providerActivity: metadata.providerActivity as
      | ProviderActivitySnapshot
      | undefined,
    providerRetention: metadata.providerRetention as
      | ProviderRetentionSnapshot
      | undefined,
    capabilities,
    diagnostics:
      metadata.diagnostics &&
      typeof metadata.diagnostics === "object" &&
      !Array.isArray(metadata.diagnostics)
        ? (metadata.diagnostics as Record<string, unknown>)
        : undefined,
  };
}

function parseCodexVersion(value: string | undefined): string | null {
  if (!value) return null;
  return /^codex-cli\s+(\d+\.\d+\.\d+)$/.exec(value)?.[1] ?? null;
}

function assertRunnerCodexDiagnostics(
  diagnostics: Record<string, unknown> | undefined,
  expectedVersion: string,
): void {
  const codex =
    diagnostics?.codex &&
    typeof diagnostics.codex === "object" &&
    !Array.isArray(diagnostics.codex)
      ? (diagnostics.codex as Record<string, unknown>)
      : null;
  if (
    codex?.available !== true ||
    codex.compatible !== true ||
    codex.version !== expectedVersion ||
    codex.authMode !== "controller-chatgpt-access-token" ||
    codex.state !== "target-native-rollout"
  ) {
    throw new Error("Managed SSH runner Codex diagnostics are incompatible");
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
    lastUpdatedAt: value?.lastUpdatedAt ? new Date(value.lastUpdatedAt) : null,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
