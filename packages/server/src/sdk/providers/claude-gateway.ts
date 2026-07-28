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

function gatewayEnvironment(
  baseUrl: string,
  model?: string,
): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: "dummy",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ...(model
      ? {
          ANTHROPIC_MODEL: model,
          ANTHROPIC_DEFAULT_OPUS_MODEL: model,
          ANTHROPIC_DEFAULT_SONNET_MODEL: model,
          ANTHROPIC_SMALL_FAST_MODEL: model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        }
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
  if (item.capabilities?.type && item.capabilities.type !== "chat") return false;
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

function modelContextWindow(item: GatewayModel): number | undefined {
  const value = item.capabilities?.limits?.max_context_window_tokens;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export function parseClaudeGatewayModels(value: unknown): ModelInfo[] {
  const data = (value as GatewayModelsResponse | null)?.data;
  if (!Array.isArray(data)) return [];

  const seen = new Set<string>();
  const models: ModelInfo[] = [];
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
    const contextWindow = modelContextWindow(item);
    models.push({
      id,
      name: displayName || id,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
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
  return models;
}

export class ClaudeGatewayProvider extends ClaudeProvider {
  override readonly name = "claude-gateway" as const;
  override readonly displayName = "Claude Gateway";
  override readonly supportsThinkingToggle = true;
  override readonly supportsNativePromptSuggestions = false;
  override readonly promptCacheKeepalive:
    | PromptCacheKeepaliveProviderInfo
    | undefined = undefined;

  private static gatewayUrl: string | undefined;
  private static gatewayStartCommand: string | undefined;

  constructor(
    private readonly gatewayLauncher: Pick<
      ClaudeGatewayLauncher,
      "ensureReady"
    > = claudeGatewayLauncher,
  ) {
    super();
  }

  static setGatewayUrl(url: string | undefined): void {
    ClaudeGatewayProvider.gatewayUrl = url;
  }

  static setGatewayStartCommand(command: string | undefined): void {
    ClaudeGatewayProvider.gatewayStartCommand = command;
  }

  static async configureGateway(options: {
    url?: string;
    startCommand?: string;
  }): Promise<void> {
    ClaudeGatewayProvider.gatewayUrl = options.url;
    ClaudeGatewayProvider.gatewayStartCommand = options.startCommand;
    await claudeGatewayLauncher.configure(options);
  }

  static async shutdownGateway(): Promise<void> {
    await claudeGatewayLauncher.shutdown();
  }

  static getGatewayUrl(): string | undefined {
    return ClaudeGatewayProvider.gatewayUrl;
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

    try {
      await this.gatewayLauncher.ensureReady({
        url: gatewayUrl,
        startCommand: ClaudeGatewayProvider.gatewayStartCommand,
      });
      const response = await fetch(`${gatewayUrl}/v1/models`, {
        headers: { Authorization: "Bearer dummy" },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return [];
      return parseClaudeGatewayModels(await response.json());
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

  protected override getSettings(model?: string): Settings | undefined {
    const gatewayUrl = ClaudeGatewayProvider.gatewayUrl;
    if (!gatewayUrl) return undefined;
    return { env: gatewayEnvironment(gatewayUrl, model) };
  }

  protected override getEnv(
    model?: string,
  ): Record<string, string | undefined> {
    const gatewayUrl = ClaudeGatewayProvider.gatewayUrl;
    return gatewayUrl
      ? { ...super.getEnv(model), ...gatewayEnvironment(gatewayUrl, model) }
      : super.getEnv(model);
  }
}

export const claudeGatewayProvider = new ClaudeGatewayProvider();
