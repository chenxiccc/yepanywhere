/**
 * Provider exports.
 *
 * Re-exports all provider implementations and types.
 */

import type { ClaudeAdditionalModelSelection } from "@yep-anywhere/shared";
import {
  hasHostedProviderRuntime,
  isProviderRuntimeHostAvailable,
  retainProviderRuntimeProcessGroup,
  startHostedProviderSession,
} from "./provider-runtime-host.js";
import { hasReloadSafeCodexRuntime } from "./codex-runtime-host.js";
// Types
import type { AgentProvider, ProviderName } from "./types.js";
export type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  ProviderName,
  StartSessionOptions,
} from "./types.js";

// Claude provider (uses @anthropic-ai/claude-agent-sdk)
import { claudeProvider } from "./claude.js";
export { ClaudeProvider, claudeProvider } from "./claude.js";

// Claude Gateway provider (Claude SDK with a per-launch gateway overlay)
import {
  ClaudeGatewayProvider,
  claudeGatewayProvider,
} from "./claude-gateway.js";
export {
  ClaudeGatewayProvider,
  claudeGatewayProvider,
} from "./claude-gateway.js";

// Codex provider (uses codex CLI)
import { codexProvider } from "./codex.js";
export {
  CodexProvider,
  codexProvider,
  type CodexProviderConfig,
} from "./codex.js";

// Gemini provider (uses gemini CLI)
import { geminiProvider } from "./gemini.js";
export {
  GeminiProvider,
  geminiProvider,
  type GeminiProviderConfig,
} from "./gemini.js";

// Gemini ACP provider (uses gemini CLI with --experimental-acp)
import { geminiACPProvider } from "./gemini-acp.js";
export {
  GeminiACPProvider,
  geminiACPProvider,
  type GeminiACPProviderConfig,
} from "./gemini-acp.js";

// Grok Build ACP provider (uses `grok agent stdio`)
// Phase 1 isolated addition per topics/grok.md. Gated by ENABLED_PROVIDERS=grok.
import { grokACPProvider } from "./grok-acp.js";
export {
  GrokACPProvider,
  grokACPProvider,
  type GrokACPProviderConfig,
} from "./grok-acp.js";

// CodexOSS provider (uses codex CLI with --oss for local models)
import { codexOSSProvider } from "./codex-oss.js";
export {
  CodexOSSProvider,
  codexOSSProvider,
  type CodexOSSProviderConfig,
} from "./codex-oss.js";

// Claude + Ollama provider (uses Claude SDK with Ollama backend)
import { claudeOllamaProvider } from "./claude-ollama.js";
export {
  ClaudeOllamaProvider,
  claudeOllamaProvider,
} from "./claude-ollama.js";

// OpenCode provider (uses opencode serve for multi-provider agent)
import { opencodeProvider } from "./opencode.js";
export {
  OpenCodeProvider,
  opencodeProvider,
  type OpenCodeProviderConfig,
} from "./opencode.js";

// pi provider (uses `pi --mode rpc`; see topics/pi-provider.md, Plan A)
import { piProvider } from "./pi.js";
export { PiProvider, piProvider, type PiProviderConfig } from "./pi.js";

export interface ProviderRuntimeConfig {
  /** Explicit Codex CLI path supplied by an embedding runtime such as desktop. */
  codexCliPath?: string;
  /** Current server-persisted opt-ins for the Claude model catalog. */
  getClaudeAdditionalModels?: () =>
    | readonly ClaudeAdditionalModelSelection[]
    | undefined;
  /** Whether eligible new and resumed Codex processes use the lifecycle host. */
  getCodexReloadSafeSessions?: () => boolean;
  /** Whether legacy ClaudeOllama has configured or persisted usage. */
  isClaudeOllamaVisible?: () => boolean;
  /** Cloneable process-scoped settings supplied to a provider worker. */
  getProviderRuntimeSnapshot?: () => ProviderRuntimeSnapshot;
}

export interface ProviderRuntimeSnapshot {
  codexCliPath?: string;
  claudeAdditionalModels?: readonly ClaudeAdditionalModelSelection[];
  claudeGatewayUrl?: string;
  claudeGatewayStartCommand?: string;
  ollamaUrl?: string;
  ollamaSystemPrompt?: string;
  ollamaUseFullSystemPrompt?: boolean;
  ambientXaiApiKey?: string;
  grokBuildUseXaiApiKey?: boolean;
}

let isClaudeOllamaVisible = () => false;
let getCodexReloadSafeSessions = () => false;
let getProviderRuntimeSnapshot = (): ProviderRuntimeSnapshot => ({});
const hostedProviderProxies = new Map<ProviderName, AgentProvider>();

export type CodexRuntimeBackend =
  | "codex-native-host"
  | "shared-provider-host";

/**
 * Keep an existing Codex session on its launch backend. For an unowned new or
 * resumed session, the provider setting selects the specialized Codex host.
 */
export function selectCodexRuntimeBackend(options: {
  resumeSessionId?: string;
  hasCodexNativeRuntime: boolean;
  hasSharedProviderRuntime: boolean;
  codexNativeHostEnabled: boolean;
}): CodexRuntimeBackend {
  if (options.resumeSessionId) {
    if (options.hasCodexNativeRuntime) return "codex-native-host";
    if (options.hasSharedProviderRuntime) return "shared-provider-host";
  }
  return options.codexNativeHostEnabled
    ? "codex-native-host"
    : "shared-provider-host";
}

export function configureProviderRuntime(config: ProviderRuntimeConfig): void {
  claudeProvider.setAdditionalModelsGetter(
    config.getClaudeAdditionalModels ?? (() => []),
  );
  codexProvider.setCodexPath(config.codexCliPath);
  codexProvider.setReloadSafeSessionsGetter(
    config.getCodexReloadSafeSessions ?? (() => false),
  );
  getCodexReloadSafeSessions =
    config.getCodexReloadSafeSessions ?? (() => false);
  codexOSSProvider.setCodexPath(config.codexCliPath);
  isClaudeOllamaVisible = config.isClaudeOllamaVisible ?? (() => false);
  getProviderRuntimeSnapshot =
    config.getProviderRuntimeSnapshot ?? (() => ({}));
}

function hostedProvider(rawProvider: AgentProvider): AgentProvider {
  const existing = hostedProviderProxies.get(rawProvider.name);
  if (existing) return existing;
  const proxy = new Proxy(rawProvider, {
    get(target, property) {
      if (
        property === "getAvailableModels" &&
        target.name === "claude-gateway"
      ) {
        return async () => {
          const models = await target.getAvailableModels();
          const processGroupId =
            ClaudeGatewayProvider.getOwnedGatewayProcessGroupId();
          if (processGroupId) {
            await retainProviderRuntimeProcessGroup(processGroupId);
            if (
              !ClaudeGatewayProvider.relinquishOwnedGatewayProcessGroup(
                processGroupId,
              )
            ) {
              throw new Error(
                "Claude Gateway ownership changed during host transfer",
              );
            }
          }
          return models;
        };
      }
      if (property === "startSession") {
        return (options: Parameters<AgentProvider["startSession"]>[0]) => {
          if (target.name === "codex") {
            const resumeSessionId = options.resumeSessionId;
            const backend = selectCodexRuntimeBackend({
              resumeSessionId,
              hasCodexNativeRuntime: Boolean(
                resumeSessionId &&
                  hasReloadSafeCodexRuntime(resumeSessionId),
              ),
              hasSharedProviderRuntime: Boolean(
                resumeSessionId &&
                  hasHostedProviderRuntime(resumeSessionId),
              ),
              codexNativeHostEnabled: getCodexReloadSafeSessions(),
            });
            if (backend === "codex-native-host") {
              return target.startSession(options);
            }
          }
          return startHostedProviderSession(
            target.name,
            options,
            getProviderRuntimeSnapshot(),
          );
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  hostedProviderProxies.set(rawProvider.name, proxy);
  return proxy;
}

export { isProviderRuntimeHostAvailable };

function runtimeProvider(rawProvider: AgentProvider): AgentProvider {
  if (!isProviderRuntimeHostAvailable()) return rawProvider;
  return hostedProvider(rawProvider);
}

/**
 * Get all available provider instances.
 * Useful for provider detection UI.
 */
export function getAllProviders(): AgentProvider[] {
  return [
    claudeProvider,
    ...(ClaudeGatewayProvider.isConfigured() ? [claudeGatewayProvider] : []),
    ...(isClaudeOllamaVisible() ? [claudeOllamaProvider] : []),
    codexProvider,
    codexOSSProvider,
    geminiProvider,
    geminiACPProvider,
    grokACPProvider, // Phase 1: additive only (see grok-acp.ts header + topics/grok.md)
    opencodeProvider,
    piProvider,
  ].map(runtimeProvider);
}

/**
 * Get a provider by name.
 *
 * Note: "gemini" maps to geminiACPProvider (ACP mode) since it's the better
 * implementation with proper permission handling. The non-ACP stream-json
 * provider is deprecated and will be removed.
 *
 * "grok" added (additive, isolated). When ENABLED_PROVIDERS does not include "grok",
 * getProvider("grok") is never reached from normal flows.
 */
export function getRawProvider(name: ProviderName): AgentProvider | null {
  switch (name) {
    case "claude":
      return claudeProvider;
    case "claude-gateway":
      return claudeGatewayProvider;
    case "claude-ollama":
      return claudeOllamaProvider;
    case "codex":
      return codexProvider;
    case "codex-oss":
      return codexOSSProvider;
    case "gemini":
    case "gemini-acp":
      // Both map to ACP provider - "gemini" is legacy name for backward compatibility
      return geminiACPProvider;
    case "grok":
      return grokACPProvider; // Phase 1 Grok Build (ACP)
    case "opencode":
      return opencodeProvider;
    case "pi":
      return piProvider;
    default:
      return null;
  }
}

export function getProvider(name: ProviderName): AgentProvider | null {
  const provider = getRawProvider(name);
  return provider ? runtimeProvider(provider) : null;
}
