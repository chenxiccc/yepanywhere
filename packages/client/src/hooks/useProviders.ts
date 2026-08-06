import {
  DEFAULT_PROVIDER,
  type ModelInfo,
  type ProviderInfo,
  type ProviderName,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { acquireClientQueryBootstrapSlot } from "../lib/clientQueryBootstrap";
import {
  getCurrentClientSummarySourceKey,
  type ClientSummarySourceKey,
  useClientSummarySourceKey,
} from "../lib/clientSummaryStore";

const PROVIDER_CACHE_TTL_MS = 5 * 60_000;
/**
 * How long a previous visit's provider rows stay usable as an opening guess.
 *
 * A snapshot is never a probe result: it renders the standing choice while the
 * real request runs, and every consumer still sees `loading` until that request
 * answers. Installing or authenticating a provider between visits therefore
 * shows up as an in-place correction rather than a wrong permanent list.
 */
const PROVIDER_SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60_000;
const PROVIDER_SNAPSHOT_PREFIX = "ya:providers:";
const PROVIDER_SNAPSHOT_VERSION = 1;

interface ProviderSnapshot {
  version: typeof PROVIDER_SNAPSHOT_VERSION;
  savedAt: number;
  providers: ProviderInfo[];
}

function snapshotModel(model: ModelInfo): ModelInfo {
  return {
    id: model.id,
    name: model.name,
    description: model.description,
    size: model.size,
    contextWindow: model.contextWindow,
    parameterSize: model.parameterSize,
    parentModel: model.parentModel,
    quantizationLevel: model.quantizationLevel,
    isDefault: model.isDefault,
    defaultReasoningEffort: model.defaultReasoningEffort,
    supportedReasoningEfforts: model.supportedReasoningEfforts?.map(
      (effort) => ({
        reasoningEffort: effort.reasoningEffort,
        description: effort.description,
      }),
    ),
    supportsEffort: model.supportsEffort,
    supportedEffortLevels: model.supportedEffortLevels
      ? [...model.supportedEffortLevels]
      : undefined,
    defaultEffortLevel: model.defaultEffortLevel,
    supportsAdaptiveThinking: model.supportsAdaptiveThinking,
    supportsFastMode: model.supportsFastMode,
    supportsAutoMode: model.supportsAutoMode,
    inputModalities: model.inputModalities
      ? [...model.inputModalities]
      : undefined,
    supportsPersonality: model.supportsPersonality,
    serviceTiers: model.serviceTiers?.map((tier) => ({
      id: tier.id,
      name: tier.name,
      description: tier.description,
    })),
    catalogGroup: model.catalogGroup,
  };
}

/** Keep only fields used to paint provider/model controls between visits. */
function snapshotProvider(provider: ProviderInfo): ProviderInfo {
  return {
    name: provider.name,
    displayName: provider.displayName,
    installed: provider.installed,
    applicationDetected: provider.applicationDetected,
    authenticated: provider.authenticated,
    enabled: provider.enabled,
    models: provider.models?.map(snapshotModel),
    additionalModelOptions: provider.additionalModelOptions?.map(snapshotModel),
    imageSizing: provider.imageSizing
      ? {
          defaultLongEdgePx: provider.imageSizing.defaultLongEdgePx,
          maxUsefulLongEdgePx: provider.imageSizing.maxUsefulLongEdgePx,
          note: provider.imageSizing.note,
        }
      : undefined,
    supportsPermissionMode: provider.supportsPermissionMode,
    supportsThinkingToggle: provider.supportsThinkingToggle,
    supportsSlashCommands: provider.supportsSlashCommands,
    supportsSteering: provider.supportsSteering,
    supportsSteerNow: provider.supportsSteerNow,
    supportsRecaps: provider.supportsRecaps,
    supportsNativeRecaps: provider.supportsNativeRecaps,
    supportsNativePromptSuggestions: provider.supportsNativePromptSuggestions,
    supportsNativeCompactThreshold: provider.supportsNativeCompactThreshold,
    supportsLaunchCompactPercentOverride:
      provider.supportsLaunchCompactPercentOverride,
    promptCacheKeepalive: provider.promptCacheKeepalive
      ? {
          supportsNoContextPollutionNudge:
            provider.promptCacheKeepalive.supportsNoContextPollutionNudge,
          defaultMode: provider.promptCacheKeepalive.defaultMode,
          defaultInactivityMinutes:
            provider.promptCacheKeepalive.defaultInactivityMinutes,
        }
      : undefined,
    supportsForkSession: provider.supportsForkSession,
  };
}

interface ProviderCacheEntry {
  providers: ProviderInfo[];
  expiresAt: number;
  requestSequence: number;
  /** Rows from a previous visit; they never satisfy a request on their own. */
  stale?: boolean;
}

let providerRequestSequence = 0;
const providerCaches = new Map<ClientSummarySourceKey, ProviderCacheEntry>();
const providerFetchPromises = new Map<
  ClientSummarySourceKey,
  Promise<ProviderInfo[]>
>();
const hydratedSnapshotSources = new Set<ClientSummarySourceKey>();
type ProviderCatalogListener = (entry: ProviderCacheEntry) => void;
const providerCatalogListeners = new Map<
  ClientSummarySourceKey,
  Set<ProviderCatalogListener>
>();
type ProviderRowListener = (
  row: ProviderInfo | null,
  requestSequence: number,
) => void;
const providerRowListeners = new Map<
  ClientSummarySourceKey,
  Map<ProviderName, Set<ProviderRowListener>>
>();

function notifyProviderCatalogListeners(
  sourceKey: ClientSummarySourceKey,
  entry: ProviderCacheEntry,
): void {
  const listeners = providerCatalogListeners.get(sourceKey);
  if (!listeners) return;
  for (const listener of listeners) listener(entry);
}

function notifyProviderRowListeners(
  sourceKey: ClientSummarySourceKey,
  providers: readonly ProviderInfo[],
  requestSequence: number,
): void {
  const sourceListeners = providerRowListeners.get(sourceKey);
  if (!sourceListeners) return;
  for (const [providerName, listeners] of sourceListeners) {
    const row =
      providers.find((provider) => provider.name === providerName) ?? null;
    for (const listener of listeners) listener(row, requestSequence);
  }
}

function snapshotStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Seed the in-memory cache from the last successful probe for this source. */
function hydrateProviderSnapshot(sourceKey: ClientSummarySourceKey): void {
  if (hydratedSnapshotSources.has(sourceKey)) return;
  hydratedSnapshotSources.add(sourceKey);
  if (providerCaches.has(sourceKey)) return;
  const storage = snapshotStorage();
  if (!storage) return;
  try {
    const raw = storage.getItem(`${PROVIDER_SNAPSHOT_PREFIX}${sourceKey}`);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<ProviderSnapshot>;
    if (
      parsed.version !== PROVIDER_SNAPSHOT_VERSION ||
      !Array.isArray(parsed.providers) ||
      parsed.providers.length === 0
    ) {
      storage.removeItem(`${PROVIDER_SNAPSHOT_PREFIX}${sourceKey}`);
      return;
    }
    if (
      typeof parsed.savedAt !== "number" ||
      Date.now() - parsed.savedAt > PROVIDER_SNAPSHOT_TTL_MS
    ) {
      storage.removeItem(`${PROVIDER_SNAPSHOT_PREFIX}${sourceKey}`);
      return;
    }
    providerCaches.set(sourceKey, {
      providers: parsed.providers,
      // A browser snapshot predates every request in this module lifetime.
      requestSequence: 0,
      // Expired on arrival: a snapshot is an opening guess, never an answer.
      expiresAt: 0,
      stale: true,
    });
  } catch {
    // A malformed or unreadable snapshot just means no opening guess.
  }
}

function writeProviderSnapshot(
  sourceKey: ClientSummarySourceKey,
  providers: ProviderInfo[],
): void {
  const storage = snapshotStorage();
  if (!storage || providers.length === 0) return;
  try {
    storage.setItem(
      `${PROVIDER_SNAPSHOT_PREFIX}${sourceKey}`,
      JSON.stringify({
        version: PROVIDER_SNAPSHOT_VERSION,
        savedAt: Date.now(),
        providers: providers.map(snapshotProvider),
      } satisfies ProviderSnapshot),
    );
  } catch {
    // Storage pressure only costs the next visit its opening guess.
  }
}

async function loadProviders(
  sourceKey: ClientSummarySourceKey,
  forceRefresh: boolean,
  bypassClientCache = false,
): Promise<ProviderInfo[]> {
  const now = Date.now();
  hydrateProviderSnapshot(sourceKey);
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

  const requestSequence = ++providerRequestSequence;
  const request = api
    .getProviders({ refresh: forceRefresh })
    .then((data) => data.providers);
  providerFetchPromises.set(sourceKey, request);

  try {
    const providers = await request;
    if (providerFetchPromises.get(sourceKey) === request) {
      const entry = {
        providers,
        expiresAt: Date.now() + PROVIDER_CACHE_TTL_MS,
        requestSequence,
      };
      providerCaches.set(sourceKey, entry);
      writeProviderSnapshot(sourceKey, providers);
      notifyProviderCatalogListeners(sourceKey, entry);
      notifyProviderRowListeners(sourceKey, providers, requestSequence);
      return providers;
    }
    const current = providerCaches.get(sourceKey);
    return current && current.requestSequence > requestSequence
      ? current.providers
      : providers;
  } catch (error) {
    const current = providerCaches.get(sourceKey);
    if (current && current.requestSequence > requestSequence) {
      return current.providers;
    }
    throw error;
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
  /** The rows on hand predate this visit's probe and may be wrong. */
  stale: boolean;
  error: Error | null;
}

function getInitialProviderState(
  sourceKey: ClientSummarySourceKey,
): ProviderHookState {
  hydrateProviderSnapshot(sourceKey);
  const providerCache = providerCaches.get(sourceKey);
  return {
    sourceKey,
    providers: providerCache?.providers ?? [],
    loading: !providerCache || providerCache.stale === true,
    stale: providerCache?.stale === true,
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
  const fetchSequenceRef = useRef(0);

  const fetch = useCallback(
    async (forceRefresh = false, bypassClientCache = false) => {
      const fetchSequence = ++fetchSequenceRef.current;
      const providerCache = providerCaches.get(sourceKey);
      if (
        forceRefresh ||
        bypassClientCache ||
        !providerCache ||
        providerCache.stale
      ) {
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
        if (fetchSequence !== fetchSequenceRef.current) return;
        setState({
          sourceKey,
          providers: nextProviders,
          loading: false,
          stale: false,
          error: null,
        });
      } catch (err) {
        if (fetchSequence !== fetchSequenceRef.current) return;
        setState((current) => ({
          ...(current.sourceKey === sourceKey
            ? current
            : getInitialProviderState(sourceKey)),
          error: err instanceof Error ? err : new Error(String(err)),
        }));
      } finally {
        if (fetchSequence === fetchSequenceRef.current) {
          setState((current) =>
            current.sourceKey === sourceKey
              ? { ...current, loading: false }
              : current,
          );
        }
      }
    },
    [sourceKey],
  );

  useEffect(() => {
    const listener: ProviderCatalogListener = (entry) => {
      setState({
        sourceKey,
        providers: entry.providers,
        loading: false,
        stale: false,
        error: null,
      });
    };
    const listeners =
      providerCatalogListeners.get(sourceKey) ??
      new Set<ProviderCatalogListener>();
    listeners.add(listener);
    providerCatalogListeners.set(sourceKey, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) providerCatalogListeners.delete(sourceKey);
    };
  }, [sourceKey]);

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

interface ProviderRowCacheEntry {
  row: ProviderInfo;
  expiresAt: number;
  requestSequence: number;
}

interface ProviderRowRequest {
  forced: boolean;
  requestSequence: number;
  promise: Promise<ProviderRowCacheEntry>;
  supersededBy?: Promise<ProviderRowCacheEntry>;
}

const providerRowCaches = new Map<string, ProviderRowCacheEntry>();
const providerRowRequests = new Map<string, ProviderRowRequest>();

function providerRowKey(
  sourceKey: ClientSummarySourceKey,
  providerName: ProviderName,
): string {
  return `${sourceKey}\0${providerName}`;
}

/** A current row good enough to skip an ordinary single-provider request. */
function readCachedProviderRowEntry(
  sourceKey: ClientSummarySourceKey,
  providerName: ProviderName,
): ProviderRowCacheEntry | null {
  const now = Date.now();
  const cachedRow = providerRowCaches.get(
    providerRowKey(sourceKey, providerName),
  );
  const rowEntry =
    cachedRow && cachedRow.expiresAt > now ? cachedRow : undefined;
  const cachedProviders = providerCaches.get(sourceKey);
  const providerCache =
    cachedProviders && !cachedProviders.stale && cachedProviders.expiresAt > now
      ? cachedProviders
      : undefined;
  if (
    rowEntry &&
    (!providerCache ||
      rowEntry.requestSequence >= providerCache.requestSequence)
  ) {
    return rowEntry;
  }
  const aggregateRow = providerCache?.providers.find(
    (provider) => provider.name === providerName,
  );
  return aggregateRow && providerCache
    ? {
        row: aggregateRow,
        expiresAt: providerCache.expiresAt,
        requestSequence: providerCache.requestSequence,
      }
    : null;
}

function readCachedProviderRow(
  sourceKey: ClientSummarySourceKey,
  providerName: ProviderName,
): ProviderInfo | null {
  return readCachedProviderRowEntry(sourceKey, providerName)?.row ?? null;
}

async function loadProviderRow(
  sourceKey: ClientSummarySourceKey,
  providerName: ProviderName,
  forceRefresh: boolean,
  supersedeBeforeSequence = 0,
): Promise<ProviderRowCacheEntry> {
  const key = providerRowKey(sourceKey, providerName);
  if (!forceRefresh) {
    const cached = readCachedProviderRowEntry(sourceKey, providerName);
    if (cached) return cached;
  }

  const pending = providerRowRequests.get(key);
  if (
    pending &&
    (!forceRefresh ||
      (pending.forced && pending.requestSequence > supersedeBeforeSequence))
  ) {
    return pending.promise;
  }

  const requestSequence = ++providerRequestSequence;
  const rawRequest = api
    .getProvider(providerName, { refresh: forceRefresh })
    .then((data) => data.provider);
  let request!: ProviderRowRequest;
  const promise = rawRequest
    .then(
      (row) => {
        if (request.supersededBy) return request.supersededBy;
        const entry = {
          row,
          expiresAt: Date.now() + PROVIDER_CACHE_TTL_MS,
          requestSequence,
        };
        const newerCached = readCachedProviderRowEntry(sourceKey, providerName);
        if (
          newerCached &&
          newerCached.requestSequence > entry.requestSequence
        ) {
          return newerCached;
        }
        if (providerRowRequests.get(key) === request) {
          providerRowCaches.set(key, entry);
        }
        return entry;
      },
      (error: unknown) => {
        if (request.supersededBy) return request.supersededBy;
        throw error;
      },
    )
    .finally(() => {
      if (providerRowRequests.get(key) === request) {
        providerRowRequests.delete(key);
      }
    });
  request = { forced: forceRefresh, requestSequence, promise };
  if (pending) pending.supersededBy = promise;
  providerRowRequests.set(key, request);
  return promise;
}

interface ProviderRowHookState {
  sourceKey: ClientSummarySourceKey;
  providerName: ProviderName | null;
  row: ProviderInfo | null;
  refreshing: boolean;
  fresh: boolean;
  error: Error | null;
}

function getInitialProviderRowState(
  sourceKey: ClientSummarySourceKey,
  providerName: ProviderName | null,
  forceRefreshOnMount: boolean,
): ProviderRowHookState {
  const row = providerName
    ? readCachedProviderRow(sourceKey, providerName)
    : null;
  const fresh = row !== null && !forceRefreshOnMount;
  return {
    sourceKey,
    providerName,
    row,
    refreshing: providerName !== null && !fresh,
    fresh,
    error: null,
  };
}

export interface UseProviderRowOptions {
  /** Require a named probe started after this selection became current. */
  forceRefreshOnMount?: boolean;
}

/**
 * Resolve one provider's own status and models, independent of the aggregate.
 *
 * The display row and its authority are separate: a caller may keep showing a
 * retained row while `fresh` is false and a current named probe is running or
 * failed. Initial acquisition participates in the route bootstrap tier; direct
 * retries never wait for that startup gate.
 */
export function useProviderRow(
  providerName: ProviderName | null | undefined,
  options: UseProviderRowOptions = {},
) {
  const sourceKey = useClientSummarySourceKey();
  const normalizedProvider = providerName ?? null;
  const forceRefreshOnMount = options.forceRefreshOnMount === true;
  const [state, setState] = useState<ProviderRowHookState>(() =>
    getInitialProviderRowState(
      sourceKey,
      normalizedProvider,
      forceRefreshOnMount,
    ),
  );
  const requestSequenceRef = useRef(0);
  const acceptedRequestSequenceRef = useRef(
    normalizedProvider
      ? (readCachedProviderRowEntry(sourceKey, normalizedProvider)
          ?.requestSequence ?? 0)
      : 0,
  );

  const fetch = useCallback(
    async (forceRefresh: boolean, supersedeBeforeSequence = 0) => {
      if (!normalizedProvider) return;
      const requestSequence = ++requestSequenceRef.current;
      setState((current) => {
        const visible =
          current.sourceKey === sourceKey &&
          current.providerName === normalizedProvider
            ? current
            : getInitialProviderRowState(
                sourceKey,
                normalizedProvider,
                forceRefresh,
              );
        return {
          ...visible,
          refreshing: true,
          fresh: forceRefresh ? false : visible.fresh,
          error: null,
        };
      });
      try {
        const entry = await loadProviderRow(
          sourceKey,
          normalizedProvider,
          forceRefresh,
          supersedeBeforeSequence,
        );
        if (requestSequence !== requestSequenceRef.current) return;
        acceptedRequestSequenceRef.current = Math.max(
          acceptedRequestSequenceRef.current,
          entry.requestSequence,
        );
        setState({
          sourceKey,
          providerName: normalizedProvider,
          row: entry.row,
          refreshing: false,
          fresh: true,
          error: null,
        });
      } catch (error) {
        if (requestSequence !== requestSequenceRef.current) return;
        setState((current) => ({
          ...(current.sourceKey === sourceKey &&
          current.providerName === normalizedProvider
            ? current
            : getInitialProviderRowState(
                sourceKey,
                normalizedProvider,
                forceRefresh,
              )),
          refreshing: false,
          fresh: false,
          error: error instanceof Error ? error : new Error(String(error)),
        }));
      }
    },
    [normalizedProvider, sourceKey],
  );

  useEffect(() => {
    if (!normalizedProvider) return undefined;
    const listener: ProviderRowListener = (row, requestSequence) => {
      if (requestSequence <= acceptedRequestSequenceRef.current) return;
      acceptedRequestSequenceRef.current = requestSequence;
      setState({
        sourceKey,
        providerName: normalizedProvider,
        row,
        refreshing: forceRefreshOnMount,
        fresh: !forceRefreshOnMount,
        error: null,
      });
      if (forceRefreshOnMount) {
        void fetch(true, requestSequence);
      }
    };
    const sourceListeners =
      providerRowListeners.get(sourceKey) ??
      new Map<ProviderName, Set<ProviderRowListener>>();
    const listeners =
      sourceListeners.get(normalizedProvider) ?? new Set<ProviderRowListener>();
    listeners.add(listener);
    sourceListeners.set(normalizedProvider, listeners);
    providerRowListeners.set(sourceKey, sourceListeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) sourceListeners.delete(normalizedProvider);
      if (sourceListeners.size === 0) providerRowListeners.delete(sourceKey);
    };
  }, [fetch, forceRefreshOnMount, normalizedProvider, sourceKey]);

  useEffect(() => {
    requestSequenceRef.current += 1;
    acceptedRequestSequenceRef.current = normalizedProvider
      ? (readCachedProviderRowEntry(sourceKey, normalizedProvider)
          ?.requestSequence ?? 0)
      : 0;
    const initial = getInitialProviderRowState(
      sourceKey,
      normalizedProvider,
      forceRefreshOnMount,
    );
    setState(initial);
    if (!normalizedProvider || initial.fresh) return undefined;

    let cancelled = false;
    const selectionSequence = providerRequestSequence;
    const slot = acquireClientQueryBootstrapSlot(sourceKey, "route");
    void slot.ready().then(() => {
      if (cancelled) {
        slot.settle();
        return;
      }
      void fetch(
        forceRefreshOnMount,
        forceRefreshOnMount ? selectionSequence : 0,
      ).finally(() => slot.settle());
    });
    return () => {
      cancelled = true;
      requestSequenceRef.current += 1;
      slot.settle();
    };
  }, [fetch, forceRefreshOnMount, normalizedProvider, sourceKey]);

  const visible =
    state.sourceKey === sourceKey && state.providerName === normalizedProvider
      ? state
      : getInitialProviderRowState(
          sourceKey,
          normalizedProvider,
          forceRefreshOnMount,
        );

  return {
    ...visible,
    loading: visible.refreshing && visible.row === null,
    refresh: () => fetch(true),
  };
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
