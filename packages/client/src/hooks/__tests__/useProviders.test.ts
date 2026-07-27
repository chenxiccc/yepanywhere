// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetProviders } = vi.hoisted(() => ({
  mockGetProviders: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    getProviders: mockGetProviders,
  },
}));

describe("useProviders", () => {
  let providersModule: typeof import("../useProviders");

  beforeEach(async () => {
    mockGetProviders.mockReset();
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
});
