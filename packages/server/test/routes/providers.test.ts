import type { ModelInfo, ProviderInfo } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import { createProvidersRoutes } from "../../src/routes/providers.js";
import type {
  AgentProvider,
  AuthStatus,
} from "../../src/sdk/providers/types.js";

function createProvider(overrides: Partial<AgentProvider> = {}): AgentProvider {
  return {
    name: "claude",
    displayName: "Claude",
    supportsPermissionMode: true,
    supportsThinkingToggle: true,
    supportsSlashCommands: false,
    supportsSteering: false,
    isInstalled: vi.fn(async () => true),
    isAuthenticated: vi.fn(async () => true),
    getAuthStatus: vi.fn(async () => ({
      installed: true,
      authenticated: true,
      enabled: true,
    })),
    getAvailableModels: vi.fn(async () => [{ id: "sonnet", name: "Sonnet" }]),
    startSession: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    ...overrides,
  } as AgentProvider;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("Providers Routes", () => {
  it("adds a coarse application hint only for the desktop runtime", async () => {
    const provider = createProvider({
      getAuthStatus: vi.fn(async () => ({
        installed: false,
        authenticated: false,
        enabled: false,
      })),
    });
    const routes = createProvidersRoutes({
      providers: [provider],
      desktopRuntime: true,
      applicationDetector: () => true,
    });

    const response = await routes.request("/");

    expect(await response.json()).toEqual({
      providers: [
        expect.objectContaining({
          name: "claude",
          installed: false,
          applicationDetected: true,
        }),
      ],
    });
  });

  it("caches provider scans for repeated list requests", async () => {
    const provider = createProvider();
    const routes = createProvidersRoutes({
      providers: [provider],
      cacheTtlMs: 60_000,
    });

    const first = await routes.request("/");
    const second = await routes.request("/");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(provider.getAuthStatus).toHaveBeenCalledTimes(1);
    expect(provider.getAvailableModels).toHaveBeenCalledTimes(1);
  });

  it("shares an in-flight scan between concurrent requests", async () => {
    const authStatus = deferred<AuthStatus>();
    const models = deferred<ModelInfo[]>();
    const provider = createProvider({
      getAuthStatus: vi.fn(() => authStatus.promise),
      getAvailableModels: vi.fn(() => models.promise),
    });
    const routes = createProvidersRoutes({
      providers: [provider],
      cacheTtlMs: 60_000,
    });

    const first = routes.request("/");
    const second = routes.request("/");
    await Promise.resolve();

    expect(provider.getAuthStatus).toHaveBeenCalledTimes(1);
    expect(provider.getAvailableModels).toHaveBeenCalledTimes(1);

    authStatus.resolve({
      installed: true,
      authenticated: true,
      enabled: true,
    });
    models.resolve([{ id: "sonnet", name: "Sonnet" }]);

    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
  });

  it("bypasses the cache when refresh is requested", async () => {
    const provider = createProvider({
      getAvailableModels: vi
        .fn()
        .mockResolvedValueOnce([{ id: "sonnet", name: "Sonnet" }])
        .mockResolvedValueOnce([{ id: "opus", name: "Opus" }]),
    });
    const routes = createProvidersRoutes({
      providers: [provider],
      cacheTtlMs: 60_000,
    });

    const cached = await routes.request("/");
    const refreshed = await routes.request("/?refresh=1");

    expect(cached.status).toBe(200);
    expect(refreshed.status).toBe(200);
    expect(provider.getAuthStatus).toHaveBeenCalledTimes(2);
    expect(provider.getAvailableModels).toHaveBeenCalledTimes(2);

    const json = (await refreshed.json()) as { providers: Array<unknown> };
    expect(json.providers).toEqual([
      expect.objectContaining({
        name: "claude",
        models: [{ id: "opus", name: "Opus" }],
      }),
    ]);
  });

  it("lets a forced refresh supersede older ordinary work", async () => {
    const ordinaryModels = deferred<ModelInfo[]>();
    const refreshedModels = deferred<ModelInfo[]>();
    const provider = createProvider({
      getAvailableModels: vi
        .fn()
        .mockImplementationOnce(() => ordinaryModels.promise)
        .mockImplementationOnce(() => refreshedModels.promise),
    });
    const routes = createProvidersRoutes({
      providers: [provider],
      cacheTtlMs: 60_000,
    });

    const ordinary = routes.request("/claude");
    await vi.waitFor(() =>
      expect(provider.getAvailableModels).toHaveBeenCalledTimes(1),
    );
    const forced = routes.request("/claude?refresh=1");
    await vi.waitFor(() =>
      expect(provider.getAvailableModels).toHaveBeenCalledTimes(2),
    );

    refreshedModels.resolve([{ id: "opus", name: "Opus" }]);
    const forcedJson = (await (await forced).json()) as {
      provider: ProviderInfo;
    };
    ordinaryModels.resolve([{ id: "sonnet", name: "Sonnet" }]);
    const ordinaryJson = (await (await ordinary).json()) as {
      provider: ProviderInfo;
    };

    expect(forcedJson.provider.models).toEqual([{ id: "opus", name: "Opus" }]);
    expect(ordinaryJson.provider.models).toEqual([
      { id: "opus", name: "Opus" },
    ]);
    const cachedJson = (await (await routes.request("/claude")).json()) as {
      provider: ProviderInfo;
    };
    expect(cachedJson.provider.models).toEqual([{ id: "opus", name: "Opus" }]);
  });

  it("keeps newer provider state when superseded work fails late", async () => {
    const ordinaryModels = deferred<ModelInfo[]>();
    const refreshedModels = deferred<ModelInfo[]>();
    const provider = createProvider({
      getAvailableModels: vi
        .fn()
        .mockImplementationOnce(() => ordinaryModels.promise)
        .mockImplementationOnce(() => refreshedModels.promise),
    });
    const routes = createProvidersRoutes({
      providers: [provider],
      cacheTtlMs: 60_000,
    });

    const ordinary = routes.request("/claude");
    await vi.waitFor(() =>
      expect(provider.getAvailableModels).toHaveBeenCalledTimes(1),
    );
    const forced = routes.request("/claude?refresh=1");
    await vi.waitFor(() =>
      expect(provider.getAvailableModels).toHaveBeenCalledTimes(2),
    );

    refreshedModels.resolve([{ id: "opus", name: "Opus" }]);
    expect((await forced).status).toBe(200);
    ordinaryModels.reject(new Error("old probe failed"));
    const ordinaryJson = (await (await ordinary).json()) as {
      provider: ProviderInfo;
    };

    expect(ordinaryJson.provider.models).toEqual([
      { id: "opus", name: "Opus" },
    ]);
    expect((await routes.request("/claude")).status).toBe(200);
    expect(provider.getAvailableModels).toHaveBeenCalledTimes(2);
  });

  it("coalesces forced refreshes and lets ordinary callers join them", async () => {
    const refreshedModels = deferred<ModelInfo[]>();
    const provider = createProvider({
      getAvailableModels: vi
        .fn()
        .mockResolvedValueOnce([{ id: "sonnet", name: "Sonnet" }])
        .mockImplementationOnce(() => refreshedModels.promise),
    });
    const routes = createProvidersRoutes({
      providers: [provider],
      cacheTtlMs: 60_000,
    });
    await routes.request("/claude");

    const firstForced = routes.request("/claude?refresh=1");
    await vi.waitFor(() =>
      expect(provider.getAvailableModels).toHaveBeenCalledTimes(2),
    );
    const secondForced = routes.request("/claude?refresh=1");
    const ordinary = routes.request("/claude");
    await Promise.resolve();

    expect(provider.getAvailableModels).toHaveBeenCalledTimes(2);
    refreshedModels.resolve([{ id: "opus", name: "Opus" }]);
    const responses = await Promise.all([firstForced, secondForced, ordinary]);
    const rows = await Promise.all(
      responses.map(async (response) => {
        const body = (await response.json()) as { provider: ProviderInfo };
        return body.provider.models;
      }),
    );
    expect(rows).toEqual([
      [{ id: "opus", name: "Opus" }],
      [{ id: "opus", name: "Opus" }],
      [{ id: "opus", name: "Opus" }],
    ]);
  });

  it("reuses list-request cache for a provider detail request", async () => {
    const provider = createProvider();
    const routes = createProvidersRoutes({
      providers: [provider],
      cacheTtlMs: 60_000,
    });

    const list = await routes.request("/");
    const detail = await routes.request("/claude");

    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(provider.getAuthStatus).toHaveBeenCalledTimes(1);
    expect(provider.getAvailableModels).toHaveBeenCalledTimes(1);
  });

  it("keeps disabled providers out of collection and named routes", async () => {
    const claude = createProvider();
    const codexUsage = vi.fn(async () => null);
    const codex = createProvider({
      name: "codex",
      displayName: "Codex",
      getSubscriptionUsage: codexUsage,
    });
    const routes = createProvidersRoutes({
      providers: [claude, codex],
      enabledProviders: ["claude"],
    });

    const list = await routes.request("/");
    const detail = await routes.request("/codex");
    const usage = await routes.request("/codex/subscription-usage");

    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      providers: [expect.objectContaining({ name: "claude" })],
    });
    expect(detail.status).toBe(404);
    expect(usage.status).toBe(404);
    expect(codex.getAuthStatus).not.toHaveBeenCalled();
    expect(codex.getAvailableModels).not.toHaveBeenCalled();
    expect(codexUsage).not.toHaveBeenCalled();
  });

  it("invalidates cached model projection when its settings key changes", async () => {
    let selected = false;
    const provider = createProvider({
      getModelCatalogCacheKey: () => String(selected),
      getAvailableModels: vi.fn(async () => [
        { id: "opus", name: "Opus" },
        ...(selected
          ? [
              {
                id: "claude-opus-4-8",
                name: "Opus 4.8",
                catalogGroup: "additional" as const,
              },
            ]
          : []),
      ]),
    });
    const routes = createProvidersRoutes({
      providers: [provider],
      cacheTtlMs: 60_000,
    });

    await routes.request("/");
    selected = true;
    const response = await routes.request("/");
    const json = (await response.json()) as {
      providers: Array<{ models: ModelInfo[] }>;
    };

    expect(provider.getAvailableModels).toHaveBeenCalledTimes(2);
    expect(json.providers[0]?.models).toContainEqual(
      expect.objectContaining({
        id: "claude-opus-4-8",
        catalogGroup: "additional",
      }),
    );
  });

  it("serializes provider-maintained opt-in model choices", async () => {
    const provider = createProvider({
      getAdditionalModelOptions: () => [
        {
          id: "claude-opus-4-8",
          name: "Opus 4.8",
          catalogGroup: "additional",
        },
      ],
    });
    const routes = createProvidersRoutes({
      providers: [provider],
      cacheTtlMs: 60_000,
    });

    const response = await routes.request("/");
    const json = (await response.json()) as { providers: Array<unknown> };

    expect(json.providers).toEqual([
      expect.objectContaining({
        additionalModelOptions: [
          {
            id: "claude-opus-4-8",
            name: "Opus 4.8",
            catalogGroup: "additional",
          },
        ],
      }),
    ]);
  });

  it("serializes active-turn steering capability flags", async () => {
    const provider = createProvider({
      supportsSteering: true,
      supportsSteerNow: true,
    });
    const routes = createProvidersRoutes({
      providers: [provider],
      cacheTtlMs: 60_000,
    });

    const response = await routes.request("/");
    const json = (await response.json()) as { providers: Array<unknown> };

    expect(json.providers).toEqual([
      expect.objectContaining({
        supportsSteering: true,
        supportsSteerNow: true,
      }),
    ]);
  });

  it("serializes prompt-cache keepalive capability", async () => {
    const provider = createProvider({
      promptCacheKeepalive: {
        supportsNoContextPollutionNudge: true,
        defaultMode: "auto",
        defaultInactivityMinutes: 40,
      },
    });
    const routes = createProvidersRoutes({
      providers: [provider],
      cacheTtlMs: 60_000,
    });

    const response = await routes.request("/");
    const json = (await response.json()) as { providers: Array<unknown> };

    expect(json.providers).toEqual([
      expect.objectContaining({
        name: "claude",
        promptCacheKeepalive: {
          supportsNoContextPollutionNudge: true,
          defaultMode: "auto",
          defaultInactivityMinutes: 40,
        },
      }),
    ]);
  });

  it("serializes launch-time compact percentage capability", async () => {
    const provider = createProvider({
      supportsLaunchCompactPercentOverride: true,
    });
    const routes = createProvidersRoutes({
      providers: [provider],
      cacheTtlMs: 60_000,
    });

    const response = await routes.request("/");
    const json = (await response.json()) as { providers: Array<unknown> };

    expect(json.providers).toEqual([
      expect.objectContaining({
        name: "claude",
        supportsLaunchCompactPercentOverride: true,
      }),
    ]);
  });

  it("includes provider login command hints", async () => {
    const provider = createProvider({
      getAuthStatus: vi.fn(async () => ({
        installed: true,
        authenticated: false,
        enabled: false,
        loginCommand:
          '& "C:\\Users\\me\\AppData\\Local\\Claude\\claude.exe" auth login --claudeai',
      })),
    });
    const routes = createProvidersRoutes({
      providers: [provider],
      cacheTtlMs: 60_000,
    });

    const response = await routes.request("/");

    expect(response.status).toBe(200);
    const json = (await response.json()) as { providers: Array<unknown> };
    expect(json.providers).toEqual([
      expect.objectContaining({
        name: "claude",
        loginCommand:
          '& "C:\\Users\\me\\AppData\\Local\\Claude\\claude.exe" auth login --claudeai',
      }),
    ]);
  });

  it("caches normalized subscription usage and refreshes on demand", async () => {
    const getSubscriptionUsage = vi.fn(async () => ({
      provider: "claude" as const,
      fetchedAt: "2026-07-29T00:00:00.000Z",
      windows: [
        {
          id: "weekly",
          usedPercent: 72,
          windowDurationMinutes: 10_080,
          scope: { type: "provider" as const },
        },
      ],
    }));
    const provider = createProvider({ getSubscriptionUsage });
    const routes = createProvidersRoutes({
      providers: [provider],
      usageCacheTtlMs: 60_000,
    });

    const first = await routes.request("/claude/subscription-usage");
    const cached = await routes.request("/claude/subscription-usage");
    const refreshed = await routes.request(
      "/claude/subscription-usage?refresh=1",
    );

    expect(first.status).toBe(200);
    expect(cached.status).toBe(200);
    expect(refreshed.status).toBe(200);
    expect(getSubscriptionUsage).toHaveBeenCalledTimes(2);
    expect(await refreshed.json()).toEqual({
      usage: expect.objectContaining({
        provider: "claude",
        windows: [expect.objectContaining({ usedPercent: 72 })],
      }),
    });
  });

  it("returns null usage when a provider has no supported read path", async () => {
    const routes = createProvidersRoutes({
      providers: [createProvider()],
    });

    const response = await routes.request("/claude/subscription-usage");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ usage: null });
  });
});
