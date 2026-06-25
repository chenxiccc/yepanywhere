import type {
  GitFileChange,
  GitHistoryCommitSummary,
  GitStashEntry,
  GitStatusInfo,
} from "@yep-anywhere/shared";
import { useEffect, useRef } from "react";
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
  activeView,
  commitMessage,
  fileFilter,
  fileActionsMenuOpen,
  selectedCommitCount,
  visibleFiles,
  historyCommits,
  historyLoading,
  historyLoadingMore,
  historyError,
  historyHasMore,
  selectedStashRef,
  selectedHistoryCommitHash,
  selectedFile,
  stashes,
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
  onViewChange,
  onToggleFileActionsMenu,
  onCloseFileActionsMenu,
  onDiscardSelected,
  onStashSelected,
  onFileClick,
  onHistoryCommitSelect,
  onLoadMoreHistory,
  onStashSelect,
  onToggleCommitFile,
  onSetCommitFiles,
}: {
  status: GitStatusInfo;
  activeView: "changes" | "stashed" | "history";
  commitMessage: string;
  fileFilter: string;
  fileActionsMenuOpen: boolean;
  selectedCommitCount: number;
  visibleFiles: GitFileChange[];
  historyCommits: GitHistoryCommitSummary[];
  historyLoading: boolean;
  historyLoadingMore: boolean;
  historyError: string | null;
  historyHasMore: boolean;
  selectedStashRef: string | null;
  selectedHistoryCommitHash: string | null;
  selectedFile: GitFileChange | null;
  stashes: GitStashEntry[];
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
  onViewChange: (view: "changes" | "stashed" | "history") => void;
  onToggleFileActionsMenu: () => void;
  onCloseFileActionsMenu: () => void;
  onDiscardSelected: () => void;
  onStashSelected: () => void;
  onFileClick: (file: GitFileChange) => void;
  onHistoryCommitSelect: (hash: string) => void;
  onLoadMoreHistory: () => void;
  onStashSelect: (stashRef: string) => void;
  onToggleCommitFile: (file: GitFileChange) => void;
  onSetCommitFiles: (files: GitFileChange[], selected: boolean) => void;
}) {
  const latestLocalCommit = status.latestLocalCommit;
  const showStashedTab = stashes.length > 0;
  const historyListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeView !== "history") return;
    if (!historyHasMore || historyLoading || historyLoadingMore) return;

    const list = historyListRef.current;
    if (!list) return;

    const handleScroll = () => {
      const remaining =
        list.scrollHeight - list.scrollTop - list.clientHeight;
      if (remaining <= 160) {
        onLoadMoreHistory();
      }
    };

    handleScroll();
    list.addEventListener("scroll", handleScroll, { passive: true });
    return () => list.removeEventListener("scroll", handleScroll);
  }, [
    activeView,
    historyHasMore,
    historyLoading,
    historyLoadingMore,
    historyCommits.length,
    onLoadMoreHistory,
  ]);

  return (
    <aside className="git-desktop-sidebar">
      <div className="git-desktop-card git-sidebar-primary-card">
        <div
          className={`git-view-tabs ${showStashedTab ? "" : "git-view-tabs-two"}`}
          role="tablist"
          aria-label={t("gitStatusSummary")}
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeView === "changes"}
            className={`git-view-tab ${activeView === "changes" ? "is-active" : ""}`}
            onClick={() => onViewChange("changes")}
          >
            {t("gitStatusChanges")}
          </button>
          {showStashedTab ? (
            <button
              type="button"
              role="tab"
              aria-selected={activeView === "stashed"}
              className={`git-view-tab ${activeView === "stashed" ? "is-active" : ""}`}
              onClick={() => onViewChange("stashed")}
            >
              {t("gitStatusStashed")}
            </button>
          ) : null}
          <button
            type="button"
            role="tab"
            aria-selected={activeView === "history"}
            className={`git-view-tab ${activeView === "history" ? "is-active" : ""}`}
            onClick={() => onViewChange("history")}
          >
            {t("gitStatusHistory")}
          </button>
        </div>

        {activeView === "changes" ? (
          <div className="git-files-card">
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
                        onChange={(event) =>
                          onFileFilterChange(event.target.value)
                        }
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
        ) : activeView === "stashed" ? (
          <div className="git-history-sidebar-card">
            {stashes.length === 0 ? (
              <div className="git-status-empty">
                {t("gitStatusStashedEmpty")}
              </div>
            ) : (
              <div className="git-history-commit-list">
                {stashes.map((stash) => {
                  const selected = stash.ref === selectedStashRef;
                  return (
                    <button
                      key={stash.ref}
                      type="button"
                      className={`git-history-commit-list-item ${selected ? "is-selected" : ""}`}
                      onClick={() => onStashSelect(stash.ref)}
                    >
                      <span className="git-history-commit-list-title">
                        {stash.createdByApp
                          ? t("gitStatusStashedTitle")
                          : stash.message}
                      </span>
                      <span className="git-history-commit-list-meta">
                        {stash.branch ? `${stash.branch} · ` : ""}
                        {formatRelativeTime(stash.createdAt, t)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="git-history-sidebar-card">
            {historyLoading ? (
              <div className="git-status-empty">
                {t("gitStatusHistoryLoading")}
              </div>
            ) : historyError ? (
              <div className="git-diff-error">{historyError}</div>
            ) : historyCommits.length === 0 ? (
              <div className="git-status-empty">
                {t("gitStatusHistoryEmpty")}
              </div>
            ) : (
              <>
                <div className="git-history-commit-list" ref={historyListRef}>
                  {historyCommits.map((commit, index) => {
                    const selected = commit.hash === selectedHistoryCommitHash;
                    const tag = commit.refs.find((ref) =>
                      ref.startsWith("tag: "),
                    );
                    const isUnpushedCommit = index < status.ahead;
                    return (
                      <button
                        key={commit.hash}
                        type="button"
                        className={`git-history-commit-list-item ${selected ? "is-selected" : ""}`}
                        onClick={() => onHistoryCommitSelect(commit.hash)}
                      >
                        <span className="git-history-commit-list-title-row">
                          <span className="git-history-commit-list-title">
                            {commit.message}
                          </span>
                          {tag || isUnpushedCommit ? (
                            <span className="git-history-commit-list-badges">
                              {tag ? (
                                <span className="git-history-commit-list-tag">
                                  {tag.slice("tag: ".length)}
                                </span>
                              ) : null}
                              {isUnpushedCommit ? (
                                <span className="git-history-commit-list-tag">
                                  ↑
                                </span>
                              ) : null}
                            </span>
                          ) : null}
                        </span>
                        <span className="git-history-commit-list-meta">
                          {commit.authorName} ·{" "}
                          {formatRelativeTime(commit.committedAt, t)}
                        </span>
                      </button>
                    );
                  })}
                  {historyLoadingMore ? (
                    <div className="git-diff-loading">
                      {t("gitStatusLoading")}
                    </div>
                  ) : null}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {activeView === "changes" ? (
        <>
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
        </>
      ) : null}
    </aside>
  );
}
