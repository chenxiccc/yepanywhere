import { useCallback, useEffect, useState } from "react";
import { type ServerSettings, api } from "../api/client";
import { useBackgroundRevalidation } from "./useBackgroundRevalidation";

interface UseServerSettingsResult {
  settings: ServerSettings | null;
  isLoading: boolean;
  error: string | null;
  updateSettings: (updates: Partial<ServerSettings>) => Promise<void>;
  updateSetting: <K extends keyof ServerSettings>(
    key: K,
    value: ServerSettings[K],
  ) => Promise<void>;
  refetch: () => Promise<void>;
}

// [ya-private] Persisted cache of the most recent settings. Lives in
// localStorage so it survives a full page reload / PWA restart, not just
// SPA route changes (the module-level variable alone is lost on reload).
// This lets the session cache adapter be REAL from the very first render
// after a refresh, avoiding a NOOP cold-load of the full session tail.
// Settings are small (a few KB of boolean flags), well within localStorage
// quotas. The refetch still runs to keep it fresh; if the stored value is
// stale, the worst case is one transient cold load after it corrects.
// [ya-private] 最近设置的持久化缓存。存于 localStorage，使其在整页刷新 /
// PWA 重启后仍存活（仅靠模块级变量在刷新时会丢失）。这让会话缓存适配器在
// 刷新后首帧即为 REAL，避免 NOOP 全量尾部冷加载。settings 很小（几 KB 布尔
// 标志），远在 localStorage 配额内。后台仍会重新拉取以保持新鲜；若存储值
// 过期，最坏情况是纠正后一次短暂的冷加载。
const SETTINGS_LS_KEY = "yep-server-settings";

function readCachedSettings(): ServerSettings | null {
  // Module-level variable (fast path, avoids JSON.parse on every hook call).
  // 模块级变量（快路径，避免每次 hook 调用都 JSON.parse）。
  if (cachedSettings !== null) return cachedSettings;
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(SETTINGS_LS_KEY);
    if (raw) {
      cachedSettings = JSON.parse(raw) as ServerSettings;
      return cachedSettings;
    }
  } catch {
    // localStorage may be unavailable (private mode) or corrupt — fall back
    // to null (cold path), same as no cache.
    // localStorage 可能不可用（隐私模式）或损坏 —— 回退 null（冷路径）。
  }
  return null;
}

function writeCachedSettings(settings: ServerSettings): void {
  cachedSettings = settings;
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SETTINGS_LS_KEY, JSON.stringify(settings));
  } catch {
    // Quota or private mode — the module-level cache still works for SPA
    // navigation; only the cross-reload persistence is lost.
    // 配额或隐私模式 —— 模块级缓存仍可用于 SPA 导航；
    // 仅跨刷新的持久化丢失。
  }
}

let cachedSettings: ServerSettings | null = readCachedSettings();

/**
 * Hook for managing server-wide settings.
 * Fetches settings on mount and provides update functionality.
 * Uses a persisted cache (localStorage + module variable) so remounts and
 * page reloads start from the last-known settings instead of null, avoiding
 * a transient NOOP window for the session cache adapter.
 */
export function useServerSettings(): UseServerSettingsResult {
  // Initialize from the persisted cache so a remount or page reload starts
  // with the last-known settings rather than null.
  // 从持久化缓存初始化，使重挂载或页面刷新以上次的 settings 起步而非 null。
  const [settings, setSettings] = useState<ServerSettings | null>(
    cachedSettings,
  );
  // Loading only when we have no cached value yet; a remount with cached
  // settings is not "loading" from the user's perspective.
  // 仅在尚无缓存值时为 loading；有缓存的重挂载对用户而言不是"加载中"。
  const [isLoading, setIsLoading] = useState(cachedSettings === null);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const response = await api.getServerSettings();
      writeCachedSettings(response.settings);
      setSettings(response.settings);
    } catch (err) {
      console.error("[useServerSettings] Failed to fetch settings:", err);
      setError(err instanceof Error ? err.message : "Failed to load settings");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  // Quietly refresh settings when the connection re-establishes.
  useBackgroundRevalidation({
    fetcher: () => api.getServerSettings().then((r) => r.settings),
    current: settings,
    apply: (next) => {
      setSettings(next);
      setError(null);
    },
  });

  const updateSettings = useCallback(
    async (updates: Partial<ServerSettings>): Promise<void> => {
      try {
        setError(null);
        const response = await api.updateServerSettings(updates);
        writeCachedSettings(response.settings);
        setSettings(response.settings);
      } catch (err) {
        console.error("[useServerSettings] Failed to update settings:", err);
        setError(
          err instanceof Error ? err.message : "Failed to update settings",
        );
        throw err;
      }
    },
    [],
  );

  const updateSetting = useCallback(
    async <K extends keyof ServerSettings>(
      key: K,
      value: ServerSettings[K],
    ): Promise<void> => {
      await updateSettings({ [key]: value });
    },
    [updateSettings],
  );

  return {
    settings,
    isLoading,
    error,
    updateSettings,
    updateSetting,
    refetch: fetchSettings,
  };
}
