// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetProviders, mockGetProvider } = vi.hoisted(() => ({
  mockGetProviders: vi.fn(),
  mockGetProvider: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    getProviders: mockGetProviders,
    getProvider: mockGetProvider,
  },
}));

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

describe("useProviders", () => {
  let providersModule: typeof import("../useProviders");

  beforeEach(async () => {
    mockGetProviders.mockReset();
    mockGetProvider.mockReset();
    localStorage.clear();
    vi.resetModules();
    providersModule = await import("../useProviders");
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("primes the provider catalog before a new-session consumer mounts", async () => {
    let resolveProviders:
      | ((value: {
          providers: Array<{
            name: "claude";
            displayName: string;
            installed: boolean;
            authenticated: boolean;
            enabled: boolean;
            models: Array<{ id: string; name: string }>;
          }>;
        }) => void)
      | undefined;
    mockGetProviders.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProviders = resolve;
      }),
    );

    const priming = providersModule.primeProviderCache();
    const { result } = renderHook(() => providersModule.useProviders());

    expect(mockGetProviders).toHaveBeenCalledTimes(1);
    expect(mockGetProviders).toHaveBeenCalledWith({ refresh: false });

    resolveProviders?.({
      providers: [
        {
          name: "claude",
          displayName: "Claude",
          installed: true,
          authenticated: true,
          enabled: true,
          models: [{ id: "latest", name: "Latest" }],
        },
      ],
    });
    await act(async () => {
      await priming;
    });
    await waitFor(() => {
      expect(result.current.providers[0]?.models).toHaveLength(1);
    });
  });

  it("keeps an explicit refresh newer than a slower primer", async () => {
    type ProvidersResponse = {
      providers: Array<{
        name: "claude";
        displayName: string;
        installed: boolean;
        authenticated: boolean;
        enabled: boolean;
        models: Array<{ id: string; name: string }>;
      }>;
    };
    let resolvePrimer: ((value: ProvidersResponse) => void) | undefined;
    let resolveRefresh: ((value: ProvidersResponse) => void) | undefined;
    mockGetProviders
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolvePrimer = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
      );

    const priming = providersModule.primeProviderCache();
    const { result } = renderHook(() => providersModule.useProviders());
    expect(mockGetProviders).toHaveBeenCalledTimes(1);

    let refreshing: Promise<void> | undefined;
    act(() => {
      refreshing = result.current.refetch();
    });
    expect(mockGetProviders).toHaveBeenCalledTimes(2);

    resolveRefresh?.({
      providers: [
        {
          name: "claude",
          displayName: "Claude",
          installed: true,
          authenticated: true,
          enabled: true,
          models: [{ id: "fresh", name: "Fresh" }],
        },
      ],
    });
    await act(async () => {
      await refreshing;
    });
    expect(result.current.providers[0]?.models?.[0]?.id).toBe("fresh");

    resolvePrimer?.({
      providers: [
        {
          name: "claude",
          displayName: "Claude",
          installed: true,
          authenticated: true,
          enabled: true,
          models: [{ id: "stale", name: "Stale" }],
        },
      ],
    });
    await act(async () => {
      await priming;
    });

    expect(result.current.providers[0]?.models?.[0]?.id).toBe("fresh");
  });

  it("keeps cached provider catalogs isolated by source", async () => {
    mockGetProviders
      .mockResolvedValueOnce({ providers: [] })
      .mockResolvedValueOnce({ providers: [] });
    const sourceA = "remote:host-a" as Parameters<
      typeof providersModule.primeProviderCache
    >[0];
    const sourceB = "remote:host-b" as Parameters<
      typeof providersModule.primeProviderCache
    >[0];

    await providersModule.primeProviderCache(sourceA);
    await providersModule.primeProviderCache(sourceA);
    await providersModule.primeProviderCache(sourceB);

    expect(mockGetProviders).toHaveBeenCalledTimes(2);
  });

  it("reloads the client catalog without forcing a server-wide provider probe", async () => {
    mockGetProviders
      .mockResolvedValueOnce({
        providers: [
          {
            name: "claude",
            displayName: "Claude",
            installed: true,
            authenticated: true,
            enabled: true,
            models: [{ id: "latest", name: "Latest" }],
          },
        ],
      })
      .mockResolvedValueOnce({
        providers: [
          {
            name: "claude",
            displayName: "Claude",
            installed: true,
            authenticated: true,
            enabled: true,
            models: [
              { id: "latest", name: "Latest" },
              {
                id: "previous",
                name: "Previous",
                catalogGroup: "additional",
              },
            ],
          },
        ],
      });
    const { result } = renderHook(() => providersModule.useProviders());

    await waitFor(() => {
      expect(result.current.providers[0]?.models).toHaveLength(1);
    });
    await act(async () => {
      await result.current.reload();
    });

    expect(result.current.providers[0]?.models).toHaveLength(2);
    expect(mockGetProviders).toHaveBeenNthCalledWith(1, { refresh: false });
    expect(mockGetProviders).toHaveBeenNthCalledWith(2, { refresh: false });
  });

  it("offers the last visit's providers while this visit's probe runs", async () => {
    const probed = {
      providers: [
        {
          name: "claude" as const,
          displayName: "Claude",
          installed: true,
          authenticated: true,
          enabled: true,
          models: [{ id: "latest", name: "Latest" }],
        },
      ],
    };
    mockGetProviders.mockResolvedValueOnce(probed);
    const { result, unmount } = renderHook(() =>
      providersModule.useProviders(),
    );
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    unmount();

    // A later visit: the module cache is gone, the browser snapshot is not.
    vi.resetModules();
    const reloadedModule = await import("../useProviders");
    let resolveProbe: ((value: typeof probed) => void) | undefined;
    mockGetProviders.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProbe = resolve;
      }),
    );
    const revisit = renderHook(() => reloadedModule.useProviders());

    expect(revisit.result.current.providers[0]?.name).toBe("claude");
    expect(revisit.result.current.stale).toBe(true);
    expect(revisit.result.current.loading).toBe(true);

    await act(async () => {
      resolveProbe?.(probed);
    });
    await waitFor(() => {
      expect(revisit.result.current.stale).toBe(false);
    });
  });

  it("resolves the selected provider without waiting for the aggregate", async () => {
    mockGetProviders.mockReturnValueOnce(new Promise(() => {}));
    mockGetProvider.mockResolvedValueOnce({
      provider: {
        name: "codex",
        displayName: "Codex",
        installed: true,
        authenticated: true,
        enabled: true,
        models: [{ id: "gpt-5", name: "GPT-5" }],
      },
    });

    renderHook(() => providersModule.useProviders());
    const { result } = renderHook(() =>
      providersModule.useProviderRow("codex"),
    );

    await waitFor(() => {
      expect(result.current.row?.models?.[0]?.id).toBe("gpt-5");
    });
    expect(result.current.fresh).toBe(true);
    expect(mockGetProvider).toHaveBeenCalledWith("codex", { refresh: false });
  });

  it("keeps a Gateway display row non-authoritative until its forced named probe succeeds", async () => {
    const aggregateRow = {
      name: "claude-gateway" as const,
      displayName: "Claude Gateway",
      installed: true,
      authenticated: true,
      enabled: true,
      models: [{ id: "stale", name: "Stale" }],
    };
    mockGetProviders.mockResolvedValueOnce({ providers: [aggregateRow] });
    const aggregate = renderHook(() => providersModule.useProviders());
    await waitFor(() => expect(aggregate.result.current.loading).toBe(false));

    const named = deferred<{
      provider: typeof aggregateRow;
    }>();
    mockGetProvider.mockReturnValueOnce(named.promise);
    const { result } = renderHook(() =>
      providersModule.useProviderRow("claude-gateway", {
        forceRefreshOnMount: true,
      }),
    );

    expect(result.current.row?.models?.[0]?.id).toBe("stale");
    expect(result.current.fresh).toBe(false);
    expect(result.current.refreshing).toBe(true);
    await waitFor(() =>
      expect(mockGetProvider).toHaveBeenCalledWith("claude-gateway", {
        refresh: true,
      }),
    );

    await act(async () => {
      named.resolve({
        provider: {
          ...aggregateRow,
          models: [{ id: "current", name: "Current" }],
        },
      });
      await named.promise;
    });
    await waitFor(() => expect(result.current.fresh).toBe(true));
    expect(result.current.row?.models?.[0]?.id).toBe("current");
  });

  it("retains a Gateway display row across a failed probe and retries by name", async () => {
    const aggregateRow = {
      name: "claude-gateway" as const,
      displayName: "Claude Gateway",
      installed: true,
      authenticated: true,
      enabled: true,
      models: [{ id: "stale", name: "Stale" }],
    };
    mockGetProviders.mockResolvedValueOnce({ providers: [aggregateRow] });
    const aggregate = renderHook(() => providersModule.useProviders());
    await waitFor(() => expect(aggregate.result.current.loading).toBe(false));

    mockGetProvider
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockResolvedValueOnce({
        provider: {
          ...aggregateRow,
          models: [{ id: "current", name: "Current" }],
        },
      });
    const { result } = renderHook(() =>
      providersModule.useProviderRow("claude-gateway", {
        forceRefreshOnMount: true,
      }),
    );

    await waitFor(() =>
      expect(result.current.error?.message).toBe("gateway unavailable"),
    );
    expect(result.current.row?.models?.[0]?.id).toBe("stale");
    expect(result.current.fresh).toBe(false);

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.row?.models?.[0]?.id).toBe("current");
    expect(result.current.fresh).toBe(true);
    expect(mockGetProvider).toHaveBeenNthCalledWith(2, "claude-gateway", {
      refresh: true,
    });
  });

  it("keeps a forced named response newer than an older ordinary response", async () => {
    mockGetProviders.mockReturnValueOnce(new Promise(() => {}));
    const ordinary = deferred<{
      provider: {
        name: "codex";
        displayName: string;
        installed: boolean;
        authenticated: boolean;
        enabled: boolean;
        models: Array<{ id: string; name: string }>;
      };
    }>();
    const forced = deferred<{
      provider: {
        name: "codex";
        displayName: string;
        installed: boolean;
        authenticated: boolean;
        enabled: boolean;
        models: Array<{ id: string; name: string }>;
      };
    }>();
    mockGetProvider
      .mockReturnValueOnce(ordinary.promise)
      .mockReturnValueOnce(forced.promise);
    renderHook(() => providersModule.useProviders());
    const selected = renderHook(() =>
      providersModule.useProviderRow("codex"),
    );
    await waitFor(() => expect(mockGetProvider).toHaveBeenCalledTimes(1));

    let refreshing: Promise<void> | undefined;
    act(() => {
      refreshing = selected.result.current.refresh();
    });
    await waitFor(() => expect(mockGetProvider).toHaveBeenCalledTimes(2));
    forced.resolve({
      provider: {
        name: "codex",
        displayName: "Codex",
        installed: true,
        authenticated: true,
        enabled: true,
        models: [{ id: "fresh", name: "Fresh" }],
      },
    });
    await act(async () => {
      await refreshing;
    });
    ordinary.resolve({
      provider: {
        name: "codex",
        displayName: "Codex",
        installed: true,
        authenticated: true,
        enabled: true,
        models: [{ id: "old", name: "Old" }],
      },
    });
    await act(async () => {
      await ordinary.promise;
    });

    expect(selected.result.current.row?.models?.[0]?.id).toBe("fresh");
    expect(selected.result.current.fresh).toBe(true);
  });

  it("coalesces concurrent forced named refreshes", async () => {
    const aggregateRow = {
      name: "claude" as const,
      displayName: "Claude",
      installed: true,
      authenticated: true,
      enabled: true,
      models: [{ id: "cached", name: "Cached" }],
    };
    mockGetProviders.mockResolvedValueOnce({ providers: [aggregateRow] });
    const aggregate = renderHook(() => providersModule.useProviders());
    await waitFor(() => expect(aggregate.result.current.loading).toBe(false));

    const refreshed = deferred<{ provider: typeof aggregateRow }>();
    mockGetProvider.mockReturnValueOnce(refreshed.promise);
    const selected = renderHook(() =>
      providersModule.useProviderRow("claude"),
    );
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    act(() => {
      first = selected.result.current.refresh();
      second = selected.result.current.refresh();
    });
    await waitFor(() => expect(mockGetProvider).toHaveBeenCalledTimes(1));

    refreshed.resolve({
      provider: {
        ...aggregateRow,
        models: [{ id: "fresh", name: "Fresh" }],
      },
    });
    await act(async () => {
      await Promise.all([first, second]);
    });
    expect(selected.result.current.row?.models?.[0]?.id).toBe("fresh");
  });

  it("reuses a fresh aggregate row instead of a single-provider request", async () => {
    mockGetProviders.mockResolvedValueOnce({
      providers: [
        {
          name: "claude",
          displayName: "Claude",
          installed: true,
          authenticated: true,
          enabled: true,
          models: [{ id: "latest", name: "Latest" }],
        },
      ],
    });
    const aggregate = renderHook(() => providersModule.useProviders());
    await waitFor(() => {
      expect(aggregate.result.current.loading).toBe(false);
    });

    const { result } = renderHook(() =>
      providersModule.useProviderRow("claude"),
    );

    expect(result.current.row?.models?.[0]?.id).toBe("latest");
    expect(result.current.fresh).toBe(true);
    expect(mockGetProvider).not.toHaveBeenCalled();
  });
});
