import type { GitRecentCommit, GitStatusInfo } from "@yep-anywhere/shared";
import { type RefObject, useCallback } from "react";
import {
  SourceRowMenuTrigger,
  sourceRowMenuSurface,
  type SourceContextMenuAction,
  useSourceContextMenu,
} from "../components/SourceContextMenu";
import { SourceShortcutHelp } from "../components/SourceShortcutHelp";
import { handleSourceListKeyDown } from "../hooks/useSourceKeyboard";
import { writeClipboardText } from "../lib/clipboard";
import type { TranslationFn } from "../i18n";
import { WORKING_TREE_KEY } from "./useCommitBrowserModel";

/**
 * Commit-history master pane. It owns revision-row presentation and row menus;
 * the parent supplies the already-resolved list/search model and navigation.
 */
export function CommitRevisionPane({
  status,
  isWideScreen,
  searchInputRef,
  searchQuery,
  searchIndexRequested,
  searchIndexing,
  indexedCount,
  totalCount,
  searchError,
  searchActive,
  displayedCommits,
  selectedKey,
  selectedIsWorkingTree,
  showWorkingTreeRevision,
  loadingList,
  listError,
  hasMore,
  workingTreeCommentCount,
  commentCountBySha,
  isRead,
  onSearchQueryChange,
  onSearchIndexRequested,
  onOpenRevision,
  onFocusRevision,
  onLoadMore,
  onMarkReadTo,
  onMarkUnreadSince,
  displayedKeys,
  t,
}: {
  status?: GitStatusInfo;
  isWideScreen: boolean;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  searchIndexRequested: boolean;
  searchIndexing: boolean;
  indexedCount: number;
  totalCount: number;
  searchError: string | null;
  searchActive: boolean;
  displayedCommits: GitRecentCommit[];
  displayedKeys: string[];
  selectedKey: string | null;
  selectedIsWorkingTree: boolean;
  showWorkingTreeRevision: boolean;
  loadingList: boolean;
  listError: string | null;
  hasMore: boolean;
  workingTreeCommentCount: number;
  commentCountBySha: ReadonlyMap<string, number>;
  isRead: (authorDate: string) => boolean;
  onSearchQueryChange: (query: string) => void;
  onSearchIndexRequested: () => void;
  onOpenRevision: (key: string) => void;
  onFocusRevision: (key: string) => void;
  onLoadMore: () => void;
  onMarkReadTo: (authorDate: string) => void;
  onMarkUnreadSince: (authorDate: string) => void;
  t: TranslationFn;
}) {
  const revisionMenu = useSourceContextMenu(t);
  const revisionMenuActions = useCallback(
    (key: string, commit?: GitRecentCommit): SourceContextMenuAction[] => {
      const index = displayedKeys.indexOf(key);
      const newer = index > 0 ? displayedKeys[index - 1] : undefined;
      const older =
        index >= 0 && index < displayedKeys.length - 1
          ? displayedKeys[index + 1]
          : undefined;
      if (!commit) {
        return [
          {
            label: t("sourceCopyRevisionLabel"),
            onSelect: () => {
              void writeClipboardText(t("sourceWorkingTree"));
            },
          },
          {
            label: t("sourceNewerCommit"),
            disabled: !newer,
            onSelect: () => newer && onOpenRevision(newer),
          },
          {
            label: t("sourceOlderCommit"),
            disabled: !older,
            onSelect: () => older && onOpenRevision(older),
          },
        ];
      }
      return [
        {
          label: t("sourceCopyCommitHash"),
          onSelect: () => {
            void writeClipboardText(commit.hash);
          },
        },
        {
          label: t("sourceCopyCommitSubject"),
          onSelect: () => {
            void writeClipboardText(commit.subject);
          },
        },
        {
          label: t("sourceMarkReadToHere"),
          separatorBefore: true,
          onSelect: () => onMarkReadTo(commit.authorDate),
        },
        {
          label: t("sourceMarkUnreadSinceHere"),
          onSelect: () => onMarkUnreadSince(commit.authorDate),
        },
        {
          label: t("sourceNewerCommit"),
          separatorBefore: true,
          disabled: !newer,
          onSelect: () => newer && onOpenRevision(newer),
        },
        {
          label: t("sourceOlderCommit"),
          disabled: !older,
          onSelect: () => older && onOpenRevision(older),
        },
      ];
    },
    [
      displayedKeys,
      onMarkReadTo,
      onMarkUnreadSince,
      onOpenRevision,
      t,
    ],
  );

  const noVisibleRevisions =
    displayedCommits.length === 0 && !showWorkingTreeRevision;
  return (
    <>
      <div className="commit-list-column">
        <div className="source-search-field">
          <input
            ref={searchInputRef}
            type="search"
            className="source-search-input"
            value={searchQuery}
            placeholder={t("sourceSearchCommits")}
            aria-keyshortcuts="/"
            onFocus={onSearchIndexRequested}
            onKeyDown={(event) => {
              if (event.key === "Escape" && searchQuery) {
                event.preventDefault();
                onSearchQueryChange("");
              }
            }}
            onChange={(event) => {
              onSearchIndexRequested();
              onSearchQueryChange(event.target.value);
            }}
          />
          <kbd className="source-search-shortcut">/</kbd>
          <SourceShortcutHelp t={t} />
        </div>
        {searchIndexRequested && searchIndexing && (
          <div className="source-search-index-status">
            {totalCount > 0
              ? t("sourceIndexingCommits", {
                  indexed: indexedCount,
                  total: totalCount,
                })
              : t("sourcePreparingCommitIndex")}
          </div>
        )}
        {loadingList && !searchActive && noVisibleRevisions ? (
          <div className="git-diff-loading">{t("gitStatusLoading")}</div>
        ) : listError && !searchActive && noVisibleRevisions ? (
          <div className="git-diff-error">{listError}</div>
        ) : searchActive && searchIndexing && noVisibleRevisions ? (
          <div className="git-diff-loading">{t("sourceSearching")}</div>
        ) : searchActive && searchError && noVisibleRevisions ? (
          <div className="git-diff-error">{searchError}</div>
        ) : noVisibleRevisions ? (
          <div className="git-status-empty">
            {searchActive ? t("sourceNoMatches") : t("sourceNoCommits")}
          </div>
        ) : (
          <>
            <ol className="commit-list" onKeyDown={handleSourceListKeyDown}>
              {showWorkingTreeRevision && (
                <li
                  className={`commit-list-row commit-list-working-tree ${sourceRowMenuSurface}`}
                >
                  <button
                    type="button"
                    className={`commit-list-item working-tree unread ${
                      selectedIsWorkingTree ? "selected" : ""
                    }`}
                    data-source-list-item
                    onFocus={() => {
                      if (isWideScreen) onFocusRevision(WORKING_TREE_KEY);
                    }}
                    {...revisionMenu.targetProps(
                      revisionMenuActions(WORKING_TREE_KEY),
                      () => onOpenRevision(WORKING_TREE_KEY),
                    )}
                  >
                    <span className="commit-subject-row">
                      <span className="commit-subject">
                        {t("sourceWorkingTree")}
                      </span>
                      {workingTreeCommentCount > 0 && (
                        <span
                          className="source-comment-badge"
                          title={t("sourceCommentCount", {
                            count: workingTreeCommentCount,
                          })}
                        >
                          {workingTreeCommentCount}
                        </span>
                      )}
                    </span>
                    <span className="commit-meta">
                      <span className="working-tree-label">
                        {t("sourceUncommitted")}
                      </span>
                      <span>
                        {t("sourceChangedFileCount", {
                          count: status
                            ? new Set(status.files.map((file) => file.path)).size
                            : 0,
                        })}
                      </span>
                    </span>
                  </button>
                  <SourceRowMenuTrigger
                    actions={revisionMenuActions(WORKING_TREE_KEY)}
                    label={t("sourceMoreActions")}
                    onOpen={revisionMenu.openFromButton}
                  />
                </li>
              )}
              {displayedCommits.map((commit) => {
                const commentCount = commentCountBySha.get(commit.hash) ?? 0;
                const menuActions = revisionMenuActions(commit.hash, commit);
                return (
                  <li
                  key={commit.hash}
                  className={`commit-list-row ${sourceRowMenuSurface}`}
                >
                    <button
                      type="button"
                      className={`commit-list-item ${
                        selectedKey === commit.hash ? "selected" : ""
                      } ${isRead(commit.authorDate) ? "read" : "unread"}`}
                      data-source-list-item
                      onFocus={() => {
                        if (isWideScreen) onFocusRevision(commit.hash);
                      }}
                      {...revisionMenu.targetProps(menuActions, () =>
                        onOpenRevision(commit.hash),
                      )}
                    >
                      <span className="commit-subject-row">
                        <span
                          className="commit-subject"
                          title={commit.subject}
                        >
                          {commit.subject}
                        </span>
                        {commentCount > 0 && (
                          <span
                            className="source-comment-badge"
                            title={t("sourceCommentCount", {
                              count: commentCount,
                            })}
                          >
                            {commentCount}
                          </span>
                        )}
                      </span>
                      <span className="commit-meta">
                        <span className="commit-hash">{commit.shortHash}</span>
                        <span className="commit-author">
                          {commit.authorName}
                        </span>
                        <span className="commit-date">
                          {formatCommitDate(commit.authorDate)}
                        </span>
                      </span>
                    </button>
                    <SourceRowMenuTrigger
                      actions={menuActions}
                      label={t("sourceMoreActions")}
                      onOpen={revisionMenu.openFromButton}
                    />
                  </li>
                );
              })}
            </ol>
            {listError && <div className="git-diff-error">{listError}</div>}
            {hasMore && !searchActive && (
              <button
                type="button"
                className="commit-load-more"
                onClick={onLoadMore}
              >
                {t("sourceLoadMore")}
              </button>
            )}
          </>
        )}
      </div>
      {revisionMenu.menu}
    </>
  );
}

function formatCommitDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
