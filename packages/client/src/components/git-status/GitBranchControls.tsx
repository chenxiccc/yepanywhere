import type { GitBranchInfo } from "@yep-anywhere/shared";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import {
  BranchMenuIcon,
  CheckIcon,
  ChevronDownIcon,
  ClearIcon,
  SearchIcon,
} from "./GitStatusIcons";
import { formatRelativeTime } from "./utils";

export function GitBranchSwitcher({
  currentBranch,
  branches,
  isOpen,
  onToggle,
  onClose,
  onSelect,
  onOpenCreateBranch,
  onOpenMerge,
  error,
}: {
  currentBranch: string;
  branches: GitBranchInfo[];
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  onSelect: (branchName: string) => void;
  onOpenCreateBranch: (branchName: string) => void;
  onOpenMerge: () => void;
  error: string | null;
}) {
  const { t } = useI18n();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState("");
  const normalizedFilter = filter.trim().toLowerCase();
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

  useEffect(() => {
    if (!isOpen) return;

    filterInputRef.current?.focus();

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (wrapperRef.current?.contains(target)) return;
      onClose();
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isOpen, onClose]);

  return (
    <div className="git-branch-switcher" ref={wrapperRef}>
      <button
        type="button"
        className="git-branch-name git-branch-name-button"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <span>{currentBranch}</span>
        <ChevronDownIcon />
      </button>
      {isOpen ? (
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
                  {group.branches.map((branch) => (
                    <button
                      key={branch.name}
                      type="button"
                      className={`git-branch-menu-item ${branch.current ? "is-current" : ""}`}
                      onClick={() => onSelect(branch.name)}
                      role="menuitem"
                    >
                      <span className="git-branch-menu-main">
                        <span
                          className="git-branch-menu-icon"
                          aria-hidden="true"
                        >
                          {branch.current ? <CheckIcon /> : <BranchMenuIcon />}
                        </span>
                        <span className="git-branch-menu-primary">
                          {branch.name}
                        </span>
                      </span>
                      <span className="git-branch-menu-meta">
                        {branch.updatedAt ? (
                          <span className="git-branch-menu-time">
                            {formatRelativeTime(branch.updatedAt, t)}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  ))}
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
  const menuRef = useRef<HTMLDivElement>(null);
  const hasAlternateAction = alternateAction !== null;

  useEffect(() => {
    if (!menuOpen || !hasAlternateAction) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target)) return;
      onCloseMenu();
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [hasAlternateAction, menuOpen, onCloseMenu]);

  return (
    <div className="git-split-action" ref={menuRef}>
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
      ) : null}
    </div>
  );
}
