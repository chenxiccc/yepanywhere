import { DEFAULT_PROVIDER, type ProviderInfo } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import {
  getCurrentClientSummarySourceKey,
  type ClientSummarySourceKey,
  useClientSummarySourceKey,
} from "../lib/clientSummaryStore";

const PROVIDER_CACHE_TTL_MS = 5 * 60_000;

interface ProviderCacheEntry {
  providers: ProviderInfo[];
  expiresAt: number;
}

const providerCaches = new Map<ClientSummarySourceKey, ProviderCacheEntry>();
const providerFetchPromises = new Map<
  ClientSummarySourceKey,
  Promise<ProviderInfo[]>
>();

async function loadProviders(
  sourceKey: ClientSummarySourceKey,
  forceRefresh: boolean,
  bypassClientCache = false,
): Promise<ProviderInfo[]> {
  const now = Date.now();
  const providerCache = providerCaches.get(sourceKey);
  if (
    !forceRefresh &&
    !bypassClientCache &&
    providerCache &&
    providerCache.expiresAt > now
  ) {
    return providerCache.providers;
  }
  const providerFetchPromise = providerFetchPromises.get(sourceKey);
  if (!forceRefresh && !bypassClientCache && providerFetchPromise) {
    return providerFetchPromise;
  }

  const request = api.getProviders({ refresh: forceRefresh }).then((data) => {
    providerCaches.set(sourceKey, {
      providers: data.providers,
      expiresAt: Date.now() + PROVIDER_CACHE_TTL_MS,
    });
    return data.providers;
  });
  providerFetchPromises.set(sourceKey, request);

  try {
    return await request;
  } finally {
    if (providerFetchPromises.get(sourceKey) === request) {
      providerFetchPromises.delete(sourceKey);
    }
  }
}

/**
 * Populate the shared provider/model cache before a consumer needs it.
 *
 * This uses the same request and in-flight deduplication as `useProviders`, so
 * a new-session form mounted during the primer joins the request rather than
 * starting another provider probe.
 */
export function primeProviderCache(
  sourceKey = getCurrentClientSummarySourceKey(),
): Promise<ProviderInfo[]> {
  return loadProviders(sourceKey, false);
}

interface ProviderHookState {
  sourceKey: ClientSummarySourceKey;
  providers: ProviderInfo[];
  loading: boolean;
  error: Error | null;
}

function getInitialProviderState(
  sourceKey: ClientSummarySourceKey,
): ProviderHookState {
  const providerCache = providerCaches.get(sourceKey);
  return {
    sourceKey,
    providers: providerCache?.providers ?? [],
    loading: !providerCache,
    error: null,
  };
}

/**
 * Hook to fetch and cache available AI providers with their auth status.
 *
 * Returns:
 * - providers: Array of provider info objects
 * - loading: Whether the initial fetch is in progress
 * - error: Any error that occurred during fetch
 * - refetch: Function to manually refresh provider status
 */
export function useProviders() {
  const sourceKey = useClientSummarySourceKey();
  const [state, setState] = useState<ProviderHookState>(() =>
    getInitialProviderState(sourceKey),
  );
  const lastFetchedSourceRef = useRef<ClientSummarySourceKey | null>(null);

  const fetch = useCallback(
    async (forceRefresh = false, bypassClientCache = false) => {
      const providerCache = providerCaches.get(sourceKey);
      if (forceRefresh || bypassClientCache || !providerCache) {
        setState((current) => ({
          ...(current.sourceKey === sourceKey
            ? current
            : getInitialProviderState(sourceKey)),
          loading: true,
        }));
      }
      setState((current) => ({
        ...(current.sourceKey === sourceKey
          ? current
          : getInitialProviderState(sourceKey)),
        error: null,
      }));
      try {
        const nextProviders = await loadProviders(
          sourceKey,
          forceRefresh,
          bypassClientCache,
        );
        setState({
          sourceKey,
          providers: nextProviders,
          loading: false,
          error: null,
        });
      } catch (err) {
        setState((current) => ({
          ...(current.sourceKey === sourceKey
            ? current
            : getInitialProviderState(sourceKey)),
          error: err instanceof Error ? err : new Error(String(err)),
        }));
      } finally {
        setState((current) =>
          current.sourceKey === sourceKey
            ? { ...current, loading: false }
            : current,
        );
      }
    },
    [sourceKey],
  );

  // Fetch once per source transition (the cache handles remounts and expiry).
  useEffect(() => {
    if (lastFetchedSourceRef.current === sourceKey) return;
    lastFetchedSourceRef.current = sourceKey;
    fetch();
  }, [fetch, sourceKey]);

  const refetch = useCallback(() => fetch(true), [fetch]);
  const reload = useCallback(() => fetch(false, true), [fetch]);
  const visibleState =
    state.sourceKey === sourceKey ? state : getInitialProviderState(sourceKey);

  return { ...visibleState, refetch, reload };
}

/**
 * Get the list of providers that are available (installed + authenticated/enabled).
 */
export function getAvailableProviders(
  providers: ProviderInfo[],
): ProviderInfo[] {
  return providers.filter((p) => p.installed && (p.authenticated || p.enabled));
}

/**
 * Get the default provider from available providers.
 * Prefers Claude if available, otherwise the first available provider.
 */
export function getDefaultProvider(
  providers: ProviderInfo[],
): ProviderInfo | null {
  const available = getAvailableProviders(providers);
  if (available.length === 0) return null;

  // Prefer default provider (Claude)
  const defaultProv = available.find((p) => p.name === DEFAULT_PROVIDER);
  if (defaultProv) return defaultProv;

  // available[0] is guaranteed to exist since we checked length > 0
  return available[0] ?? null;
}
