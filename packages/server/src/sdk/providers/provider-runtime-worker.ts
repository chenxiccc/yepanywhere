import "../../startupEnv.js";
import { randomUUID } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import type { PermissionMode } from "@yep-anywhere/shared";
import { prepareSessionSandbox } from "../../session-sandbox.js";
import type { MessageQueue } from "../messageQueue.js";
import type {
  CanUseTool,
  ProviderActivitySnapshot,
  ProviderRetentionSnapshot,
  SDKMessage,
  ToolApprovalResult,
  UserMessage,
} from "../types.js";
import { getModuleEnv } from "../../yaModuleEnv.js";
import { ClaudeGatewayProvider } from "./claude-gateway.js";
import { ClaudeOllamaProvider } from "./claude-ollama.js";
import { grokACPProvider } from "./grok-acp.js";
import {
  configureProviderRuntime,
  getRawProvider,
  type ProviderRuntimeSnapshot,
} from "./index.js";
import type {
  AgentSession,
  ProviderName,
  StartSessionOptions,
} from "./types.js";

const MAX_UNACKNOWLEDGED_EVENTS = 10_000;
const MAX_UNACKNOWLEDGED_BYTES = 64 * 1024 * 1024;
const WORKER_PROTOCOL_VERSION = 1;

interface WorkerLaunchRequest {
  providerName: ProviderName;
  options: StartSessionOptions;
  runtimeConfig: ProviderRuntimeSnapshot;
}

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readLaunchRequest(): Promise<WorkerLaunchRequest> {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const parsed = JSON.parse(input) as WorkerLaunchRequest;
  if (!parsed || typeof parsed.providerName !== "string") {
    throw new Error("Provider worker received an invalid launch request");
  }
  return parsed;
}

function write(socket: Socket | null, message: unknown): void {
  if (!socket || socket.destroyed) return;
  socket.write(`${JSON.stringify(message)}\n`);
}

function resolvedPid(session: AgentSession): number | undefined {
  return typeof session.pid === "function" ? session.pid() : session.pid;
}

class ProviderRuntimeWorker {
  private server: ReturnType<typeof createServer> | null = null;
  private connections = new Set<Socket>();
  private attachedSocket: Socket | null = null;
  private attachedGeneration: string | null = null;
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
  private lastProviderPid: number | undefined;

  constructor(
    private readonly socketPath: string,
    private readonly token: string,
    private readonly runtimeId: string,
  ) {}

  async start(request: WorkerLaunchRequest): Promise<void> {
    await this.configureRuntime(request.runtimeConfig);
    const provider = getRawProvider(request.providerName);
    if (!provider) throw new Error(`Unknown provider ${request.providerName}`);
    if (request.providerName === "claude-gateway") {
      await provider.getAvailableModels();
      const gatewayProcessGroupId =
        ClaudeGatewayProvider.getOwnedGatewayProcessGroupId();
      if (gatewayProcessGroupId) {
        this.sendParent({
          type: "retainedProcessGroup",
          processGroupId: gatewayProcessGroupId,
        });
        ClaudeGatewayProvider.relinquishOwnedGatewayProcessGroup(
          gatewayProcessGroupId,
        );
      }
    }

    const sandboxOptions = request.options.sessionSandboxOptions;
    if (
      sandboxOptions &&
      sandboxOptions.provider !== request.providerName &&
      !(
        sandboxOptions.provider === "gemini" &&
        request.providerName === "gemini-acp"
      )
    ) {
      throw new Error("Provider worker sandbox request has the wrong provider");
    }
    const sessionSandbox = sandboxOptions
      ? await prepareSessionSandbox(sandboxOptions)
      : undefined;

    const onToolApproval: CanUseTool = (toolName, input, options) =>
      this.requestApproval(
        toolName,
        input,
        options.permissionMode,
        options.signal,
      );

    const session = await provider.startSession({
      ...request.options,
      sessionSandbox,
      sessionSandboxOptions: undefined,
      onToolApproval,
      shouldEmitLiveDeltas: () => true,
      onPermissionModeApplied: (mode) => {
        this.appliedPermissionMode = mode;
        write(this.attachedSocket, { type: "permissionMode", mode });
      },
      onProviderRetentionChange: () => this.refreshRetention(),
    });
    this.session = session;
    this.reportProviderPid();
    this.providerActivity = session.getProviderActivity?.() ?? {};
    this.providerRetention = session.getProviderRetention?.() ?? {
      retained: false,
      reasons: [],
    };
    this.queueDepth = session.queue.depth;
    this.observeQueueDepth(session.queue);

    await rm(this.socketPath, { force: true });
    this.server = createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      server.once("error", reject);
      server.listen(this.socketPath, resolve);
    });
    await chmod(this.socketPath, 0o600);

    void this.drainProviderIterator(session);
    this.reportProviderPid();
    this.sendParent({
      type: "ready",
      providerPid: this.lastProviderPid,
      metadata: {
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
          interrupt: Boolean(session.interrupt),
          supportedModels: Boolean(session.supportedModels),
          supportedCommands: Boolean(session.supportedCommands),
          setModel: Boolean(session.setModel),
          runProviderCommand: Boolean(session.runProviderCommand),
        },
        sandbox: sessionSandbox
          ? {
              enforcement: sessionSandbox.enforcement,
              stateKey: sessionSandbox.stateKey,
              projectPath: sessionSandbox.projectPath,
            }
          : undefined,
      },
    });
  }

  private async configureRuntime(
    config: ProviderRuntimeSnapshot,
  ): Promise<void> {
    configureProviderRuntime({
      codexCliPath: config.codexCliPath,
      getClaudeAdditionalModels: () => config.claudeAdditionalModels ?? [],
      getCodexReloadSafeSessions: () => false,
      isClaudeOllamaVisible: () => true,
      getProviderRuntimeSnapshot: () => config,
    });
    ClaudeGatewayProvider.setGatewayUrl(config.claudeGatewayUrl);
    ClaudeGatewayProvider.setGatewayStartCommand(
      config.claudeGatewayStartCommand,
    );
    ClaudeGatewayProvider.setGatewayDisableAgent(
      config.claudeGatewayDisableAgent ?? true,
    );
    ClaudeOllamaProvider.setOllamaUrl(config.ollamaUrl);
    ClaudeOllamaProvider.setSystemPrompt(config.ollamaSystemPrompt);
    ClaudeOllamaProvider.setUseFullSystemPrompt(
      config.ollamaUseFullSystemPrompt ?? false,
    );
    grokACPProvider.setAmbientXaiApiKey(config.ambientXaiApiKey);
    grokACPProvider.setUseAmbientXaiApiKey(
      config.grokBuildUseXaiApiKey ?? false,
    );
    if (config.claudeGatewayUrl) {
      await ClaudeGatewayProvider.configureGateway({
        url: config.claudeGatewayUrl,
        startCommand: config.claudeGatewayStartCommand,
        disableAgent: config.claudeGatewayDisableAgent ?? true,
      });
    }
  }

  private observeQueueDepth(queue: AgentSession["queue"]): void {
    const concrete = queue as MessageQueue;
    if (typeof concrete.subscribeDepth !== "function") return;
    this.unsubscribeQueueDepth = concrete.subscribeDepth((depth) => {
      this.queueDepth = depth;
      write(this.attachedSocket, { type: "queueDepth", depth });
    });
    if (typeof concrete.subscribeRemoved === "function") {
      this.unsubscribeQueueRemoved = concrete.subscribeRemoved((messages) => {
        write(this.attachedSocket, {
          type: "queueRemoved",
          uuids: messages.flatMap((message) =>
            message.uuid ? [message.uuid] : [],
          ),
        });
      });
    }
  }

  private async drainProviderIterator(session: AgentSession): Promise<void> {
    try {
      for await (const message of session.iterator) {
        this.providerActivity = session.getProviderActivity?.() ?? {};
        this.providerRetention = session.getProviderRetention?.() ?? {
          retained: false,
          reasons: [],
        };
        this.reportProviderPid();
        this.bufferEvent(message);
      }
      this.providerAlive = false;
      write(this.attachedSocket, { type: "complete" });
      this.shutdownAndExit("provider iterator completed", 0);
    } catch (error) {
      this.providerAlive = false;
      write(this.attachedSocket, {
        type: "failed",
        error: errorMessage(error),
      });
      this.shutdownAndExit("provider iterator failed", 1);
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
      this.events.length > MAX_UNACKNOWLEDGED_EVENTS ||
      this.bufferedBytes > MAX_UNACKNOWLEDGED_BYTES
    ) {
      write(this.attachedSocket, {
        type: "failed",
        error: "Provider reload replay buffer exceeded its bound",
      });
      this.shutdownAndExit("replay buffer exceeded", 1);
      return;
    }
    write(this.attachedSocket, {
      type: "event",
      sequence,
      message,
      providerActivity: this.providerActivity,
      providerRetention: this.providerRetention,
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

  private handleConnection(socket: Socket): void {
    this.connections.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let attached = false;
    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        if (!rawLine.trim()) continue;
        let request: Record<string, unknown>;
        try {
          request = JSON.parse(rawLine) as Record<string, unknown>;
        } catch {
          write(socket, { type: "error", error: "Invalid JSON request" });
          continue;
        }
        if (!attached) {
          try {
            this.attach(socket, request);
            attached = true;
          } catch (error) {
            write(socket, { type: "error", error: errorMessage(error) });
            socket.end();
          }
          continue;
        }
        void this.handleAttachedRequest(socket, request).catch((error) => {
          const id = typeof request.id === "number" ? request.id : undefined;
          write(socket, {
            type: "rpcResult",
            id,
            ok: false,
            error: errorMessage(error),
          });
        });
      }
    });
    socket.on("close", () => {
      this.connections.delete(socket);
      if (this.attachedSocket !== socket) return;
      const generation = this.attachedGeneration;
      this.attachedSocket = null;
      this.attachedGeneration = null;
      if (generation) {
        this.sendParent({ type: "controllerDetached", generation });
      }
    });
    socket.on("error", () => {});
  }

  private attach(socket: Socket, request: Record<string, unknown>): void {
    if (request.type !== "attach" || request.token !== this.token) {
      throw new Error("Unauthorized provider worker attach");
    }
    if (request.protocolVersion !== WORKER_PROTOCOL_VERSION) {
      throw new Error("Incompatible provider worker protocol");
    }
    const generation =
      typeof request.generation === "string" ? request.generation : "";
    if (!generation) throw new Error("Missing server generation");
    if (this.attachedSocket && !this.attachedSocket.destroyed) {
      throw new Error(
        `Provider worker is already attached to ${this.attachedGeneration}`,
      );
    }
    this.attachedSocket = socket;
    this.attachedGeneration = generation;
    write(socket, {
      type: "attached",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      runtimeId: this.runtimeId,
      acknowledgedSequence: this.acknowledgedSequence,
      queueDepth: this.queueDepth,
      providerAlive: this.providerAlive,
      providerActivity: this.providerActivity,
      providerRetention: this.providerRetention,
      appliedPermissionMode: this.appliedPermissionMode,
    });
    for (const event of this.events) {
      write(socket, {
        type: "event",
        sequence: event.sequence,
        message: event.message,
        providerActivity: event.providerActivity,
        providerRetention: event.providerRetention,
      });
    }
    for (const approval of this.pendingApprovals.values()) {
      this.writeApproval(socket, approval);
    }
    if (!this.providerAlive) write(socket, { type: "complete" });
  }

  private async handleAttachedRequest(
    socket: Socket,
    request: Record<string, unknown>,
  ): Promise<void> {
    if (socket !== this.attachedSocket) {
      throw new Error("Stale provider worker controller");
    }
    if (request.type === "ack") {
      this.acknowledge(Number(request.sequence));
      return;
    }
    if (request.type === "queuePush") {
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
    write(socket, { type: "rpcResult", id: request.id, ok: true, result });
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
        await session.publishAgentctlSessionId?.(sessionId);
        this.sendParent({ type: "bound", sessionId });
        return undefined;
      }
      case "steer":
        return await session.steer?.(args[0] as UserMessage);
      case "setMaxThinkingTokens":
        return await session.setMaxThinkingTokens?.(args[0] as number | null);
      case "setEffort":
        return await session.setEffort?.(
          (args[0] ?? undefined) as Parameters<
            NonNullable<AgentSession["setEffort"]>
          >[0],
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
      const onAbort = () => {
        if (!this.pendingApprovals.delete(requestId)) return;
        write(this.attachedSocket, { type: "approvalCancelled", requestId });
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
      this.writeApproval(this.attachedSocket, pending);
    });
  }

  private writeApproval(socket: Socket | null, pending: PendingApproval): void {
    write(socket, {
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
    write(this.attachedSocket, {
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
    this.sendParent({ type: "providerPid", pid });
  }

  private sendParent(message: unknown): void {
    if (typeof process.send === "function" && process.connected) {
      process.send(message);
    }
  }

  private shutdownAndExit(reason: string, exitCode: number): void {
    void this.shutdown(reason).then(
      () => process.exit(exitCode),
      () => process.exit(1),
    );
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
      await Promise.resolve(this.session?.abort()).catch(() => {});
      for (const socket of this.connections) socket.destroy();
      this.connections.clear();
      this.attachedSocket = null;
      if (this.server) {
        await new Promise<void>((resolve) =>
          this.server!.close(() => resolve()),
        );
        this.server = null;
      }
      await rm(this.socketPath, { force: true });
    })();
    return await this.shuttingDown;
  }
}

async function main(): Promise<void> {
  const workerEnv = getModuleEnv("provider-worker");
  const socketPath = workerEnv.SOCKET;
  const token = workerEnv.TOKEN;
  const runtimeId = workerEnv.RUNTIME_ID;
  if (!socketPath || !token || !runtimeId) {
    throw new Error("Provider worker environment is incomplete");
  }
  const worker = new ProviderRuntimeWorker(socketPath, token, runtimeId);
  const terminalShutdown = (reason: string) => {
    void worker
      .shutdown(reason)
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on("message", (message: unknown) => {
    if (
      message &&
      typeof message === "object" &&
      "type" in message &&
      message.type === "shutdown"
    ) {
      terminalShutdown(
        "reason" in message ? String(message.reason) : "runtime host shutdown",
      );
    }
  });
  process.on("disconnect", () => terminalShutdown("runtime host IPC closed"));
  process.on("SIGINT", () => terminalShutdown("SIGINT"));
  process.on("SIGTERM", () => terminalShutdown("SIGTERM"));
  try {
    await worker.start(await readLaunchRequest());
  } catch (error) {
    if (typeof process.send === "function" && process.connected) {
      process.send({ type: "startupError", error: errorMessage(error) });
    }
    await worker.shutdown("provider worker startup failed").catch(() => {});
    throw error;
  }
}

void main().catch((error) => {
  process.stderr.write(`[ProviderRuntimeWorker] ${errorMessage(error)}\n`);
  process.exit(1);
});
