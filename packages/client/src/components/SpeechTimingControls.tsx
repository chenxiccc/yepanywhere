import { useId } from "react";
import {
  MAX_SPEECH_ASR_ATTRIBUTION_MS,
  MAX_SPEECH_FOLLOW_UP_LISTEN_MS,
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
  } = useSpeechCaptureSettings();

  return (
    <div className={styles.root}>
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
          disabled={disabled}
          onCommit={setAsrAttributionMs}
        />
        <p className={styles.hint}>
          {t("speechSettingsAsrAttributionDescription")}
        </p>
      </div>
    </div>
  );
}
