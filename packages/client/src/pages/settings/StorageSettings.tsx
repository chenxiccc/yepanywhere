import {
  PROJECT_DIRECTORY_STORAGE_POLICY_CAPABILITY,
  TOOL_RESULT_MEDIA_PRESERVATION_POLICY_CAPABILITY,
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
import styles from "./StorageSettings.module.css";

interface StorageChoiceProps {
  name: string;
  value: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  isDefault?: boolean;
  onChange: () => void;
}

function StorageChoice({
  name,
  value,
  label,
  description,
  checked,
  disabled,
  isDefault = false,
  onChange,
}: StorageChoiceProps) {
  const { t } = useI18n();
  return (
    <label
      className={`${styles.choice} ${checked ? styles.selected : ""}`.trim()}
    >
      <input
        type="radio"
        name={name}
        value={value}
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span className={styles.choiceText}>
        <span className={styles.choiceHeading}>
          <span>{label}</span>
          {isDefault && (
            <span className={styles.defaultBadge}>
              {t("storageChoiceDefault")}
            </span>
          )}
        </span>
        <span className={styles.choiceDescription}>{description}</span>
      </span>
    </label>
  );
}

export function StorageSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("storageSettingsTitle"));
  const { version } = useVersion();
  const supportsProjectLocation = serverHasCapability(
    version,
    PROJECT_DIRECTORY_STORAGE_POLICY_CAPABILITY,
  );
  const supportsMediaPreservation = serverHasCapability(
    version,
    TOOL_RESULT_MEDIA_PRESERVATION_POLICY_CAPABILITY,
  );
  const { settings, isLoading, error, updateSettings } = useServerSettings();
  const projectLocation = settings?.projectDirectoryStorage ?? "app-data";
  const mediaPreservation =
    settings?.toolResultMediaPreservation ?? "on-demand";

  const undoState = useMemo(
    () =>
      settings
        ? {
            projectLocation,
            mediaPreservation,
            supportsProjectLocation,
            supportsMediaPreservation,
          }
        : null,
    [
      mediaPreservation,
      projectLocation,
      settings,
      supportsMediaPreservation,
      supportsProjectLocation,
    ],
  );
  const restoreUndoState = useCallback(
    (snapshot: NonNullable<typeof undoState>) => {
      void updateSettings({
        ...(snapshot.supportsProjectLocation
          ? { projectDirectoryStorage: snapshot.projectLocation }
          : {}),
        ...(snapshot.supportsMediaPreservation
          ? { toolResultMediaPreservation: snapshot.mediaPreservation }
          : {}),
      }).catch(() => {
        // The hook keeps the actionable error visible in this pane.
      });
    },
    [updateSettings],
  );
  useSettingsUndoBaseline(undoState, restoreUndoState);

  if (isLoading) {
    return <SettingsSection description={t("storageSettingsLoading")} />;
  }

  return (
    <SettingsSection
      description={t("storageSettingsDescription")}
      keywords={[".yep", ".attachments", "YEP_DATA_DIR"]}
    >
      <div className="settings-group">
        <SettingsItem
          id="project-data-location"
          className={styles.setting}
          label={t("projectDataLocationTitle")}
          description={t("projectDataLocationDescription")}
          keywords={[".yep", ".attachments", "YEP_DATA_DIR"]}
          valueText={
            projectLocation === "project"
              ? t("projectDataLocationProject")
              : t("projectDataLocationAppData")
          }
          after={
            supportsProjectLocation ? null : (
              <p className="settings-warning">
                {t("projectDataLocationUpdateRequired")}
              </p>
            )
          }
        >
          <fieldset
            className={styles.choices}
            aria-label={t("projectDataLocationTitle")}
          >
            <StorageChoice
              name="project-data-location"
              value="app-data"
              label={t("projectDataLocationAppData")}
              description={t("projectDataLocationAppDataDescription")}
              checked={
                supportsProjectLocation && projectLocation === "app-data"
              }
              disabled={!supportsProjectLocation}
              isDefault
              onChange={() => {
                void updateSettings({
                  projectDirectoryStorage: "app-data",
                }).catch(() => {
                  // The hook keeps the actionable error visible in this pane.
                });
              }}
            />
            <StorageChoice
              name="project-data-location"
              value="project"
              label={t("projectDataLocationProject")}
              description={t("projectDataLocationProjectDescription")}
              checked={supportsProjectLocation && projectLocation === "project"}
              disabled={!supportsProjectLocation}
              onChange={() => {
                void updateSettings({
                  projectDirectoryStorage: "project",
                }).catch(() => {
                  // The hook keeps the actionable error visible in this pane.
                });
              }}
            />
          </fieldset>
        </SettingsItem>

        <SettingsItem
          id="tool-result-images"
          className={styles.setting}
          label={t("toolResultImagesStorageTitle")}
          description={t("toolResultImagesStorageDescription")}
          keywords={["tool results", "image", "preserve", "storage"]}
          valueText={
            mediaPreservation === "preserve"
              ? t("toolResultImagesPreserve")
              : t("toolResultImagesOnDemand")
          }
          after={
            supportsMediaPreservation ? null : (
              <p className="settings-warning">
                {t("toolResultImagesUpdateRequired")}
              </p>
            )
          }
        >
          <fieldset
            className={styles.choices}
            aria-label={t("toolResultImagesStorageTitle")}
          >
            <StorageChoice
              name="tool-result-images"
              value="on-demand"
              label={t("toolResultImagesOnDemand")}
              description={t("toolResultImagesOnDemandDescription")}
              checked={
                supportsMediaPreservation && mediaPreservation === "on-demand"
              }
              disabled={!supportsMediaPreservation}
              isDefault
              onChange={() => {
                void updateSettings({
                  toolResultMediaPreservation: "on-demand",
                }).catch(() => {
                  // The hook keeps the actionable error visible in this pane.
                });
              }}
            />
            <StorageChoice
              name="tool-result-images"
              value="preserve"
              label={t("toolResultImagesPreserve")}
              description={t("toolResultImagesPreserveDescription")}
              checked={
                supportsMediaPreservation && mediaPreservation === "preserve"
              }
              disabled={!supportsMediaPreservation}
              onChange={() => {
                void updateSettings({
                  toolResultMediaPreservation: "preserve",
                }).catch(() => {
                  // The hook keeps the actionable error visible in this pane.
                });
              }}
            />
          </fieldset>
        </SettingsItem>
      </div>
      {error && <p className="settings-warning">{error}</p>}
    </SettingsSection>
  );
}
