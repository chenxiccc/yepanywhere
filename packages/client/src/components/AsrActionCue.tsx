import styles from "./AsrActionCue.module.css";

/** Keeps the delivery glyph intact while showing that the action is ASR-owned. */
export function AsrActionCue() {
  return (
    <span className={styles.cue} aria-hidden="true">
      ASR
    </span>
  );
}
