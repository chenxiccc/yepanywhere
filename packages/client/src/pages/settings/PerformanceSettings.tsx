import {
  HOST_AGENT_PROCESS_OBSERVABILITY_CAPABILITY,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { useCallback, useMemo, useState } from "react";
import { CommittedRangeInput } from "../../components/ui/CommittedRangeInput";
import { useSessionLoadingProgress } from "../../hooks/useSessionLoadingProgress";
import { useServerSettings } from "../../hooks/useServerSettings";
import {
  getLastSessionTranscriptBytes,
  getSessionTranscriptMemoryStats,
  TRANSCRIPT_CACHE_BUDGET_MB_STOPS,
  TRANSCRIPT_CACHE_TTL_HOUR_STOPS,
  TYPICAL_SESSION_TRANSCRIPT_BYTES,
  useSessionPerformanceSettings,
} from "../../hooks/useSessionPerformanceSettings";
import { useStableToolPreviewRendering } from "../../hooks/useStableToolPreviewRendering";
import { useStreamingEnabled } from "../../hooks/useStreamingEnabled";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { SettingsSection } from "./SettingsSection";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";

function nearestStopIndex(stops: readonly number[], value: number): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  stops.forEach((stop, index) => {
    const distance = Math.abs(stop - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function formatMemoryMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb < 10 ? mb.toFixed(1) : String(Math.round(mb));
}

export function PerformanceSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("performanceSectionTitle"));
  const { streamingEnabled, setStreamingEnabled } = useStreamingEnabled();
  const { sessionLoadingProgressEnabled, setSessionLoadingProgressEnabled } =
    useSessionLoadingProgress();
  const {
    sessionDomLingerEnabled,
    sessionActiveWindowTrimEnabled,
    sessionTranscriptCacheBudgetMb,
    sessionTranscriptCacheTtlHours,
    setSessionDomLingerEnabled,
    setSessionActiveWindowTrimEnabled,
    setSessionTranscriptCacheBudgetMb,
    setSessionTranscriptCacheTtlHours,
  } = useSessionPerformanceSettings();
  const { stableToolPreviewRendering, setStableToolPreviewRendering } =
    useStableToolPreviewRendering();
  const { version } = useVersion();
  const {
    settings: serverSettings,
    isLoading: serverSettingsLoading,
    error: serverSettingsError,
    updateSetting: updateServerSetting,
  } = useServerSettings();
  const hostProcessObservabilitySupported = serverHasCapability(
    version,
    HOST_AGENT_PROCESS_OBSERVABILITY_CAPABILITY,
  );
  const hostProcessObservabilityEnabled =
    serverSettings?.hostProcessObservabilityEnabled ?? true;
  const [savingHostProcessObservability, setSavingHostProcessObservability] =
    useState(false);

  const [budgetDraftIndex, setBudgetDraftIndex] = useState<number | null>(null);
  const [ttlDraftIndex, setTtlDraftIndex] = useState<number | null>(null);

  const budgetIndex =
    budgetDraftIndex ??
    nearestStopIndex(
      TRANSCRIPT_CACHE_BUDGET_MB_STOPS,
      sessionTranscriptCacheBudgetMb,
    );
  const ttlIndex =
    ttlDraftIndex ??
    nearestStopIndex(
      TRANSCRIPT_CACHE_TTL_HOUR_STOPS,
      sessionTranscriptCacheTtlHours,
    );
  const budgetMb = TRANSCRIPT_CACHE_BUDGET_MB_STOPS[budgetIndex] ?? 0;
  const ttlHours = TRANSCRIPT_CACHE_TTL_HOUR_STOPS[ttlIndex] ?? 1;

  const budgetLabel =
    budgetMb === 0
      ? t("commonOff")
      : t("performanceTranscriptCacheMbValue", { count: budgetMb });
  const ttlLabel =
    ttlHours < 24
      ? t("performanceTranscriptCacheTtlHoursValue", { count: ttlHours })
      : t("performanceTranscriptCacheTtlDaysValue", {
          count: Math.round(ttlHours / 24),
        });

  const budgetEquivalent = useMemo(() => {
    if (budgetMb === 0) {
      return null;
    }
    const lastBytes = getLastSessionTranscriptBytes();
    const perSession = lastBytes ?? TYPICAL_SESSION_TRANSCRIPT_BYTES;
    const count = Math.max(
      1,
      Math.floor((budgetMb * 1024 * 1024) / perSession),
    );
    const size = (perSession / (1024 * 1024)).toFixed(1);
    return t(
      lastBytes !== null
        ? "performanceTranscriptCacheEquivalentLast"
        : "performanceTranscriptCacheEquivalentTypical",
      { count, size },
    );
  }, [budgetMb, t]);
  const transcriptMemoryStats = getSessionTranscriptMemoryStats();
  const cacheMemoryUsage =
    transcriptMemoryStats.totalBytes > 0
      ? t("performanceTranscriptCacheCurrentUsage", {
          warmSize: formatMemoryMb(transcriptMemoryStats.warmCacheBytes),
          liveSize: formatMemoryMb(transcriptMemoryStats.liveRetainedBytes),
        })
      : null;

  const commitBudget = useCallback(
    (index: number) => {
      setBudgetDraftIndex(null);
      const stop = TRANSCRIPT_CACHE_BUDGET_MB_STOPS[index];
      if (stop !== undefined) {
        setSessionTranscriptCacheBudgetMb(stop);
      }
    },
    [setSessionTranscriptCacheBudgetMb],
  );
  const commitTtl = useCallback(
    (index: number) => {
      setTtlDraftIndex(null);
      const stop = TRANSCRIPT_CACHE_TTL_HOUR_STOPS[index];
      if (stop !== undefined) {
        setSessionTranscriptCacheTtlHours(stop);
      }
    },
    [setSessionTranscriptCacheTtlHours],
  );
  const setHostProcessObservability = useCallback(
    async (enabled: boolean) => {
      setSavingHostProcessObservability(true);
      try {
        await updateServerSetting("hostProcessObservabilityEnabled", enabled);
      } catch {
        // useServerSettings retains the actionable error for this pane.
      } finally {
        setSavingHostProcessObservability(false);
      }
    },
    [updateServerSetting],
  );

  const undoState = useMemo(
    () => ({
      streamingEnabled,
      sessionLoadingProgressEnabled,
      sessionDomLingerEnabled,
      sessionActiveWindowTrimEnabled,
      sessionTranscriptCacheBudgetMb,
      sessionTranscriptCacheTtlHours,
      stableToolPreviewRendering,
      hostProcessObservabilityEnabled,
    }),
    [
      streamingEnabled,
      sessionLoadingProgressEnabled,
      sessionDomLingerEnabled,
      sessionActiveWindowTrimEnabled,
      sessionTranscriptCacheBudgetMb,
      sessionTranscriptCacheTtlHours,
      stableToolPreviewRendering,
      hostProcessObservabilityEnabled,
    ],
  );
  const restoreUndoState = useCallback(
    (snapshot: typeof undoState) => {
      setStreamingEnabled(snapshot.streamingEnabled);
      setSessionLoadingProgressEnabled(snapshot.sessionLoadingProgressEnabled);
      setSessionDomLingerEnabled(snapshot.sessionDomLingerEnabled);
      setSessionActiveWindowTrimEnabled(
        snapshot.sessionActiveWindowTrimEnabled,
      );
      setSessionTranscriptCacheBudgetMb(
        snapshot.sessionTranscriptCacheBudgetMb,
      );
      setSessionTranscriptCacheTtlHours(
        snapshot.sessionTranscriptCacheTtlHours,
      );
      setStableToolPreviewRendering(snapshot.stableToolPreviewRendering);
      if (
        hostProcessObservabilitySupported &&
        snapshot.hostProcessObservabilityEnabled !==
          hostProcessObservabilityEnabled
      ) {
        void setHostProcessObservability(
          snapshot.hostProcessObservabilityEnabled,
        );
      }
    },
    [
      setStreamingEnabled,
      setSessionLoadingProgressEnabled,
      setSessionDomLingerEnabled,
      setSessionActiveWindowTrimEnabled,
      setSessionTranscriptCacheBudgetMb,
      setSessionTranscriptCacheTtlHours,
      setStableToolPreviewRendering,
      hostProcessObservabilityEnabled,
      hostProcessObservabilitySupported,
      setHostProcessObservability,
    ],
  );
  useSettingsUndoBaseline(undoState, restoreUndoState);

  return (
    <SettingsSection description={t("performanceSectionDescription")}>
      <div className="settings-group">
        <SettingsItem
          label={t("appearanceStreamingTitle")}
          description={t("appearanceStreamingDescription")}
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={streamingEnabled}
              onChange={(event) => setStreamingEnabled(event.target.checked)}
              aria-label={t("appearanceStreamingTitle")}
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceSessionLoadingProgressTitle")}
          description={t("appearanceSessionLoadingProgressDescription")}
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={sessionLoadingProgressEnabled}
              onChange={(event) =>
                setSessionLoadingProgressEnabled(event.target.checked)
              }
              aria-label={t("appearanceSessionLoadingProgressTitle")}
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
        <SettingsItem
          label={t("performanceKeepRecentSessionMountedTitle")}
          description={t("performanceKeepRecentSessionMountedDescription")}
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={sessionDomLingerEnabled}
              onChange={(event) =>
                setSessionDomLingerEnabled(event.target.checked)
              }
              aria-label={t("performanceKeepRecentSessionMountedTitle")}
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
        <SettingsItem
          label={t("performanceActiveWindowTrimTitle")}
          description={t("performanceActiveWindowTrimDescription")}
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={sessionActiveWindowTrimEnabled}
              onChange={(event) =>
                setSessionActiveWindowTrimEnabled(event.target.checked)
              }
              aria-label={t("performanceActiveWindowTrimTitle")}
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
        <SettingsItem
          label={t("performanceTranscriptCacheTitle")}
          description={t("performanceTranscriptCacheDescription")}
          valueText={budgetLabel}
          className="settings-item--wide-control"
          info={
            <>
              <strong>{t("performanceTranscriptCacheTitle")}</strong>
              <p>{t("performanceTranscriptCacheDescription")}</p>
              {budgetEquivalent ? <p>{budgetEquivalent}</p> : null}
              {cacheMemoryUsage ? <p>{cacheMemoryUsage}</p> : null}
            </>
          }
        >
          <div className="settings-item-actions">
            <CommittedRangeInput
              min={0}
              max={TRANSCRIPT_CACHE_BUDGET_MB_STOPS.length - 1}
              step={1}
              value={budgetIndex}
              onDraftChange={setBudgetDraftIndex}
              onCommit={commitBudget}
              aria-label={t("performanceTranscriptCacheTitle")}
            />
            <span className="settings-input-unit">{budgetLabel}</span>
          </div>
        </SettingsItem>
        <SettingsItem
          label={t("performanceTranscriptCacheTtlTitle")}
          description={t("performanceTranscriptCacheTtlDescription")}
          valueText={ttlLabel}
          className="settings-item--wide-control"
        >
          <div className="settings-item-actions">
            <CommittedRangeInput
              min={0}
              max={TRANSCRIPT_CACHE_TTL_HOUR_STOPS.length - 1}
              step={1}
              value={ttlIndex}
              onDraftChange={setTtlDraftIndex}
              onCommit={commitTtl}
              disabled={budgetMb === 0}
              aria-label={t("performanceTranscriptCacheTtlTitle")}
            />
            <span className="settings-input-unit">{ttlLabel}</span>
          </div>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceStableToolPreviewTitle")}
          description={t("appearanceStableToolPreviewDescription")}
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={stableToolPreviewRendering}
              onChange={(event) =>
                setStableToolPreviewRendering(event.target.checked)
              }
              aria-label={t("appearanceStableToolPreviewTitle")}
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
        {hostProcessObservabilitySupported && (
          <SettingsItem
            label={t("performanceHostProcessObservabilityTitle")}
            description={t("performanceHostProcessObservabilityDescription")}
            keywords={["Agents", "CPU", "memory", "external processes"]}
            after={
              serverSettingsError ? (
                <p className="settings-error">{serverSettingsError}</p>
              ) : null
            }
          >
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={hostProcessObservabilityEnabled}
                disabled={
                  serverSettingsLoading || savingHostProcessObservability
                }
                onChange={(event) =>
                  void setHostProcessObservability(event.target.checked)
                }
                aria-label={t("performanceHostProcessObservabilityTitle")}
              />
              <span className="toggle-slider" />
            </label>
          </SettingsItem>
        )}
      </div>
    </SettingsSection>
  );
}
