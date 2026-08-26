import { randomUUID } from "node:crypto";
import type {
  PermissionMode,
  SessionSandboxEnforcement,
} from "@yep-anywhere/shared";
import type { MessageQueue } from "../messageQueue.js";
import type {
  CanUseTool,
  ProviderActivitySnapshot,
  ProviderRetentionSnapshot,
  SDKMessage,
  ToolApprovalResult,
  UserMessage,
} from "../types.js";
import { pickBrowserDebugAgentEnvironment } from "./agentctl-session-env.js";
import type {
  AgentSession,
  ProviderSessionOptions,
  ProviderSessionOptionsUpdateResult,
} from "./types.js";
import {
  PROVIDER_SESSION_OPTION_KEYS,
  resolveProviderSessionOptions,
  unknownProviderSessionOptionsResult,
} from "./types.js";

export const PROVIDER_SESSION_PROTOCOL_VERSION = 1;
export const MAX_UNACKNOWLEDGED_PROVIDER_EVENTS = 10_000;
export const MAX_UNACKNOWLEDGED_PROVIDER_BYTES = 64 * 1024 * 1024;

interface BufferedEvent {
  sequence: number;
  message: SDKMessage;
  bytes: number;
  providerActivity: ProviderActivitySnapshot;
  providerRetention: ProviderRetentionSnapshot;
}

interface PendingApproval {
  requestId: string;
  toolName: string;
  input: unknown;
  permissionMode?: PermissionMode;
  resolve: (result: ToolApprovalResult) => void;
  removeAbortListener: () => void;
}

interface AuxiliarySubmission {
  submissionId: string;
  messageUuid: string;
  tempId: string;
  started: boolean;
  terminalOutcome?: string;
  lastProviderEventSequence?: number;
}

interface AttachedController {
  id: string;
  generation: string;
  write: (message: unknown) => void;
  isActive?: () => boolean;
}

export interface ProviderSessionSandboxMetadata {
  enforcement: SessionSandboxEnforcement;
  stateKey: string;
  projectPath: string;
}

export interface ProviderSessionReadyMetadata {
  sessionId?: string;
  queueDepth: number;
  providerActivity: ProviderActivitySnapshot;
  providerRetention: ProviderRetentionSnapshot;
  capabilities: {
    probeLiveness: boolean;
    getProviderActivity: boolean;
    getProviderRetention: boolean;
    refreshPromptCache: boolean;
    publishAgentctlSessionId: boolean;
    steer: boolean;
    setMaxThinkingTokens: boolean;
    setEffort: boolean;
    setSessionOptions: boolean;
    interrupt: boolean;
    supportedModels: boolean;
    supportedCommands: boolean;
    setModel: boolean;
    runProviderCommand: boolean;
  };
  sandbox?: ProviderSessionSandboxMetadata;
}

export interface ProviderSessionStartHooks {
  onToolApproval: CanUseTool;
  onPermissionModeApplied: (mode: PermissionMode) => void;
  onProviderRetentionChange: () => void;
  shouldEmitLiveDeltas: () => boolean;
  getBrowserDebugEnvironment: () => Record<string, string>;
}

export interface ProviderSessionStartResult {
  session: AgentSession;
  sandbox?: ProviderSessionSandboxMetadata;
}

export type StartOwnedProviderSession = (
  hooks: ProviderSessionStartHooks,
) => Promise<ProviderSessionStartResult>;

export interface ProviderSessionOwnerOptions {
  runtimeId: string;
  emitSupervisor?: (message: unknown) => void;
  onTerminal?: (reason: string, exitCode: number) => void | Promise<void>;
}

export interface ProviderSessionAttachedState {
  type: "attached";
  protocolVersion: number;
  runtimeId: string;
  acknowledgedSequence: number;
  queueDepth: number;
  providerAlive: boolean;
  providerActivity: ProviderActivitySnapshot;
  providerRetention: ProviderRetentionSnapshot;
  appliedPermissionMode?: PermissionMode;
}

export function providerSessionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolvedPid(session: AgentSession): number | undefined {
  return typeof session.pid === "function" ? session.pid() : session.pid;
}

export class ProviderSessionOwner {
  private attachedController: AttachedController | null = null;
  private session: AgentSession | null = null;
  private sequence = 0;
  private acknowledgedSequence = 0;
  private bufferedBytes = 0;
  private events: BufferedEvent[] = [];
  private pendingApprovals = new Map<string, PendingApproval>();
  private queueDepth = 0;
  private providerAlive = true;
  private providerActivity: ProviderActivitySnapshot = {};
  private providerRetention: ProviderRetentionSnapshot = {
    retained: false,
    reasons: [],
  };
  private appliedPermissionMode: PermissionMode | undefined;
  private shuttingDown: Promise<void> | null = null;
  private unsubscribeQueueDepth: (() => void) | null = null;
  private unsubscribeQueueRemoved: (() => void) | null = null;
  private unsubscribeQueueYielded: (() => void) | null = null;
  private lastProviderPid: number | undefined;
  private observesQueueYield = false;
  private activeProviderTurn = false;
  private auxiliarySubmission: AuxiliarySubmission | null = null;
  private browserDebugEnvironment: Record<string, string> = {};
  private iteratorStarted = false;
  private terminalSignalled = false;
  private sandboxMetadata: ProviderSessionSandboxMetadata | undefined;

  constructor(private readonly options: ProviderSessionOwnerOptions) {}

  async start(
    startSession: StartOwnedProviderSession,
    initialBrowserDebugEnvironment?: Record<string, string>,
  ): Promise<ProviderSessionReadyMetadata> {
    if (this.session) throw new Error("Provider session owner already started");
    this.browserDebugEnvironment = pickBrowserDebugAgentEnvironment(
      initialBrowserDebugEnvironment,
    );
    const result = await startSession({
      onToolApproval: (toolName, input, approvalOptions) =>
        this.requestApproval(
          toolName,
          input,
          approvalOptions.permissionMode,
          approvalOptions.signal,
        ),
      onPermissionModeApplied: (mode) => {
        this.appliedPermissionMode = mode;
        this.emitController({ type: "permissionMode", mode });
      },
      onProviderRetentionChange: () => this.refreshRetention(),
      shouldEmitLiveDeltas: () => true,
      getBrowserDebugEnvironment: () => ({ ...this.browserDebugEnvironment }),
    });
    this.session = result.session;
    this.sandboxMetadata = result.sandbox;
    this.reportProviderPid();
    this.providerActivity = result.session.getProviderActivity?.() ?? {};
    this.providerRetention = result.session.getProviderRetention?.() ?? {
      retained: false,
      reasons: [],
    };
    this.queueDepth = result.session.queue.depth;
    this.observeQueueDepth(result.session.queue);
    return this.readyMetadata();
  }

  begin(): void {
    if (this.iteratorStarted) return;
    const session = this.requireSession();
    this.iteratorStarted = true;
    void this.drainProviderIterator(session);
    this.reportProviderPid();
  }

  readyMetadata(): ProviderSessionReadyMetadata {
    const session = this.requireSession();
    return {
      sessionId: session.sessionId,
      queueDepth: this.queueDepth,
      providerActivity: this.providerActivity,
      providerRetention: this.providerRetention,
      capabilities: {
        probeLiveness: Boolean(session.probeLiveness),
        getProviderActivity: Boolean(session.getProviderActivity),
        getProviderRetention: Boolean(session.getProviderRetention),
        refreshPromptCache: Boolean(session.refreshPromptCache),
        publishAgentctlSessionId: Boolean(session.publishAgentctlSessionId),
        steer: Boolean(session.steer),
        setMaxThinkingTokens: Boolean(session.setMaxThinkingTokens),
        setEffort: Boolean(session.setEffort),
        setSessionOptions: Boolean(session.setSessionOptions),
        interrupt: Boolean(session.interrupt),
        supportedModels: Boolean(session.supportedModels),
        supportedCommands: Boolean(session.supportedCommands),
        setModel: Boolean(session.setModel),
        runProviderCommand: Boolean(session.runProviderCommand),
      },
      sandbox: this.sandboxMetadata,
    };
  }

  providerPid(): number | undefined {
    return this.lastProviderPid;
  }

  attach(
    controllerId: string,
    generation: string,
    write: (message: unknown) => void,
    options: { emitAttached?: boolean; isActive?: () => boolean } = {},
  ): ProviderSessionAttachedState {
    if (!generation) throw new Error("Missing server generation");
    if (
      this.attachedController &&
      this.attachedController.isActive?.() !== false
    ) {
      throw new Error(
        `Provider worker is already attached to ${this.attachedController.generation}`,
      );
    }
    this.attachedController = {
      id: controllerId,
      generation,
      write,
      isActive: options.isActive,
    };
    const state = this.attachedState();
    if (options.emitAttached !== false) write(state);
    for (const event of this.events) {
      write({
        type: "event",
        sequence: event.sequence,
        message: event.message,
        providerActivity: event.providerActivity,
        providerRetention: event.providerRetention,
      });
    }
    for (const approval of this.pendingApprovals.values()) {
      this.writeApproval(write, approval);
    }
    if (!this.providerAlive) write({ type: "complete" });
    return state;
  }

  detach(controllerId: string): void {
    if (this.attachedController?.id !== controllerId) return;
    const generation = this.attachedController.generation;
    this.attachedController = null;
    this.emitSupervisor({ type: "controllerDetached", generation });
  }

  handleSupervisorMessage(message: unknown): void {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    if (message.type === "sessionTurn") {
      void this.acceptAuxiliarySubmission(message as Record<string, unknown>);
      return;
    }
    if (message.type === "interruptSessionTurn") {
      void this.interruptAuxiliarySubmission(
        String((message as Record<string, unknown>).submissionId ?? ""),
      );
    }
  }

  async handleControllerRequest(
    controllerId: string,
    request: Record<string, unknown>,
  ): Promise<void> {
    if (this.attachedController?.id !== controllerId) {
      throw new Error("Stale provider worker controller");
    }
    if (request.type === "ack") {
      this.acknowledge(Number(request.sequence));
      return;
    }
    if (request.type === "queuePush") {
      if (this.auxiliarySubmission) {
        throw new Error("A provider-host session turn is already active");
      }
      this.requireSession().queue.push(request.message as UserMessage);
      return;
    }
    if (request.type === "removeQueued") {
      const queue = this.requireSession().queue as MessageQueue;
      queue.removeByTempId(String(request.tempId));
      return;
    }
    if (request.type === "approvalResult") {
      const pending = this.pendingApprovals.get(String(request.requestId));
      if (!pending) return;
      this.pendingApprovals.delete(pending.requestId);
      pending.removeAbortListener();
      pending.resolve(request.result as ToolApprovalResult);
      return;
    }
    if (request.type !== "rpc" || typeof request.id !== "number") {
      throw new Error("Unknown provider worker request");
    }
    const result = await this.call(String(request.method), request.args);
    this.emitController({
      type: "rpcResult",
      id: request.id,
      ok: true,
      result,
    });
  }

  emitControllerError(request: Record<string, unknown>, error: unknown): void {
    const id = typeof request.id === "number" ? request.id : undefined;
    this.emitController({
      type: "rpcResult",
      id,
      ok: false,
      error: providerSessionErrorMessage(error),
    });
  }

  private attachedState(): ProviderSessionAttachedState {
    return {
      type: "attached",
      protocolVersion: PROVIDER_SESSION_PROTOCOL_VERSION,
      runtimeId: this.options.runtimeId,
      acknowledgedSequence: this.acknowledgedSequence,
      queueDepth: this.queueDepth,
      providerAlive: this.providerAlive,
      providerActivity: this.providerActivity,
      providerRetention: this.providerRetention,
      appliedPermissionMode: this.appliedPermissionMode,
    };
  }

  private async drainProviderIterator(session: AgentSession): Promise<void> {
    try {
      for await (const message of session.iterator) {
        if (this.shuttingDown) return;
        this.providerActivity = session.getProviderActivity?.() ?? {};
        this.providerRetention = session.getProviderRetention?.() ?? {
          retained: false,
          reasons: [],
        };
        this.reportProviderPid();
        this.bufferEvent(message);
        if (message.type === "result") this.activeProviderTurn = false;
      }
      if (this.shuttingDown) return;
      this.providerAlive = false;
      this.emitController({ type: "complete" });
      this.signalTerminal("provider iterator completed", 0);
    } catch (error) {
      if (this.shuttingDown) return;
      this.providerAlive = false;
      try {
        this.emitController({
          type: "failed",
          error: providerSessionErrorMessage(error),
        });
      } catch {
        // A failed transport cannot receive the terminal provider frame, but
        // it must not prevent the shared owner from tearing the session down.
      }
      this.signalTerminal("provider iterator failed", 1);
    }
  }

  private bufferEvent(message: SDKMessage): void {
    const sequence = ++this.sequence;
    const bytes = Buffer.byteLength(JSON.stringify(message));
    this.events.push({
      sequence,
      message,
      bytes,
      providerActivity: this.providerActivity,
      providerRetention: this.providerRetention,
    });
    this.bufferedBytes += bytes;
    if (
      this.events.length > MAX_UNACKNOWLEDGED_PROVIDER_EVENTS ||
      this.bufferedBytes > MAX_UNACKNOWLEDGED_PROVIDER_BYTES
    ) {
      this.emitController({
        type: "failed",
        error: "Provider reload replay buffer exceeded its bound",
      });
      this.signalTerminal("replay buffer exceeded", 1);
      return;
    }
    this.emitController({
      type: "event",
      sequence,
      message,
      providerActivity: this.providerActivity,
      providerRetention: this.providerRetention,
    });
    const auxiliary = this.auxiliarySubmission;
    if (!auxiliary?.started) return;
    auxiliary.lastProviderEventSequence = sequence;
    this.emitSupervisor({
      type: "sessionTurnEvent",
      submissionId: auxiliary.submissionId,
      sequence,
      message,
    });
    if (message.type === "result") {
      const providerFailed =
        Boolean(message.error) ||
        /error|fail/i.test(String(message.subtype ?? ""));
      this.finishAuxiliarySubmission(
        auxiliary.terminalOutcome ??
          (providerFailed ? "provider-failed" : "completed"),
        providerFailed
          ? providerSessionErrorMessage(message.error ?? message.subtype)
          : undefined,
      );
    }
  }

  private observeQueueDepth(queue: AgentSession["queue"]): void {
    const concrete = queue as MessageQueue;
    if (typeof concrete.subscribeDepth !== "function") return;
    this.unsubscribeQueueDepth = concrete.subscribeDepth((depth) => {
      this.queueDepth = depth;
      this.emitController({ type: "queueDepth", depth });
    });
    if (typeof concrete.subscribeRemoved === "function") {
      this.unsubscribeQueueRemoved = concrete.subscribeRemoved((messages) => {
        this.emitController({
          type: "queueRemoved",
          uuids: messages.flatMap((message) =>
            message.uuid ? [message.uuid] : [],
          ),
        });
        const auxiliary = this.auxiliarySubmission;
        if (
          auxiliary &&
          !auxiliary.started &&
          messages.some((message) => message.uuid === auxiliary.messageUuid)
        ) {
          this.finishAuxiliarySubmission("interrupted");
        }
      });
    }
    if (typeof concrete.subscribeYielded === "function") {
      this.observesQueueYield = true;
      this.unsubscribeQueueYielded = concrete.subscribeYielded((messages) => {
        this.activeProviderTurn = true;
        this.emitController({
          type: "queueYielded",
          uuids: messages.flatMap((message) =>
            message.uuid ? [message.uuid] : [],
          ),
        });
        const auxiliary = this.auxiliarySubmission;
        if (
          !auxiliary ||
          !messages.some((message) => message.uuid === auxiliary.messageUuid)
        ) {
          return;
        }
        auxiliary.started = true;
        if (messages.length > 1) {
          auxiliary.terminalOutcome = "uncertain-after-acceptance";
        }
        this.emitSupervisor({
          type: "sessionTurnStarted",
          submissionId: auxiliary.submissionId,
        });
      });
    }
  }

  private async acceptAuxiliarySubmission(
    message: Record<string, unknown>,
  ): Promise<void> {
    const submissionId = String(message.submissionId ?? "");
    const userMessage = message.message as UserMessage | undefined;
    const reject = (outcome: string, error: string) =>
      this.emitSupervisor({
        type: "sessionTurnRejected",
        submissionId,
        outcome,
        error,
      });
    if (!submissionId || !userMessage || typeof userMessage.text !== "string") {
      reject("rejected", "Invalid session-turn submission");
      return;
    }
    if (!userMessage.text.trim()) {
      reject("rejected", "Session-turn text is empty");
      return;
    }
    let requestedSessionOptions: Required<ProviderSessionOptions>;
    try {
      const rawSessionOptions = message.sessionOptions;
      if (
        rawSessionOptions !== undefined &&
        (!rawSessionOptions || typeof rawSessionOptions !== "object")
      ) {
        throw new Error("sessionOptions must be an object");
      }
      const candidate = (rawSessionOptions ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(candidate)) {
        if (
          !PROVIDER_SESSION_OPTION_KEYS.includes(
            key as (typeof PROVIDER_SESSION_OPTION_KEYS)[number],
          ) ||
          typeof value !== "boolean"
        ) {
          throw new Error(`Invalid provider session option ${key}`);
        }
      }
      requestedSessionOptions = resolveProviderSessionOptions(
        candidate as ProviderSessionOptions,
      );
    } catch (error) {
      reject("rejected", providerSessionErrorMessage(error));
      return;
    }
    if (!this.providerAlive || !this.session) {
      reject("unavailable", "Provider session is not alive");
      return;
    }
    if (!this.observesQueueYield) {
      reject(
        "unavailable",
        "Provider queue cannot prove the session-turn start boundary",
      );
      return;
    }
    if (
      this.auxiliarySubmission ||
      this.activeProviderTurn ||
      this.queueDepth > 0
    ) {
      reject("busy", "Provider session is not idle");
      return;
    }
    if (this.pendingApprovals.size > 0) {
      reject(
        "provider-approval-required",
        "Provider approval is already pending",
      );
      return;
    }
    const messageUuid = randomUUID();
    const tempId = `provider-host:${submissionId}`;
    const auxiliarySubmission: AuxiliarySubmission = {
      submissionId,
      messageUuid,
      tempId,
      started: false,
    };
    this.auxiliarySubmission = auxiliarySubmission;
    let sessionOptionsResult: ProviderSessionOptionsUpdateResult;
    try {
      sessionOptionsResult = this.session.setSessionOptions
        ? await this.session.setSessionOptions(requestedSessionOptions)
        : unknownProviderSessionOptionsResult(
            requestedSessionOptions,
            "This provider adapter has no session-option control implementation",
          );
    } catch (error) {
      if (this.auxiliarySubmission === auxiliarySubmission) {
        this.auxiliarySubmission = null;
      }
      reject(
        "rejected",
        `Provider session options failed: ${providerSessionErrorMessage(error)}`,
      );
      return;
    }
    if (this.auxiliarySubmission !== auxiliarySubmission) return;
    this.requireSession().queue.push({
      ...userMessage,
      uuid: messageUuid,
      tempId,
    });
    this.emitSupervisor({
      type: "sessionTurnAccepted",
      submissionId,
      sessionOptionsResult,
    });
  }

  private async interruptAuxiliarySubmission(
    submissionId: string,
  ): Promise<void> {
    const auxiliary = this.auxiliarySubmission;
    if (!auxiliary || auxiliary.submissionId !== submissionId) return;
    if (!auxiliary.started) {
      const queue = this.requireSession().queue as MessageQueue;
      queue.removeByTempId(auxiliary.tempId);
      if (this.auxiliarySubmission === auxiliary) {
        this.finishAuxiliarySubmission("interrupted");
      }
      return;
    }
    if (!this.session?.interrupt) {
      auxiliary.terminalOutcome = "uncertain-after-acceptance";
      return;
    }
    auxiliary.terminalOutcome = "interrupted";
    try {
      await this.session.interrupt();
    } catch {
      auxiliary.terminalOutcome = "uncertain-after-acceptance";
    }
  }

  private finishAuxiliarySubmission(outcome: string, error?: string): void {
    const auxiliary = this.auxiliarySubmission;
    if (!auxiliary) return;
    this.auxiliarySubmission = null;
    this.emitSupervisor({
      type: "sessionTurnTerminal",
      submissionId: auxiliary.submissionId,
      outcome,
      error,
      providerSessionId: this.session?.sessionId,
      lastProviderEventSequence: auxiliary.lastProviderEventSequence,
    });
  }

  private acknowledge(sequence: number): void {
    if (!Number.isInteger(sequence) || sequence <= this.acknowledgedSequence) {
      return;
    }
    if (sequence > this.sequence) {
      throw new Error(
        "Provider worker received an invalid event acknowledgement",
      );
    }
    this.acknowledgedSequence = sequence;
    let removeCount = 0;
    let removeBytes = 0;
    for (const event of this.events) {
      if (event.sequence > sequence) break;
      removeCount += 1;
      removeBytes += event.bytes;
    }
    if (removeCount > 0) {
      this.events.splice(0, removeCount);
      this.bufferedBytes -= removeBytes;
    }
  }

  private async call(method: string, rawArgs: unknown): Promise<unknown> {
    const session = this.requireSession();
    const args = Array.isArray(rawArgs) ? rawArgs : [];
    switch (method) {
      case "drainQueue":
        return session.queue.drain();
      case "probeLiveness":
        return await session.probeLiveness?.();
      case "refreshPromptCache":
        return await session.refreshPromptCache?.(
          args[0] as { sessionId: string },
        );
      case "publishAgentctlSessionId": {
        const sessionId = String(args[0]);
        const requestedEnvironment = args[1];
        if (
          requestedEnvironment &&
          typeof requestedEnvironment === "object" &&
          !Array.isArray(requestedEnvironment)
        ) {
          this.browserDebugEnvironment = pickBrowserDebugAgentEnvironment(
            requestedEnvironment as Record<string, string>,
          );
        }
        await session.publishAgentctlSessionId?.(
          sessionId,
          this.browserDebugEnvironment,
        );
        this.emitSupervisor({ type: "bound", sessionId });
        return undefined;
      }
      case "steer":
        if (this.auxiliarySubmission) {
          throw new Error("A provider-host session turn is already active");
        }
        return await session.steer?.(args[0] as UserMessage);
      case "setMaxThinkingTokens":
        return await session.setMaxThinkingTokens?.(args[0] as number | null);
      case "setEffort":
        return await session.setEffort?.(
          (args[0] ?? undefined) as Parameters<
            NonNullable<AgentSession["setEffort"]>
          >[0],
        );
      case "setSessionOptions":
        return session.setSessionOptions
          ? await session.setSessionOptions(args[0] as ProviderSessionOptions)
          : unknownProviderSessionOptionsResult(
              args[0] as ProviderSessionOptions,
              "This provider adapter has no session-option control implementation",
            );
      case "interrupt":
        return await session.interrupt?.();
      case "supportedModels":
        return await session.supportedModels?.();
      case "supportedCommands":
        return await session.supportedCommands?.();
      case "setModel":
        return await session.setModel?.(
          (args[0] ?? undefined) as string | undefined,
        );
      case "runProviderCommand":
        if (this.auxiliarySubmission) {
          throw new Error("A provider-host session turn is already active");
        }
        return await session.runProviderCommand?.(
          String(args[0]),
          (args[1] ?? undefined) as string | undefined,
        );
      default:
        throw new Error(`Unknown provider session method ${method}`);
    }
  }

  private requireSession(): AgentSession {
    if (!this.session) throw new Error("Provider session is not ready");
    return this.session;
  }

  private requestApproval(
    toolName: string,
    input: unknown,
    permissionMode: PermissionMode | undefined,
    signal: AbortSignal,
  ): Promise<ToolApprovalResult> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const auxiliary = this.auxiliarySubmission;
      if (auxiliary?.started) {
        this.emitSupervisor({
          type: "sessionTurnApproval",
          submissionId: auxiliary.submissionId,
          requestId,
          toolName,
          controlledBy: this.attachedController ? "hono" : null,
        });
        if (!this.attachedController) {
          auxiliary.terminalOutcome = "provider-approval-required";
          resolve({
            behavior: "deny",
            message: "No Hono approval controller is attached",
            interrupt: true,
          });
          return;
        }
      }
      const onAbort = () => {
        if (!this.pendingApprovals.delete(requestId)) return;
        this.emitController({ type: "approvalCancelled", requestId });
        resolve({
          behavior: "deny",
          message: "Operation interrupted",
          interrupt: true,
        });
      };
      const pending: PendingApproval = {
        requestId,
        toolName,
        input,
        permissionMode,
        resolve,
        removeAbortListener: () => signal.removeEventListener("abort", onAbort),
      };
      this.pendingApprovals.set(requestId, pending);
      signal.addEventListener("abort", onAbort, { once: true });
      this.writeApproval(this.attachedController?.write, pending);
    });
  }

  private writeApproval(
    write: ((message: unknown) => void) | undefined,
    pending: PendingApproval,
  ): void {
    write?.({
      type: "approval",
      requestId: pending.requestId,
      toolName: pending.toolName,
      input: pending.input,
      permissionMode: pending.permissionMode,
    });
  }

  private refreshRetention(): void {
    const session = this.session;
    if (!session) return;
    this.providerRetention = session.getProviderRetention?.() ?? {
      retained: false,
      reasons: [],
    };
    this.emitController({
      type: "providerRetention",
      value: this.providerRetention,
    });
  }

  private reportProviderPid(): void {
    const session = this.session;
    if (!session) return;
    const pid = resolvedPid(session);
    if (!pid || pid === this.lastProviderPid) return;
    this.lastProviderPid = pid;
    this.emitSupervisor({ type: "providerPid", pid });
  }

  private emitController(message: unknown): void {
    this.attachedController?.write(message);
  }

  private emitSupervisor(message: unknown): void {
    this.options.emitSupervisor?.(message);
  }

  private signalTerminal(reason: string, exitCode: number): void {
    if (this.terminalSignalled) return;
    this.terminalSignalled = true;
    void this.shutdown(reason).finally(() => {
      void this.options.onTerminal?.(reason, exitCode);
    });
  }

  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return await this.shuttingDown;
    this.shuttingDown = (async () => {
      for (const pending of this.pendingApprovals.values()) {
        pending.removeAbortListener();
        pending.resolve({
          behavior: "deny",
          message: `Provider runtime ended: ${reason}`,
          interrupt: true,
        });
      }
      this.pendingApprovals.clear();
      this.unsubscribeQueueDepth?.();
      this.unsubscribeQueueDepth = null;
      this.unsubscribeQueueRemoved?.();
      this.unsubscribeQueueRemoved = null;
      this.unsubscribeQueueYielded?.();
      this.unsubscribeQueueYielded = null;
      this.finishAuxiliarySubmission("interrupted");
      await Promise.resolve(this.session?.abort()).catch(() => {});
      this.attachedController = null;
    })();
    return await this.shuttingDown;
  }
}
