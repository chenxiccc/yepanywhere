import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  clearDefaultSessionDetailMemoryCache,
  clearDefaultSessionDetailMemoryCacheScrollSnapshots,
  configureSessionDetailRetention,
  evictExpiredDefaultSessionDetailMemoryCache,
} from "../lib/sessionDetail/sessionDetailStore";
import {
  DEFAULT_SESSION_SCROLL_BEHAVIOR_MODE,
  parseSessionScrollBehaviorMode,
  shouldRetainSessionScrollMemory,
  type SessionScrollBehaviorMode,
} from "../lib/sessionScrollBehavior";
import {
  createLocalStorageBoolean,
  createLocalStorageValue,
} from "../lib/localStorageValue";
import { UI_KEYS } from "../lib/storageKeys";

const DEFAULT_SESSION_DOM_LINGER_ENABLED = false;
const DEFAULT_SESSION_OFFSCREEN_TRANSCRIPT_RENDERING_ENABLED = false;
const DEFAULT_SESSION_ACTIVE_WINDOW_TRIM_ENABLED = true;

/** Budget 0 disables the cache (matching the old default-off toggle). */
const DEFAULT_TRANSCRIPT_CACHE_BUDGET_MB = 0;
/** Budget seeded when only the legacy boolean toggle was enabled;
 * matches the byte cap that toggle governed. */
const LEGACY_ENABLED_BUDGET_MB = 24;
const DEFAULT_TRANSCRIPT_CACHE_TTL_HOURS = 1;

export const TRANSCRIPT_CACHE_BUDGET_MB_STOPS = [
  0, 8, 16, 24, 32, 48, 64, 96, 128, 192, 256,
] as const;
export const TRANSCRIPT_CACHE_TTL_HOUR_STOPS = [1, 4, 12, 24, 72, 168] as const;

/** Placeholder when no session size has been recorded yet; roughly a
 * typical recent transcript per the 2026-07 charge calibration
 * (see sessionDetail/transcriptCharge.ts). */
export const TYPICAL_SESSION_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

const sessionDomLingerStore = createLocalStorageBoolean(
  UI_KEYS.sessionDomLinger,
  DEFAULT_SESSION_DOM_LINGER_ENABLED,
);
const sessionTranscriptCacheBudgetMbStore = createLocalStorageValue(
  UI_KEYS.sessionTranscriptCacheBudgetMb,
  DEFAULT_TRANSCRIPT_CACHE_BUDGET_MB,
  (raw) => {
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  },
  String,
  {
    relatedKeys: [UI_KEYS.sessionTranscriptCache],
    readFallback: (storage) =>
      storage.getItem(UI_KEYS.sessionTranscriptCache) === "true"
        ? LEGACY_ENABLED_BUDGET_MB
        : DEFAULT_TRANSCRIPT_CACHE_BUDGET_MB,
  },
);
const sessionTranscriptCacheTtlHoursStore = createLocalStorageValue(
  UI_KEYS.sessionTranscriptCacheTtlHours,
  DEFAULT_TRANSCRIPT_CACHE_TTL_HOURS,
  (raw) => {
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  },
);
const sessionScrollBehaviorStore =
  createLocalStorageValue<SessionScrollBehaviorMode>(
    UI_KEYS.sessionScrollBehavior,
    DEFAULT_SESSION_SCROLL_BEHAVIOR_MODE,
    parseSessionScrollBehaviorMode,
  );
const sessionOffscreenTranscriptRenderingStore = createLocalStorageBoolean(
  UI_KEYS.sessionOffscreenTranscriptRendering,
  DEFAULT_SESSION_OFFSCREEN_TRANSCRIPT_RENDERING_ENABLED,
);
const sessionActiveWindowTrimStore = createLocalStorageBoolean(
  UI_KEYS.sessionActiveWindowTrim,
  DEFAULT_SESSION_ACTIVE_WINDOW_TRIM_ENABLED,
);
const performancePreferenceStores = [
  sessionDomLingerStore,
  sessionTranscriptCacheBudgetMbStore,
  sessionTranscriptCacheTtlHoursStore,
  sessionScrollBehaviorStore,
  sessionOffscreenTranscriptRenderingStore,
  sessionActiveWindowTrimStore,
] as const;

// Canonical home is the memory-cache facade so non-hook consumers (client
// telemetry) can sample the same stats; re-exported here for the settings
// surface.
export {
  getSessionTranscriptMemoryStats,
  type SessionTranscriptMemoryStats,
} from "../lib/sessionDetail/sessionDetailStore";

function getStorage(): Storage | null {
  if (
    typeof globalThis.localStorage === "undefined" ||
    typeof globalThis.localStorage.getItem !== "function"
  ) {
    return null;
  }
  return globalThis.localStorage;
}

function loadNonNegativeNumberPreference(key: string): number | null {
  const stored = getStorage()?.getItem(key);
  if (stored === null || stored === undefined) {
    return null;
  }
  const parsed = Number(stored);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function savePreference(key: string, value: string): void {
  const storage = getStorage();
  if (!storage || typeof storage.setItem !== "function") return;
  storage.setItem(key, value);
}

function subscribe(listener: () => void) {
  const unsubscribers = performancePreferenceStores.map((store) =>
    store.subscribe(listener),
  );
  return () => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  };
}

function getSnapshot() {
  return [
    getSessionDomLingerEnabled() ? "1" : "0",
    String(getSessionTranscriptCacheBudgetMb()),
    String(getSessionTranscriptCacheTtlHours()),
    getSessionScrollBehaviorMode(),
    getSessionOffscreenTranscriptRenderingEnabled() ? "1" : "0",
    getSessionActiveWindowTrimEnabled() ? "1" : "0",
  ].join(":");
}

function parseSnapshot(snapshot: string) {
  const [
    domLinger,
    budgetMb,
    ttlHours,
    scrollBehavior,
    offscreenTranscriptRendering,
    activeWindowTrim,
  ] = snapshot.split(":");
  const parsedBudget = Number(budgetMb);
  const parsedTtl = Number(ttlHours);
  const sessionTranscriptCacheBudgetMb = Number.isFinite(parsedBudget)
    ? parsedBudget
    : DEFAULT_TRANSCRIPT_CACHE_BUDGET_MB;
  return {
    sessionDomLingerEnabled: domLinger !== "0",
    sessionTranscriptCacheBudgetMb,
    sessionTranscriptCacheEnabled: sessionTranscriptCacheBudgetMb > 0,
    sessionTranscriptCacheTtlHours: Number.isFinite(parsedTtl)
      ? parsedTtl
      : DEFAULT_TRANSCRIPT_CACHE_TTL_HOURS,
    sessionScrollBehaviorMode: parseSessionScrollBehaviorMode(scrollBehavior),
    sessionOffscreenTranscriptRenderingEnabled:
      offscreenTranscriptRendering !== "0",
    sessionActiveWindowTrimEnabled: activeWindowTrim !== "0",
  };
}

export function getSessionDomLingerEnabled(): boolean {
  return sessionDomLingerStore.read();
}

export function getSessionTranscriptCacheBudgetMb(): number {
  return sessionTranscriptCacheBudgetMbStore.read();
}

export function getSessionTranscriptCacheTtlHours(): number {
  return sessionTranscriptCacheTtlHoursStore.read();
}

export function getSessionTranscriptCacheEnabled(): boolean {
  return getSessionTranscriptCacheBudgetMb() > 0;
}

export function getSessionScrollBehaviorMode(): SessionScrollBehaviorMode {
  return sessionScrollBehaviorStore.read();
}

export function getSessionOffscreenTranscriptRenderingEnabled(): boolean {
  return sessionOffscreenTranscriptRenderingStore.read();
}

export function getSessionActiveWindowTrimEnabled(): boolean {
  return sessionActiveWindowTrimStore.read();
}

function applySessionDetailRetentionPreferences(): void {
  const budgetMb = getSessionTranscriptCacheBudgetMb();
  configureSessionDetailRetention({
    // Budget is the sole size policy; no entry-count cap.
    maxEntries: Number.POSITIVE_INFINITY,
    // Off (budget 0) is enforced at the hook layer (no snapshot
    // reads/writes, delete at unmount), so keep a sane byte floor here
    // rather than a 0 cap that would reject unrelated store writes.
    maxBytes:
      (budgetMb > 0 ? budgetMb : LEGACY_ENABLED_BUDGET_MB) * 1024 * 1024,
    ttlMs: getSessionTranscriptCacheTtlHours() * 60 * 60 * 1000,
  });
}

// Retention is a non-React consumer and must follow both same-tab setters and
// cross-tab changes even when no settings/session component is mounted.
sessionTranscriptCacheBudgetMbStore.subscribe(
  applySessionDetailRetentionPreferences,
);
sessionTranscriptCacheTtlHoursStore.subscribe(
  applySessionDetailRetentionPreferences,
);

export function setSessionDomLingerPreference(enabled: boolean): void {
  sessionDomLingerStore.set(enabled);
}

export function setSessionOffscreenTranscriptRenderingPreference(
  enabled: boolean,
): void {
  sessionOffscreenTranscriptRenderingStore.set(enabled);
}

export function setSessionActiveWindowTrimPreference(enabled: boolean): void {
  sessionActiveWindowTrimStore.set(enabled);
}

export function setSessionTranscriptCacheBudgetMbPreference(
  budgetMb: number,
): void {
  const normalized = Number.isFinite(budgetMb) ? Math.max(0, budgetMb) : 0;
  sessionTranscriptCacheBudgetMbStore.set(normalized);
  // Keep the legacy boolean coherent for older bundles reading it.
  savePreference(UI_KEYS.sessionTranscriptCache, String(normalized > 0));
  if (normalized <= 0) {
    clearDefaultSessionDetailMemoryCache();
  }
}

export function setSessionTranscriptCacheTtlHoursPreference(
  ttlHours: number,
): void {
  const normalized =
    Number.isFinite(ttlHours) && ttlHours > 0
      ? ttlHours
      : DEFAULT_TRANSCRIPT_CACHE_TTL_HOURS;
  sessionTranscriptCacheTtlHoursStore.set(normalized);
}

export function setSessionScrollBehaviorModePreference(
  mode: SessionScrollBehaviorMode,
): void {
  const normalized = parseSessionScrollBehaviorMode(mode);
  sessionScrollBehaviorStore.set(normalized);
  if (!shouldRetainSessionScrollMemory(normalized)) {
    clearDefaultSessionDetailMemoryCacheScrollSnapshots();
  }
}

/**
 * Most recent measured transcript size at session leave; feeds the
 * budget slider's "sessions like your last" hint.
 */
export function recordLastSessionTranscriptBytes(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return;
  }
  savePreference(UI_KEYS.sessionLastTranscriptBytes, String(Math.round(bytes)));
}

export function getLastSessionTranscriptBytes(): number | null {
  const stored = loadNonNegativeNumberPreference(
    UI_KEYS.sessionLastTranscriptBytes,
  );
  return stored !== null && stored > 0 ? stored : null;
}

// TTL eviction otherwise only runs when something calls into the store,
// so an idle background tab would keep its cache past expiry. A
// low-frequency sweep (browser-throttled when backgrounded) reclaims it.
const SWEEP_INTERVAL_MS = 60 * 1000;

if (typeof window !== "undefined") {
  applySessionDetailRetentionPreferences();
  if (import.meta.env.MODE !== "test") {
    window.setInterval(() => {
      evictExpiredDefaultSessionDetailMemoryCache();
    }, SWEEP_INTERVAL_MS);
  }
}

export function useSessionPerformanceSettings() {
  const snapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => `0:0:1:${DEFAULT_SESSION_SCROLL_BEHAVIOR_MODE}:1:1`,
  );
  const settings = useMemo(() => parseSnapshot(snapshot), [snapshot]);

  const setSessionDomLingerEnabled = useCallback(
    setSessionDomLingerPreference,
    [],
  );
  const setSessionTranscriptCacheBudgetMb = useCallback(
    setSessionTranscriptCacheBudgetMbPreference,
    [],
  );
  const setSessionTranscriptCacheTtlHours = useCallback(
    setSessionTranscriptCacheTtlHoursPreference,
    [],
  );
  const setSessionScrollBehaviorMode = useCallback(
    setSessionScrollBehaviorModePreference,
    [],
  );
  const setSessionOffscreenTranscriptRenderingEnabled = useCallback(
    setSessionOffscreenTranscriptRenderingPreference,
    [],
  );
  const setSessionActiveWindowTrimEnabled = useCallback(
    setSessionActiveWindowTrimPreference,
    [],
  );

  return {
    ...settings,
    setSessionDomLingerEnabled,
    setSessionTranscriptCacheBudgetMb,
    setSessionTranscriptCacheTtlHours,
    setSessionScrollBehaviorMode,
    setSessionOffscreenTranscriptRenderingEnabled,
    setSessionActiveWindowTrimEnabled,
  };
}
