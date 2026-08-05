import type { ClientSummarySourceKey } from "./clientSummaryStore";

export type ClientQueryKey = string;

export interface ClientQueryCoverage {
  minRows?: number;
  includeStats?: boolean;
  pagesLoaded?: number;
  [key: string]: unknown;
}

export interface ClientQueryRequestContext {
  sourceKey: ClientSummarySourceKey;
  key: ClientQueryKey;
  coverage: ClientQueryCoverage;
  requestStartedAt: number;
  meta?: unknown;
}

export interface ClientQueryState {
  sourceKey: ClientSummarySourceKey;
  key: ClientQueryKey;
  coverage: ClientQueryCoverage;
  retainedCount: number;
  inFlight: boolean;
  stale: boolean;
  fetchedAt?: number;
  requestStartedAt?: number;
  error?: Error;
}

export interface EnsureClientQueryOptions<T> {
  sourceKey: ClientSummarySourceKey;
  key: ClientQueryKey | unknown;
  coverage?: ClientQueryCoverage;
  staleTimeMs?: number;
  force?: boolean;
  meta?: unknown;
  fetcher: (context: ClientQueryRequestContext) => Promise<T>;
  applySnapshot?: (
    result: T,
    context: ClientQueryRequestContext,
  ) => void | Promise<void>;
}

export interface RetainClientQueryOptions {
  sourceKey: ClientSummarySourceKey;
  key: ClientQueryKey | unknown;
}

type ClientQueryListener = () => void;

interface ClientQueryInFlight {
  coverage: ClientQueryCoverage;
  promise: Promise<void>;
  requestStartedAt: number;
  staleVersionAtStart: number;
}

interface ClientQueryEntry {
  sourceKey: ClientSummarySourceKey;
  key: ClientQueryKey;
  coverage: ClientQueryCoverage;
  retainedCount: number;
  inFlights: Set<ClientQueryInFlight>;
  stale: boolean;
  staleVersion: number;
  fetchedAt?: number;
  requestStartedAt?: number;
  error?: Error;
}

const entries = new Map<string, ClientQueryEntry>();
const listeners = new Set<ClientQueryListener>();

function stableSerialize(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
}

export function createClientQueryKey(value: unknown): ClientQueryKey {
  return typeof value === "string" ? value : stableSerialize(value);
}

function getEntryMapKey(
  sourceKey: ClientSummarySourceKey,
  key: ClientQueryKey,
): string {
  return `${sourceKey}\0${key}`;
}

function emitChange(): void {
  for (const listener of Array.from(listeners)) {
    listener();
  }
}

export function subscribeClientQueries(
  listener: ClientQueryListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function normalizeCoverage(
  coverage: ClientQueryCoverage | undefined,
): ClientQueryCoverage {
  return coverage ? { ...coverage } : {};
}

/**
 * Whether work done for `available` also answers a need for `requested`.
 * Exported for the revalidation owner, which uses it to pick the one
 * subscriber whose refetch satisfies every other subscriber of the same query.
 */
export function coverageSatisfies(
  available: ClientQueryCoverage,
  requested: ClientQueryCoverage,
): boolean {
  for (const [key, requestedValue] of Object.entries(requested)) {
    if (requestedValue === undefined) {
      continue;
    }

    const availableValue = available[key];
    if (
      (key === "minRows" || key === "pagesLoaded") &&
      typeof requestedValue === "number"
    ) {
      if (
        typeof availableValue !== "number" ||
        availableValue < requestedValue
      ) {
        return false;
      }
      continue;
    }

    if (key === "includeStats" && requestedValue === true) {
      if (availableValue !== true) {
        return false;
      }
      continue;
    }

    if (availableValue !== requestedValue) {
      return false;
    }
  }

  return true;
}

function mergeCoverage(
  current: ClientQueryCoverage,
  next: ClientQueryCoverage,
): ClientQueryCoverage {
  const merged: ClientQueryCoverage = { ...current };
  for (const [key, nextValue] of Object.entries(next)) {
    if (nextValue === undefined) {
      continue;
    }

    const currentValue = merged[key];
    if (
      (key === "minRows" || key === "pagesLoaded") &&
      typeof nextValue === "number"
    ) {
      merged[key] =
        typeof currentValue === "number"
          ? Math.max(currentValue, nextValue)
          : nextValue;
      continue;
    }

    if (key === "includeStats" && nextValue === true) {
      merged[key] = true;
      continue;
    }

    merged[key] = nextValue;
  }
  return merged;
}

function getOrCreateEntry(
  sourceKey: ClientSummarySourceKey,
  key: ClientQueryKey,
): ClientQueryEntry {
  const entryKey = getEntryMapKey(sourceKey, key);
  let entry = entries.get(entryKey);
  if (!entry) {
    entry = {
      sourceKey,
      key,
      coverage: {},
      retainedCount: 0,
      inFlights: new Set(),
      stale: true,
      staleVersion: 0,
    };
    entries.set(entryKey, entry);
  }
  return entry;
}

function toState(entry: ClientQueryEntry): ClientQueryState {
  return {
    sourceKey: entry.sourceKey,
    key: entry.key,
    coverage: { ...entry.coverage },
    retainedCount: entry.retainedCount,
    inFlight: entry.inFlights.size > 0,
    stale: entry.stale,
    fetchedAt: entry.fetchedAt,
    requestStartedAt: entry.requestStartedAt,
    error: entry.error,
  };
}

function isFresh(
  entry: ClientQueryEntry,
  requestedCoverage: ClientQueryCoverage,
  staleTimeMs: number | undefined,
): boolean {
  if (entry.stale || entry.fetchedAt === undefined) {
    return false;
  }
  if (!coverageSatisfies(entry.coverage, requestedCoverage)) {
    return false;
  }
  return (
    staleTimeMs === undefined || Date.now() - entry.fetchedAt <= staleTimeMs
  );
}

function markStaleForForcedFetch(entry: ClientQueryEntry): void {
  if (entry.stale) {
    return;
  }
  entry.staleVersion += 1;
  entry.stale = true;
  emitChange();
}

export function ensureClientQuery<T>(
  options: EnsureClientQueryOptions<T>,
): Promise<void> {
  const key = createClientQueryKey(options.key);
  const requestedCoverage = normalizeCoverage(options.coverage);
  const entry = getOrCreateEntry(options.sourceKey, key);

  if (
    !options.force &&
    isFresh(entry, requestedCoverage, options.staleTimeMs)
  ) {
    return Promise.resolve();
  }

  for (const inFlight of entry.inFlights) {
    if (coverageSatisfies(inFlight.coverage, requestedCoverage)) {
      return inFlight.promise;
    }
  }

  if (options.force) {
    markStaleForForcedFetch(entry);
  }

  const requestStartedAt = Date.now();
  const context: ClientQueryRequestContext = {
    sourceKey: options.sourceKey,
    key,
    coverage: requestedCoverage,
    requestStartedAt,
    meta: options.meta,
  };

  const inFlight: ClientQueryInFlight = {
    coverage: requestedCoverage,
    requestStartedAt,
    staleVersionAtStart: entry.staleVersion,
    promise: Promise.resolve()
      .then(() => options.fetcher(context))
      .then(async (result) => {
        await options.applySnapshot?.(result, context);
        entry.coverage = mergeCoverage(entry.coverage, requestedCoverage);
        entry.fetchedAt = Date.now();
        entry.requestStartedAt = Math.max(
          entry.requestStartedAt ?? Number.NEGATIVE_INFINITY,
          requestStartedAt,
        );
        entry.error = undefined;
        if (entry.staleVersion === inFlight.staleVersionAtStart) {
          entry.stale = false;
        }
      })
      .catch((error: unknown) => {
        entry.error = error instanceof Error ? error : new Error(String(error));
        throw error;
      })
      .finally(() => {
        entry.inFlights.delete(inFlight);
        emitChange();
      }),
  };

  entry.inFlights.add(inFlight);
  emitChange();
  return inFlight.promise;
}

export function retainClientQuery(
  options: RetainClientQueryOptions,
): () => void {
  const key = createClientQueryKey(options.key);
  const entry = getOrCreateEntry(options.sourceKey, key);
  entry.retainedCount += 1;
  emitChange();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.retainedCount = Math.max(0, entry.retainedCount - 1);
    emitChange();
  };
}

export function getClientQueryState(
  sourceKey: ClientSummarySourceKey,
  key: ClientQueryKey | unknown,
): ClientQueryState | undefined {
  const normalizedKey = createClientQueryKey(key);
  const entry = entries.get(getEntryMapKey(sourceKey, normalizedKey));
  return entry ? toState(entry) : undefined;
}

export function getClientQueryStates(): ClientQueryState[] {
  return Array.from(entries.values(), toState);
}

export function invalidateClientQuery(
  sourceKey: ClientSummarySourceKey,
  key: ClientQueryKey | unknown,
): void {
  const normalizedKey = createClientQueryKey(key);
  const entry = entries.get(getEntryMapKey(sourceKey, normalizedKey));
  if (!entry) {
    return;
  }
  entry.staleVersion += 1;
  if (entry.stale) {
    return;
  }
  entry.stale = true;
  emitChange();
}

export function invalidateClientQueries(
  predicate: (state: ClientQueryState) => boolean,
): void {
  let changed = false;
  for (const entry of entries.values()) {
    if (predicate(toState(entry))) {
      entry.staleVersion += 1;
      if (!entry.stale) {
        entry.stale = true;
        changed = true;
      }
    }
  }
  if (changed) {
    emitChange();
  }
}

export function resetClientQueryControllerForTests(): void {
  entries.clear();
  listeners.clear();
}
