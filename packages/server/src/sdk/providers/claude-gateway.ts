/**
 * Claude SDK provider routed through an Anthropic-compatible LLM gateway.
 *
 * Transport settings are supplied in Claude's supplementary flag-settings
 * layer for each spawned process. This outranks user/project/local settings
 * without editing any settings file or affecting concurrently running TUIs.
 */

import type { Settings } from "@anthropic-ai/claude-agent-sdk";
import type {
  EffortLevel,
  ModelInfo,
  PromptCacheKeepaliveProviderInfo,
} from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import {
  type ClaudeGatewayLauncher,
  claudeGatewayLauncher,
} from "./claude-gateway-launcher.js";
import { ClaudeProvider } from "./claude.js";
import type { AuthStatus } from "./types.js";

interface GatewayModel {
  id?: unknown;
  display_name?: unknown;
  name?: unknown;
  model_picker_enabled?: unknown;
  supported_endpoints?: unknown;
  capabilities?: {
    type?: unknown;
    limits?: {
      max_context_window_tokens?: unknown;
      max_prompt_tokens?: unknown;
    };
    supports?: {
      reasoning_effort?: unknown;
    };
  };
  policy?: {
    state?: unknown;
  };
}

interface GatewayModelsResponse {
  data?: GatewayModel[];
}

interface GatewayModelWindows {
  contextWindow: number;
  promptWindow: number;
}

interface GatewayModelLaunchMetadata {
  windows?: GatewayModelWindows;
}

interface GatewayCatalogSnapshot {
  configurationGeneration: number;
  baseUrl: string;
  launchMetadata: Map<string, GatewayModelLaunchMetadata>;
}

/**
 * Claude Code resolves a gateway model's effective context window separately
 * from its automatic-compaction window. The total catalog window becomes the
 * former; the prompt-only ceiling bounds the latter. Automatic windows below
 * 100K cannot be expressed, so omit them rather than rounding above a model's
 * advertised hard limit.
 */
const AUTO_COMPACT_WINDOW_MIN = 100_000;
const AUTO_COMPACT_WINDOW_MAX = 1_000_000;

export function gatewayAutoCompactWindow(
  promptWindow: number | undefined,
): number | undefined {
  if (
    typeof promptWindow !== "number" ||
    !Number.isFinite(promptWindow) ||
    promptWindow < AUTO_COMPACT_WINDOW_MIN
  ) {
    return undefined;
  }
  return Math.min(AUTO_COMPACT_WINDOW_MAX, Math.round(promptWindow));
}

function gatewayMaxContextTokens(
  contextWindow: number | undefined,
): number | undefined {
  return typeof contextWindow === "number" &&
    Number.isFinite(contextWindow) &&
    contextWindow > 0
    ? Math.round(contextWindow)
    : undefined;
}

function gatewayEnvironment(
  baseUrl: string,
  model?: string,
  metadata?: GatewayModelLaunchMetadata,
): Record<string, string> {
  const maxContextTokens = gatewayMaxContextTokens(
    metadata?.windows?.contextWindow,
  );
  const autoCompactWindow = gatewayAutoCompactWindow(
    metadata?.windows?.promptWindow,
  );
  return {
    YEP_CLAUDE_GATEWAY: "1",
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: "dummy",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    // DISABLE_NON_ESSENTIAL_MODEL_CALLS is no longer read by Claude Code
    // (absent from 2.1.220's env registry); it is kept for older CLIs.
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
    // This one is a privacy/traffic choice, not a token or quota saver, and it
    // is not free: it puts the CLI in essential-traffic mode, which disables
    // GrowthBook, so every feature flag falls back to its compiled default and
    // the session loses flag-gated features — the Monitor tool and hosted push
    // among them. Retained deliberately; see topics/claude.md.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // Gateway models pay for nesting twice: every extra level multiplies
    // quota burn against a shared Copilot allowance, and the deeper agents
    // are the ones least able to recover from a truncated context. Claude
    // Code's own default is 3; one level of subagents is the useful part.
    // An explicit operator value still wins.
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH:
      process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH ?? "1",
    ...(model
      ? {
          ANTHROPIC_MODEL: model,
          ANTHROPIC_DEFAULT_OPUS_MODEL: model,
          ANTHROPIC_DEFAULT_SONNET_MODEL: model,
          ANTHROPIC_SMALL_FAST_MODEL: model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        }
      : {}),
    ...(maxContextTokens !== undefined
      ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(maxContextTokens) }
      : {}),
    ...(autoCompactWindow !== undefined
      ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(autoCompactWindow) }
      : {}),
    ...(metadata && !metadata.windows
      ? { CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1" }
      : {}),
  };
}

const CLAUDE_GATEWAY_ENDPOINTS = new Set([
  "/v1/messages",
  "/responses",
  "/chat/completions",
]);

const CLAUDE_GATEWAY_EFFORT_LEVELS = new Set<EffortLevel>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function isGatewayModelVisible(item: GatewayModel, id: string): boolean {
  if (item.model_picker_enabled === false) return false;
  if (item.policy?.state && item.policy.state !== "enabled") return false;
  if (item.capabilities?.type && item.capabilities.type !== "chat")
    return false;
  if (id.startsWith("text-embedding-") || id === "trajectory-compaction") {
    return false;
  }

  if (!Array.isArray(item.supported_endpoints)) return true;
  return item.supported_endpoints.some(
    (endpoint) =>
      typeof endpoint === "string" && CLAUDE_GATEWAY_ENDPOINTS.has(endpoint),
  );
}

function modelEffortLevels(item: GatewayModel): EffortLevel[] {
  const values = item.capabilities?.supports?.reasoning_effort;
  if (!Array.isArray(values)) return [];
  return values.filter(
    (value): value is EffortLevel =>
      typeof value === "string" &&
      CLAUDE_GATEWAY_EFFORT_LEVELS.has(value as EffortLevel),
  );
}

function positiveLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function modelWindows(item: GatewayModel): GatewayModelWindows | undefined {
  const limits = item.capabilities?.limits;
  const contextWindow = positiveLimit(limits?.max_context_window_tokens);
  if (contextWindow === undefined) return undefined;

  const advertisedPromptWindow = positiveLimit(limits?.max_prompt_tokens);
  return {
    contextWindow,
    promptWindow: Math.min(
      advertisedPromptWindow ?? contextWindow,
      contextWindow,
    ),
  };
}

interface ParsedGatewayCatalog {
  models: ModelInfo[];
  launchMetadata: Map<string, GatewayModelLaunchMetadata>;
}

function parseClaudeGatewayCatalog(value: unknown): ParsedGatewayCatalog {
  const data = (value as GatewayModelsResponse | null)?.data;
  if (!Array.isArray(data)) {
    return { models: [], launchMetadata: new Map() };
  }

  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  const launchMetadata = new Map<string, GatewayModelLaunchMetadata>();
  for (const item of data) {
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id || seen.has(id) || !isGatewayModelVisible(item, id)) continue;
    seen.add(id);
    const displayName =
      typeof item.display_name === "string"
        ? item.display_name.trim()
        : typeof item.name === "string"
          ? item.name.trim()
          : "";
    const supportedEffortLevels = modelEffortLevels(item);
    const advertisedWindows = modelWindows(item);
    launchMetadata.set(
      id,
      advertisedWindows ? { windows: advertisedWindows } : {},
    );
    models.push({
      id,
      name: displayName || id,
      ...(advertisedWindows
        ? { contextWindow: advertisedWindows.contextWindow }
        : {}),
      supportsEffort: supportedEffortLevels.length > 0,
      ...(supportedEffortLevels.length > 0
        ? {
            supportedEffortLevels,
            supportedReasoningEfforts: supportedEffortLevels.map(
              (reasoningEffort) => ({ reasoningEffort }),
            ),
          }
        : {}),
      supportsAdaptiveThinking: supportedEffortLevels.length > 0,
    });
  }
  return { models, launchMetadata };
}

export function parseClaudeGatewayModels(value: unknown): ModelInfo[] {
  return parseClaudeGatewayCatalog(value).models;
}

export class ClaudeGatewayProvider extends ClaudeProvider {
  override readonly name = "claude-gateway" as const;
  override readonly displayName = "Claude Gateway";
  override readonly supportsThinkingToggle = true;
  override readonly supportsNativePromptSuggestions = false;
  override readonly supportsLaunchCompactPercentOverride = false;
  override readonly promptCacheKeepalive:
    | PromptCacheKeepaliveProviderInfo
    | undefined = undefined;

  private static gatewayUrl: string | undefined;
  private static gatewayStartCommand: string | undefined;
  private static configurationGeneration = 0;
  /**
   * The last successful catalog and the exact endpoint that supplied it.
   * Configuration changes invalidate both facts as one generation.
   */
  private static catalogSnapshot: GatewayCatalogSnapshot | undefined;

  constructor(
    private readonly gatewayLauncher: Pick<
      ClaudeGatewayLauncher,
      "ensureReady"
    > = claudeGatewayLauncher,
  ) {
    super();
  }

  static setGatewayUrl(url: string | undefined): void {
    if (ClaudeGatewayProvider.gatewayUrl !== url) {
      ClaudeGatewayProvider.forgetGatewayCatalog();
    }
    ClaudeGatewayProvider.gatewayUrl = url;
  }

  static setGatewayStartCommand(command: string | undefined): void {
    if (ClaudeGatewayProvider.gatewayStartCommand !== command) {
      ClaudeGatewayProvider.forgetGatewayCatalog();
    }
    ClaudeGatewayProvider.gatewayStartCommand = command;
  }

  static async configureGateway(options: {
    url?: string;
    startCommand?: string;
  }): Promise<void> {
    if (
      ClaudeGatewayProvider.gatewayUrl !== options.url ||
      ClaudeGatewayProvider.gatewayStartCommand !== options.startCommand
    ) {
      ClaudeGatewayProvider.forgetGatewayCatalog();
    }
    ClaudeGatewayProvider.gatewayUrl = options.url;
    ClaudeGatewayProvider.gatewayStartCommand = options.startCommand;
    await claudeGatewayLauncher.configure(options);
  }

  static async shutdownGateway(): Promise<void> {
    await claudeGatewayLauncher.shutdown();
  }

  static getOwnedGatewayProcessGroupId(): number | undefined {
    return claudeGatewayLauncher.getOwnedProcessGroupId();
  }

  static relinquishOwnedGatewayProcessGroup(processGroupId: number): boolean {
    return claudeGatewayLauncher.relinquishOwnedProcessGroup(processGroupId);
  }

  static getGatewayUrl(): string | undefined {
    return ClaudeGatewayProvider.gatewayUrl;
  }

  private static rememberGatewayCatalog(
    configurationGeneration: number,
    baseUrl: string,
    launchMetadata: Map<string, GatewayModelLaunchMetadata>,
  ): boolean {
    if (
      configurationGeneration !== ClaudeGatewayProvider.configurationGeneration
    ) {
      return false;
    }
    ClaudeGatewayProvider.catalogSnapshot = {
      configurationGeneration,
      baseUrl,
      launchMetadata,
    };
    return true;
  }

  static forgetGatewayCatalog(): void {
    ClaudeGatewayProvider.configurationGeneration += 1;
    ClaudeGatewayProvider.catalogSnapshot = undefined;
  }

  static isConfigured(): boolean {
    return Boolean(ClaudeGatewayProvider.gatewayUrl);
  }

  override getModelCatalogCacheKey(): string {
    return `${ClaudeGatewayProvider.gatewayUrl ?? ""}\n${
      ClaudeGatewayProvider.gatewayStartCommand ?? ""
    }`;
  }

  override async isInstalled(): Promise<boolean> {
    return ClaudeGatewayProvider.isConfigured();
  }

  override async isAuthenticated(): Promise<boolean> {
    return ClaudeGatewayProvider.isConfigured();
  }

  override async getAuthStatus(): Promise<AuthStatus> {
    const configured = ClaudeGatewayProvider.isConfigured();
    return {
      installed: configured,
      authenticated: configured,
      enabled: configured,
    };
  }

  /**
   * The gateway catalog is authoritative: do not merge Claude's built-in
   * aliases or fall back to models that this gateway did not advertise.
   */
  override async getAvailableModels(): Promise<ModelInfo[]> {
    const gatewayUrl = ClaudeGatewayProvider.gatewayUrl;
    if (!gatewayUrl) return [];
    const gatewayStartCommand = ClaudeGatewayProvider.gatewayStartCommand;
    const configurationGeneration =
      ClaudeGatewayProvider.configurationGeneration;

    try {
      // Read the catalog from the address readiness was proven against, not
      // from a second resolution of the configured hostname: `localhost` can
      // front one gateway on 127.0.0.1 and another on ::1.
      const listeningUrl = await this.gatewayLauncher.ensureReady({
        url: gatewayUrl,
        startCommand: gatewayStartCommand,
      });
      if (
        configurationGeneration !==
        ClaudeGatewayProvider.configurationGeneration
      ) {
        return [];
      }
      const baseUrl = listeningUrl ?? gatewayUrl;
      const response = await fetch(`${baseUrl}/v1/models`, {
        headers: { Authorization: "Bearer dummy" },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return [];
      const catalog = parseClaudeGatewayCatalog(await response.json());
      if (
        !ClaudeGatewayProvider.rememberGatewayCatalog(
          configurationGeneration,
          baseUrl,
          catalog.launchMetadata,
        )
      ) {
        return [];
      }
      return catalog.models;
    } catch (error) {
      getLogger().debug(
        { error, gatewayUrl },
        "Failed to fetch Claude gateway models",
      );
      return [];
    }
  }

  protected override async normalizeSupportedModels(): Promise<ModelInfo[]> {
    return this.getAvailableModels();
  }

  private static launchContext(model?: string):
    | {
        baseUrl: string;
        metadata: GatewayModelLaunchMetadata | undefined;
      }
    | undefined {
    const gatewayUrl = ClaudeGatewayProvider.gatewayUrl;
    if (!gatewayUrl) return undefined;
    const snapshot = ClaudeGatewayProvider.catalogSnapshot;
    const currentSnapshot =
      snapshot?.configurationGeneration ===
      ClaudeGatewayProvider.configurationGeneration
        ? snapshot
        : undefined;
    return {
      baseUrl: currentSnapshot?.baseUrl ?? gatewayUrl,
      metadata: model ? currentSnapshot?.launchMetadata.get(model) : undefined,
    };
  }

  protected override getSettings(model?: string): Settings | undefined {
    const launch = ClaudeGatewayProvider.launchContext(model);
    if (!launch) return undefined;
    return {
      env: gatewayEnvironment(launch.baseUrl, model, launch.metadata),
    };
  }

  protected override getEnv(
    model?: string,
  ): Record<string, string | undefined> {
    const launch = ClaudeGatewayProvider.launchContext(model);
    return launch
      ? {
          ...super.getEnv(model),
          ...gatewayEnvironment(launch.baseUrl, model, launch.metadata),
        }
      : super.getEnv(model);
  }
}

export const claudeGatewayProvider = new ClaudeGatewayProvider();
