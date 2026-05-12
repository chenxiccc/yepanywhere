import type { GitFileChange, GitStatusInfo } from "@yep-anywhere/shared";
import { Button } from "../ui/Button";
import { GitFileActionsMenu, GitFileSection } from "./GitFileList";
import { ClearIcon, SearchIcon } from "./GitStatusIcons";
import { formatRelativeTime } from "./utils";

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

export function GitStatusSidebar({
  status,
  commitMessage,
  fileFilter,
  fileActionsMenuOpen,
  selectedCommitCount,
  visibleFiles,
  selectedFile,
  excludedCommitFileKeys,
  busyAction,
  canCommit,
  canUndo,
  t,
  onCommitMessageChange,
  onCommit,
  onUndo,
  onFileFilterChange,
  onClearFileFilter,
  onToggleFileActionsMenu,
  onCloseFileActionsMenu,
  onDiscardSelected,
  onStashSelected,
  onFileClick,
  onToggleCommitFile,
  onSetCommitFiles,
}: {
  status: GitStatusInfo;
  commitMessage: string;
  fileFilter: string;
  fileActionsMenuOpen: boolean;
  selectedCommitCount: number;
  visibleFiles: GitFileChange[];
  selectedFile: GitFileChange | null;
  excludedCommitFileKeys: Set<string>;
  busyAction: string | null;
  canCommit: boolean;
  canUndo: boolean;
  t: Translate;
  onCommitMessageChange: (value: string) => void;
  onCommit: () => void;
  onUndo: () => void;
  onFileFilterChange: (value: string) => void;
  onClearFileFilter: () => void;
  onToggleFileActionsMenu: () => void;
  onCloseFileActionsMenu: () => void;
  onDiscardSelected: () => void;
  onStashSelected: () => void;
  onFileClick: (file: GitFileChange) => void;
  onToggleCommitFile: (file: GitFileChange) => void;
  onSetCommitFiles: (files: GitFileChange[], selected: boolean) => void;
}) {
  const latestLocalCommit = status.latestLocalCommit;

  return (
    <aside className="git-desktop-sidebar">
      <div className="git-desktop-card git-commit-card">
        <textarea
          value={commitMessage}
          onChange={(event) => onCommitMessageChange(event.target.value)}
          className="git-commit-textarea"
          rows={3}
          placeholder={t("gitStatusCommitPlaceholder")}
        />
        <Button
          variant="primary"
          className="git-commit-button"
          onClick={onCommit}
          disabled={busyAction !== null || !canCommit}
        >
          {busyAction === "commit"
            ? t("gitStatusLoading")
            : t("gitStatusCommitToBranch", {
                branch: status.branch ?? "HEAD",
              })}
        </Button>
        {canUndo ? (
          <div className="git-undo-card">
            <div className="git-undo-copy">
              <span className="git-undo-eyebrow">
                {t("gitStatusUndoCommittedAt", {
                  time: latestLocalCommit?.committedAt
                    ? formatRelativeTime(latestLocalCommit.committedAt, t)
                    : t("gitStatusRelativeNow"),
                })}
              </span>
              <span className="git-undo-message">
                {latestLocalCommit?.message ?? t("gitStatusUndo")}
              </span>
            </div>
            <Button
              variant="secondary"
              className="git-undo-button"
              onClick={onUndo}
              disabled={busyAction !== null}
            >
              <span>
                {busyAction === "undo"
                  ? t("gitStatusLoading")
                  : t("gitStatusUndo")}
              </span>
            </Button>
          </div>
        ) : null}
      </div>

      <div className="git-desktop-card git-files-card">
        {status.files.length === 0 ? (
          <div className="git-status-empty">
            {t("gitStatusWorkingTreeClean")}
          </div>
        ) : (
          <div className="git-desktop-file-groups">
            <div className="git-file-filter">
              <div className="git-filter-bar">
                <div className="git-filter-field">
                  <span className="git-filter-icon" aria-hidden="true">
                    <SearchIcon />
                  </span>
                  <input
                    type="text"
                    value={fileFilter}
                    onChange={(event) => onFileFilterChange(event.target.value)}
                    placeholder={t("gitStatusFileFilterPlaceholder")}
                    className="git-filter-input"
                    aria-label={t("gitStatusFileFilterPlaceholder")}
                  />
                  {fileFilter.length > 0 ? (
                    <button
                      type="button"
                      className="git-filter-clear"
                      onClick={onClearFileFilter}
                      aria-label={t("activityClear")}
                    >
                      <ClearIcon />
                    </button>
                  ) : null}
                </div>
                <GitFileActionsMenu
                  isOpen={fileActionsMenuOpen}
                  onToggle={onToggleFileActionsMenu}
                  onClose={onCloseFileActionsMenu}
                  onDiscard={onDiscardSelected}
                  onStash={onStashSelected}
                  busyAction={busyAction}
                  disabled={selectedCommitCount === 0}
                  t={t}
                />
              </div>
            </div>
            {visibleFiles.length === 0 ? (
              <div className="git-branch-merge-empty">
                {t("gitStatusFileFilterEmpty")}
              </div>
            ) : null}
            {visibleFiles.length > 0 ? (
              <GitFileSection
                title={t("gitStatusFilesChanged", {
                  count: visibleFiles.length,
                })}
                files={visibleFiles}
                selectedFile={selectedFile}
                onFileClick={onFileClick}
                excludedCommitFileKeys={excludedCommitFileKeys}
                onToggleCommitFile={onToggleCommitFile}
                onSetCommitFiles={onSetCommitFiles}
              />
            ) : null}
          </div>
        )}
      </div>
    </aside>
  );
}
