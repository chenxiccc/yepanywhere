import { ClearIcon, SearchIcon } from "./git-status/GitStatusIcons";

interface FileTreeSearchProps {
  /** 搜索查询 / Search query */
  value: string;
  /** 搜索变化回调 / Change callback */
  onChange: (value: string) => void;
  /** 占位文本 / Placeholder text */
  placeholder?: string;
  /** 清除按钮无障碍标签 / Clear button aria-label */
  clearLabel?: string;
}

/**
 * 文件树搜索栏组件
 * File tree search bar component.
 */
export function FileTreeSearch({
  value,
  onChange,
  placeholder = "搜索文件...",
  clearLabel = "清除搜索",
}: FileTreeSearchProps) {
  return (
    <div className="git-filter-bar">
      <div className="git-filter-field">
        <span className="git-filter-icon" aria-hidden="true">
          <SearchIcon />
        </span>
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="git-filter-input"
          aria-label={placeholder}
        />
        {value.length > 0 ? (
          <button
            type="button"
            className="git-filter-clear"
            onClick={() => onChange("")}
            aria-label={clearLabel}
          >
            <ClearIcon />
          </button>
        ) : null}
      </div>
    </div>
  );
}
