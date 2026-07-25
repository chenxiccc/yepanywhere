import { useCallback, useMemo, useState } from "react";
import { CommittedRangeInput } from "../../components/ui/CommittedRangeInput";
import { useSessionLoadingProgress } from "../../hooks/useSessionLoadingProgress";
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
    sessionOffscreenTranscriptRenderingEnabled,
    sessionTranscriptCacheBudgetMb,
    sessionTranscriptCacheTtlHours,
    setSessionDomLingerEnabled,
    setSessionActiveWindowTrimEnabled,
    setSessionOffscreenTranscriptRenderingEnabled,
    setSessionTranscriptCacheBudgetMb,
    setSessionTranscriptCacheTtlHours,
  } = useSessionPerformanceSettings();
  const { stableToolPreviewRendering, setStableToolPreviewRendering } =
    useStableToolPreviewRendering();

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

  const undoState = useMemo(
    () => ({
      streamingEnabled,
      sessionLoadingProgressEnabled,
      sessionDomLingerEnabled,
      sessionActiveWindowTrimEnabled,
      sessionOffscreenTranscriptRenderingEnabled,
      sessionTranscriptCacheBudgetMb,
      sessionTranscriptCacheTtlHours,
      stableToolPreviewRendering,
    }),
    [
      streamingEnabled,
      sessionLoadingProgressEnabled,
      sessionDomLingerEnabled,
      sessionActiveWindowTrimEnabled,
      sessionOffscreenTranscriptRenderingEnabled,
      sessionTranscriptCacheBudgetMb,
      sessionTranscriptCacheTtlHours,
      stableToolPreviewRendering,
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
      setSessionOffscreenTranscriptRenderingEnabled(
        snapshot.sessionOffscreenTranscriptRenderingEnabled,
      );
      setSessionTranscriptCacheBudgetMb(
        snapshot.sessionTranscriptCacheBudgetMb,
      );
      setSessionTranscriptCacheTtlHours(
        snapshot.sessionTranscriptCacheTtlHours,
      );
      setStableToolPreviewRendering(snapshot.stableToolPreviewRendering);
    },
    [
      setStreamingEnabled,
      setSessionLoadingProgressEnabled,
      setSessionDomLingerEnabled,
      setSessionActiveWindowTrimEnabled,
      setSessionOffscreenTranscriptRenderingEnabled,
      setSessionTranscriptCacheBudgetMb,
      setSessionTranscriptCacheTtlHours,
      setStableToolPreviewRendering,
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
          label={t("performanceOffscreenTranscriptRenderingTitle")}
          description={t("performanceOffscreenTranscriptRenderingDescription")}
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={sessionOffscreenTranscriptRenderingEnabled}
              onChange={(event) =>
                setSessionOffscreenTranscriptRenderingEnabled(
                  event.target.checked,
                )
              }
              aria-label={t("performanceOffscreenTranscriptRenderingTitle")}
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
      </div>
    </SettingsSection>
  );
}
