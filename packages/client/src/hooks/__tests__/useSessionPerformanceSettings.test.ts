// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asClientSummarySourceKey } from "../../lib/clientSummaryStore";
import { invalidateLocalStorageValues } from "../../lib/localStorageValue";
import {
  defaultSessionDetailMemoryCache,
  getSessionDetailRetentionDefaults,
} from "../../lib/sessionDetail/sessionDetailStore";
import type { SessionRouteSnapshot } from "../../lib/sessionRouteSnapshots";
import {
  readSessionScrollMemory,
  writeSessionScrollMemory,
} from "../../lib/sessionScrollMemoryStorage";
import { UI_KEYS } from "../../lib/storageKeys";
import {
  getLastSessionTranscriptBytes,
  getSessionActiveWindowTrimEnabled,
  getSessionScrollBehaviorMode,
  getSessionDomLingerEnabled,
  getSessionTranscriptMemoryStats,
  getSessionTranscriptCacheBudgetMb,
  getSessionTranscriptCacheEnabled,
  getSessionTranscriptCacheTtlHours,
  recordLastSessionTranscriptBytes,
  useSessionPerformanceSettings,
} from "../useSessionPerformanceSettings";

const SOURCE = asClientSummarySourceKey("host:a");
const PROJECT_ID = toUrlProjectId("/repo/project-a");

function snapshot(): SessionRouteSnapshot {
  return {
    messages: [
      {
        uuid: "msg-1",
        type: "user",
        timestamp: "2026-07-01T00:00:00.000Z",
        message: { role: "user", content: "hello" },
      },
    ],
    session: {
      id: "session-a",
      projectId: PROJECT_ID,
      provider: "claude",
      title: "Session A",
      fullTitle: "Session A",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      messageCount: 1,
      ownership: { owner: "none" },
    },
    agentContent: {},
    toolUseToAgentEntries: [],
    lastMessageId: "msg-1",
    maxPersistedTimestampMs: 0,
  };
}

describe("useSessionPerformanceSettings", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size;
      },
      clear: () => {
        storage.clear();
      },
    });
    defaultSessionDetailMemoryCache.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    defaultSessionDetailMemoryCache.clear();
  });

  it("defaults to dom-linger off and transcript cache off with a 1h TTL", () => {
    const { result } = renderHook(() => useSessionPerformanceSettings());

    expect(result.current.sessionDomLingerEnabled).toBe(false);
    expect(result.current.sessionTranscriptCacheBudgetMb).toBe(0);
    expect(result.current.sessionTranscriptCacheEnabled).toBe(false);
    expect(result.current.sessionTranscriptCacheTtlHours).toBe(1);
    expect(result.current.sessionScrollBehaviorMode).toBe("live-tail");
    expect(result.current.sessionActiveWindowTrimEnabled).toBe(true);
    expect(getSessionDomLingerEnabled()).toBe(false);
    expect(getSessionTranscriptCacheEnabled()).toBe(false);
    expect(getSessionTranscriptCacheBudgetMb()).toBe(0);
    expect(getSessionTranscriptCacheTtlHours()).toBe(1);
    expect(getSessionScrollBehaviorMode()).toBe("live-tail");
    expect(getSessionActiveWindowTrimEnabled()).toBe(true);
  });

  it("persists and publishes an explicit active-window trim opt-out", () => {
    const { result: first } = renderHook(() => useSessionPerformanceSettings());
    const { result: second } = renderHook(() =>
      useSessionPerformanceSettings(),
    );

    act(() => {
      first.current.setSessionActiveWindowTrimEnabled(false);
    });

    expect(first.current.sessionActiveWindowTrimEnabled).toBe(false);
    expect(second.current.sessionActiveWindowTrimEnabled).toBe(false);
    expect(getSessionActiveWindowTrimEnabled()).toBe(false);
    expect(localStorage.getItem(UI_KEYS.sessionActiveWindowTrim)).toBe("false");
  });

  it("updates active-window trim from another tab's storage event", () => {
    const { result } = renderHook(() => useSessionPerformanceSettings());
    expect(result.current.sessionActiveWindowTrimEnabled).toBe(true);

    localStorage.setItem(UI_KEYS.sessionActiveWindowTrim, "false");
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: UI_KEYS.sessionActiveWindowTrim,
          newValue: "false",
        }),
      );
    });

    expect(result.current.sessionActiveWindowTrimEnabled).toBe(false);
  });

  it("seeds the budget from the legacy boolean toggle", () => {
    localStorage.setItem(UI_KEYS.sessionTranscriptCache, "true");
    invalidateLocalStorageValues(UI_KEYS.sessionTranscriptCache);
    expect(getSessionTranscriptCacheBudgetMb()).toBe(24);
    expect(getSessionTranscriptCacheEnabled()).toBe(true);

    localStorage.setItem(UI_KEYS.sessionTranscriptCache, "false");
    invalidateLocalStorageValues(UI_KEYS.sessionTranscriptCache);
    expect(getSessionTranscriptCacheBudgetMb()).toBe(0);
    expect(getSessionTranscriptCacheEnabled()).toBe(false);

    // An explicit budget wins over the legacy toggle.
    localStorage.setItem(UI_KEYS.sessionTranscriptCache, "true");
    localStorage.setItem(UI_KEYS.sessionTranscriptCacheBudgetMb, "64");
    invalidateLocalStorageValues(UI_KEYS.sessionTranscriptCacheBudgetMb);
    expect(getSessionTranscriptCacheBudgetMb()).toBe(64);
  });

  it("persists and publishes budget and TTL updates", () => {
    const { result: first } = renderHook(() => useSessionPerformanceSettings());
    const { result: second } = renderHook(() =>
      useSessionPerformanceSettings(),
    );

    act(() => {
      first.current.setSessionTranscriptCacheBudgetMb(48);
      first.current.setSessionTranscriptCacheTtlHours(24);
    });

    expect(first.current.sessionTranscriptCacheBudgetMb).toBe(48);
    expect(first.current.sessionTranscriptCacheEnabled).toBe(true);
    expect(first.current.sessionTranscriptCacheTtlHours).toBe(24);
    expect(second.current.sessionTranscriptCacheBudgetMb).toBe(48);
    expect(second.current.sessionTranscriptCacheTtlHours).toBe(24);
    expect(localStorage.getItem(UI_KEYS.sessionTranscriptCacheBudgetMb)).toBe(
      "48",
    );
    expect(localStorage.getItem(UI_KEYS.sessionTranscriptCacheTtlHours)).toBe(
      "24",
    );
    // Legacy boolean stays coherent for older bundles.
    expect(localStorage.getItem(UI_KEYS.sessionTranscriptCache)).toBe("true");
  });

  it("configures store retention from the sliders with no entry cap", () => {
    const { result } = renderHook(() => useSessionPerformanceSettings());

    act(() => {
      result.current.setSessionTranscriptCacheBudgetMb(48);
      result.current.setSessionTranscriptCacheTtlHours(24);
    });

    const defaults = getSessionDetailRetentionDefaults();
    expect(defaults.maxEntries).toBe(Number.POSITIVE_INFINITY);
    expect(defaults.maxBytes).toBe(48 * 1024 * 1024);
    expect(defaults.ttlMs).toBe(24 * 60 * 60 * 1000);
  });

  it("clears retained session snapshots when the budget is set to zero", () => {
    const key = {
      sourceKey: SOURCE,
      projectId: PROJECT_ID,
      sessionId: "session-a",
    };
    const { result } = renderHook(() => useSessionPerformanceSettings());
    act(() => {
      result.current.setSessionTranscriptCacheBudgetMb(24);
    });
    defaultSessionDetailMemoryCache.writeRouteSnapshot(key, snapshot());
    expect(
      defaultSessionDetailMemoryCache.readRouteSnapshot(key),
    ).toBeDefined();

    act(() => {
      result.current.setSessionTranscriptCacheBudgetMb(0);
    });

    expect(
      defaultSessionDetailMemoryCache.readRouteSnapshot(key),
    ).toBeUndefined();
    expect(localStorage.getItem(UI_KEYS.sessionTranscriptCache)).toBe("false");
  });

  it("records and reads the last session transcript size", () => {
    expect(getLastSessionTranscriptBytes()).toBeNull();
    recordLastSessionTranscriptBytes(1_500_000);
    expect(getLastSessionTranscriptBytes()).toBe(1_500_000);
    recordLastSessionTranscriptBytes(0);
    expect(getLastSessionTranscriptBytes()).toBe(1_500_000);
  });

  it("reports live retained and warm transcript memory separately", () => {
    const warmKey = {
      sourceKey: SOURCE,
      projectId: PROJECT_ID,
      sessionId: "session-a",
    };
    const liveKey = {
      ...warmKey,
      tailFrom: "msg-1",
    };

    defaultSessionDetailMemoryCache.writeRouteSnapshot(warmKey, snapshot());
    defaultSessionDetailMemoryCache.writeRouteSnapshot(liveKey, snapshot());
    const release = defaultSessionDetailMemoryCache.retain(liveKey);

    const stats = getSessionTranscriptMemoryStats();
    expect(stats.totalBytes).toBeGreaterThan(0);
    expect(stats.liveRetainedEntryCount).toBe(1);
    expect(stats.liveRetainedBytes).toBeGreaterThan(0);
    expect(stats.warmCacheEntryCount).toBe(1);
    expect(stats.warmCacheBytes).toBeGreaterThan(0);

    release();
  });

  it("persists scroll behavior mode and clears only scroll memory when disabled", () => {
    const storeKey = {
      sourceKey: SOURCE,
      projectId: PROJECT_ID,
      sessionId: "session-a",
    };
    const { result } = renderHook(() => useSessionPerformanceSettings());

    act(() => {
      result.current.setSessionScrollBehaviorMode("remember-place");
    });

    expect(result.current.sessionScrollBehaviorMode).toBe("remember-place");
    expect(localStorage.getItem(UI_KEYS.sessionScrollBehavior)).toBe(
      "remember-place",
    );
    expect(getSessionScrollBehaviorMode()).toBe("remember-place");

    defaultSessionDetailMemoryCache.writeRouteSnapshot(storeKey, {
      ...snapshot(),
      scrollSnapshot: {
        atBottom: true,
        scrollTop: 120,
        scrollHeight: 800,
        clientHeight: 400,
        updatedAtMs: 10,
      },
    });
    expect(
      defaultSessionDetailMemoryCache.readRouteSnapshot(storeKey),
    ).toBeDefined();
    expect(
      defaultSessionDetailMemoryCache.readScrollSnapshot(storeKey),
    ).toBeDefined();
    writeSessionScrollMemory(storeKey, {
      atBottom: true,
      scrollTop: 400,
      scrollHeight: 800,
      clientHeight: 400,
      completedTurn: { id: "turn-1", timestampMs: 20 },
      following: true,
      updatedAtMs: 20,
    });
    expect(readSessionScrollMemory(storeKey)).not.toBeNull();

    act(() => {
      result.current.setSessionScrollBehaviorMode("no-memory");
    });

    expect(result.current.sessionScrollBehaviorMode).toBe("no-memory");
    expect(
      defaultSessionDetailMemoryCache.readRouteSnapshot(storeKey),
    ).toBeDefined();
    expect(
      defaultSessionDetailMemoryCache.readRouteSnapshot(storeKey)
        ?.scrollSnapshot,
    ).toBeUndefined();
    expect(
      defaultSessionDetailMemoryCache.readScrollSnapshot(storeKey),
    ).toBeUndefined();
    expect(readSessionScrollMemory(storeKey)).toBeNull();
  });

  it("migrates the retired manual-follow value to remember-place", () => {
    localStorage.setItem(UI_KEYS.sessionScrollBehavior, "manual-follow");
    invalidateLocalStorageValues(UI_KEYS.sessionScrollBehavior);

    const { result } = renderHook(() => useSessionPerformanceSettings());

    expect(result.current.sessionScrollBehaviorMode).toBe("remember-place");
    expect(getSessionScrollBehaviorMode()).toBe("remember-place");
  });
});
