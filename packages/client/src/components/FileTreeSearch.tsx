import { useI18n } from "../i18n";

interface FileTreeSearchProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

/**
 * 文件树搜索栏，实时过滤文件树
 * File tree search bar — real-time file tree filtering.
 */
export function FileTreeSearch({ value, onChange, className }: FileTreeSearchProps) {
  const { t } = useI18n();

  return (
    <div className={`source-file-search ${className ?? ""}`}>
      <span className="source-file-search-icon">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </span>
      <input
        type="text"
        className="source-file-search-input"
        placeholder={t("sourceFileSearchPlaceholder" as never)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          type="button"
          className="source-file-search-clear"
          onClick={() => onChange("")}
          aria-label={t("sourceFileSearchClear" as never)}
        >
          ×
        </button>
      )}
    </div>
  );
}