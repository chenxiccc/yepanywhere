import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fetchJSON, type VersionInfo } from "../../api/client";
import { RemoteCompatibilityNoticeCard } from "../../components/RemoteCompatibilityNotices";
import { useOptionalRemoteConnection } from "../../contexts/RemoteConnectionContext";
import { useRemoteCompatibilityNoticeDismissals } from "../../hooks/useRemoteCompatibilityNoticeDismissals";
import { useOnboarding } from "../../hooks/useOnboarding";
import { usePwaInstall } from "../../hooks/usePwaInstall";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import {
  activityBus,
  getInterruptibleSessionCount,
  type WorkerActivityEvent,
} from "../../lib/activityBus";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { HideInSettingsSearch } from "./SettingsSearchContext";
import { SettingsSection } from "./SettingsSection";
import {
  formatRemoteServerVersion,
  getRemoteCompatibilityNotices,
  parseSemver,
} from "../../lib/remoteCompatibilityNotices";
import {
  formatDesktopBuildVersion,
  getDesktopRuntimeMetadata,
} from "../../lib/desktopRuntime";

export function AboutSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("aboutTitle"));
  const { canInstall, isInstalled, install } = usePwaInstall();
  const {
    version: versionInfo,
    loading: versionLoading,
    error: versionError,
    refetchFresh: refetchVersionFresh,
  } = useVersion({ freshOnMount: true });
  const remoteConnection = useOptionalRemoteConnection();
  const { resetOnboarding } = useOnboarding();
  const desktopRuntime = getDesktopRuntimeMetadata();
  const currentRelayUsername = remoteConnection?.currentRelayUsername ?? null;
  const getNoticesForVersion = useCallback(
    (candidate: VersionInfo | null) => {
      if (!candidate) return [];

      return getRemoteCompatibilityNotices({
        currentVersion: candidate?.current ?? null,
        latestVersion: candidate?.latest ?? null,
        updateAvailable: candidate?.updateAvailable ?? false,
        installSource: candidate?.installSource,
        resumeProtocolVersion: candidate?.resumeProtocolVersion,
        remoteCompatibilityLevel: candidate?.remoteCompatibilityLevel,
        capabilities: candidate?.capabilities,
        relayUsername: currentRelayUsername,
      });
    },
    [currentRelayUsername],
  );
  const remoteCompatibilityNotices = useMemo(
    () => getNoticesForVersion(versionInfo),
    [getNoticesForVersion, versionInfo],
  );
  const remoteCompatibilityNotice = remoteCompatibilityNotices[0];
  const {
    dismissedNotices: dismissedRemoteCompatibilityNotices,
    restoreNotices: restoreRemoteCompatibilityNotices,
    visibleNotices: visibleRemoteCompatibilityNotices,
  } = useRemoteCompatibilityNoticeDismissals(remoteCompatibilityNotices);
  const inlineRemoteCompatibilityNotice =
    visibleRemoteCompatibilityNotices.length === 0
      ? dismissedRemoteCompatibilityNotices[0]
      : null;

  // Server restart state
  const [restarting, setRestarting] = useState(false);
  const [interruptibleSessionCount, setInterruptibleSessionCount] = useState(0);

  // Fetch worker activity on mount
  useEffect(() => {
    fetchJSON<WorkerActivityEvent>("/status/workers")
      .then((data) =>
        setInterruptibleSessionCount(getInterruptibleSessionCount(data)),
      )
      .catch(() => {});
    return activityBus.on("worker-activity-changed", (data) => {
      setInterruptibleSessionCount(getInterruptibleSessionCount(data));
    });
  }, []);

  // When activity bus reconnects after restart, clear restarting state
  useEffect(() => {
    if (!restarting) return;
    return activityBus.on("reconnect", () => {
      setRestarting(false);
    });
  }, [restarting]);

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try {
      await api.restartServer();
    } catch {
      // Expected - server drops connection during restart
    }
  }, []);

  const handleShowRemoteCompatibilityBanner = useCallback(() => {
    restoreRemoteCompatibilityNotices(remoteCompatibilityNotices);
  }, [remoteCompatibilityNotices, restoreRemoteCompatibilityNotices]);

  const handleCheckUpdates = useCallback(async () => {
    const freshVersion = await refetchVersionFresh();
    restoreRemoteCompatibilityNotices(
      getNoticesForVersion(freshVersion ?? versionInfo),
    );
  }, [
    getNoticesForVersion,
    refetchVersionFresh,
    restoreRemoteCompatibilityNotices,
    versionInfo,
  ]);

  return (
    <SettingsSection>
      <div className="settings-group">
        {/* Only show Install option if install is possible or already installed */}
        {(canInstall || isInstalled) && (
          <SettingsItem
            label={t("aboutInstallTitle")}
            description={
              isInstalled
                ? t("aboutInstalledDescription")
                : t("aboutInstallDescription")
            }
          >
            {isInstalled ? (
              <span className="settings-status-badge">
                {t("aboutInstalled")}
              </span>
            ) : (
              <button
                type="button"
                className="settings-button"
                onClick={install}
              >
                {t("aboutInstall")}
              </button>
            )}
          </SettingsItem>
        )}
        <HideInSettingsSearch>
          <div className="settings-item settings-version-item">
            <div className="settings-version-item__row">
              <div className="settings-item-info">
                <strong>{t("aboutVersionTitle")}</strong>
                {desktopRuntime ? (
                  <>
                    <p>
                      {t("aboutDesktopVersion")}{" "}
                      {formatDesktopBuildVersion(desktopRuntime.desktopVersion)}
                    </p>
                    <p>
                      {t("aboutBundledYaVersion")}{" "}
                      {formatDesktopBuildVersion(
                        desktopRuntime.bundledYaVersion ?? __APP_VERSION__,
                      )}
                    </p>
                  </>
                ) : (
                  <>
                    <p>
                      {t("aboutServerVersion")}{" "}
                      {versionInfo ? (
                        <>
                          {formatRemoteServerVersion(
                            versionInfo.current,
                            versionInfo.installSource,
                          )}
                          {parseSemver(versionInfo.current) &&
                          versionInfo.updateAvailable &&
                          versionInfo.latest ? (
                            <span className="settings-update-available">
                              {" "}
                              {t("aboutVersionAvailable", {
                                version: versionInfo.latest,
                              })}
                            </span>
                          ) : parseSemver(versionInfo.current) &&
                            versionInfo.latest ? (
                            <span className="settings-up-to-date">
                              {" "}
                              {t("aboutUpToDate")}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        t("loginLoading")
                      )}
                    </p>
                    <p>
                      {t("aboutClientVersion")} v{__APP_VERSION__}
                    </p>
                  </>
                )}
                {versionError && (
                  <p className="settings-warning">{t("aboutUnableRefresh")}</p>
                )}
                {versionInfo?.updateAvailable && !remoteCompatibilityNotice && (
                  <p className="settings-update-hint">{t("aboutUpdateHint")}</p>
                )}
              </div>
              <div className="settings-item-actions">
                <button
                  type="button"
                  className="settings-button"
                  onClick={() => void handleCheckUpdates()}
                  disabled={versionLoading}
                >
                  {versionLoading ? t("aboutChecking") : t("aboutCheckUpdates")}
                </button>
              </div>
            </div>
            {inlineRemoteCompatibilityNotice && (
              <RemoteCompatibilityNoticeCard
                notice={inlineRemoteCompatibilityNotice}
                noticeCount={remoteCompatibilityNotices.length}
                placement="inline"
                onRestore={handleShowRemoteCompatibilityBanner}
              />
            )}
          </div>
        </HideInSettingsSearch>
        <SettingsItem
          label={t("developmentRestartTitle")}
          description={t("developmentRestartDescription")}
          info={
            <>
              <strong>{t("developmentRestartTitle")}</strong>
              <p>{t("developmentRestartDescription")}</p>
              {interruptibleSessionCount > 0 && !restarting && (
                <p className="settings-warning">
                  {t("developmentInterruptedWarning", {
                    count: interruptibleSessionCount,
                    suffix: interruptibleSessionCount !== 1 ? "s " : " ",
                  })}
                </p>
              )}
            </>
          }
        >
          <button
            type="button"
            className={`settings-button ${interruptibleSessionCount > 0 ? "settings-button-danger" : ""}`}
            onClick={handleRestart}
            disabled={restarting}
          >
            {restarting
              ? t("developmentRestarting")
              : interruptibleSessionCount > 0
                ? t("developmentRestartAnyway")
                : t("developmentRestart")}
          </button>
        </SettingsItem>
        <SettingsItem
          label={t("aboutReportBugTitle")}
          description={t("aboutReportBugDescription")}
        >
          <a
            href="https://github.com/kzahel/yepanywhere/issues"
            target="_blank"
            rel="noopener noreferrer"
            className="settings-button"
          >
            {t("aboutReportBug")}
          </a>
        </SettingsItem>
        <SettingsItem
          label={t("aboutSetupWizardTitle")}
          description={t("aboutSetupWizardDescription")}
        >
          <button
            type="button"
            className="settings-button"
            onClick={resetOnboarding}
          >
            {t("aboutLaunchWizard")}
          </button>
        </SettingsItem>
      </div>
    </SettingsSection>
  );
}
