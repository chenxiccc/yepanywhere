import {
  getApplicableSubscriptionUsageWindows,
  getMostUsedSubscriptionUsageWindow,
  type ProviderSubscriptionUsage,
  type ProviderSubscriptionUsageWindow,
} from "@yep-anywhere/shared";
import { useI18n } from "../i18n";

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

export function SubscriptionUsageDetails({
  usage,
  modelId,
  refreshing,
  onRefresh,
  onEditCompactThreshold,
}: {
  usage: ProviderSubscriptionUsage;
  modelId?: string;
  refreshing: boolean;
  onRefresh: () => void;
  onEditCompactThreshold?: () => void;
}) {
  const { locale, t } = useI18n();
  const windows = getApplicableSubscriptionUsageWindows(usage, modelId).sort(
    (left, right) => right.usedPercent - left.usedPercent,
  );
  const binding = getMostUsedSubscriptionUsageWindow(usage, modelId);

  return (
    <div
      className="context-subscription-popover"
      role="dialog"
      aria-label={t("subscriptionUsageTitle")}
      aria-busy={refreshing}
    >
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
