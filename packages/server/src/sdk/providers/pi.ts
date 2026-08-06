/**
 * pi provider — Plan A: subprocess RPC mode (`pi --mode rpc`).
 *
 * pi (Mario Zechner's provider-agnostic coding agent, @earendil-works/pi) ships
 * a headless JSON-RPC front-door that is a peer of its TUI on one shared
 * AgentSessionRuntime — so this is "pi as shipped, headless", not TUI driving.
 * See topics/pi-provider.md for the full plan (Plan A here; Plan B = in-process
 * SDK; PiSessionReader / steering / permission-bridge are documented follow-ups).
 *
 * One `pi --mode rpc` child runs per YA session. Commands go to stdin as
 * LF-JSONL; stdout interleaves command responses, agent events, and extension
 * UI requests (see pi-rpc-client.ts). Each YA user turn sends `prompt` and
 * streams agent events until `agent_settled`, normalizing them to YA
 * SDKMessages.
 */

import { type ChildProcess, exec, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { EffortLevel, ModelInfo } from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import { whichCommand } from "../cli-detection.js";
import { MessageQueue } from "../messageQueue.js";
import { forkPiSessionFile } from "../../sessions/pi-fork.js";
import { PiSessionReader } from "../../sessions/pi-reader.js";
import type {
  ContentBlock,
  ProviderCommandResult,
  ProviderLivenessProbeResult,
  SDKMessage,
} from "../types.js";
import { PiRpcClient } from "./pi-rpc-client.js";
import {
  attachPiResultDetailToToolInput,
  normalizePiTool,
  normalizePiToolResult,
  stringifyPiToolResult,
  type PiToolState,
} from "./pi-tools.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  ProviderForkBoundary,
  StartSessionOptions,
} from "./types.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const PI_AGENT_SETTLED_MIN_VERSION = [0, 80, 4] as const;

/** pi image content block, as accepted by the RPC `prompt`/`steer` commands. */
interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

/** Subset of pi's `Model` we read from get_available_models / get_state. */
interface PiModel {
  provider: string;
  id: string;
  name?: string;
}

/** Subset of pi's `RpcSessionState` we read from get_state. */
interface PiSessionState {
  sessionId: string;
  sessionFile?: string;
  isStreaming?: boolean;
  model?: PiModel | null;
}

interface PiModelSelection {
  provider: string;
  modelId: string;
}

interface PiRuntimeState {
  lastRawProviderEventAt: Date | null;
  lastRawProviderEventSource: string | null;
}

/** Per-turn streaming state for the in-flight assistant message. */
interface PiStreamState {
  /** Stable base id; text uses it, thinking uses `${id}-thinking`. */
  currentAssistantId: string | null;
  /** Cumulative assistant text so far (emitted whole each update). */
  text: string;
  /** Cumulative assistant thinking so far (emitted whole each update). */
  thinking: string;
  lastUsage: SdkUsage | null;
  lastCostUsd: number | null;
  /** Version-selected event that ends one YA provider turn. */
  terminalEvent: "agent_end" | "agent_settled";
  /** Canonical tool inputs by pi toolCallId, updated by live partial/final events. */
  toolStates: Map<string, PiToolState>;
}

/** Stable per-message id for streamed assistant content. */
function mintAssistantId(): string {
  return `pi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface SdkUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface PiProviderConfig {
  /** Path to the pi binary (auto-detected if not specified). */
  piPath?: string;
  /** Override for testing (defaults to ~/.pi/agent/sessions). */
  sessionsDir?: string;
}

export function piVersionUsesAgentSettled(rawVersion: string): boolean | null {
  const match = rawVersion.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  const version = match.slice(1, 4).map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < PI_AGENT_SETTLED_MIN_VERSION.length; i++) {
    const actual = version[i] ?? 0;
    const minimum = PI_AGENT_SETTLED_MIN_VERSION[i] ?? 0;
    if (actual !== minimum) return actual > minimum;
  }
  return true;
}

/** YA EffortLevel → pi ThinkingLevel (pi has no "max"; map it to "xhigh"). */
function effortToThinkingLevel(effort: EffortLevel): string {
  return effort === "max" ? "xhigh" : effort;
}

function parsePiModelSelection(
  model: string | undefined,
): PiModelSelection | undefined {
  if (!model || model === "default" || model === "auto") {
    return undefined;
  }
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    return undefined;
  }
  return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

function isProcessStillAlive(proc: ChildProcess): boolean {
  return !proc.killed && proc.exitCode === null && proc.signalCode === null;
}

function mapPiUsage(usage: unknown): {
  usage: SdkUsage;
  costUsd: number | null;
} | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
  return {
    usage: {
      input_tokens: u.input ?? 0,
      output_tokens: u.output ?? 0,
      cache_read_input_tokens: u.cacheRead ?? 0,
      cache_creation_input_tokens: u.cacheWrite ?? 0,
    },
    costUsd: typeof u.cost?.total === "number" ? u.cost.total : null,
  };
}

/**
 * pi provider (RPC subprocess mode).
 */
export class PiProvider implements AgentProvider {
  readonly name = "pi" as const;
  readonly displayName = "pi";
  // pi runs tools autonomously; the YA approval bridge (tool_execution_start
  // "can block" hook over extension_ui_request) is a documented follow-up, so
  // YA permission modes do not yet gate pi tools.
  readonly supportsPermissionMode = false;
  readonly supportsThinkingToggle = true;
  // Native /compact etc. exist, but the command inventory isn't surfaced yet.
  readonly supportsSlashCommands = false;
  // True steering exists in pi (steer lands before the next LLM call); wiring
  // it to YA's steer dispatch is a follow-up, so start conservative (queue).
  readonly supportsSteering = false;

  private readonly configuredPath?: string;
  private readonly sessionsDir?: string;
  private cachedModels: { at: number; models: ModelInfo[] } | null = null;
  private readonly cachedTerminalEvents = new Map<
    string,
    "agent_end" | "agent_settled"
  >();

  constructor(config: PiProviderConfig = {}) {
    this.configuredPath = config.piPath;
    this.sessionsDir = config.sessionsDir;
  }

  async isInstalled(): Promise<boolean> {
    return (await this.findPiPath()) !== null;
  }

  async isAuthenticated(): Promise<boolean> {
    // pi resolves credentials per-model (auth.json / env keys). Treat "installed"
    // as usable; a missing key surfaces as a turn error, like opencode.
    return this.isInstalled();
  }

  async getAuthStatus(): Promise<AuthStatus> {
    const installed = await this.isInstalled();
    return {
      installed,
      authenticated: installed,
      enabled: installed,
      loginCommand: installed ? undefined : "pi",
    };
  }

  /**
   * List models by briefly running an ephemeral `pi --mode rpc --no-session`
   * and querying get_available_models. Cached for 5 minutes; falls back to a
   * single "default" entry on any failure so the provider still appears.
   */
  async getAvailableModels(): Promise<ModelInfo[]> {
    const fresh =
      this.cachedModels && Date.now() - this.cachedModels.at < 5 * 60_000;
    if (fresh && this.cachedModels) {
      return this.cachedModels.models;
    }

    const defaultModel: ModelInfo = {
      id: "default",
      name: "Default",
      description: "pi default model",
    };
    const fallback: ModelInfo[] = [defaultModel];

    const piPath = await this.findPiPath();
    if (!piPath) return fallback;

    let proc: ChildProcess | undefined;
    try {
      proc = spawn(piPath, ["--mode", "rpc", "--no-session"], {
        cwd: homedir(),
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });
      const client = new PiRpcClient(proc);
      const response = await client.request(
        { type: "get_available_models" },
        10000,
      );
      const models =
        response.success && response.data
          ? this.mapModels(
              (response.data as { models?: PiModel[] }).models ?? [],
            )
          : [];
      const result = models.length > 0 ? [defaultModel, ...models] : fallback;
      this.cachedModels = { at: Date.now(), models: result };
      return result;
    } catch (error) {
      getLogger().debug({ error }, "pi: model listing failed; using fallback");
      return fallback;
    } finally {
      proc?.kill("SIGTERM");
    }
  }

  private mapModels(models: PiModel[]): ModelInfo[] {
    return models.map((m) => ({
      id: `${m.provider}/${m.id}`,
      name: m.name ?? `${m.provider}/${m.id}`,
    }));
  }

  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const log = getLogger();
    const piPath = await this.findPiPath();
    if (!piPath) {
      return this.errorSession("pi CLI not found");
    }
    const terminalEvent = await this.getPiTerminalEvent(piPath);
    if (!terminalEvent) {
      return this.errorSession(
        "Unable to determine pi RPC lifecycle support from `pi --version`",
      );
    }

    const args = ["--mode", "rpc"];
    if (options.model && options.model !== "default") {
      args.push("--model", options.model);
    }
    if (options.resumeSessionId) {
      args.push("--session", options.resumeSessionId);
    }

    let proc: ChildProcess;
    try {
      proc = spawn(piPath, args, {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...options.remoteEnv },
      });
    } catch (error) {
      return this.errorSession(
        `Failed to spawn pi: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    proc.stderr?.on("data", (chunk: Buffer) => {
      log.debug({ line: chunk.toString().trim() }, "pi stderr");
    });

    const client = new PiRpcClient(proc);

    // Resolve the pi session id synchronously (relative to Supervisor startup)
    // so waitForSessionId() resolves on the first init yield.
    let sessionId: string;
    try {
      const state = await client.request({ type: "get_state" }, 10000);
      if (!state.success) {
        throw new Error(state.error ?? "get_state failed");
      }
      sessionId = (state.data as PiSessionState).sessionId;
    } catch (error) {
      proc.kill("SIGTERM");
      return this.errorSession(
        `pi session did not start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    log.info({ sessionId, cwd: options.cwd }, "pi RPC session ready");

    // Best-effort thinking level (effort wins; else leave pi's model default).
    if (options.effort) {
      void client
        .request({
          type: "set_thinking_level",
          level: effortToThinkingLevel(options.effort),
        })
        .catch(() => {});
    }

    const queue = new MessageQueue();
    const abortController = new AbortController();
    const runtime: PiRuntimeState = {
      lastRawProviderEventAt: null,
      lastRawProviderEventSource: null,
    };
    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    const iterator = this.runSession(
      client,
      proc,
      sessionId,
      queue,
      abortController.signal,
      options,
      runtime,
      terminalEvent,
    );

    return {
      iterator,
      queue,
      abort: () => abortController.abort(),
      // Graceful turn interrupt: stop the in-flight turn but keep the process.
      interrupt: async () => {
        try {
          const r = await client.request({ type: "abort" }, 5000);
          return r.success;
        } catch {
          return false;
        }
      },
      isProcessAlive: () => isProcessStillAlive(proc),
      probeLiveness: () => this.probeLiveness(client, proc),
      getProviderActivity: () => ({
        lastRawProviderEventAt: runtime.lastRawProviderEventAt,
        lastRawProviderEventSource: runtime.lastRawProviderEventSource,
      }),
      supportedModels: () => this.getAvailableModels(),
      setModel: async (model?: string) => {
        const sel = parsePiModelSelection(model);
        if (!sel) return;
        await client
          .request({
            type: "set_model",
            provider: sel.provider,
            modelId: sel.modelId,
          })
          .catch(() => {});
      },
      runProviderCommand: (command, argument) =>
        this.runProviderCommand(client, command, argument),
      sessionId,
      get pid() {
        return proc.pid;
      },
    };
  }

  async forkSession(options: {
    sessionId: string;
    cwd: string;
    upToMessageId?: string;
    boundary?: ProviderForkBoundary;
    title?: string;
  }): Promise<{ sessionId: string }> {
    if (options.boundary && options.boundary.kind !== "entry") {
      throw new Error("Pi fork requires an entry boundary");
    }
    const reader = new PiSessionReader({
      sessionsDir: this.sessionsDir,
      projectPath: options.cwd,
    });
    const sourcePath = await reader.getSessionFilePath(options.sessionId);
    if (!sourcePath) {
      throw new Error(`Pi session ${options.sessionId} was not found`);
    }
    const fork = await forkPiSessionFile({
      sourcePath,
      cwd: options.cwd,
      upToMessageId:
        options.boundary?.kind === "entry"
          ? options.boundary.entryId
          : options.upToMessageId,
    });
    return { sessionId: fork.sessionId };
  }

  /**
   * Native command dispatch. pi owns /compact (RPC `compact`); everything else
   * falls back to normal turn delivery.
   */
  private async runProviderCommand(
    client: PiRpcClient,
    command: string,
    argument?: string,
  ): Promise<ProviderCommandResult> {
    const normalized = command.replace(/^\//, "").trim().toLowerCase();
    if (normalized !== "compact") {
      return { handled: false };
    }
    try {
      const r = await client.request(
        {
          type: "compact",
          ...(argument ? { customInstructions: argument } : {}),
        },
        120000,
      );
      return r.success
        ? { handled: true }
        : { handled: true, error: r.error ?? "compact failed" };
    } catch (error) {
      return {
        handled: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async probeLiveness(
    client: PiRpcClient,
    proc: ChildProcess,
  ): Promise<ProviderLivenessProbeResult> {
    const checkedAt = new Date();
    if (!isProcessStillAlive(proc)) {
      return {
        status: "unavailable",
        source: "pi:process",
        detail: "pi process is not alive",
        checkedAt,
      };
    }
    try {
      const r = await client.request({ type: "get_state" }, 5000);
      if (!r.success) {
        return {
          status: "error",
          source: "pi:get_state",
          detail: r.error ?? "get_state failed",
          checkedAt,
        };
      }
      const streaming = (r.data as PiSessionState).isStreaming === true;
      return {
        status: streaming ? "active" : "idle",
        source: "pi:get_state",
        detail: streaming ? "pi is streaming" : "pi is idle",
        checkedAt,
      };
    } catch (error) {
      return {
        status: "error",
        source: "pi:get_state",
        detail: error instanceof Error ? error.message : String(error),
        checkedAt,
      };
    }
  }

  /**
   * Session loop. Process + RPC client are already up and the session id is
   * known. Yields an init message first, then per queued user turn sends a
   * `prompt` and streams agent events until `agent_settled`.
   */
  private async *runSession(
    client: PiRpcClient,
    proc: ChildProcess,
    sessionId: string,
    queue: MessageQueue,
    signal: AbortSignal,
    options: StartSessionOptions,
    runtime: PiRuntimeState,
    terminalEvent: PiStreamState["terminalEvent"],
  ): AsyncIterableIterator<SDKMessage> {
    const log = getLogger();

    // Shared event buffer fed by the single stdout subscription, drained per
    // turn. `wake` lets the per-turn drain block until the next event/exit.
    const events: SDKMessage[] = [];
    let wake: (() => void) | null = null;
    let processExited = false;

    const stream: PiStreamState = {
      currentAssistantId: null,
      text: "",
      thinking: "",
      lastUsage: null,
      lastCostUsd: null,
      terminalEvent,
      toolStates: new Map(),
    };

    const unsubscribe = client.subscribe((event) => {
      runtime.lastRawProviderEventAt = new Date();
      runtime.lastRawProviderEventSource = `pi:event:${event.type}`;
      for (const sdk of this.mapEvent(event, sessionId, stream)) {
        events.push(sdk);
      }
      wake?.();
    });
    const onExit = () => {
      processExited = true;
      wake?.();
    };
    proc.once("exit", onExit);

    const abortHandler = () => {
      log.info({ sessionId }, "Aborting pi process");
      proc.kill("SIGTERM");
    };
    signal.addEventListener("abort", abortHandler);

    // Init message — resolves waitForSessionId().
    yield {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      cwd: options.cwd,
    } as SDKMessage;

    try {
      let isFirst = true;
      for await (const message of queue) {
        if (signal.aborted) break;

        let text = this.extractText(message);
        const images = this.extractImages(message);
        if (isFirst && options.globalInstructions) {
          text = `[Global context]\n${options.globalInstructions}\n\n---\n\n${text}`;
        }
        isFirst = false;

        yield {
          type: "user",
          uuid: message.uuid,
          session_id: sessionId,
          message: { role: "user", content: text },
        } as SDKMessage;

        // `agent_settled` flips this true after retries, compaction, and queued
        // continuations finish; the drain loop stops only at that boundary.
        let turnComplete = false;
        stream.currentAssistantId = null;
        stream.text = "";
        stream.thinking = "";
        stream.toolStates.clear();
        client.notify({
          type: "prompt",
          message: text,
          ...(images.length > 0 ? { images } : {}),
        });

        while (!turnComplete && !signal.aborted) {
          while (events.length > 0) {
            const sdk = events.shift();
            if (!sdk) continue;
            if (sdk.type === "result") {
              turnComplete = true;
            }
            yield sdk;
          }
          if (turnComplete) break;
          if (processExited) {
            yield {
              type: "result",
              session_id: sessionId,
              error: "pi process exited mid-turn",
            } as SDKMessage;
            break;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 200);
          });
          wake = null;
        }
      }
    } finally {
      unsubscribe();
      proc.off("exit", onExit);
      signal.removeEventListener("abort", abortHandler);
      if (!proc.killed) {
        proc.kill("SIGTERM");
      }
    }
  }

  /**
   * Map one pi AgentSessionEvent to zero or more YA SDKMessages.
   *
   * Streaming text/thinking are emitted as delta slices under a stable per-
   * message uuid (YA appends same-uuid assistant content). `agent_settled`
   * becomes a `result` carrying the last turn's usage — the drain loop's turn
   * boundary. `agent_end` only ends one low-level run and may precede automatic
   * retry, compaction, or queued continuation.
   */
  private mapEvent(
    event: { type: string; [key: string]: unknown },
    sessionId: string,
    stream: PiStreamState,
  ): SDKMessage[] {
    switch (event.type) {
      case "message_start": {
        // A fresh assistant message: mint a stable id and reset accumulators.
        const message = event.message as { role?: string } | undefined;
        if (message?.role === "assistant") {
          stream.currentAssistantId = mintAssistantId();
          stream.text = "";
          stream.thinking = "";
        }
        return [];
      }

      case "message_update": {
        const ame = event.assistantMessageEvent as
          | { type?: string; delta?: string }
          | undefined;
        if (!ame?.delta) return [];
        // YA merges same-uuid assistant messages by replacement (mergeMessage:
        // both-SDK -> keep newer), not by appending — so each emission must carry
        // the *cumulative* content, like codex-oss/gemini/grok. Emitting bare
        // deltas drops all but the final chunk (text appears truncated at the
        // start). Text and thinking get distinct stable uuids so their string vs
        // block-array content shapes don't clobber one another.
        if (!stream.currentAssistantId) {
          stream.currentAssistantId = mintAssistantId();
        }
        const baseId = stream.currentAssistantId;
        if (ame.type === "text_delta") {
          stream.text += ame.delta;
          return [
            {
              type: "assistant",
              session_id: sessionId,
              uuid: baseId,
              message: { role: "assistant", content: stream.text },
            } as SDKMessage,
          ];
        }
        if (ame.type === "thinking_delta") {
          stream.thinking += ame.delta;
          return [
            {
              type: "assistant",
              session_id: sessionId,
              uuid: `${baseId}-thinking`,
              message: {
                role: "assistant",
                content: [
                  { type: "thinking", thinking: stream.thinking },
                ] satisfies ContentBlock[],
              },
            } as SDKMessage,
          ];
        }
        return [];
      }

      case "message_end": {
        stream.currentAssistantId = null;
        stream.text = "";
        stream.thinking = "";
        return [];
      }

      case "turn_end": {
        const message = event.message as { usage?: unknown } | undefined;
        const mapped = mapPiUsage(message?.usage);
        if (mapped) {
          stream.lastUsage = mapped.usage;
          stream.lastCostUsd = mapped.costUsd;
        }
        return [];
      }

      case "tool_execution_start": {
        const toolName = String(event.toolName ?? "tool");
        const id = String(event.toolCallId ?? "");
        const { name, input } = normalizePiTool(toolName, event.args ?? {});
        stream.toolStates.set(id, { name, input });
        return [this.makeToolUseMessage(sessionId, id, name, input)];
      }

      case "tool_execution_update": {
        const id = String(event.toolCallId ?? "");
        const state = stream.toolStates.get(id);
        if (state?.name !== "Bash") return [];
        const preview = normalizePiToolResult(
          state.name,
          event.partialResult,
          state.input,
          false,
        );
        if (preview === undefined) return [];
        state.input = { ...state.input, _previewResult: preview };
        stream.toolStates.set(id, state);
        return [
          this.makeToolUseMessage(sessionId, id, state.name, state.input),
        ];
      }

      case "tool_execution_end": {
        const id = String(event.toolCallId ?? "");
        const state =
          stream.toolStates.get(id) ??
          (() => {
            const normalized = normalizePiTool(
              String(event.toolName ?? "tool"),
              event.args ?? {},
            );
            return { name: normalized.name, input: normalized.input };
          })();
        const isError = event.isError === true;
        attachPiResultDetailToToolInput(state.name, state.input, event.result);
        const structured = normalizePiToolResult(
          state.name,
          event.result,
          state.input,
          isError,
        );
        const resultMessage: SDKMessage = {
          type: "user",
          session_id: sessionId,
          ...(structured !== undefined ? { toolUseResult: structured } : {}),
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: id,
                content: stringifyPiToolResult(event.result),
                is_error: isError,
              },
            ],
          },
        } as SDKMessage;
        const messages: SDKMessage[] = [resultMessage];
        if (state.input._rawPatch || state.input._previewResult) {
          messages.unshift(
            this.makeToolUseMessage(sessionId, id, state.name, state.input),
          );
        }
        stream.toolStates.delete(id);
        return messages;
      }

      case "agent_end":
      case "agent_settled": {
        if (event.type !== stream.terminalEvent) return [];
        const result: SDKMessage = {
          type: "result",
          session_id: sessionId,
        } as SDKMessage;
        if (stream.lastUsage) {
          result.usage = stream.lastUsage;
        }
        if (stream.lastCostUsd !== null) {
          result.total_cost_usd = stream.lastCostUsd;
        }
        stream.lastUsage = null;
        stream.lastCostUsd = null;
        return [result];
      }

      default:
        return [];
    }
  }

  private makeToolUseMessage(
    sessionId: string,
    id: string,
    name: string,
    input: Record<string, unknown>,
  ): SDKMessage {
    return {
      type: "assistant",
      session_id: sessionId,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id,
            name,
            input,
          },
        ],
      },
    } as SDKMessage;
  }

  private errorSession(errorMsg: string): AgentSession {
    const queue = new MessageQueue();
    return {
      iterator: (async function* () {
        yield { type: "error", error: errorMsg } as SDKMessage;
      })(),
      queue,
      abort: () => {},
    };
  }

  private extractText(message: SDKUserMessage): string {
    const content = message.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter(
          (block): block is { type: "text"; text: string } =>
            typeof block === "object" &&
            block !== null &&
            (block as { type?: unknown }).type === "text",
        )
        .map((block) => block.text)
        .join("\n");
    }
    return "";
  }

  private extractImages(message: SDKUserMessage): PiImageContent[] {
    const content = message.message?.content;
    if (!Array.isArray(content)) return [];
    const images: PiImageContent[] = [];
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as {
        type?: string;
        source?: { type?: string; media_type?: string; data?: string };
      };
      if (b.type === "image" && b.source?.type === "base64" && b.source.data) {
        images.push({
          type: "image",
          data: b.source.data,
          mimeType: b.source.media_type || "image/png",
        });
      }
    }
    return images;
  }

  private async findPiPath(): Promise<string | null> {
    const envExecutable = process.env.PI_EXECUTABLE ?? process.env.PI_PATH;
    if (envExecutable && existsSync(envExecutable)) {
      return envExecutable;
    }
    if (this.configuredPath && existsSync(this.configuredPath)) {
      return this.configuredPath;
    }
    const commonPaths = [
      join(homedir(), ".local", "bin", "pi"),
      "/usr/local/bin/pi",
      join(homedir(), "bin", "pi"),
      join(homedir(), ".bun", "bin", "pi"),
    ];
    for (const path of commonPaths) {
      if (existsSync(path)) return path;
    }
    try {
      const { stdout } = await execAsync(whichCommand("pi"), {
        encoding: "utf-8",
      });
      const result = stdout.trim();
      if (result && existsSync(result)) return result;
    } catch {
      // Not in PATH.
    }
    return null;
  }

  private async getPiTerminalEvent(
    piPath: string,
  ): Promise<"agent_end" | "agent_settled" | null> {
    const cached = this.cachedTerminalEvents.get(piPath);
    if (cached) return cached;
    try {
      const { stdout } = await execFileAsync(piPath, ["--version"], {
        encoding: "utf-8",
      });
      const usesAgentSettled = piVersionUsesAgentSettled(stdout);
      if (usesAgentSettled === null) return null;
      const terminalEvent = usesAgentSettled ? "agent_settled" : "agent_end";
      this.cachedTerminalEvents.set(piPath, terminalEvent);
      return terminalEvent;
    } catch (error) {
      getLogger().debug({ error, piPath }, "pi: version probe failed");
      return null;
    }
  }
}

/** Default pi provider instance. */
export const piProvider = new PiProvider();
