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

// [ya-private] Module-level cache of the most recent settings. Each component
// that calls useServerSettings remounts on session switch (SessionPageContent
// has key={sessionId}), and without this cache the hook would start from null
// on every remount -- which made the session cache adapter briefly NOOP until
// the settings refetch resolved, firing a redundant full-tail cold load.
// With the cache, a remount initializes settings to the last-known value, so
// the adapter is REAL from the very first render and no NOOP cold load fires.
// The refetch still runs in the background to keep the cache fresh.
// [ya-private] 最近一次设置的模块级缓存。每个调用 useServerSettings 的组件在
// 切换会话时都会重挂载（SessionPageContent 带 key={sessionId}），若无此缓存，
// hook 每次重挂载都从 null 起步 —— 这会让会话缓存适配器在 settings 重新拉取
// 解析前短暂为 NOOP，从而触发一次冗余的全量尾部冷加载。有了缓存，重挂载时
// settings 直接用上次的值初始化，适配器从首帧起即为 REAL，不会发 NOOP 冷加载。
// 后台仍会重新拉取以保持缓存新鲜。
let cachedSettings: ServerSettings | null = null;

/**
 * Hook for managing server-wide settings.
 * Fetches settings on mount and provides update functionality.
 * Uses a module-level cache so remounts start from the last-known settings
 * instead of null, avoiding a transient NOOP window for the session cache.
 */
export function useServerSettings(): UseServerSettingsResult {
  // Initialize from the module cache so a remount (e.g. session switch) starts
  // with the last-known settings rather than null.
  // 从模块缓存初始化，使重挂载（如切换会话）以上次的 settings 起步而非 null。
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
      cachedSettings = response.settings;
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
        cachedSettings = response.settings;
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
