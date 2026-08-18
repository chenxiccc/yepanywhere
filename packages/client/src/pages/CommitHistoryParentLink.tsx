import type { TranslationFn } from "../i18n";
import styles from "./CommitHistoryParentLink.module.css";

export function CommitHistoryParentLink({
  onClick,
  t,
}: {
  onClick: () => void;
  t: TranslationFn;
}) {
  return (
    <button type="button" className={styles.link} onClick={onClick}>
      <span aria-hidden="true">‹</span>
      <span>{t("sourceCommitHistory")}</span>
    </button>
  );
}
