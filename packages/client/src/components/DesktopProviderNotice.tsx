import type { ProviderInfo } from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { useProviders } from "../hooks/useProviders";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";

const CLAUDE_DOWNLOAD_URL = "https://claude.com/download";
const CODEX_DOWNLOAD_URL = "https://openai.com/codex/get-started/";

export function hasDesktopProviderRuntime(providers: ProviderInfo[]): boolean {
  return providers.some(
    (provider) =>
      (provider.name === "claude" || provider.name === "codex") &&
      (provider.applicationDetected ?? provider.installed),
  );
}

export function DesktopProviderNotice() {
  const { t } = useI18n();
  const { version } = useVersion();
  const { providers, loading, error, refetch } = useProviders();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (version?.desktopRuntime !== true) return;
    const refresh = () => void refetch();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refetch, version?.desktopRuntime]);

  if (
    dismissed ||
    version?.desktopRuntime !== true ||
    loading ||
    error ||
    hasDesktopProviderRuntime(providers)
  ) {
    return null;
  }

  return (
    <aside className="desktop-provider-notice" aria-live="polite">
      <div className="desktop-provider-notice__copy">
        <strong>{t("desktopProviderNoticeTitle")}</strong>
        <span>{t("desktopProviderNoticeDescription")}</span>
      </div>
      <div className="desktop-provider-notice__actions">
        <a href={CLAUDE_DOWNLOAD_URL} target="_blank" rel="noreferrer">
          {t("desktopProviderNoticeGetClaude")}
        </a>
        <a href={CODEX_DOWNLOAD_URL} target="_blank" rel="noreferrer">
          {t("desktopProviderNoticeGetCodex")}
        </a>
        <button type="button" onClick={() => void refetch()}>
          {t("desktopProviderNoticeRetry")}
        </button>
        <button
          type="button"
          className="desktop-provider-notice__dismiss"
          aria-label={t("desktopProviderNoticeDismiss")}
          onClick={() => setDismissed(true)}
        >
          ×
        </button>
      </div>
    </aside>
  );
}
