import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useToastContext } from "../contexts/ToastContext";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { activityBus } from "../lib/activityBus";

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }
  return String(tokens);
}

export function CacheMissBillingToasts() {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();

  useEffect(() => {
    return activityBus.on("cache-miss-billing", (event) => {
      if (!event.showToast || !event.record.exception) {
        return;
      }
      const { record } = event;
      showToast(
        t("cacheMissBillingToast", {
          provider: record.provider,
          tokens: formatTokenCount(record.wastedInputTokens),
        }),
        "error",
        {
          label: t("cacheMissBillingOpenSession"),
          onClick: () => navigate(`${basePath}${record.sessionPath}`),
        },
      );
    });
  }, [basePath, navigate, showToast, t]);

  return null;
}
