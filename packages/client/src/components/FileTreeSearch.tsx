import { useEffect, useRef, useState } from "react";
import { ClearIcon, SearchIcon } from "./git-status/GitStatusIcons";

// 搜索防抖时间 / Search debounce delay
const SEARCH_DEBOUNCE_MS = 280;

interface FileTreeSearchProps {
  /** 搜索查询 / Search query */
  value: string;
  /** 搜索变化回调（已防抖）/ Change callback (debounced) */
  onChange: (value: string) => void;
  /** 占位文本 / Placeholder text */
  placeholder: string;
  /** 清除按钮无障碍标签 / Clear button aria-label */
  clearLabel: string;
}

/**
 * 文件树搜索栏组件
 * File tree search bar component.
 *
 * input 绑定本地 localValue，即时反映用户输入（避免防抖导致输入丢失）；
 * 仅向父组件的 onChange 做防抖，从而搜索请求被节流但输入体验不受影响。
 * The input binds to a local value so typing is immediate (debounce would otherwise drop keystrokes);
 * only the parent onChange is debounced, so search requests are throttled without hurting input responsiveness.
 */
export function FileTreeSearch({
  value,
  onChange,
  placeholder,
  clearLabel,
}: FileTreeSearchProps) {
  // 本地输入值，即时反映用户输入 / Local input value, reflects user input immediately
  const [localValue, setLocalValue] = useState(value);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 同步外部 value 变化（如外部清空或重置）/ Sync external value changes (e.g. external clear/reset)
  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  // 卸载时清理定时器 / Clear pending timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // 即时更新本地输入；空值即时回调父组件，非空值防抖回调 / Update local input immediately; empty fires onChange at once, non-empty is debounced
  const handleChange = (next: string) => {
    setLocalValue(next);
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (next === "") {
      onChange("");
      return;
    }
    debounceTimerRef.current = setTimeout(() => {
      onChange(next);
    }, SEARCH_DEBOUNCE_MS);
  };

  return (
    <div className="git-filter-bar">
      <div className="git-filter-field">
        <span className="git-filter-icon" aria-hidden="true">
          <SearchIcon />
        </span>
        <input
          type="text"
          value={localValue}
          onChange={(event) => handleChange(event.target.value)}
          placeholder={placeholder}
          className="git-filter-input"
          aria-label={placeholder}
        />
        {localValue.length > 0 ? (
          <button
            type="button"
            className="git-filter-clear"
            onClick={() => handleChange("")}
            aria-label={clearLabel}
          >
            <ClearIcon />
          </button>
        ) : null}
      </div>
    </div>
  );
}
