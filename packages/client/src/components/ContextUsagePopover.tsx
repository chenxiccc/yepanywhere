import {
  getApplicableSubscriptionUsageWindows,
  getMostUsedSubscriptionUsageWindow,
  type ProviderSubscriptionUsage,
  type ProviderSubscriptionUsageWindow,
} from "@yep-anywhere/shared";
import { useI18n } from "../i18n";
import type { ContextUsage } from "../types";
import styles from "./ContextUsagePopover.module.css";

function formatDuration(minutes: number | undefined): string {
  if (!minutes) return "—";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function scopeLabel(
  window: ProviderSubscriptionUsageWindow,
  allModels: string,
  oauthApps: string,
): string {
  if (window.scope.type === "models") {
    return window.scope.label ?? window.scope.modelIds.join(", ");
  }
  return window.scope.category === "oauthApps" ? oauthApps : allModels;
}

/**
 * True when the last turn's usage carries provider-reported cache/output
 * counts worth showing. Plain `inputTokens` alone is already on the pie
 * indicator and its tooltip, so it does not by itself earn a popover.
 */
export function hasContextTokenDetails(
  usage: ContextUsage | undefined,
): boolean {
  return (
    !!usage &&
    (usage.cacheReadTokens !== undefined ||
      usage.cacheCreationTokens !== undefined ||
      usage.outputTokens !== undefined)
  );
}

function ContextTokenRows({ usage }: { usage: ContextUsage }) {
  const { locale, t } = useI18n();
  const format = (tokens: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(tokens);

  return (
    <div className={styles.tokenUsage}>
      <div className="context-threshold-popover-title">
        {t("contextTokenUsageTitle")}
      </div>
      <dl className={styles.rows}>
        <div className={styles.row}>
          <dt>{t("contextTokenUsageContext")}</dt>
          <dd>{format(usage.inputTokens)}</dd>
        </div>
        {usage.cacheReadTokens !== undefined && (
          <div className={styles.row}>
            <dt>{t("contextTokenUsageCacheRead")}</dt>
            <dd>{format(usage.cacheReadTokens)}</dd>
          </div>
        )}
        {usage.cacheCreationTokens !== undefined && (
          <div className={styles.row}>
            <dt>{t("contextTokenUsageCacheWrite")}</dt>
            <dd>{format(usage.cacheCreationTokens)}</dd>
          </div>
        )}
        {usage.outputTokens !== undefined && (
          <div className={styles.row}>
            <dt>{t("contextTokenUsageOutput")}</dt>
            <dd>{format(usage.outputTokens)}</dd>
          </div>
        )}
      </dl>
      <div className={styles.hint}>{t("contextTokenUsageHint")}</div>
    </div>
  );
}

/**
 * The left-click popover behind the context-usage pie. It shows the last
 * turn's provider-reported token accounting (including cache read/write, so
 * cache reuse is visible per turn) and, for providers that report one, the
 * subscription quota windows. Either half may be absent: Claude sessions
 * always have token counts, while quota windows exist only for providers
 * whose account API reports them.
 */
export function ContextUsagePopover({
  usage,
  contextUsage,
  modelId,
  refreshing,
  onRefresh,
  onEditCompactThreshold,
}: {
  usage?: ProviderSubscriptionUsage;
  contextUsage?: ContextUsage;
  modelId?: string;
  refreshing: boolean;
  onRefresh: () => void;
  onEditCompactThreshold?: () => void;
}) {
  const { locale, t } = useI18n();
  const windows = usage
    ? getApplicableSubscriptionUsageWindows(usage, modelId).sort(
        (left, right) => right.usedPercent - left.usedPercent,
      )
    : [];
  const binding = usage
    ? getMostUsedSubscriptionUsageWindow(usage, modelId)
    : null;
  const showTokens = hasContextTokenDetails(contextUsage);

  return (
    <div
      className="context-subscription-popover"
      role="dialog"
      aria-label={
        usage ? t("subscriptionUsageTitle") : t("contextTokenUsageTitle")
      }
      aria-busy={refreshing}
    >
      {usage && (
        <div className="subscription-usage-header">
          <div>
            <div className="context-threshold-popover-title">
              {t("subscriptionUsageTitle")}
            </div>
            {binding && (
              <div className="subscription-usage-summary">
                {t("subscriptionUsageCompact", {
                  percent: Math.round(binding.usedPercent),
                })}
              </div>
            )}
          </div>
          <button
            type="button"
            className="subscription-usage-refresh"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label={t("subscriptionUsageRefresh")}
            title={t("subscriptionUsageRefresh")}
          >
            ↻
          </button>
        </div>
      )}
      <div className="subscription-usage-windows">
        {windows.map((window) => (
          <div className="subscription-usage-window" key={window.id}>
            <div className="subscription-usage-window-heading">
              <span>
                {scopeLabel(
                  window,
                  t("subscriptionUsageAllModels"),
                  t("subscriptionUsageClaudeApps"),
                )}
                {" · "}
                {t("subscriptionUsageWindow", {
                  duration: formatDuration(window.windowDurationMinutes),
                })}
              </span>
              <strong>
                {t("subscriptionUsagePercent", {
                  percent: Math.round(window.usedPercent),
                })}
              </strong>
            </div>
            <div className="subscription-usage-meter" aria-hidden="true">
              <span style={{ width: `${window.usedPercent}%` }} />
            </div>
            {window.resetsAt && (
              <div className="subscription-usage-reset">
                {t("subscriptionUsageResets", {
                  time: new Intl.DateTimeFormat(locale, {
                    dateStyle: "short",
                    timeStyle: "short",
                  }).format(new Date(window.resetsAt)),
                })}
              </div>
            )}
          </div>
        ))}
      </div>
      {showTokens && contextUsage && <ContextTokenRows usage={contextUsage} />}
      {onEditCompactThreshold && (
        <button
          type="button"
          className="subscription-usage-compact-action"
          onClick={onEditCompactThreshold}
        >
          {t("subscriptionUsageEditCompact")}
        </button>
      )}
    </div>
  );
}
