import {
  GIT_SOURCE_REVIEW_SUBMISSIONS_CAPABILITY,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { useCallback, useMemo } from "react";
import { useServerSettings } from "../../hooks/useServerSettings";
import {
  type SourceControlCleanLanding,
  useSourceControlCleanLanding,
} from "../../hooks/useSourceControlCleanLanding";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { SettingsSection } from "./SettingsSection";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";

export function SourceControlSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("sourceControlSettingsTitle"));
  const { version } = useVersion();
  const supported = serverHasCapability(
    version,
    GIT_SOURCE_REVIEW_SUBMISSIONS_CAPABILITY,
  );
  const { settings, isLoading, error, updateSettings } = useServerSettings();
  const enabled = settings?.sourceReviewSubmissionsEnabled ?? false;
  const { sourceControlCleanLanding, setSourceControlCleanLanding } =
    useSourceControlCleanLanding();

  const undoState = useMemo(
    () =>
      settings
        ? {
            sourceControlCleanLanding,
            sourceReviewSubmissionsEnabled: enabled,
          }
        : null,
    [enabled, settings, sourceControlCleanLanding],
  );
  const restoreUndoState = useCallback(
    (snapshot: NonNullable<typeof undoState>) => {
      setSourceControlCleanLanding(snapshot.sourceControlCleanLanding);
      void updateSettings({
        sourceReviewSubmissionsEnabled: snapshot.sourceReviewSubmissionsEnabled,
      }).catch(() => {
        // The hook keeps the actionable error visible in this pane.
      });
    },
    [setSourceControlCleanLanding, updateSettings],
  );
  useSettingsUndoBaseline(undoState, restoreUndoState);

  if (!supported) return null;
  if (isLoading) {
    return <SettingsSection description={t("sourceControlSettingsLoading")} />;
  }

  return (
    <SettingsSection description={t("sourceControlSettingsDescription")}>
      <div className="settings-group">
        <SettingsItem
          className="settings-item--wide-control"
          label={t("sourceControlCleanLandingTitle")}
          description={t("sourceControlCleanLandingDescription")}
          valueText={
            sourceControlCleanLanding === "latest-commit"
              ? t("sourceControlCleanLandingLatestCommit")
              : t("sourceControlCleanLandingWorkingTree")
          }
        >
          <select
            className="settings-select"
            aria-label={t("sourceControlCleanLandingTitle")}
            value={sourceControlCleanLanding}
            onChange={(event) =>
              setSourceControlCleanLanding(
                event.target.value as SourceControlCleanLanding,
              )
            }
          >
            <option value="working-tree">
              {t("sourceControlCleanLandingWorkingTree")}
            </option>
            <option value="latest-commit">
              {t("sourceControlCleanLandingLatestCommit")}
            </option>
          </select>
        </SettingsItem>
        <SettingsItem
          as="label"
          label={t("sourceReviewSubmissionsSettingTitle")}
          description={t("sourceReviewSubmissionsSettingDescription")}
        >
          <span className="toggle-switch">
            <input
              type="checkbox"
              aria-label={t("sourceReviewSubmissionsSettingTitle")}
              checked={enabled}
              onChange={(event) => {
                void updateSettings({
                  sourceReviewSubmissionsEnabled: event.target.checked,
                }).catch(() => {
                  // The hook keeps the actionable error visible in this pane.
                });
              }}
            />
            <span className="toggle-slider" />
          </span>
        </SettingsItem>
      </div>
      {error && <p className="settings-error">{error}</p>}
    </SettingsSection>
  );
}
