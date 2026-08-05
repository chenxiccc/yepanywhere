import { type ChangeEvent, useId } from "react";
import {
  MAX_SPEECH_ASR_ATTRIBUTION_MS,
  MAX_SPEECH_FOLLOW_UP_LISTEN_MS,
  MAX_SPEECH_MESSAGE_CUSTOM_PREFIX_LENGTH,
  type SpeechMessagePrefixMode,
  useSpeechCaptureSettings,
} from "../hooks/useSpeechCaptureSettings";
import { useI18n } from "../i18n";
import { CommittedRangeInput } from "./ui/CommittedRangeInput";
import styles from "./SpeechTimingControls.module.css";

interface SpeechTimingControlsProps {
  showFollowUp: boolean;
  disabled?: boolean;
}

export function SpeechTimingControls({
  showFollowUp,
  disabled = false,
}: SpeechTimingControlsProps) {
  const { t } = useI18n();
  const id = useId();
  const {
    followUpListenMs,
    setFollowUpListenMs,
    asrAttributionMs,
    setAsrAttributionMs,
    speechMessagePrefixMode,
    setSpeechMessagePrefixMode,
    speechMessageCustomPrefix,
    setSpeechMessageCustomPrefix,
    speechMessagePrefix,
  } = useSpeechCaptureSettings();
  const handlePrefixModeChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setSpeechMessagePrefixMode(event.target.value as SpeechMessagePrefixMode);
  };

  return (
    <div className={styles.root}>
      <div className={styles.control}>
        <label className={styles.heading} htmlFor={`${id}-prefix`}>
          {t("speechSettingsMessagePrefixTitle")}
        </label>
        <select
          id={`${id}-prefix`}
          className={styles.select}
          value={speechMessagePrefixMode}
          disabled={disabled}
          onChange={handlePrefixModeChange}
        >
          <option value="off">{t("commonOff")}</option>
          <option value="asr">[ASR]</option>
          <option value="stt">[STT]</option>
          <option value="dictation">[Dictation]</option>
          <option value="custom">
            {t("speechSettingsMessagePrefixCustom")}
          </option>
        </select>
        {speechMessagePrefixMode === "custom" && (
          <input
            className={styles.textInput}
            type="text"
            value={speechMessageCustomPrefix}
            maxLength={MAX_SPEECH_MESSAGE_CUSTOM_PREFIX_LENGTH}
            disabled={disabled}
            aria-label={t("speechSettingsMessagePrefixCustomLabel")}
            placeholder={t("speechSettingsMessagePrefixCustomPlaceholder")}
            onChange={(event) =>
              setSpeechMessageCustomPrefix(event.currentTarget.value)
            }
          />
        )}
        <p className={styles.hint}>
          {t("speechSettingsMessagePrefixDescription")}
        </p>
        {speechMessagePrefix && (
          <p className={styles.preview}>
            {t("speechSettingsMessagePrefixPreview", {
              example: `${speechMessagePrefix} ${t("speechSettingsMessagePrefixPreviewText")}`,
            })}
          </p>
        )}
      </div>
      {showFollowUp && (
        <div className={styles.control}>
          <div className={styles.heading}>
            <label htmlFor={`${id}-follow-up`}>
              {t("speechSettingsFollowUpListenTitle")}
            </label>
            <output htmlFor={`${id}-follow-up`} className={styles.value}>
              {followUpListenMs === 0
                ? t("commonOff")
                : t("speechDurationSeconds", {
                    seconds: Math.round(followUpListenMs / 1000),
                  })}
            </output>
          </div>
          <CommittedRangeInput
            id={`${id}-follow-up`}
            min="0"
            max={String(MAX_SPEECH_FOLLOW_UP_LISTEN_MS)}
            step="1000"
            value={followUpListenMs}
            disabled={disabled}
            onCommit={setFollowUpListenMs}
          />
          <p className={styles.hint}>
            {t("speechSettingsFollowUpListenDescription")}
          </p>
        </div>
      )}
      <div className={styles.control}>
        <div className={styles.heading}>
          <label htmlFor={`${id}-attribution`}>
            {t("speechSettingsAsrAttributionTitle")}
          </label>
          <output htmlFor={`${id}-attribution`} className={styles.value}>
            {asrAttributionMs === 0
              ? t("commonOff")
              : t("speechDurationMilliseconds", {
                  milliseconds: asrAttributionMs,
                })}
          </output>
        </div>
        <CommittedRangeInput
          id={`${id}-attribution`}
          min="0"
          max={String(MAX_SPEECH_ASR_ATTRIBUTION_MS)}
          step="100"
          value={asrAttributionMs}
          disabled={disabled || !speechMessagePrefix}
          onCommit={setAsrAttributionMs}
        />
        <p className={styles.hint}>
          {speechMessagePrefix
            ? t("speechSettingsAsrAttributionDescription", {
                prefix: speechMessagePrefix,
              })
            : t("speechSettingsAsrAttributionDisabledDescription")}
        </p>
      </div>
    </div>
  );
}
