import {
  PROVIDER_SUBSCRIPTION_USAGE_CAPABILITY,
  serverHasCapability,
  type ProviderName,
  type ProviderSubscriptionUsage,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import {
  type ClientSummarySourceKey,
  useClientSummarySourceKey,
} from "../lib/clientSummaryStore";
import { useVersion } from "./useVersion";

const USAGE_CACHE_TTL_MS = 60_000;

interface UsageCacheEntry {
  value: ProviderSubscriptionUsage | null;
  expiresAt: number;
}

const usageCaches = new Map<
  ClientSummarySourceKey,
  Map<ProviderName, UsageCacheEntry>
>();
const usageRequests = new Map<
  ClientSummarySourceKey,
  Map<ProviderName, Promise<ProviderSubscriptionUsage | null>>
>();

function sourceMap<T>(
  stores: Map<ClientSummarySourceKey, Map<ProviderName, T>>,
  sourceKey: ClientSummarySourceKey,
): Map<ProviderName, T> {
  const existing = stores.get(sourceKey);
  if (existing) return existing;
  const created = new Map<ProviderName, T>();
  stores.set(sourceKey, created);
  return created;
}

async function loadUsage(
  sourceKey: ClientSummarySourceKey,
  provider: ProviderName,
  forceRefresh: boolean,
): Promise<ProviderSubscriptionUsage | null> {
  const cache = sourceMap(usageCaches, sourceKey);
  const cached = cache.get(provider);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const requests = sourceMap(usageRequests, sourceKey);
  const pending = requests.get(provider);
  if (!forceRefresh && pending) return pending;

  const request = api
    .getProviderSubscriptionUsage(provider, { refresh: forceRefresh })
    .then((response) => response.usage);
  requests.set(provider, request);
  try {
    const value = await request;
    if (requests.get(provider) === request) {
      cache.set(provider, {
        value,
        expiresAt: Date.now() + USAGE_CACHE_TTL_MS,
      });
    }
    return value;
  } finally {
    if (requests.get(provider) === request) {
      requests.delete(provider);
    }
  }
}

interface UsageState {
  sourceKey: ClientSummarySourceKey;
  provider: ProviderName | null;
  usage: ProviderSubscriptionUsage | null;
  loading: boolean;
  error: Error | null;
}

export function useProviderSubscriptionUsage(
  provider: ProviderName | null | undefined,
) {
  const sourceKey = useClientSummarySourceKey();
  const { version } = useVersion();
  const supported = serverHasCapability(
    version,
    PROVIDER_SUBSCRIPTION_USAGE_CAPABILITY,
  );
  const normalizedProvider = provider ?? null;
  const [state, setState] = useState<UsageState>({
    sourceKey,
    provider: normalizedProvider,
    usage: null,
    loading: false,
    error: null,
  });
  const sequenceRef = useRef(0);

  const fetchUsage = useCallback(
    async (forceRefresh: boolean) => {
      const sequence = ++sequenceRef.current;
      if (!supported || !normalizedProvider) {
        setState({
          sourceKey,
          provider: normalizedProvider,
          usage: null,
          loading: false,
          error: null,
        });
        return null;
      }

      const cached = sourceMap(usageCaches, sourceKey).get(normalizedProvider);
      setState({
        sourceKey,
        provider: normalizedProvider,
        usage: cached?.value ?? null,
        loading: true,
        error: null,
      });
      try {
        const usage = await loadUsage(
          sourceKey,
          normalizedProvider,
          forceRefresh,
        );
        if (sequence === sequenceRef.current) {
          setState({
            sourceKey,
            provider: normalizedProvider,
            usage,
            loading: false,
            error: null,
          });
        }
        return usage;
      } catch (error) {
        if (sequence === sequenceRef.current) {
          setState({
            sourceKey,
            provider: normalizedProvider,
            usage: null,
            loading: false,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
        return null;
      }
    },
    [normalizedProvider, sourceKey, supported],
  );

  useEffect(() => {
    void fetchUsage(false);
  }, [fetchUsage]);

  const visible =
    state.sourceKey === sourceKey && state.provider === normalizedProvider
      ? state
      : {
          sourceKey,
          provider: normalizedProvider,
          usage: null,
          loading: supported && normalizedProvider !== null,
          error: null,
        };

  return {
    ...visible,
    supported,
    refresh: () => fetchUsage(true),
  };
}
