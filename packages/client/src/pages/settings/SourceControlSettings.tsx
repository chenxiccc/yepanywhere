import {
  GIT_SOURCE_REVIEW_SUBMISSIONS_CAPABILITY,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { SettingsSection } from "./SettingsSection";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";

const DEFAULT_RESPONSE_TURNS = 8;
const MIN_RESPONSE_TURNS = 1;
const MAX_RESPONSE_TURNS = 32;

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
  const responseTurns =
    settings?.sourceReviewResponseTurns ?? DEFAULT_RESPONSE_TURNS;
  const [turnsDraft, setTurnsDraft] = useState<string | null>(null);

  useEffect(() => {
    if (turnsDraft === String(responseTurns)) setTurnsDraft(null);
  }, [responseTurns, turnsDraft]);

  const undoState = useMemo(
    () =>
      settings
        ? { sourceReviewSubmissionsEnabled: enabled, responseTurns }
        : null,
    [enabled, responseTurns, settings],
  );
  const restoreUndoState = useCallback(
    (snapshot: NonNullable<typeof undoState>) => {
      setTurnsDraft(null);
      void updateSettings({
        sourceReviewSubmissionsEnabled:
          snapshot.sourceReviewSubmissionsEnabled,
        sourceReviewResponseTurns: snapshot.responseTurns,
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

  const commitResponseTurns = () => {
    const parsed = Number(turnsDraft ?? responseTurns);
    if (
      !Number.isInteger(parsed) ||
      parsed < MIN_RESPONSE_TURNS ||
      parsed > MAX_RESPONSE_TURNS
    ) {
      setTurnsDraft(null);
      return;
    }
    setTurnsDraft(String(parsed));
    void updateSettings({ sourceReviewResponseTurns: parsed }).catch(() => {
      // The hook keeps the actionable error visible in this pane.
    });
  };

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
        <SettingsItem
          label={t("sourceReviewResponseTurnsSettingTitle")}
          description={t("sourceReviewResponseTurnsSettingDescription")}
          valueText={String(responseTurns)}
        >
          <input
            type="number"
            className="settings-input-small output-appearance-number"
            aria-label={t("sourceReviewResponseTurnsSettingTitle")}
            min={MIN_RESPONSE_TURNS}
            max={MAX_RESPONSE_TURNS}
            value={turnsDraft ?? String(responseTurns)}
            onChange={(event) => setTurnsDraft(event.target.value)}
            onBlur={commitResponseTurns}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </SettingsItem>
      </div>
      {error && <p className="settings-error">{error}</p>}
    </SettingsSection>
  );
}
