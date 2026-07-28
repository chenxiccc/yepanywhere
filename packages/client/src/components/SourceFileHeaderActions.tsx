import type { TranslationFn } from "../i18n";
import { CopyButton } from "./CopyButton";

/** Compact path-copy and provenance actions shared by source diff headers. */
export function SourceFileHeaderActions({
  path,
  onBlameFile,
  t,
}: {
  path: string;
  onBlameFile?: (path: string) => void;
  t: TranslationFn;
}) {
  return (
    <>
      <CopyButton
        value={path}
        title={t("sourceCopyPath")}
        className="source-detail-action source-detail-icon-action"
        icon="path"
      />
      {onBlameFile && (
        <button
          type="button"
          className="source-detail-action source-detail-icon-action"
          title={t("sourceBlameAtHead")}
          aria-label={t("sourceBlameAtHead")}
          onClick={() => onBlameFile(path)}
        >
          <BlameIcon />
        </button>
      )}
    </>
  );
}

function BlameIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
