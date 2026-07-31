import type { TranslationFn } from "../i18n";

export function CommitHistoryParentLink({
  onClick,
  t,
}: {
  onClick: () => void;
  t: TranslationFn;
}) {
  return (
    <button
      type="button"
      className="source-history-parent-link"
      onClick={onClick}
    >
      <span aria-hidden="true">‹</span>
      <span>{t("sourceCommitHistory")}</span>
    </button>
  );
}
