import { useId } from "react";
import {
  MAX_SPEECH_FOLLOW_UP_LISTEN_MS,
  useSpeechCaptureSettings,
} from "../hooks/useSpeechCaptureSettings";
import { useI18n } from "../i18n";
import {
  cleanSpeechSmartTurnSettings,
  MAX_SPEECH_SMART_TURN_GRACE_MS,
  MAX_SPEECH_SMART_TURN_TIMEOUT_MS,
  type SpeechSmartTurnSettings,
} from "../lib/speechProviders/SpeechProvider";
import { RangeNumberRow } from "./ui/RangeNumberRow";
import styles from "./SpeechSmartTurnControls.module.css";

interface SpeechSmartTurnControlsProps {
  settings: SpeechSmartTurnSettings;
  onChange: (settings: SpeechSmartTurnSettings) => void;
  compact?: boolean;
  disabled?: boolean;
}

export function SpeechSmartTurnControls({
  settings,
  onChange,
  compact = false,
  disabled = false,
}: SpeechSmartTurnControlsProps) {
  const { t } = useI18n();
  const id = useId();
  const { followUpListenMs, setFollowUpListenMs } = useSpeechCaptureSettings();
  const clean = cleanSpeechSmartTurnSettings(settings);
  const update = (patch: Partial<SpeechSmartTurnSettings>) => {
    onChange(cleanSpeechSmartTurnSettings({ ...clean, ...patch }));
  };
  const activate = () => {
    if (!disabled && !clean.enabled) {
      update({ enabled: true });
    }
  };
  const body = (
    <div className={styles.body}>
      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={clean.enabled}
          disabled={disabled}
          onChange={(event) => update({ enabled: event.target.checked })}
        />
        <span>Smart Turn</span>
      </label>
      <RangeNumberRow
        id={`${id}-threshold`}
        label="Threshold"
        min={0}
        max={1}
        step={0.01}
        value={clean.threshold}
        disabled={disabled}
        numberAriaLabel="Smart Turn threshold"
        hint={t("speechSmartTurnThresholdHint")}
        onCommit={(threshold) => update({ enabled: true, threshold })}
        onActivate={activate}
      />
      <RangeNumberRow
        id={`${id}-timeout`}
        label="Timeout"
        min={0}
        max={MAX_SPEECH_SMART_TURN_TIMEOUT_MS}
        step={100}
        value={clean.timeoutMs}
        disabled={disabled}
        numberAriaLabel="Smart Turn timeout milliseconds"
        onCommit={(timeoutMs) => update({ enabled: true, timeoutMs })}
        onActivate={activate}
      />
      <RangeNumberRow
        id={`${id}-grace`}
        label={t("speechSmartTurnGraceLabel")}
        min={0}
        max={MAX_SPEECH_SMART_TURN_GRACE_MS}
        step={100}
        value={clean.graceMs}
        disabled={disabled}
        numberAriaLabel="Smart Turn command grace milliseconds"
        hint={t("speechSmartTurnGraceHint")}
        onCommit={(graceMs) => update({ enabled: true, graceMs })}
        onActivate={activate}
      />
      <RangeNumberRow
        id={`${id}-follow-up`}
        label={t("speechSettingsFollowUpListenTitle")}
        min={0}
        max={MAX_SPEECH_FOLLOW_UP_LISTEN_MS}
        step={1000}
        value={followUpListenMs}
        disabled={disabled}
        numberAriaLabel="Follow-up listening milliseconds"
        hint={t("speechSettingsFollowUpListenDescription")}
        onCommit={setFollowUpListenMs}
        onActivate={activate}
      />
      {clean.enabled && (
        <p className={styles.caption}>{t("speechSmartTurnCaption")}</p>
      )}
    </div>
  );

  if (compact) {
    return (
      <details className={`${styles.root} ${styles.compact}`}>
        <summary
          className={styles.summary}
          title="Grok STT Smart Turn controls"
        >
          Turn
        </summary>
        <div className={styles.popover}>{body}</div>
      </details>
    );
  }

  return <div className={styles.root}>{body}</div>;
}
