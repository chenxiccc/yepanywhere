import { useCallback, useEffect, useState } from "react";
import { type WebhookPrivateConfig, api } from "../api/client";
import { useBackgroundRevalidation } from "./useBackgroundRevalidation";

interface UseWebhookPrivateConfigResult {
  config: WebhookPrivateConfig | null;
  isLoading: boolean;
  error: string | null;
  updateConfig: (updates: Partial<WebhookPrivateConfig>) => Promise<void>;
  testWebhook: () => Promise<{
    success: boolean;
    error?: string;
  }>;
  refetch: () => Promise<void>;
}

/**
 * 钉钉/飞书群机器人 webhook 配置 hook。
 * Hook for managing the DingTalk/Feishu group-bot webhook config.
 * 独立于 useServerSettings，打 /api/webhook-private。
 * Independent of useServerSettings; talks to /api/webhook-private.
 */
export function useWebhookPrivateConfig(): UseWebhookPrivateConfigResult {
  const [config, setConfig] = useState<WebhookPrivateConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchConfig = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const response = await api.getWebhookPrivateConfig();
      setConfig(response.config);
    } catch (err) {
      console.error(
        "[useWebhookPrivateConfig] Failed to fetch config:",
        err,
      );
      setError(err instanceof Error ? err.message : "Failed to load config");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // 连接恢复时静默刷新配置 / Quietly refresh config when the connection re-establishes
  useBackgroundRevalidation({
    fetcher: () => api.getWebhookPrivateConfig().then((r) => r.config),
    current: config,
    apply: (next) => {
      setConfig(next);
      setError(null);
    },
  });

  const updateConfig = useCallback(
    async (updates: Partial<WebhookPrivateConfig>): Promise<void> => {
      try {
        setError(null);
        const response = await api.updateWebhookPrivateConfig(updates);
        setConfig(response.config);
      } catch (err) {
        console.error(
          "[useWebhookPrivateConfig] Failed to update config:",
          err,
        );
        setError(
          err instanceof Error ? err.message : "Failed to update config",
        );
        throw err;
      }
    },
    [],
  );

  const testWebhook = useCallback(async () => {
    try {
      const result = await api.testWebhookPrivate();
      return { success: result.success, error: result.error };
    } catch (err) {
      console.error("[useWebhookPrivateConfig] Test failed:", err);
      return {
        success: false,
        error: err instanceof Error ? err.message : "Test failed",
      };
    }
  }, []);

  return {
    config,
    isLoading,
    error,
    updateConfig,
    testWebhook,
    refetch: fetchConfig,
  };
}
