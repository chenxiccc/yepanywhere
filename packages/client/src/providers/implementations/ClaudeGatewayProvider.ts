import type {
  Provider,
  ProviderCapabilities,
  ProviderMetadata,
} from "../types";

export class ClaudeGatewayProvider implements Provider {
  readonly id = "claude-gateway";
  readonly displayName = "Claude Gateway";

  readonly capabilities: ProviderCapabilities = {
    supportsDag: true,
    supportsCloning: true,
    needsApproxMessageDedup: false,
    dedupQueueOperationEchoes: true,
  };

  readonly metadata: ProviderMetadata = {
    description:
      "Claude Code routed through an isolated Anthropic-compatible LLM gateway.",
    limitations: [
      "Only gateway-advertised models are available",
      "Model availability and behavior depend on the configured gateway",
      "Reasoning controls depend on the gateway",
    ],
    website: "https://code.claude.com/docs/en/llm-gateway-connect",
    cliName: "claude",
  };
}
