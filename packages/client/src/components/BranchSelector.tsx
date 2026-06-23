import type { BranchInfo } from "@yep-anywhere/shared";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useI18n } from "../i18n";

interface BranchSelectorProps {
  projectId: string;
  currentBranch: string | null;
  branches: BranchInfo | null;
  loading: boolean;
  onBranchChanged: () => void;
  /** 检出分支 / Checkout a branch */
  onCheckout: (branch: string) => Promise<{ success: boolean; error?: string }>;
  /** 创建分支 / Create a branch */
  onCreateBranch: (branch: string) => Promise<{ success: boolean; error?: string }>;
}

/**
 * 分支选择器，显示当前分支名，支持下拉切换和新建分支
 * Branch selector — displays current branch name, dropdown for switching and creating branches.
 */
export function BranchSelector({
  currentBranch,
  branches,
  loading,
  onBranchChanged,
  onCheckout,
  onCreateBranch,
}: BranchSelectorProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [showCreateInput, setShowCreateInput] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);

  // 关闭下拉菜单 / Close dropdown
  const handleClose = useCallback(() => {
    setIsOpen(false);
    setSearchText("");
    setShowCreateInput(false);
    setNewBranchName("");
  }, []);

  // 点击外部关闭 / Click outside to close
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        handleClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, handleClose]);

  // Escape 关闭 / Escape to close
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleClose]);

  // 聚焦新建输入框 / Focus create input when shown
  useEffect(() => {
    if (showCreateInput && createInputRef.current) {
      createInputRef.current.focus();
    }
  }, [showCreateInput]);

  // 过滤分支 / Filter branches
  const filterBranches = useCallback(
    (items: string[]): string[] => {
      if (!searchText) return items;
      const q = searchText.toLowerCase();
      return items.filter((b) => b.toLowerCase().includes(q));
    },
    [searchText],
  );

  const handleCheckout = useCallback(
    async (branch: string) => {
      setActionLoading(true);
      setActionError(null);
      try {
        // 确认对话框（如果有未提交变更）/ Confirm dialog (if there are uncommitted changes)
        const result = await onCheckout(branch);
        if (result.success) {
          handleClose();
          onBranchChanged();
        } else {
          setActionError(result.error || "Checkout failed");
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Checkout failed");
      } finally {
        setActionLoading(false);
      }
    },
    [onCheckout, handleClose, onBranchChanged],
  );

  const handleCreateBranch = useCallback(async () => {
    const name = newBranchName.trim();
    if (!name) return;
    setActionLoading(true);
    setActionError(null);
    try {
      const result = await onCreateBranch(name);
      if (result.success) {
        handleClose();
        onBranchChanged();
      } else {
        setActionError(result.error || "Create branch failed");
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Create branch failed");
    } finally {
      setActionLoading(false);
    }
  }, [newBranchName, onCreateBranch, handleClose, onBranchChanged]);

  const handleCreateKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        handleCreateBranch();
      } else if (e.key === "Escape") {
        setShowCreateInput(false);
        setNewBranchName("");
      }
    },
    [handleCreateBranch],
  );

  // 非 Git 仓库不显示 / Hide if not a git repo
  if (!loading && branches && !branches.isGitRepo) {
    return null;
  }

  const displayName = loading ? "…" : (currentBranch || "HEAD");

  const localBranches = filterBranches(branches?.local || []);
  const remoteBranches = filterBranches(branches?.remote || []);

  const dropdown = isOpen ? (
        <div
          ref={dropdownRef}
          className="branch-dropdown"
          role="listbox"
          aria-label={t("sourceFileSelectBranch" as never)}
        >
          {/* 搜索框 / Search input */}
          <div className="branch-dropdown-search">
            <input
              type="text"
              placeholder={t("sourceFileFilterBranches" as never)}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
            />
          </div>

          {/* 本地分支 / Local branches */}
          {localBranches.length > 0 && (
            <div className="branch-dropdown-section">
              <div className="branch-dropdown-section-title">
                {t("sourceFileLocalBranches" as never)}
              </div>
              {localBranches.map((branch) => (
                <button
                  key={branch}
                  type="button"
                  className={`branch-dropdown-item ${branch === currentBranch ? "active" : ""}`}
                  onClick={() => handleCheckout(branch)}
                  disabled={actionLoading}
                >
                  {branch}
                  {branch === currentBranch && (
                    <span className="branch-dropdown-check">✓</span>
                  )}
                </button>
              ))}
              {/* 新建分支 / Create branch — 在本地分支下方 */}
              {showCreateInput ? (
                <div className="branch-dropdown-create-input">
                  <input
                    ref={createInputRef}
                    type="text"
                    placeholder={t("sourceFileNewBranchName" as never)}
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    onKeyDown={handleCreateKeyDown}
                  />
                  <button
                    type="button"
                    className="branch-dropdown-create-btn"
                    onClick={handleCreateBranch}
                    disabled={actionLoading || !newBranchName.trim()}
                  >
                    {t("sourceFileCreateBranch" as never)}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="branch-dropdown-item branch-dropdown-create-item"
                  onClick={() => setShowCreateInput(true)}
                >
                  + {t("sourceFileNewBranch" as never)}
                </button>
              )}
              {actionError && (
                <div className="branch-dropdown-error">{actionError}</div>
              )}
            </div>
          )}

          {/* 远程分支 / Remote branches */}
          {remoteBranches.length > 0 && (
            <div className="branch-dropdown-section">
              <div className="branch-dropdown-section-title">
                {t("sourceFileRemoteBranches" as never)}
              </div>
              {remoteBranches.map((branch) => (
                <button
                  key={`remote-${branch}`}
                  type="button"
                  className="branch-dropdown-item"
                  onClick={() => handleCheckout(branch)}
                  disabled={actionLoading}
                >
                  {branch}
                </button>
              ))}
            </div>
          )}

        </div>
      ) : null;

  return (
    <div className="branch-selector">
      <button
        ref={buttonRef}
        type="button"
        className="branch-selector-btn"
        onClick={() => setIsOpen(!isOpen)}
        title={t("sourceFileSwitchBranch" as never)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
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
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        <span className="branch-selector-name">{displayName}</span>
        <svg
          className="branch-selector-chevron"
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {dropdown}
    </div>
  );
}