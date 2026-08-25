import {
  CACHE_MISS_BILLING_EXPECTED_EXPIRY_CAPABILITY,
  CACHE_MISS_BILLING_IGNORE_AFTER_CAPABILITY,
  DEFAULT_CACHE_MISS_BILLING_SETTINGS,
  type CacheMissBillingRecord,
  type CacheMissBillingSettings as CacheMissBillingSettingsValue,
  type ProviderName,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import { useRelativeNow } from "../../hooks/useRelativeNow";
import { useRemoteBasePath } from "../../hooks/useRemoteBasePath";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import { activityBus } from "../../lib/activityBus";
import styles from "./CacheMissBillingSettings.module.css";
import { CacheMissEventTable } from "./CacheMissEventTable";
import {
  CacheMissInactivityChart,
  CacheMissProbabilityChart,
  CacheMissProviderChart,
} from "./CacheMissInactivityChart";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { HideInSettingsSearch } from "./SettingsSearchContext";
import { SettingsSection } from "./SettingsSection";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";

const MAX_EVENTS = 500;
const MAX_RECENCY_HOURS = 96;
const UNLIMITED_RECENCY_SLIDER_VALUE = MAX_RECENCY_HOURS + 1;

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

function providerFreshWindowMinutes(
  settings: Required<CacheMissBillingSettingsValue>,
  provider: ProviderName,
): number {
  return (
    settings.providerFreshWindowMinutes[provider] ?? settings.freshWindowMinutes
  );
}

export function cacheMissBillingSettingsForServer(
  settings: CacheMissBillingSettingsValue,
  supportsIgnoreAfter: boolean,
): CacheMissBillingSettingsValue {
  if (supportsIgnoreAfter) return settings;
  const legacySettings: CacheMissBillingSettingsValue = { ...settings };
  delete legacySettings.ignoreAfterMinutes;
  return legacySettings;
}

export function filterCacheMissEvents(
  events: CacheMissBillingRecord[],
  recencyHours: number | null,
  ignoreAfterMinutes: number,
  nowMs: number,
  includeExpectedExpiry = false,
): CacheMissBillingRecord[] {
  const cutoffMs =
    recencyHours === null ? null : nowMs - recencyHours * 60 * 60_000;
  return events.filter((event) => {
    if (!includeExpectedExpiry && !event.expectedInputCost.freshEnough) {
      return false;
    }
    const timestampMs = Date.parse(event.timestamp);
    if (
      cutoffMs !== null &&
      (!Number.isFinite(timestampMs) || timestampMs < cutoffMs)
    ) {
      return false;
    }
    return (
      ignoreAfterMinutes === 0 ||
      event.elapsedSinceExpectedCacheMs === undefined ||
      event.elapsedSinceExpectedCacheMs <= ignoreAfterMinutes * 60_000
    );
  });
}

export function CacheMissBillingSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("cacheMissBillingTitle"));
  const { version } = useVersion();
  const supportsIgnoreAfter = serverHasCapability(
    version,
    CACHE_MISS_BILLING_IGNORE_AFTER_CAPABILITY,
  );
  const supportsExpectedExpiry = serverHasCapability(
    version,
    CACHE_MISS_BILLING_EXPECTED_EXPIRY_CAPABILITY,
  );
  const basePath = useRemoteBasePath();
  const { settings, isLoading, error, updateSettings } = useServerSettings();
  const [events, setEvents] = useState<CacheMissBillingRecord[]>([]);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [recencyHours, setRecencyHours] = useState<number | null>(null);
  const [recencyText, setRecencyText] = useState("");
  const [includeExpectedExpiry, setIncludeExpectedExpiry] = useState(false);
  const nowMs = useRelativeNow(60_000);

  const effective = effectiveCacheMissBillingSettings(
    settings?.cacheMissBilling,
  );

  const updateCacheMissBilling = useCallback(
    async (patch: CacheMissBillingSettingsValue) => {
      const current = effectiveCacheMissBillingSettings(
        settings?.cacheMissBilling,
      );
      await updateSettings({
        cacheMissBilling: cacheMissBillingSettingsForServer(
          {
            ...current,
            ...patch,
            providerFreshWindowMinutes: {
              ...current.providerFreshWindowMinutes,
              ...patch.providerFreshWindowMinutes,
            },
          },
          supportsIgnoreAfter,
        ),
      });
    },
    [settings?.cacheMissBilling, supportsIgnoreAfter, updateSettings],
  );

  const restore = useCallback(
    async (snapshot: Required<CacheMissBillingSettingsValue>) => {
      await updateSettings({
        cacheMissBilling: cacheMissBillingSettingsForServer(
          snapshot,
          supportsIgnoreAfter,
        ),
      });
    },
    [supportsIgnoreAfter, updateSettings],
  );
  useSettingsUndoBaseline(settings ? effective : null, restore);
  const filteredEvents = filterCacheMissEvents(
    events,
    recencyHours,
    effective.ignoreAfterMinutes,
    nowMs,
    includeExpectedExpiry,
  );

  useEffect(() => {
    let cancelled = false;
    api
      .getCacheMissBillingEvents(MAX_EVENTS, supportsExpectedExpiry)
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
  }, [supportsExpectedExpiry, t]);

  useEffect(() => {
    const addEvent = (event: { record: CacheMissBillingRecord }) => {
      setEvents((current) => {
        const next = [
          event.record,
          ...current.filter((candidate) => candidate.id !== event.record.id),
        ];
        return next.slice(0, MAX_EVENTS);
      });
    };
    const unsubscribe = activityBus.on("cache-miss-billing", addEvent);
    const unsubscribeExpectedExpiry = supportsExpectedExpiry
      ? activityBus.on("cache-miss-billing-expected-expiry", addEvent)
      : undefined;
    return () => {
      unsubscribe();
      unsubscribeExpectedExpiry?.();
    };
  }, [supportsExpectedExpiry]);

  const setRecencyFromSlider = (value: number) => {
    if (value === UNLIMITED_RECENCY_SLIDER_VALUE) {
      setRecencyHours(null);
      setRecencyText("");
      return;
    }
    setRecencyHours(value);
    setRecencyText(String(value));
  };

  const setRecencyFromText = (value: string) => {
    setRecencyText(value);
    if (value.trim() === "") {
      setRecencyHours(null);
      return;
    }
    const parsed = Number.parseInt(value, 10);
    if (
      Number.isInteger(parsed) &&
      parsed >= 1 &&
      parsed <= MAX_RECENCY_HOURS
    ) {
      setRecencyHours(parsed);
    }
  };

  const normalizeRecencyText = () => {
    if (recencyText.trim() === "") return;
    const value = clampInteger(
      recencyText,
      recencyHours ?? MAX_RECENCY_HOURS,
      1,
      MAX_RECENCY_HOURS,
    );
    setRecencyHours(value);
    setRecencyText(String(value));
  };

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
                  key={`minimum-${effective.minimumWastedTokens}`}
                  type="number"
                  className={`settings-input-small ${styles.tokenInput}`}
                  min={1}
                  max={5_000_000}
                  step={1000}
                  defaultValue={effective.minimumWastedTokens}
                  disabled={!effective.enabled}
                  onBlur={(event) => {
                    const value = clampInteger(
                      event.currentTarget.value,
                      effective.minimumWastedTokens,
                      1,
                      5_000_000,
                    );
                    event.currentTarget.value = String(value);
                    if (value !== effective.minimumWastedTokens) {
                      void updateCacheMissBilling({
                        minimumWastedTokens: value,
                      });
                    }
                  }}
                  aria-label={t("cacheMissBillingMinimumTokensTitle")}
                />
                <span>{t("cacheMissBillingTokensUnit")}</span>
              </span>
            </div>
          </SettingsItem>

          <SettingsItem
            label={t("cacheMissBillingRecentActivityTitle")}
            description={t("cacheMissBillingRecentActivityDescription")}
            className="settings-item--wide-control"
          >
            <div className="settings-item-actions">
              <span className="settings-input-unit">
                <input
                  key={`recent-${effective.recentActivityMinutes}`}
                  type="number"
                  className="settings-input-small"
                  min={0}
                  max={1440}
                  defaultValue={effective.recentActivityMinutes}
                  disabled={!effective.enabled}
                  onBlur={(event) => {
                    const value = clampInteger(
                      event.currentTarget.value,
                      effective.recentActivityMinutes,
                      0,
                      1440,
                    );
                    event.currentTarget.value = String(value);
                    if (value !== effective.recentActivityMinutes) {
                      void updateCacheMissBilling({
                        recentActivityMinutes: value,
                      });
                    }
                  }}
                  aria-label={t("cacheMissBillingRecentActivityTitle")}
                />
                <span>{t("cacheMissBillingMinutesUnit")}</span>
              </span>
            </div>
          </SettingsItem>

          {supportsIgnoreAfter && (
            <SettingsItem
              label={t("cacheMissBillingIgnoreAfterTitle")}
              description={t("cacheMissBillingIgnoreAfterDescription")}
              className="settings-item--wide-control"
            >
              <div className="settings-item-actions">
                <span className="settings-input-unit">
                  <input
                    key={`ignore-after-${effective.ignoreAfterMinutes}`}
                    type="number"
                    className="settings-input-small"
                    min={0}
                    max={1440}
                    defaultValue={effective.ignoreAfterMinutes}
                    disabled={!effective.enabled}
                    onBlur={(event) => {
                      const value = clampInteger(
                        event.currentTarget.value,
                        effective.ignoreAfterMinutes,
                        0,
                        1440,
                      );
                      event.currentTarget.value = String(value);
                      if (value !== effective.ignoreAfterMinutes) {
                        void updateCacheMissBilling({
                          ignoreAfterMinutes: value,
                        });
                      }
                    }}
                    aria-label={t("cacheMissBillingIgnoreAfterTitle")}
                  />
                  <span>{t("cacheMissBillingMinutesUnit")}</span>
                </span>
              </div>
            </SettingsItem>
          )}
        </div>

        {error && <p className="settings-warning">{error}</p>}
      </SettingsSection>

      <SettingsSection
        title={t("cacheMissEvidenceTitle")}
        description={t("cacheMissEvidenceDescription")}
      >
        {eventsError && <p className="settings-warning">{eventsError}</p>}
        <HideInSettingsSearch>
          <div className={styles.evidence}>
            <div className={styles.recencyControl}>
              <div className={styles.recencyHeader}>
                <div>
                  <h3>{t("cacheMissRecencyTitle")}</h3>
                  <p>{t("cacheMissRecencyDescription")}</p>
                </div>
                <span>
                  {t("cacheMissRecencySummary", {
                    shown: filteredEvents.length,
                    total: events.length,
                  })}
                </span>
              </div>
              {supportsExpectedExpiry && (
                <label className={styles.expectedExpiryToggle}>
                  <input
                    type="checkbox"
                    checked={includeExpectedExpiry}
                    onChange={(event) =>
                      setIncludeExpectedExpiry(event.currentTarget.checked)
                    }
                    aria-label={t("cacheMissExpectedExpiryToggleTitle")}
                  />
                  <span>
                    <strong>{t("cacheMissExpectedExpiryToggleTitle")}</strong>
                    <span>{t("cacheMissExpectedExpiryToggleDescription")}</span>
                  </span>
                </label>
              )}
              <div className={styles.recencyInputs}>
                <div className={styles.sliderStack}>
                  <input
                    type="range"
                    min={1}
                    max={UNLIMITED_RECENCY_SLIDER_VALUE}
                    step={1}
                    value={recencyHours ?? UNLIMITED_RECENCY_SLIDER_VALUE}
                    onChange={(event) =>
                      setRecencyFromSlider(
                        Number.parseInt(event.currentTarget.value, 10),
                      )
                    }
                    aria-label={t("cacheMissRecencySliderLabel")}
                  />
                  <div className={styles.sliderLabels} aria-hidden="true">
                    <span>1h</span>
                    <span>96h</span>
                    <span>∞</span>
                  </div>
                </div>
                <label className={styles.recencyTextInput}>
                  <span>{t("cacheMissRecencyHoursLabel")}</span>
                  <span className="settings-input-unit">
                    <input
                      type="number"
                      min={1}
                      max={MAX_RECENCY_HOURS}
                      value={recencyText}
                      placeholder="∞"
                      onChange={(event) =>
                        setRecencyFromText(event.currentTarget.value)
                      }
                      onBlur={normalizeRecencyText}
                    />
                    <span>{t("cacheMissRecencyHoursUnit")}</span>
                  </span>
                </label>
              </div>
            </div>

            <div className={styles.chartGrid}>
              <section className={styles.chartPanel}>
                <h3>{t("cacheMissChartTitle")}</h3>
                <p>{t("cacheMissChartDescription")}</p>
                <CacheMissInactivityChart events={filteredEvents} />
              </section>
              <section className={styles.chartPanel}>
                <h3>{t("cacheMissProbabilityTitle")}</h3>
                <p>{t("cacheMissProbabilityDescription")}</p>
                <CacheMissProbabilityChart events={filteredEvents} />
              </section>
              <section className={styles.chartPanel}>
                <h3>{t("cacheMissProviderTitle")}</h3>
                <p>{t("cacheMissProviderDescription")}</p>
                <CacheMissProviderChart events={filteredEvents} />
              </section>
            </div>

            <section className={styles.eventTableSection}>
              <h3>{t("cacheMissEventsTitle")}</h3>
              <p>{t("cacheMissBillingEventsDescription")}</p>
              <CacheMissEventTable
                events={filteredEvents}
                basePath={basePath}
                recencyHours={recencyHours}
              />
            </section>
          </div>
        </HideInSettingsSearch>
      </SettingsSection>
    </>
  );
}
