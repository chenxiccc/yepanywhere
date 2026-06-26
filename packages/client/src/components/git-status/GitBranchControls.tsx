import type { GitBranchInfo } from "@yep-anywhere/shared";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import {
  BranchMenuIcon,
  CheckIcon,
  ChevronDownIcon,
  ClearIcon,
  CopyIcon,
  SearchIcon,
} from "./GitStatusIcons";
import { formatRelativeTime } from "./utils";

/** 复制分支名按钮（下拉菜单内），用 span[role=button] 避免嵌套 button / Copy button inside dropdown, uses span to avoid nested buttons */
function CopyBranchButton({
  branchName,
  copiedBranch,
  onCopy,
}: {
  branchName: string;
  copiedBranch: string | null;
  onCopy: (name: string) => void;
}) {
  const { t } = useI18n();
  const copied = copiedBranch === branchName;

  return (
    <span
      role="button"
      tabIndex={0}
      className={`git-history-copy-button git-branch-copy-button ${copied ? "copied" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onCopy(branchName);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.stopPropagation();
          e.preventDefault();
          onCopy(branchName);
        }
      }}
      title={
        copied ? t("gitStatusHistoryHashCopied") : t("gitStatusHistoryCopyHash")
      }
      aria-label={
        copied ? t("gitStatusHistoryHashCopied") : t("gitStatusHistoryCopyHash")
      }
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </span>
  );
}

/** 当前分支名旁的复制按钮，用 span[role=button] 避免嵌套 button / Copy button for current branch, uses span to avoid nested buttons */
function CopyBranchNameSpan({
  branchName,
  copiedBranch,
  onCopy,
}: {
  branchName: string;
  copiedBranch: string | null;
  onCopy: (name: string) => void;
}) {
  const { t } = useI18n();
  const copied = copiedBranch === branchName;

  return (
    <span
      role="button"
      tabIndex={0}
      className={`git-history-copy-button git-branch-name-copy-button ${copied ? "copied" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onCopy(branchName);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.stopPropagation();
          e.preventDefault();
          onCopy(branchName);
        }
      }}
      title={
        copied ? t("gitStatusHistoryHashCopied") : t("gitStatusHistoryCopyHash")
      }
      aria-label={
        copied ? t("gitStatusHistoryHashCopied") : t("gitStatusHistoryCopyHash")
      }
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </span>
  );
}

export function GitBranchSwitcher({
  currentBranch,
  branches,
  isOpen,
  onToggle,
  onClose,
  onSelectView,
  onSwitchBranch,
  viewingBranch,
  onOpenCreateBranch,
  onOpenMerge,
  error,
}: {
  currentBranch: string;
  branches: GitBranchInfo[];
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** 点分支名区域：只设查看分支，不 checkout / Click branch name area: set viewing branch only, no checkout */
  onSelectView: (branchName: string) => void;
  /** 点切换按钮：触发 checkout / Click switch button: trigger checkout */
  onSwitchBranch: (branchName: string) => void;
  /** 当前查看的分支（null=跟随当前 checkout）/ Currently viewing branch (null=follow checkout) */
  viewingBranch: string | null;
  onOpenCreateBranch: (branchName: string) => void;
  onOpenMerge: () => void;
  error: string | null;
}) {
  const { t } = useI18n();
  const filterInputRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState("");
  const [copiedBranch, setCopiedBranch] = useState<string | null>(null);
  const normalizedFilter = filter.trim().toLowerCase();

  // Auto-reset copy icon after 2 seconds / 2 秒后自动重置复制图标
  useEffect(() => {
    if (!copiedBranch) return;
    const timeoutId = window.setTimeout(() => {
      setCopiedBranch(null);
    }, 2000);
    return () => window.clearTimeout(timeoutId);
  }, [copiedBranch]);

  const copyBranchName = useCallback(
    async (branchName: string) => {
      try {
        await navigator.clipboard.writeText(branchName);
        setCopiedBranch(branchName);
      } catch (err) {
        console.error("Failed to copy branch name:", err);
      }
    },
    [],
  );

  const branchGroups = [
    {
      key: "default",
      title: t("gitStatusBranchGroupDefault"),
      branches: branches.filter(
        (branch) =>
          branch.group === "default" &&
          (normalizedFilter.length === 0 ||
            branch.name.toLowerCase().includes(normalizedFilter)),
      ),
    },
    {
      key: "recent",
      title: t("gitStatusBranchGroupRecent"),
      branches: branches.filter(
        (branch) =>
          branch.group === "recent" &&
          (normalizedFilter.length === 0 ||
            branch.name.toLowerCase().includes(normalizedFilter)),
      ),
    },
    {
      key: "other",
      title: t("gitStatusBranchGroupOther"),
      branches: branches.filter(
        (branch) =>
          branch.group === "other" &&
          (normalizedFilter.length === 0 ||
            branch.name.toLowerCase().includes(normalizedFilter)),
      ),
    },
  ].filter((group) => group.branches.length > 0);

  useEffect(() => {
    if (!isOpen) {
      setFilter("");
    }
  }, [isOpen]);

  return (
    <div className="git-branch-switcher">
      <button
        type="button"
        className="git-branch-name git-branch-name-button"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        {/* 显示查看分支名（null 时跟随当前 checkout 分支）/ Show viewing branch name (null = follow checkout) */}
        <span className="git-branch-name-text">
          {viewingBranch ?? currentBranch}
        </span>
        <CopyBranchNameSpan
          branchName={viewingBranch ?? currentBranch}
          copiedBranch={copiedBranch}
          onCopy={copyBranchName}
        />
        <ChevronDownIcon />
      </button>
      {isOpen ? (
        <>
          {/* 透明遮罩层：portal 到 body，确保覆盖全屏含顶部 header（不受父级层叠上下文限制） */}
          {/* Transparent backdrop: portaled to body so it covers full screen incl. header (escapes parent stacking context) */}
          {createPortal(
            <button
              type="button"
              className="git-branch-menu-backdrop"
              aria-label="Close menu"
              onClick={onClose}
              onContextMenu={(e) => {
                e.preventDefault();
                onClose();
              }}
            />,
            document.body,
          )}
          <div className="git-branch-menu" role="menu">
          {error ? (
            <div className="git-branch-menu-error">{error}</div>
          ) : (
            <>
              <div className="git-branch-menu-filter">
                <div className="git-branch-menu-filter-row">
                  <div className="git-filter-bar">
                    <div className="git-filter-field">
                      <span className="git-filter-icon" aria-hidden="true">
                        <SearchIcon />
                      </span>
                      <input
                        ref={filterInputRef}
                        type="text"
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                        placeholder={t("gitStatusMergeFilterPlaceholder")}
                        className="git-filter-input"
                        aria-label={t("gitStatusMergeFilterPlaceholder")}
                      />
                      {filter.length > 0 ? (
                        <button
                          type="button"
                          className="git-filter-clear"
                          onClick={() => setFilter("")}
                          aria-label={t("activityClear")}
                        >
                          <ClearIcon />
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="git-branch-create-button"
                    onClick={() => onOpenCreateBranch(filter.trim())}
                  >
                    {t("gitStatusBranchCreateButton")}
                  </button>
                </div>
              </div>
              {branchGroups.length === 0 ? (
                <div className="git-branch-merge-empty">
                  {t("gitStatusBranchFilterEmpty")}
                </div>
              ) : null}
              {branchGroups.map((group) => (
                <div key={group.key} className="git-branch-menu-group">
                  <div className="git-branch-menu-heading">{group.title}</div>
                  {group.branches.map((branch) => {
                    // 用 currentBranch（来自 status.branch，refetch 后即时更新）判断当前分支，避免 loadBranches 延迟
                    // Use currentBranch (from status.branch, updates immediately after refetch) to avoid loadBranches lag
                    const isCurrent = branch.name === currentBranch;
                    const isViewing =
                      branch.name === (viewingBranch ?? currentBranch);
                    return (
                      <div
                        key={branch.name}
                        role="menuitem"
                        tabIndex={0}
                        className={`git-branch-menu-item ${isCurrent ? "is-current" : ""} ${isViewing ? "is-viewing" : ""}`}
                        onClick={() => {
                          onSelectView(branch.name);
                          onClose();
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onSelectView(branch.name);
                            onClose();
                          }
                        }}
                      >
                        {/* 最前：当前分支显 HEAD pill，其他分支显切换按钮 */}
                        {/* Leading: HEAD pill for current branch, switch button for others */}
                        {isCurrent ? (
                          <span className="git-head-badge" role="img" aria-label={t("gitStatusBranchCurrent")}>HEAD</span>
                        ) : (
                          <span
                            role="button"
                            tabIndex={0}
                            className="git-branch-switch-button"
                            aria-label={t("gitStatusBranchSwitchButton")}
                            title={t("gitStatusBranchSwitchButton")}
                            onClick={(e) => {
                              e.stopPropagation();
                              onSwitchBranch(branch.name);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.stopPropagation();
                                e.preventDefault();
                                onSwitchBranch(branch.name);
                              }
                            }}
                          >
                            {t("gitStatusBranchSwitchButton")}
                          </span>
                        )}
                        <span className="git-branch-menu-main">
                          <span
                            className="git-branch-menu-icon"
                            aria-hidden="true"
                          >
                            <BranchMenuIcon />
                          </span>
                          <span className="git-branch-menu-primary">
                            {branch.name}
                          </span>
                          <CopyBranchButton
                            branchName={branch.name}
                            copiedBranch={copiedBranch}
                            onCopy={copyBranchName}
                          />
                        </span>
                        <span className="git-branch-menu-meta">
                          {branch.updatedAt ? (
                            <span className="git-branch-menu-time">
                              {formatRelativeTime(branch.updatedAt, t)}
                            </span>
                          ) : null}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
              <div className="git-branch-menu-footer">
                <button
                  type="button"
                  className="git-branch-menu-action"
                  onClick={onOpenMerge}
                  role="menuitem"
                >
                  <span
                    className="git-branch-menu-action-icon"
                    aria-hidden="true"
                  >
                    <BranchMenuIcon />
                  </span>
                  <span className="git-branch-menu-action-label">
                    {t("gitStatusMergeChooseBranch", {
                      branch: currentBranch,
                    })}
                  </span>
                </button>
              </div>
            </>
          )}
        </div>
        </>
      ) : null}
    </div>
  );
}

export function GitSplitActionButton({
  label,
  onClick,
  disabled,
  icon,
  count,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  alternateAction,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  icon: ReactNode;
  count?: string | number;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  alternateAction: {
    label: string;
    onClick: () => void;
  } | null;
}) {
  const hasAlternateAction = alternateAction !== null;

  useEffect(() => {
    if (!menuOpen || !hasAlternateAction) return;
  }, [hasAlternateAction, menuOpen, onCloseMenu]);

  return (
    <div className="git-split-action">
      <button
        type="button"
        className="git-split-action-main"
        onClick={onClick}
        disabled={disabled}
      >
        {icon}
        <span>{label}</span>
        {count !== undefined && count !== null ? (
          <span className="git-sync-count">{count}</span>
        ) : null}
      </button>
      {hasAlternateAction ? (
        <button
          type="button"
          className="git-split-action-toggle"
          onClick={onToggleMenu}
          disabled={disabled}
          aria-label={label}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
        >
          <ChevronDownIcon />
        </button>
      ) : null}
      {menuOpen && alternateAction ? (
        <>
          <button
            type="button"
            className="git-branch-menu-backdrop"
            aria-label="Close menu"
            onClick={onCloseMenu}
            onContextMenu={(e) => {
              e.preventDefault();
              onCloseMenu();
            }}
          />
          <div className="git-split-action-menu" role="menu">
          <button
            type="button"
            className="git-split-action-menu-item"
            onClick={() => {
              onCloseMenu();
              alternateAction.onClick();
            }}
            role="menuitem"
          >
            <span>{alternateAction.label}</span>
          </button>
        </div>
        </>
      ) : null}
    </div>
  );
}