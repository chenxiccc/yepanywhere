import type { ClientSummarySourceKey } from "./clientSummaryStore";

export type RouteRetentionParamValue =
  | string
  | number
  | boolean
  | null
  | undefined;

export type RouteRetentionParamMap = Record<
  string,
  RouteRetentionParamValue | RouteRetentionParamValue[]
>;

export interface RouteRetentionKeyInput {
  sourceKey: ClientSummarySourceKey;
  routeId: string;
  projectId?: string | null;
  routeParams?: RouteRetentionParamMap;
  queryParams?: RouteRetentionParamMap | URLSearchParams;
}

export interface RouteRetentionOptions {
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  approxBytes?: number;
  nowMs?: number;
  touch?: boolean;
  recordDiagnostics?: boolean;
}

export interface RouteRetentionReadResult<T> {
  value: T | null;
  missReason?: RouteRetentionMissReason;
}

export type RouteRetentionMissReason =
  | "missing"
  | "expired"
  | "source-mismatch"
  | "route-mismatch";

export interface RouteRetentionDiagnosticEntry {
  key: string;
  sourceKey: string;
  routeId: string;
  projectId: string | null;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  expiresAt: number;
  approxBytes: number;
}

export interface RouteRetentionDiagnosticEvent {
  type: "hit" | "miss" | "write" | "patch" | "invalidate" | "evict";
  key: string;
  sourceKey: string;
  routeId: string;
  projectId: string | null;
  at: number;
  reason?: string;
  approxBytes?: number;
}

export interface RouteRetentionDiagnostics {
  entries: RouteRetentionDiagnosticEntry[];
  events: RouteRetentionDiagnosticEvent[];
  totalBytes: number;
}

interface NormalizedRouteRetentionKey {
  key: string;
  sourceKey: ClientSummarySourceKey;
  routeId: string;
  projectId: string | null;
}

interface RouteRetentionEntry<T = unknown> extends NormalizedRouteRetentionKey {
  value: T;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  expiresAt: number;
  approxBytes: number;
}

interface RouteRetentionDeveloperApi {
  entries: () => RouteRetentionDiagnosticEntry[];
  events: () => RouteRetentionDiagnosticEvent[];
  diagnostics: () => RouteRetentionDiagnostics;
  clear: () => void;
  invalidate: (key: RouteRetentionKeyInput) => void;
}

declare global {
  interface Window {
    __YA_ROUTE_RETENTION__?: RouteRetentionDeveloperApi;
  }
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_EVENTS = 100;

const entries = new Map<string, RouteRetentionEntry>();
const listeners = new Set<() => void>();
const diagnosticEvents: RouteRetentionDiagnosticEvent[] = [];

function now(options?: Pick<RouteRetentionOptions, "nowMs">): number {
  return options?.nowMs ?? Date.now();
}

function normalizeParamValue(
  value: RouteRetentionParamValue | RouteRetentionParamValue[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeParamValue(item));
  }
  return value ?? null;
}

function normalizeParams(
  params: RouteRetentionParamMap | URLSearchParams | undefined,
): Record<string, unknown> {
  if (!params) {
    return {};
  }
  if (params instanceof URLSearchParams) {
    const normalized: Record<string, string | string[]> = {};
    for (const key of Array.from(new Set(params.keys())).sort()) {
      const values = params.getAll(key);
      normalized[key] = values.length > 1 ? values : (values[0] ?? "");
    }
    return normalized;
  }

  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(params).sort()) {
    normalized[key] = normalizeParamValue(params[key]);
  }
  return normalized;
}

function stableSerialize(value: unknown): string {
  if (value === undefined) {
    return "undefined";
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

export function createRouteRetentionKey(
  input: RouteRetentionKeyInput,
): NormalizedRouteRetentionKey {
  const projectId = input.projectId ?? null;
  const key = stableSerialize({
    sourceKey: input.sourceKey,
    routeId: input.routeId,
    projectId,
    routeParams: normalizeParams(input.routeParams),
    queryParams: normalizeParams(input.queryParams),
  });
  return {
    key,
    sourceKey: input.sourceKey,
    routeId: input.routeId,
    projectId,
  };
}

function estimateBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function emitChange(): void {
  for (const listener of Array.from(listeners)) {
    listener();
  }
}

function toDiagnosticEntry(
  entry: RouteRetentionEntry,
): RouteRetentionDiagnosticEntry {
  return {
    key: entry.key,
    sourceKey: entry.sourceKey,
    routeId: entry.routeId,
    projectId: entry.projectId,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    lastAccessedAt: entry.lastAccessedAt,
    expiresAt: entry.expiresAt,
    approxBytes: entry.approxBytes,
  };
}

function publishDeveloperApi(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.__YA_ROUTE_RETENTION__ = {
    entries: () => getRouteRetentionDiagnostics().entries,
    events: () => getRouteRetentionDiagnostics().events,
    diagnostics: getRouteRetentionDiagnostics,
    clear: clearRouteRetention,
    invalidate: invalidateRouteRetention,
  };
}

function recordEvent(
  event: RouteRetentionDiagnosticEvent,
  options: { emit?: boolean } = {},
): void {
  diagnosticEvents.push(event);
  while (diagnosticEvents.length > MAX_DIAGNOSTIC_EVENTS) {
    diagnosticEvents.shift();
  }
  publishDeveloperApi();
  if (options.emit) {
    emitChange();
  }
}

function deleteEntry(
  key: string,
  reason: string,
  at: number,
  emit = true,
): void {
  const entry = entries.get(key);
  if (!entry) {
    return;
  }
  entries.delete(key);
  recordEvent(
    {
      type: reason === "invalidate" ? "invalidate" : "evict",
      key: entry.key,
      sourceKey: entry.sourceKey,
      routeId: entry.routeId,
      projectId: entry.projectId,
      at,
      reason,
      approxBytes: entry.approxBytes,
    },
    { emit },
  );
}

function pruneExpired(at: number): void {
  for (const entry of Array.from(entries.values())) {
    if (entry.expiresAt <= at) {
      deleteEntry(entry.key, "expired", at, false);
    }
  }
}

function getTotalBytes(): number {
  let total = 0;
  for (const entry of entries.values()) {
    total += entry.approxBytes;
  }
  return total;
}

function enforceLimits(options: RouteRetentionOptions, at: number): void {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  while (entries.size > maxEntries || getTotalBytes() > maxBytes) {
    const oldest = Array.from(entries.values()).sort((left, right) => {
      if (left.lastAccessedAt !== right.lastAccessedAt) {
        return left.lastAccessedAt - right.lastAccessedAt;
      }
      return left.updatedAt - right.updatedAt;
    })[0];
    if (!oldest) {
      break;
    }
    deleteEntry(oldest.key, "lru", at, false);
  }
}

export function subscribeRouteRetention(listener: () => void): () => void {
  listeners.add(listener);
  publishDeveloperApi();
  return () => {
    listeners.delete(listener);
  };
}

export function readRouteRetentionResult<T>(
  input: RouteRetentionKeyInput,
  options: RouteRetentionOptions = {},
): RouteRetentionReadResult<T> {
  const at = now(options);
  const normalizedKey = createRouteRetentionKey(input);
  const entry = entries.get(normalizedKey.key);
  const recordDiagnostics = options.recordDiagnostics ?? true;

  if (!entry) {
    if (recordDiagnostics) {
      recordEvent({
        type: "miss",
        key: normalizedKey.key,
        sourceKey: normalizedKey.sourceKey,
        routeId: normalizedKey.routeId,
        projectId: normalizedKey.projectId,
        at,
        reason: "missing",
      });
    }
    return { value: null, missReason: "missing" };
  }

  if (entry.expiresAt <= at) {
    if (options.touch === false && !recordDiagnostics) {
      // `useSyncExternalStore` snapshot readers use this quiet form. React may
      // call them during render, so observing expiry must not mutate the store
      // or synchronously notify another mounted subscriber. Ordinary reads and
      // the next write still reclaim the expired entry.
      return { value: null, missReason: "expired" };
    }
    deleteEntry(entry.key, "expired", at);
    if (recordDiagnostics) {
      recordEvent({
        type: "miss",
        key: normalizedKey.key,
        sourceKey: normalizedKey.sourceKey,
        routeId: normalizedKey.routeId,
        projectId: normalizedKey.projectId,
        at,
        reason: "expired",
      });
    }
    return { value: null, missReason: "expired" };
  }

  if (options.touch !== false) {
    entry.lastAccessedAt = at;
  }
  if (recordDiagnostics) {
    recordEvent({
      type: "hit",
      key: entry.key,
      sourceKey: entry.sourceKey,
      routeId: entry.routeId,
      projectId: entry.projectId,
      at,
      approxBytes: entry.approxBytes,
    });
  }
  return { value: entry.value as T };
}

export function readRouteRetention<T>(
  input: RouteRetentionKeyInput,
  options?: RouteRetentionOptions,
): T | null {
  return readRouteRetentionResult<T>(input, options).value;
}

export function writeRouteRetention<T>(
  input: RouteRetentionKeyInput,
  value: T,
  options: RouteRetentionOptions = {},
): void {
  const at = now(options);
  pruneExpired(at);

  const normalizedKey = createRouteRetentionKey(input);
  const existing = entries.get(normalizedKey.key);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const entry: RouteRetentionEntry<T> = {
    ...normalizedKey,
    value,
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
    lastAccessedAt: at,
    expiresAt: at + ttlMs,
    approxBytes: options.approxBytes ?? estimateBytes(value),
  };
  entries.set(normalizedKey.key, entry);
  enforceLimits(options, at);
  recordEvent(
    {
      type: "write",
      key: entry.key,
      sourceKey: entry.sourceKey,
      routeId: entry.routeId,
      projectId: entry.projectId,
      at,
      approxBytes: entry.approxBytes,
    },
    { emit: true },
  );
}

export function patchRouteRetention<T extends object>(
  input: RouteRetentionKeyInput,
  patch: Partial<T> | ((current: T | null) => T),
  options: RouteRetentionOptions = {},
): void {
  const current = readRouteRetention<T>(input, {
    ...options,
    touch: false,
    recordDiagnostics: false,
  });
  const next =
    typeof patch === "function"
      ? patch(current)
      : (Object.assign({}, current, patch) as T);
  writeRouteRetention(input, next, options);

  const normalizedKey = createRouteRetentionKey(input);
  recordEvent({
    type: "patch",
    key: normalizedKey.key,
    sourceKey: normalizedKey.sourceKey,
    routeId: normalizedKey.routeId,
    projectId: normalizedKey.projectId,
    at: now(options),
    approxBytes: options.approxBytes ?? estimateBytes(next),
  });
}

export function invalidateRouteRetention(input: RouteRetentionKeyInput): void {
  const at = Date.now();
  deleteEntry(createRouteRetentionKey(input).key, "invalidate", at);
}

export function invalidateRouteRetentionWhere(
  predicate: (entry: RouteRetentionDiagnosticEntry) => boolean,
): void {
  const at = Date.now();
  for (const entry of Array.from(entries.values())) {
    if (predicate(toDiagnosticEntry(entry))) {
      deleteEntry(entry.key, "invalidate", at, false);
    }
  }
  emitChange();
}

export function clearRouteRetentionForSource(
  sourceKey: ClientSummarySourceKey,
): void {
  invalidateRouteRetentionWhere((entry) => entry.sourceKey === sourceKey);
}

export function clearRouteRetention(): void {
  const at = Date.now();
  for (const entry of Array.from(entries.values())) {
    deleteEntry(entry.key, "invalidate", at, false);
  }
  emitChange();
}

export function getRouteRetentionDiagnostics(): RouteRetentionDiagnostics {
  const diagnosticEntries = Array.from(entries.values(), toDiagnosticEntry);
  return {
    entries: diagnosticEntries,
    events: [...diagnosticEvents],
    totalBytes: diagnosticEntries.reduce(
      (total, entry) => total + entry.approxBytes,
      0,
    ),
  };
}

export function resetRouteRetentionForTests(): void {
  entries.clear();
  diagnosticEvents.length = 0;
  listeners.clear();
  publishDeveloperApi();
}

publishDeveloperApi();
