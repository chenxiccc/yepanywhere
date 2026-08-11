import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useSchemaValidationContext } from "../../contexts/SchemaValidationContext";
import { useDeveloperMode } from "../../hooks/useDeveloperMode";
import { useReloadNotifications } from "../../hooks/useReloadNotifications";
import { useRemoteBasePath } from "../../hooks/useRemoteBasePath";
import { useSchemaValidation } from "../../hooks/useSchemaValidation";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useSessionPerformanceSettings } from "../../hooks/useSessionPerformanceSettings";
import { useI18n } from "../../i18n";
import {
  SESSION_SCROLL_BEHAVIOR_MODES,
  type SessionScrollBehaviorMode,
} from "../../lib/sessionScrollBehavior";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { HideInSettingsSearch } from "./SettingsSearchContext";
import { SettingsSection } from "./SettingsSection";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";

type SessionScrollMemoryModeDescriptionKey =
  | "developmentSessionScrollMemoryModeLiveTailDescription"
  | "developmentSessionScrollMemoryModeRememberPlaceDescription"
  | "developmentSessionScrollMemoryModeManualFollowDescription"
  | "developmentSessionScrollMemoryModeNoMemoryDescription";

type SessionScrollMemoryModeLabelKey =
  | "developmentSessionScrollMemoryModeLiveTail"
  | "developmentSessionScrollMemoryModeRememberPlace"
  | "developmentSessionScrollMemoryModeManualFollow"
  | "developmentSessionScrollMemoryModeNoMemory";

const sessionScrollMemoryModeDescriptionKeys: Record<
  SessionScrollBehaviorMode,
  SessionScrollMemoryModeDescriptionKey
> = {
  "live-tail": "developmentSessionScrollMemoryModeLiveTailDescription",
  "remember-place":
    "developmentSessionScrollMemoryModeRememberPlaceDescription",
  "manual-follow": "developmentSessionScrollMemoryModeManualFollowDescription",
  "no-memory": "developmentSessionScrollMemoryModeNoMemoryDescription",
};

const sessionScrollMemoryModeLabelKeys: Record<
  SessionScrollBehaviorMode,
  SessionScrollMemoryModeLabelKey
> = {
  "live-tail": "developmentSessionScrollMemoryModeLiveTail",
  "remember-place": "developmentSessionScrollMemoryModeRememberPlace",
  "manual-follow": "developmentSessionScrollMemoryModeManualFollow",
  "no-memory": "developmentSessionScrollMemoryModeNoMemory",
};

export function DevelopmentSettings() {
  const { t } = useI18n();
  const basePath = useRemoteBasePath();
  useSettingsPaneTitle(t("developmentSectionTitle"));
  const {
    isManualReloadMode,
    pendingReloads,
    connected,
    reloadBackend,
    unsafeToRestart,
    interruptibleSessionCount,
    queuedSessionMessageCount,
  } = useReloadNotifications();
  const { settings: validationSettings, setEnabled: setValidationEnabled } =
    useSchemaValidation();
  const {
    crossHostDelegationEnabled,
    setCrossHostDelegationEnabled,
    multiHostMonitorEnabled,
    setMultiHostMonitorEnabled,
    relayDebugEnabled,
    setRelayDebugEnabled,
    remoteLogCollectionEnabled,
    setRemoteLogCollectionEnabled,
  } = useDeveloperMode();
  const { sessionScrollBehaviorMode, setSessionScrollBehaviorMode } =
    useSessionPerformanceSettings();
  const { ignoredTools, clearIgnoredTools } = useSchemaValidationContext();
  const { settings: serverSettings, updateSetting: updateServerSetting } =
    useServerSettings();

  const undoState = useMemo(
    () =>
      serverSettings
        ? {
            validationEnabled: validationSettings.enabled,
            crossHostDelegationEnabled,
            multiHostMonitorEnabled,
            relayDebugEnabled,
            remoteLogCollectionEnabled,
            sessionScrollBehaviorMode,
            serviceWorkerEnabled: serverSettings.serviceWorkerEnabled ?? true,
            workstreamsEnabled: serverSettings.workstreamsEnabled ?? false,
          }
        : null,
    [
      validationSettings.enabled,
      crossHostDelegationEnabled,
      multiHostMonitorEnabled,
      relayDebugEnabled,
      remoteLogCollectionEnabled,
      serverSettings,
      sessionScrollBehaviorMode,
    ],
  );
  const restoreUndoState = useCallback(
    (snapshot: NonNullable<typeof undoState>) => {
      setValidationEnabled(snapshot.validationEnabled);
      setCrossHostDelegationEnabled(snapshot.crossHostDelegationEnabled);
      setMultiHostMonitorEnabled(snapshot.multiHostMonitorEnabled);
      setRelayDebugEnabled(snapshot.relayDebugEnabled);
      setRemoteLogCollectionEnabled(snapshot.remoteLogCollectionEnabled);
      setSessionScrollBehaviorMode(snapshot.sessionScrollBehaviorMode);
      void updateServerSetting(
        "serviceWorkerEnabled",
        snapshot.serviceWorkerEnabled,
      );
      void updateServerSetting(
        "workstreamsEnabled",
        snapshot.workstreamsEnabled,
      );
    },
    [
      setValidationEnabled,
      setCrossHostDelegationEnabled,
      setMultiHostMonitorEnabled,
      setRelayDebugEnabled,
      setRemoteLogCollectionEnabled,
      setSessionScrollBehaviorMode,
      updateServerSetting,
    ],
  );
  useSettingsUndoBaseline(undoState, restoreUndoState);

  const [restarting, setRestarting] = useState(false);
  // When SSE reconnects after restart, re-enable the button
  useEffect(() => {
    if (restarting && connected) {
      setRestarting(false);
    }
  }, [restarting, connected]);

  const handleRestartServer = async () => {
    setRestarting(true);
    await reloadBackend();
  };

  const restartWarning =
    interruptibleSessionCount > 0 && queuedSessionMessageCount > 0
      ? t("developmentInterruptedWarningActiveAndQueued", {
          activeCount: interruptibleSessionCount,
          activeSuffix: interruptibleSessionCount !== 1 ? "s" : "",
          queuedCount: queuedSessionMessageCount,
          queuedSuffix: queuedSessionMessageCount !== 1 ? "s" : "",
        })
      : queuedSessionMessageCount > 0
        ? t("developmentInterruptedWarningQueued", {
            count: queuedSessionMessageCount,
            suffix: queuedSessionMessageCount !== 1 ? "s" : "",
          })
        : t("developmentInterruptedWarning", {
            count: interruptibleSessionCount,
            suffix: interruptibleSessionCount !== 1 ? "s " : " ",
          });

  return (
    <SettingsSection>
      <div className="settings-group">
        <SettingsItem
          label={t("developmentSchemaTitle")}
          description={t("developmentSchemaDescription")}
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={validationSettings.enabled}
              onChange={(e) => setValidationEnabled(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
        {ignoredTools.length > 0 && (
          <SettingsItem
            label={t("developmentIgnoredToolsTitle")}
            description={t("developmentIgnoredToolsDescription")}
            info={
              <>
                <strong>{t("developmentIgnoredToolsTitle")}</strong>
                <p>{t("developmentIgnoredToolsDescription")}</p>
                <div className="ignored-tools-list">
                  {ignoredTools.map((tool) => (
                    <span key={tool} className="ignored-tool-badge">
                      {tool}
                    </span>
                  ))}
                </div>
              </>
            }
          >
            <button
              type="button"
              className="settings-button settings-button-secondary"
              onClick={clearIgnoredTools}
            >
              {t("developmentClearIgnored")}
            </button>
          </SettingsItem>
        )}
        <SettingsItem
          label={t("developmentCrossHostDelegationTitle")}
          description={t("developmentCrossHostDelegationDescription")}
          className="settings-item--wide-control"
        >
          <div className="settings-item-actions">
            {crossHostDelegationEnabled && (
              <Link
                className="settings-button settings-button-secondary"
                to={`${basePath}/-/hosts`}
              >
                {t("developmentHostsPreviewOpen")}
              </Link>
            )}
            <label className="toggle-switch">
              <input
                type="checkbox"
                aria-label={t("developmentCrossHostDelegationTitle")}
                checked={crossHostDelegationEnabled}
                onChange={(event) =>
                  setCrossHostDelegationEnabled(event.target.checked)
                }
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </SettingsItem>
        <SettingsItem
          label={t("developmentMultiHostMonitorTitle")}
          description={t("developmentMultiHostMonitorDescription")}
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              aria-label={t("developmentMultiHostMonitorTitle")}
              checked={multiHostMonitorEnabled}
              onChange={(event) =>
                setMultiHostMonitorEnabled(event.target.checked)
              }
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
        <SettingsItem
          label={t("developmentRelayDebugTitle")}
          description={t("developmentRelayDebugDescription")}
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              aria-label={t("developmentRelayDebugTitle")}
              checked={relayDebugEnabled}
              onChange={(e) => setRelayDebugEnabled(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
        <SettingsItem
          label={t("developmentDiagnosticsTitle")}
          description={t("developmentDiagnosticsDescription")}
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={remoteLogCollectionEnabled}
              onChange={(e) => setRemoteLogCollectionEnabled(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
        <SettingsItem
          label={t("developmentServiceWorkerTitle")}
          description={t("developmentServiceWorkerDescription")}
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={serverSettings?.serviceWorkerEnabled ?? true}
              onChange={(e) =>
                updateServerSetting("serviceWorkerEnabled", e.target.checked)
              }
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
        <SettingsItem
          label={t("developmentWorkstreamsTitle")}
          description={t("developmentWorkstreamsDescription")}
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={serverSettings?.workstreamsEnabled ?? false}
              onChange={(e) =>
                updateServerSetting("workstreamsEnabled", e.target.checked)
              }
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
      </div>

      <HideInSettingsSearch>
        <div className="settings-group">
          <details>
            <summary className="settings-hint">
              <strong>{t("developmentSessionScrollMemoryTitle")}</strong>
            </summary>
            <SettingsItem
              label={t("developmentSessionScrollMemoryControlTitle")}
              description={t("developmentSessionScrollMemoryDescription")}
              valueText={t(
                sessionScrollMemoryModeLabelKeys[sessionScrollBehaviorMode],
              )}
              className="settings-item--wide-control"
              info={
                <>
                  <strong>
                    {t("developmentSessionScrollMemoryControlTitle")}
                  </strong>
                  <p>{t("developmentSessionScrollMemoryDescription")}</p>
                  <ul className="settings-option-description-list">
                    {SESSION_SCROLL_BEHAVIOR_MODES.map((mode) => (
                      <li key={mode}>
                        <strong>
                          {t(sessionScrollMemoryModeLabelKeys[mode])}
                        </strong>
                        <span>
                          {t(sessionScrollMemoryModeDescriptionKeys[mode])}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              }
            >
              <div className="settings-item-actions">
                <select
                  className="settings-select"
                  value={sessionScrollBehaviorMode}
                  onChange={(event) =>
                    setSessionScrollBehaviorMode(
                      event.target.value as SessionScrollBehaviorMode,
                    )
                  }
                  aria-label={t("developmentSessionScrollMemoryControlTitle")}
                >
                  {SESSION_SCROLL_BEHAVIOR_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {t(sessionScrollMemoryModeLabelKeys[mode])}
                    </option>
                  ))}
                </select>
              </div>
            </SettingsItem>
          </details>
        </div>
      </HideInSettingsSearch>

      {isManualReloadMode && (
        <div className="settings-group">
          <SettingsItem
            label={t("developmentRestartTitle")}
            description={t("developmentRestartDescription")}
            info={
              <>
                <strong>{t("developmentRestartTitle")}</strong>
                <p>
                  {t("developmentRestartDescription")}
                  {pendingReloads.backend && (
                    <span className="settings-pending">
                      {" "}
                      {t("developmentChangesPending")}
                    </span>
                  )}
                </p>
                {unsafeToRestart && (
                  <p className="settings-warning">{restartWarning}</p>
                )}
              </>
            }
          >
            <button
              type="button"
              className={`settings-button ${unsafeToRestart ? "settings-button-danger" : ""}`}
              onClick={handleRestartServer}
              disabled={restarting}
            >
              {restarting
                ? t("developmentRestarting")
                : unsafeToRestart
                  ? t("developmentRestartAnyway")
                  : t("developmentRestart")}
            </button>
          </SettingsItem>
        </div>
      )}
    </SettingsSection>
  );
}
