import {
  GIT_SOURCE_REVIEW_SUBMISSIONS_CAPABILITY,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { useCallback, useMemo } from "react";
import { useServerSettings } from "../../hooks/useServerSettings";
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

  const undoState = useMemo(
    () => (settings ? { sourceReviewSubmissionsEnabled: enabled } : null),
    [enabled, settings],
  );
  const restoreUndoState = useCallback(
    (snapshot: NonNullable<typeof undoState>) => {
      void updateSettings({
        sourceReviewSubmissionsEnabled: snapshot.sourceReviewSubmissionsEnabled,
      }).catch(() => {
        // The hook keeps the actionable error visible in this pane.
      });
    },
    [updateSettings],
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
