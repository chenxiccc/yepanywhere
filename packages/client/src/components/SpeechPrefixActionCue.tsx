import { getSpeechPrefixCueLabel } from "../lib/speechMessagePrefix";
import styles from "./SpeechPrefixActionCue.module.css";

export function SpeechPrefixActionCue({ prefix }: { prefix: string }) {
  return (
    <span className={styles.cue} aria-hidden="true">
      {getSpeechPrefixCueLabel(prefix)}
    </span>
  );
}
