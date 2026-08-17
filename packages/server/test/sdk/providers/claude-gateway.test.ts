import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeGatewayProvider,
  gatewayAutoCompactWindow,
  parseClaudeGatewayModels,
} from "../../../src/sdk/providers/claude-gateway.js";
import { ClaudeOllamaProvider } from "../../../src/sdk/providers/claude-ollama.js";
import {
  configureProviderRuntime,
  getAllProviders,
} from "../../../src/sdk/providers/index.js";

class ExposedClaudeGatewayProvider extends ClaudeGatewayProvider {
  getLaunchSettings(model?: string) {
    return this.getSettings(model);
  }

  getLaunchEnvironment(model?: string) {
    return this.getEnv(model);
  }

  getLaunchToolOptions(model?: string) {
    return this.getDisallowedToolOptions(model);
  }
}

describe("ClaudeGatewayProvider", () => {
  afterEach(() => {
    ClaudeGatewayProvider.setGatewayUrl(undefined);
    ClaudeGatewayProvider.setGatewayStartCommand(undefined);
    ClaudeGatewayProvider.setGatewayDisableAgent(true);
    ClaudeGatewayProvider.setGatewayDisablePlanMode(true);
    ClaudeGatewayProvider.forgetGatewayCatalog();
    ClaudeOllamaProvider.setOllamaUrl(undefined);
    configureProviderRuntime({ isClaudeOllamaVisible: () => false });
    vi.unstubAllGlobals();
  });

  it("uses the gateway catalog without built-in Claude additions", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "gpt-5.6-terra",
                display_name: "GPT-5.6 Terra",
                model_picker_enabled: true,
                supported_endpoints: ["/responses", "ws:/responses"],
                capabilities: {
                  type: "chat",
                  limits: { max_context_window_tokens: 400_000 },
                  supports: {
                    reasoning_effort: [
                      "none",
                      "low",
                      "medium",
                      "high",
                      "xhigh",
                      "max",
                    ],
                  },
                },
                policy: { state: "enabled" },
              },
              {
                id: "claude-sonnet-5",
                display_name: "Claude Sonnet 5",
                supported_endpoints: ["/v1/messages", "/chat/completions"],
              },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    ClaudeGatewayProvider.setGatewayUrl("http://localhost:4141");

    // Nothing answers the probe here, so the configured URL is used as-is.
    const provider = new ClaudeGatewayProvider({
      ensureReady: async () => null,
    });
    await expect(provider.getAvailableModels()).resolves.toEqual([
      {
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        contextWindow: 400_000,
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        supportedReasoningEfforts: [
          { reasoningEffort: "low" },
          { reasoningEffort: "medium" },
          { reasoningEffort: "high" },
          { reasoningEffort: "xhigh" },
          { reasoningEffort: "max" },
        ],
        supportsAdaptiveThinking: true,
      },
      {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        supportsEffort: false,
        supportsAdaptiveThinking: false,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4141/v1/models",
      expect.objectContaining({
        headers: { Authorization: "Bearer dummy" },
        signal: expect.any(Object),
      }),
    );
  });

  it("reads the catalog from the address readiness was proven against", async () => {
    // `localhost` can front one gateway on 127.0.0.1 and a stale one on ::1;
    // re-resolving the hostname for the fetch could reach the other server.
    const ensureReady = vi.fn(async () => "http://[::1]:4141");
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    ClaudeGatewayProvider.setGatewayUrl("http://localhost:4141");
    ClaudeGatewayProvider.setGatewayStartCommand("gateway start");

    const provider = new ExposedClaudeGatewayProvider({ ensureReady });
    await provider.getAvailableModels();

    expect(ensureReady).toHaveBeenCalledWith({
      url: "http://localhost:4141",
      startCommand: "gateway start",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://[::1]:4141/v1/models",
      expect.anything(),
    );
    expect(provider.getLaunchSettings("gateway-model")?.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://[::1]:4141",
    });
    expect(provider.getLaunchEnvironment("gateway-model")).toMatchObject({
      ANTHROPIC_BASE_URL: "http://[::1]:4141",
    });
  });

  it("rejects a catalog that finishes after its gateway configuration", async () => {
    let releaseCatalog!: (response: Response) => void;
    let markCatalogRequested!: () => void;
    const catalogRequested = new Promise<void>((resolve) => {
      markCatalogRequested = resolve;
    });
    const fetchMock = vi.fn(() => {
      markCatalogRequested();
      return new Promise<Response>((resolve) => {
        releaseCatalog = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    ClaudeGatewayProvider.setGatewayUrl("http://localhost:4141");
    const provider = new ExposedClaudeGatewayProvider({
      ensureReady: async () => "http://[::1]:4141",
    });

    const staleCatalog = provider.getAvailableModels();
    await catalogRequested;
    ClaudeGatewayProvider.setGatewayUrl("http://localhost:4242");
    releaseCatalog(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "stale-model",
              capabilities: {
                limits: { max_context_window_tokens: 400_000 },
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    await expect(staleCatalog).resolves.toEqual([]);
    expect(provider.getLaunchSettings("stale-model")?.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://localhost:4242",
    });
    expect(provider.getLaunchSettings("stale-model")?.env).not.toHaveProperty(
      "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
    );
  });

  it("publishes endpoint changes only with a successful catalog", async () => {
    const endpoints = [
      "http://[::1]:4141",
      "http://127.0.0.1:4141",
      "http://127.0.0.1:4141",
    ];
    const responses = [
      new Response(JSON.stringify({ data: [{ id: "gateway-model" }] }), {
        status: 200,
      }),
      new Response("unavailable", { status: 503 }),
      new Response(JSON.stringify({ data: [{ id: "gateway-model" }] }), {
        status: 200,
      }),
    ];
    const ensureReady = vi.fn(async () => endpoints.shift() ?? null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const response = responses.shift();
        if (!response) throw new Error("Unexpected catalog request");
        return response;
      }),
    );
    ClaudeGatewayProvider.setGatewayUrl("http://localhost:4141");
    const provider = new ExposedClaudeGatewayProvider({ ensureReady });

    await provider.getAvailableModels();
    expect(provider.getLaunchSettings("gateway-model")?.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://[::1]:4141",
    });

    await expect(provider.getAvailableModels()).resolves.toEqual([]);
    expect(provider.getLaunchSettings("gateway-model")?.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://[::1]:4141",
    });

    await provider.getAvailableModels();
    expect(provider.getLaunchSettings("gateway-model")?.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4141",
    });
  });

  it("propagates an explicit copilot-api catalog identity", async () => {
    const responses = [
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "X-Copilot-API": "1" },
      }),
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const response = responses.shift();
        if (!response) throw new Error("Unexpected catalog request");
        return response;
      }),
    );
    ClaudeGatewayProvider.setGatewayUrl("http://localhost:4141");
    const provider = new ExposedClaudeGatewayProvider({
      ensureReady: async () => null,
    });

    expect(provider.getLaunchSettings()?.env).not.toHaveProperty(
      "YEP_COPILOT_API",
    );
    await provider.getAvailableModels();
    expect(provider.getLaunchSettings()?.env).toMatchObject({
      YEP_COPILOT_API: "1",
    });
    expect(provider.getLaunchEnvironment()).toMatchObject({
      YEP_COPILOT_API: "1",
    });

    ClaudeGatewayProvider.setGatewayUrl("http://localhost:4242");
    expect(provider.getLaunchSettings()?.env).not.toHaveProperty(
      "YEP_COPILOT_API",
    );
    await provider.getAvailableModels();
    expect(provider.getLaunchSettings()?.env).not.toHaveProperty(
      "YEP_COPILOT_API",
    );
  });

  it("retains metadata-less rows but filters known unsupported rows", () => {
    expect(
      parseClaudeGatewayModels({
        data: [
          { id: "gpt-5.6-terra", name: "Terra" },
          { id: "gpt-5.6-terra", name: "Duplicate" },
          { id: "text-embedding-3-small", name: "Embedding" },
          { id: "trajectory-compaction", name: "Compaction" },
          { id: "  kimi-k2.7-code  " },
          {
            id: "audio-utility",
            model_picker_enabled: false,
            supported_endpoints: ["/chat/completions"],
          },
          {
            id: "disabled-chat",
            policy: { state: "disabled" },
            supported_endpoints: ["/chat/completions"],
          },
          {
            id: "unknown-endpoint",
            supported_endpoints: ["/embeddings"],
          },
          {
            id: "non-chat",
            capabilities: { type: "embeddings" },
          },
          { id: 7 },
        ],
      }),
    ).toEqual([
      {
        id: "gpt-5.6-terra",
        name: "Terra",
        supportsEffort: false,
        supportsAdaptiveThinking: false,
      },
      {
        id: "kimi-k2.7-code",
        name: "kimi-k2.7-code",
        supportsEffort: false,
        supportsAdaptiveThinking: false,
      },
    ]);
  });

  it("isolates gateway overrides in flag settings and the spawned child", () => {
    ClaudeGatewayProvider.setGatewayUrl("http://localhost:4141");
    const provider = new ExposedClaudeGatewayProvider();
    const expectedGatewayEnvironment = {
      YEP_CLAUDE_GATEWAY: "1",
      ANTHROPIC_BASE_URL: "http://localhost:4141",
      ANTHROPIC_AUTH_TOKEN: "dummy",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
      ANTHROPIC_MODEL: "kimi-k2.7-code",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-k2.7-code",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-k2.7-code",
      ANTHROPIC_SMALL_FAST_MODEL: "kimi-k2.7-code",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-k2.7-code",
    };

    expect(provider.getLaunchSettings("kimi-k2.7-code")).toEqual({
      env: expectedGatewayEnvironment,
      permissions: { deny: ["Agent"] },
    });
    expect(provider.getLaunchEnvironment("kimi-k2.7-code")).toMatchObject(
      expectedGatewayEnvironment,
    );
  });

  it("can leave the Agent tool available for Gateway launches", () => {
    ClaudeGatewayProvider.setGatewayUrl("http://localhost:4141");
    ClaudeGatewayProvider.setGatewayDisableAgent(false);
    const provider = new ExposedClaudeGatewayProvider();

    expect(provider.getLaunchSettings("kimi-k2.7-code")).not.toHaveProperty(
      "permissions",
    );
  });

  it("removes only plan-mode tools from Gateway model context", () => {
    const provider = new ExposedClaudeGatewayProvider();

    expect(provider.getLaunchToolOptions("gpt-5.6-sol")).toEqual({
      disallowedTools: ["EnterPlanMode", "ExitPlanMode"],
    });
    expect(provider.getLaunchToolOptions().disallowedTools).not.toContain(
      "TaskCreate",
    );
  });

  it("can leave plan mode available for Gateway launches", () => {
    ClaudeGatewayProvider.setGatewayDisablePlanMode(false);
    const provider = new ExposedClaudeGatewayProvider();

    expect(provider.getLaunchToolOptions("gpt-5.6-sol")).toEqual({});
  });

  it("keeps an explicit subagent spawn depth chosen by the operator", () => {
    const previous = process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;
    process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = "3";
    try {
      ClaudeGatewayProvider.setGatewayUrl("http://localhost:4141");
      const provider = new ExposedClaudeGatewayProvider();
      expect(provider.getLaunchSettings("kimi-k2.7-code")?.env).toMatchObject({
        CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "3",
      });
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;
      } else {
        process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = previous;
      }
    }
  });

  it("omits the subagent spawn depth when YA leaves it unspecified", () => {
    const previous = process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;
    delete process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;
    try {
      ClaudeGatewayProvider.setGatewayUrl("http://localhost:4141");
      const provider = new ExposedClaudeGatewayProvider();
      provider.setSubagentMaxDepthGetter(() => null);

      expect(
        provider.getLaunchSettings("kimi-k2.7-code")?.env,
      ).not.toHaveProperty("CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH");
      expect(
        provider.getLaunchEnvironment("kimi-k2.7-code"),
      ).not.toHaveProperty("CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH");
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;
      } else {
        process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = previous;
      }
    }
  });

  it("keeps Claude Code inside the catalog's total and prompt windows", async () => {
    // Claude Code resolves its model and automatic-compaction windows
    // independently; the catalog provides both parts of that launch contract.
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "gpt-5.6-sol",
                capabilities: {
                  type: "chat",
                  limits: {
                    max_context_window_tokens: 400_000,
                    max_prompt_tokens: 272_000,
                  },
                },
              },
              {
                id: "gpt-4",
                capabilities: {
                  type: "chat",
                  limits: {
                    max_context_window_tokens: 32_768,
                    max_prompt_tokens: 24_576,
                  },
                },
              },
              {
                id: "gpt-5.6-sol-long",
                capabilities: {
                  type: "chat",
                  limits: {
                    max_context_window_tokens: 1_050_000,
                    max_prompt_tokens: 922_000,
                  },
                },
              },
              {
                id: "prompt-over-total",
                capabilities: {
                  type: "chat",
                  limits: {
                    max_context_window_tokens: 400_000,
                    max_prompt_tokens: 500_000,
                  },
                },
              },
              { id: "windowless-model" },
              { id: "claude-opus-5" },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    ClaudeGatewayProvider.setGatewayUrl("http://localhost:4141");

    const provider = new ExposedClaudeGatewayProvider({
      ensureReady: async () => null,
    });

    // A launch before any catalog read keeps Claude Code's own default.
    expect(provider.getLaunchSettings("gpt-5.6-sol")?.env).not.toHaveProperty(
      "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
    );
    expect(provider.getLaunchSettings("gpt-5.6-sol")?.env).not.toHaveProperty(
      "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    );
    expect(provider.getLaunchSettings("gpt-5.6-sol")?.env).not.toHaveProperty(
      "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT",
    );

    await provider.getAvailableModels();

    const solEnvironment = {
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "400000",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "272000",
    };
    expect(provider.getLaunchSettings("gpt-5.6-sol")?.env).toMatchObject(
      solEnvironment,
    );
    expect(provider.getLaunchEnvironment("gpt-5.6-sol")).toMatchObject(
      solEnvironment,
    );
    expect(provider.getLaunchSettings("gpt-5.6-sol")?.env).not.toHaveProperty(
      "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT",
    );
    // Never round a compaction window above an advertised hard limit. The
    // effective model window still narrows through MAX_CONTEXT_TOKENS.
    expect(provider.getLaunchSettings("gpt-4")?.env).toMatchObject({
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "32768",
    });
    expect(provider.getLaunchSettings("gpt-4")?.env).not.toHaveProperty(
      "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    );
    expect(provider.getLaunchSettings("gpt-5.6-sol-long")?.env).toMatchObject({
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1050000",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "922000",
    });
    expect(provider.getLaunchSettings("prompt-over-total")?.env).toMatchObject({
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "400000",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "400000",
    });
    const windowlessEnvironment = {
      CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
    };
    expect(provider.getLaunchSettings("windowless-model")?.env).toMatchObject(
      windowlessEnvironment,
    );
    expect(provider.getLaunchEnvironment("windowless-model")).toMatchObject(
      windowlessEnvironment,
    );
    expect(provider.getLaunchSettings("claude-opus-5")?.env).toMatchObject(
      windowlessEnvironment,
    );
    expect(
      provider.getLaunchSettings("windowless-model")?.env,
    ).not.toHaveProperty("CLAUDE_CODE_MAX_CONTEXT_TOKENS");
    expect(
      provider.getLaunchSettings("windowless-model")?.env,
    ).not.toHaveProperty("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
    expect(provider.getLaunchSettings("absent-model")?.env).not.toHaveProperty(
      "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT",
    );
    expect(provider.getLaunchSettings()?.env).not.toHaveProperty(
      "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
    );
    expect(provider.getLaunchSettings()?.env).not.toHaveProperty(
      "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    );
    expect(provider.getLaunchSettings()?.env).not.toHaveProperty(
      "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT",
    );
  });

  it("atomically replaces catalog launch metadata after successful refreshes", async () => {
    const responses = [
      new Response(
        JSON.stringify({
          data: [
            {
              id: "changing-model",
              capabilities: {
                limits: {
                  max_context_window_tokens: 400_000,
                  max_prompt_tokens: 272_000,
                },
              },
            },
          ],
        }),
        { status: 200 },
      ),
      new Response(JSON.stringify({ data: [{ id: "changing-model" }] }), {
        status: 200,
      }),
      new Response("unavailable", { status: 503 }),
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    ];
    const fetchMock = vi.fn(async () => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected catalog request");
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    ClaudeGatewayProvider.setGatewayUrl("http://localhost:4141");
    const provider = new ExposedClaudeGatewayProvider({
      ensureReady: async () => null,
    });

    await provider.getAvailableModels();
    expect(provider.getLaunchSettings("changing-model")?.env).toMatchObject({
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "400000",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "272000",
    });

    await provider.getAvailableModels();
    expect(provider.getLaunchSettings("changing-model")?.env).toMatchObject({
      CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
    });
    expect(
      provider.getLaunchSettings("changing-model")?.env,
    ).not.toHaveProperty("CLAUDE_CODE_MAX_CONTEXT_TOKENS");

    await expect(provider.getAvailableModels()).resolves.toEqual([]);
    expect(provider.getLaunchSettings("changing-model")?.env).toMatchObject({
      CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
    });

    await provider.getAvailableModels();
    expect(
      provider.getLaunchSettings("changing-model")?.env,
    ).not.toHaveProperty(
      "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT",
    );
  });

  it("invalidates catalog launch metadata when gateway identity changes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: "gpt-5.6-sol",
                  capabilities: {
                    limits: { max_context_window_tokens: 400_000 },
                  },
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    ClaudeGatewayProvider.setGatewayUrl("http://localhost:4141");
    const provider = new ExposedClaudeGatewayProvider({
      ensureReady: async () => null,
    });

    await provider.getAvailableModels();
    expect(provider.getLaunchSettings("gpt-5.6-sol")?.env).toMatchObject({
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "400000",
    });

    ClaudeGatewayProvider.setGatewayStartCommand("start replacement gateway");
    expect(provider.getLaunchSettings("gpt-5.6-sol")?.env).not.toHaveProperty(
      "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
    );

    await provider.getAvailableModels();
    expect(provider.getLaunchSettings("gpt-5.6-sol")?.env).toMatchObject({
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "400000",
    });

    ClaudeGatewayProvider.setGatewayUrl("http://localhost:4242");
    expect(provider.getLaunchSettings("gpt-5.6-sol")?.env).not.toHaveProperty(
      "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
    );
  });

  it("only emits automatic-compaction windows Claude Code can express safely", () => {
    expect(gatewayAutoCompactWindow(2_000_000)).toBe(1_000_000);
    expect(gatewayAutoCompactWindow(400_000)).toBe(400_000);
    expect(gatewayAutoCompactWindow(100_000)).toBe(100_000);
    expect(gatewayAutoCompactWindow(99_999)).toBeUndefined();
    expect(gatewayAutoCompactWindow(32_768)).toBeUndefined();
    expect(gatewayAutoCompactWindow(undefined)).toBeUndefined();
    expect(gatewayAutoCompactWindow(0)).toBeUndefined();
    expect(gatewayAutoCompactWindow(Number.NaN)).toBeUndefined();
  });

  it("is hidden and has no fallback catalog until configured", async () => {
    const provider = new ClaudeGatewayProvider();

    await expect(provider.getAuthStatus()).resolves.toEqual({
      installed: false,
      authenticated: false,
      enabled: false,
    });
    await expect(provider.getAvailableModels()).resolves.toEqual([]);
  });

  it("hides unused gateway variants from provider menus", () => {
    configureProviderRuntime({ isClaudeOllamaVisible: () => false });

    expect(getAllProviders().map((provider) => provider.name)).not.toContain(
      "claude-gateway",
    );
    expect(getAllProviders().map((provider) => provider.name)).not.toContain(
      "claude-ollama",
    );
  });

  it("shows configured gateway variants without migrating legacy use", () => {
    ClaudeGatewayProvider.setGatewayUrl("http://localhost:4141");
    configureProviderRuntime({ isClaudeOllamaVisible: () => true });

    expect(getAllProviders().map((provider) => provider.name)).toContain(
      "claude-gateway",
    );
    expect(getAllProviders().map((provider) => provider.name)).toContain(
      "claude-ollama",
    );
  });
});
