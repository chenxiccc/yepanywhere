import {
  DEFAULT_HEARTBEAT_TURN_TEXT,
  DEFAULT_HEARTBEAT_TURNS_AFTER_MINUTES,
  MAX_HEARTBEAT_TURN_TEXT_LENGTH,
} from "@yep-anywhere/shared";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useServerSettings } from "../hooks/useServerSettings";
import { useI18n } from "../i18n";
import { HeartbeatTextArea } from "./HeartbeatTextArea";
import styles from "./ProjectSessionDefaultsModal.module.css";
import { Modal } from "./ui/Modal";

interface ProjectSessionDefaultsModalProps {
  projectId: string;
  projectName?: string;
  onClose: () => void;
}

export function ProjectSessionDefaultsModal({
  projectId,
  projectName,
  onClose,
}: ProjectSessionDefaultsModalProps) {
  const { t } = useI18n();
  const { settings } = useServerSettings();
  const globalMinutes =
    settings?.heartbeatTurnsAfterMinutes ??
    DEFAULT_HEARTBEAT_TURNS_AFTER_MINUTES;
  const globalText = settings?.heartbeatTurnText ?? DEFAULT_HEARTBEAT_TURN_TEXT;
  const [inheritMinutes, setInheritMinutes] = useState(true);
  const [minutes, setMinutes] = useState(String(globalMinutes));
  const [inheritText, setInheritText] = useState(true);
  const [text, setText] = useState("");
  const [recentTexts, setRecentTexts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api
      .getProjectSessionDefaults(projectId)
      .then((response) => {
        if (cancelled) return;
        const savedMinutes = response.overrides.heartbeatTurnsAfterMinutes;
        const savedText = response.overrides.heartbeatTurnText;
        setInheritMinutes(savedMinutes === null);
        setMinutes(String(savedMinutes ?? globalMinutes));
        setInheritText(savedText === null);
        setText(savedText ?? "");
        setRecentTexts(response.recentHeartbeatTurnTexts);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(
            reason instanceof Error
              ? reason.message
              : t("projectSettingsLoadFailed"),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [globalMinutes, projectId, t]);

  const parsedMinutes = Number(minutes);
  const invalidMinutes =
    !inheritMinutes &&
    (!Number.isInteger(parsedMinutes) ||
      parsedMinutes < 1 ||
      parsedMinutes > 1440);
  const invalidText = !inheritText && text.trim().length === 0;
  const canSave = !loading && !saving && !invalidMinutes && !invalidText;
  const title = useMemo(
    () =>
      projectName
        ? t("projectSettingsTitleNamed", { project: projectName })
        : t("projectSettingsTitle"),
    [projectName, t],
  );

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await api.updateProjectSessionDefaults(projectId, {
        heartbeatTurnsAfterMinutes: inheritMinutes ? null : parsedMinutes,
        heartbeatTurnText: inheritText ? null : text.trim(),
      });
      onClose();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t("projectSettingsSaveFailed"),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      <div className={styles.body}>
        <p className={styles.intro}>{t("projectSettingsHeartbeatIntro")}</p>

        <section className={styles.section}>
          <div className={styles.headingRow}>
            <div>
              <h3>{t("projectSettingsHeartbeatInterval")}</h3>
              <p>{t("projectSettingsHeartbeatIntervalDescription")}</p>
            </div>
            <label className={styles.inheritToggle}>
              <input
                type="checkbox"
                checked={inheritMinutes}
                disabled={loading}
                onChange={(event) => setInheritMinutes(event.target.checked)}
              />
              <span>
                {t("projectSettingsUseGlobalMinutes", {
                  minutes: globalMinutes,
                })}
              </span>
            </label>
          </div>
          <label className={styles.numberField}>
            <span>{t("projectSettingsMinutes")}</span>
            <input
              type="number"
              min={1}
              max={1440}
              value={minutes}
              disabled={loading || inheritMinutes}
              onChange={(event) => setMinutes(event.target.value)}
            />
          </label>
        </section>

        <section className={styles.section}>
          <div className={styles.headingRow}>
            <div>
              <h3>{t("projectSettingsHeartbeatMessage")}</h3>
              <p>{t("projectSettingsHeartbeatMessageDescription")}</p>
            </div>
            <label className={styles.inheritToggle}>
              <input
                type="checkbox"
                checked={inheritText}
                disabled={loading}
                onChange={(event) => {
                  const inherit = event.target.checked;
                  setInheritText(inherit);
                  if (!inherit && !text.trim()) setText(globalText);
                }}
              />
              <span>{t("projectSettingsUseGlobalMessage")}</span>
            </label>
          </div>
          {recentTexts.length > 0 && (
            <label className={styles.recentField}>
              <span>{t("projectSettingsRecentMessages")}</span>
              <select
                value=""
                disabled={loading}
                onChange={(event) => {
                  if (!event.target.value) return;
                  setText(event.target.value);
                  setInheritText(false);
                }}
              >
                <option value="">{t("projectSettingsChooseRecent")}</option>
                {recentTexts.map((recent) => (
                  <option key={recent} value={recent}>
                    {recent}
                  </option>
                ))}
              </select>
            </label>
          )}
          <HeartbeatTextArea
            value={text}
            disabled={loading || inheritText}
            placeholder={globalText}
            aria-label={t("projectSettingsHeartbeatMessage")}
            className={styles.textarea}
            onChange={(value) => {
              setText(value);
              setInheritText(false);
            }}
          />
          <div className={styles.textMeta}>
            <span>{t("projectSettingsMessageHint")}</span>
            <span>
              {text.length.toLocaleString()} /{" "}
              {MAX_HEARTBEAT_TURN_TEXT_LENGTH.toLocaleString()}
            </span>
          </div>
        </section>

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={onClose}>
            {t("cancel")}
          </button>
          <button
            type="button"
            className={styles.primary}
            disabled={!canSave}
            onClick={() => void handleSave()}
          >
            {saving ? t("providersSaving") : t("providersSave")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
