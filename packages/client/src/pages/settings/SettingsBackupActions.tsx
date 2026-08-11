import {
  BROWSER_SETTINGS_BACKUP_VERSION,
  type BrowserSettingsBackup,
} from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { useI18n } from "../../i18n";
import {
  applyBrowserSettingsBackup,
  captureBrowserSettings,
} from "../../lib/browserSettingsBackup";

type Operation = "fetching" | "saving" | "loading" | null;

function formatSavedAt(savedAt: string): string {
  const date = new Date(savedAt);
  return Number.isNaN(date.getTime()) ? savedAt : date.toLocaleString();
}

export function SettingsBackupActions() {
  const { t } = useI18n();
  const [backup, setBackup] = useState<BrowserSettingsBackup | null>(null);
  const [operation, setOperation] = useState<Operation>("fetching");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .getBrowserSettingsBackup()
      .then((response) => {
        if (!cancelled) setBackup(response.backup);
      })
      .catch(() => {
        if (!cancelled) setError(t("settingsBackupUnavailable"));
      })
      .finally(() => {
        if (!cancelled) setOperation(null);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const handleSave = async () => {
    setOperation("saving");
    setError(null);
    try {
      const response = await api.saveBrowserSettingsBackup({
        version: BROWSER_SETTINGS_BACKUP_VERSION,
        values: captureBrowserSettings(),
      });
      setBackup(response.backup);
    } catch {
      setError(t("settingsBackupSaveFailed"));
    } finally {
      setOperation(null);
    }
  };

  const handleLoad = () => {
    if (!backup || !window.confirm(t("settingsBackupLoadConfirm"))) return;
    setOperation("loading");
    setError(null);
    try {
      applyBrowserSettingsBackup(backup);
      window.location.reload();
    } catch {
      setError(t("settingsBackupLoadFailed"));
      setOperation(null);
    }
  };

  const status = error
    ? error
    : operation === "fetching"
      ? t("settingsBackupChecking")
      : backup
        ? t("settingsBackupSavedAt", { time: formatSavedAt(backup.savedAt) })
        : t("settingsBackupEmpty");

  return (
    <section
      className="settings-backup-actions"
      aria-label={t("settingsBackupTitle")}
    >
      <span className="settings-backup-title">{t("settingsBackupTitle")}</span>
      <span className="settings-backup-status">
        {t("settingsBackupDescription")}
      </span>
      <div className="settings-backup-buttons">
        <button
          type="button"
          className="settings-button"
          onClick={() => void handleSave()}
          disabled={operation !== null}
          title={t("settingsBackupSaveTooltip")}
        >
          {operation === "saving"
            ? t("settingsBackupSaving")
            : t("settingsBackupSave")}
        </button>
        <button
          type="button"
          className="settings-button"
          onClick={handleLoad}
          disabled={operation !== null || !backup}
          title={t("settingsBackupLoadTooltip")}
        >
          {operation === "loading"
            ? t("settingsBackupLoading")
            : t("settingsBackupLoad")}
        </button>
      </div>
      <span
        className={`settings-backup-status ${error ? "error" : ""}`}
        role={error ? "alert" : "status"}
      >
        {status}
      </span>
    </section>
  );
}
