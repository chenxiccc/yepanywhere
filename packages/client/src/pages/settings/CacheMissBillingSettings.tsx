import {
  DEFAULT_CACHE_MISS_BILLING_SETTINGS,
  type CacheMissBillingRecord,
  type CacheMissBillingSettings as CacheMissBillingSettingsValue,
  type ProviderName,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import styles from "./CacheMissBillingSettings.module.css";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useRemoteBasePath } from "../../hooks/useRemoteBasePath";
import { useI18n } from "../../i18n";
import { activityBus } from "../../lib/activityBus";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { HideInSettingsSearch } from "./SettingsSearchContext";
import { SettingsSection } from "./SettingsSection";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";

const MAX_EVENTS = 200;
type TFunction = ReturnType<typeof useI18n>["t"];

function clampInteger(
  value: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function formatTokenCount(tokens: number): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 0,
  }).format(tokens);
}

function effectiveCacheMissBillingSettings(
  settings: CacheMissBillingSettingsValue | undefined,
): Required<CacheMissBillingSettingsValue> {
  return {
    ...DEFAULT_CACHE_MISS_BILLING_SETTINGS,
    ...settings,
    providerFreshWindowMinutes: {
      ...DEFAULT_CACHE_MISS_BILLING_SETTINGS.providerFreshWindowMinutes,
      ...settings?.providerFreshWindowMinutes,
    },
  };
}

function eventReasonLabel(event: CacheMissBillingRecord, t: TFunction): string {
  switch (event.reason) {
    case "fork-prefix-cache-hit":
      return t("cacheMissBillingReasonForkHit");
    case "warm-session-cache-hit":
      return t("cacheMissBillingReasonWarmHit");
    case "fork-prefix-cache-miss":
      return t("cacheMissBillingReasonForkMiss");
    case "warm-session-cache-miss":
      return t("cacheMissBillingReasonWarmMiss");
  }
}

function eventPositionLabel(
  event: CacheMissBillingRecord,
  t: TFunction,
): string {
  if (event.messageId) {
    return t("cacheMissBillingEventMessageId", {
      messageId: event.messageId,
    });
  }
  if (event.messageIndex !== undefined) {
    return t("cacheMissBillingEventMessageIndex", {
      index: String(event.messageIndex),
    });
  }
  return t("cacheMissBillingEventMessageUnknown");
}

function eventUsageLabel(event: CacheMissBillingRecord, t: TFunction): string {
  if (event.outcome === "expected-cache-hit") {
    return t("cacheMissBillingEventUsageHit", {
      provider: event.provider,
      tokens: formatTokenCount(event.observedUsage.cacheReadTokens ?? 0),
    });
  }
  return t("cacheMissBillingEventUsageMiss", {
    provider: event.provider,
    tokens: formatTokenCount(event.observedUsage.uncachedInputTokens),
  });
}

function eventExpectedCostLabel(
  event: CacheMissBillingRecord,
  t: TFunction,
): string {
  const basis =
    event.expectedInputCost.prefixBasis === "provider-fork-byte-identical"
      ? t("cacheMissBillingExpectedBasisFork")
      : t("cacheMissBillingExpectedBasisWarm");
  return t("cacheMissBillingExpectedCostDetail", {
    basis,
    window: String(event.expectedInputCost.providerFreshWindowMinutes),
  });
}

function providerFreshWindowMinutes(
  settings: Required<CacheMissBillingSettingsValue>,
  provider: ProviderName,
): number {
  return (
    settings.providerFreshWindowMinutes[provider] ?? settings.freshWindowMinutes
  );
}

function CacheMissBillingEventList({
  emptyMessage,
  events,
  t,
  basePath,
}: {
  emptyMessage: string;
  events: CacheMissBillingRecord[];
  t: TFunction;
  basePath: string;
}) {
  if (events.length === 0) {
    return <p className="settings-empty">{emptyMessage}</p>;
  }
  return (
    <div className={`settings-group ${styles.events}`}>
      {events.map((event) => (
        <div key={event.id} className="settings-item model-settings-item">
          <div className={styles.eventHeader}>
            <div className="settings-item-info">
              <strong>{eventReasonLabel(event, t)}</strong>
              <p>{eventUsageLabel(event, t)}</p>
            </div>
            <Link
              className="settings-button"
              to={`${basePath}${event.sessionPath}`}
            >
              {t("cacheMissBillingOpenSession")}
            </Link>
          </div>
          <p className={`settings-hint ${styles.eventDetail}`}>
            {t("cacheMissBillingEventDetail", {
              time: new Date(event.timestamp).toLocaleString(),
              position: eventPositionLabel(event, t),
            })}
          </p>
          <p className={`settings-hint ${styles.eventDetail}`}>
            {eventExpectedCostLabel(event, t)}
          </p>
        </div>
      ))}
    </div>
  );
}

export function CacheMissBillingSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("cacheMissBillingTitle"));
  const basePath = useRemoteBasePath();
  const { settings, isLoading, error, updateSettings } = useServerSettings();
  const [events, setEvents] = useState<CacheMissBillingRecord[]>([]);
  const [eventsError, setEventsError] = useState<string | null>(null);

  const effective = effectiveCacheMissBillingSettings(
    settings?.cacheMissBilling,
  );

  const updateCacheMissBilling = useCallback(
    async (patch: CacheMissBillingSettingsValue) => {
      const current = effectiveCacheMissBillingSettings(
        settings?.cacheMissBilling,
      );
      await updateSettings({
        cacheMissBilling: {
          ...current,
          ...patch,
          providerFreshWindowMinutes: {
            ...current.providerFreshWindowMinutes,
            ...patch.providerFreshWindowMinutes,
          },
        },
      });
    },
    [settings?.cacheMissBilling, updateSettings],
  );

  const restore = useCallback(
    async (snapshot: Required<CacheMissBillingSettingsValue>) => {
      await updateSettings({ cacheMissBilling: snapshot });
    },
    [updateSettings],
  );
  useSettingsUndoBaseline(settings ? effective : null, restore);
  const failureEvents = events.filter(
    (event) => event.outcome === "unexpected-recompute",
  );
  const successEvents = events.filter(
    (event) => event.outcome === "expected-cache-hit",
  );

  useEffect(() => {
    let cancelled = false;
    api
      .getCacheMissBillingEvents(MAX_EVENTS)
      .then((response) => {
        if (!cancelled) {
          setEvents(response.events);
          setEventsError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setEventsError(
            err instanceof Error
              ? err.message
              : t("cacheMissBillingEventsLoadError"),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    return activityBus.on("cache-miss-billing", (event) => {
      setEvents((current) => {
        const next = [
          event.record,
          ...current.filter((candidate) => candidate.id !== event.record.id),
        ];
        return next.slice(0, MAX_EVENTS);
      });
    });
  }, []);

  if (isLoading) {
    return <SettingsSection description={t("cacheMissBillingLoading")} />;
  }

  return (
    <>
      <SettingsSection description={t("cacheMissBillingDescription")}>
        <div className="settings-group">
          <SettingsItem
            as="label"
            label={t("cacheMissBillingEnableTitle")}
            description={t("cacheMissBillingEnableDescription")}
          >
            <input
              type="checkbox"
              checked={effective.enabled}
              onChange={(event) =>
                void updateCacheMissBilling({
                  enabled: event.currentTarget.checked,
                })
              }
              aria-label={t("cacheMissBillingEnableTitle")}
            />
          </SettingsItem>

          <SettingsItem
            as="label"
            label={t("cacheMissBillingToastTitle")}
            description={t("cacheMissBillingToastDescription")}
          >
            <input
              type="checkbox"
              checked={effective.showToasts}
              disabled={!effective.enabled}
              onChange={(event) =>
                void updateCacheMissBilling({
                  showToasts: event.currentTarget.checked,
                })
              }
              aria-label={t("cacheMissBillingToastTitle")}
            />
          </SettingsItem>

          <SettingsItem
            label={t("cacheMissBillingClaudeFreshWindowTitle")}
            description={t("cacheMissBillingClaudeFreshWindowDescription")}
            className="settings-item--wide-control"
          >
            <div className="settings-item-actions">
              <span className="settings-input-unit">
                <input
                  key={`fresh-claude-${providerFreshWindowMinutes(effective, "claude")}`}
                  type="number"
                  className="settings-input-small"
                  min={1}
                  max={1440}
                  defaultValue={providerFreshWindowMinutes(effective, "claude")}
                  disabled={!effective.enabled}
                  onBlur={(event) => {
                    const currentValue = providerFreshWindowMinutes(
                      effective,
                      "claude",
                    );
                    const value = clampInteger(
                      event.currentTarget.value,
                      currentValue,
                      1,
                      1440,
                    );
                    event.currentTarget.value = String(value);
                    if (value !== currentValue) {
                      void updateCacheMissBilling({
                        providerFreshWindowMinutes: { claude: value },
                      });
                    }
                  }}
                  aria-label={t("cacheMissBillingClaudeFreshWindowTitle")}
                />
                <span>{t("cacheMissBillingMinutesUnit")}</span>
              </span>
            </div>
          </SettingsItem>

          <SettingsItem
            label={t("cacheMissBillingCodexFreshWindowTitle")}
            description={t("cacheMissBillingCodexFreshWindowDescription")}
            className="settings-item--wide-control"
          >
            <div className="settings-item-actions">
              <span className="settings-input-unit">
                <input
                  key={`fresh-codex-${providerFreshWindowMinutes(effective, "codex")}`}
                  type="number"
                  className="settings-input-small"
                  min={1}
                  max={1440}
                  defaultValue={providerFreshWindowMinutes(effective, "codex")}
                  disabled={!effective.enabled}
                  onBlur={(event) => {
                    const currentValue = providerFreshWindowMinutes(
                      effective,
                      "codex",
                    );
                    const value = clampInteger(
                      event.currentTarget.value,
                      currentValue,
                      1,
                      1440,
                    );
                    event.currentTarget.value = String(value);
                    if (value !== currentValue) {
                      void updateCacheMissBilling({
                        providerFreshWindowMinutes: { codex: value },
                      });
                    }
                  }}
                  aria-label={t("cacheMissBillingCodexFreshWindowTitle")}
                />
                <span>{t("cacheMissBillingMinutesUnit")}</span>
              </span>
            </div>
          </SettingsItem>

          <SettingsItem
            label={t("cacheMissBillingMinimumTokensTitle")}
            description={t("cacheMissBillingMinimumTokensDescription")}
            className="settings-item--wide-control"
          >
            <div className="settings-item-actions">
              <span className="settings-input-unit">
                <input
                  key={`minimum-${effective.minimumInputTokens}`}
                  type="number"
                  className={`settings-input-small ${styles.tokenInput}`}
                  min={1}
                  max={5_000_000}
                  step={1000}
                  defaultValue={effective.minimumInputTokens}
                  disabled={!effective.enabled}
                  onBlur={(event) => {
                    const value = clampInteger(
                      event.currentTarget.value,
                      effective.minimumInputTokens,
                      1,
                      5_000_000,
                    );
                    event.currentTarget.value = String(value);
                    if (value !== effective.minimumInputTokens) {
                      void updateCacheMissBilling({
                        minimumInputTokens: value,
                      });
                    }
                  }}
                  aria-label={t("cacheMissBillingMinimumTokensTitle")}
                />
                <span>{t("cacheMissBillingTokensUnit")}</span>
              </span>
            </div>
          </SettingsItem>
        </div>

        {error && <p className="settings-warning">{error}</p>}
      </SettingsSection>

      <SettingsSection description={t("cacheMissBillingEventsDescription")}>
        {eventsError && <p className="settings-warning">{eventsError}</p>}
        <HideInSettingsSearch>
          <div className={styles.eventLog}>
            <div className={styles.eventColumns}>
              <div className={styles.eventColumn}>
                <h3 className={styles.eventColumnTitle}>
                  {t("cacheMissBillingFailuresTitle")}
                </h3>
                <CacheMissBillingEventList
                  emptyMessage={t("cacheMissBillingFailuresEmpty")}
                  events={failureEvents}
                  t={t}
                  basePath={basePath}
                />
              </div>
              <div className={styles.eventColumn}>
                <h3 className={styles.eventColumnTitle}>
                  {t("cacheMissBillingSuccessesTitle")}
                </h3>
                <CacheMissBillingEventList
                  emptyMessage={t("cacheMissBillingSuccessesEmpty")}
                  events={successEvents}
                  t={t}
                  basePath={basePath}
                />
              </div>
            </div>
          </div>
        </HideInSettingsSearch>
      </SettingsSection>
    </>
  );
}
