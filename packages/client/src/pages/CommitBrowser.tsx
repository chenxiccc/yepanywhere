import type {
  GitCommitDetail,
  GitFileChange,
  GitRecentCommit,
  GitRevisionComparison,
  GitStatusInfo,
} from "@yep-anywhere/shared";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../api/client";
import { CopyButton } from "../components/CopyButton";
import { ResizableSourceColumns } from "../components/ResizableSourceColumns";
import {
  SourceRowMenuTrigger,
  type SourceContextMenuAction,
  useSourceContextMenu,
} from "../components/SourceContextMenu";
import { SourceShortcutHelp } from "../components/SourceShortcutHelp";
import { Modal } from "../components/ui/Modal";
import { useCommitReadWatermark } from "../hooks/useCommitReadWatermark";
import { useCommitSearchIndex } from "../hooks/useCommitSearchIndex";
import { useProjectReviewComments } from "../hooks/useProjectReviewComments";
import {
  handleSourceListKeyDown,
  isEditableKeyboardTarget,
  useSourceSearchShortcut,
} from "../hooks/useSourceKeyboard";
import { reflowCommitMessage } from "../lib/reflowCommitMessage";
import { writeClipboardText } from "../lib/clipboard";
import {
  GitDiffModal,
  GitDiffPreview,
  type GitDiffPreviewHandle,
} from "./GitStatusDiffPreview";
import { WorkingTreeBrowser } from "./WorkingTreeBrowser";
import type { TranslationFn } from "../i18n";

const COMMIT_PAGE_SIZE = 50;
const WORKING_TREE_KEY = "working-tree";
const NOOP = () => {};

/**
 * The responsive commit history: commits · changed files · diff. Wide screens
 * expose all three panes; narrow screens drill from the list into one
 * selected commit's files so selection never renders below the full history.
 */
export function CommitBrowser({
  projectId,
  status,
  isWideScreen,
  onBlameFile,
  supportsProjections = false,
  ignoreWhitespace = false,
  onToggleIgnoreWhitespace = NOOP,
  onProjectionUnavailable = NOOP,
  t,
}: {
  projectId: string;
  /** Supplies the pinned Working tree revision without a second git model. */
  status?: GitStatusInfo;
  isWideScreen: boolean;
  /** Bridge a commit file to its blame-at-HEAD view (the files tab). */
  onBlameFile?: (path: string) => void;
  supportsProjections?: boolean;
  ignoreWhitespace?: boolean;
  onToggleIgnoreWhitespace?: () => void;
  onProjectionUnavailable?: () => void;
  t: TranslationFn;
}) {
  const [commits, setCommits] = useState<GitRecentCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [compareToHead, setCompareToHead] = useState(false);
  const [comparison, setComparison] =
    useState<GitRevisionComparison | null>(null);
  const [loadingComparison, setLoadingComparison] = useState(false);
  // When true, the detail pane shows the commit's original-format message
  // (verbatim, with its exact time) instead of a file diff.
  const [messageView, setMessageView] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndexRequested, setSearchIndexRequested] = useState(false);
  const diffPreviewRef = useRef<GitDiffPreviewHandle>(null);
  const revisionMenu = useSourceContextMenu(t);
  const fileMenu = useSourceContextMenu(t);
  const searchActive = searchQuery.trim().length > 0;
  const searchIndex = useCommitSearchIndex(
    projectId,
    searchQuery,
    searchIndexRequested,
  );
  const displayedCommits = searchActive ? searchIndex.results : commits;
  const selectedIsWorkingTree = selectedKey === WORKING_TREE_KEY;
  const selectedSha =
    selectedKey && !selectedIsWorkingTree ? selectedKey : null;
  const hasWorkingTree = status?.isClean === false;
  // If a live refresh cleans the tree while its comment editor is open, keep
  // the selected revision mounted. Navigating away removes the now-clean row.
  const showWorkingTreeRevision = hasWorkingTree || selectedIsWorkingTree;
  const displayedKeys = useMemo(
    () => [
      ...(showWorkingTreeRevision ? [WORKING_TREE_KEY] : []),
      ...displayedCommits.map((commit) => commit.hash),
    ],
    [displayedCommits, showWorkingTreeRevision],
  );
  const browserRef = useRef<HTMLDivElement>(null);
  const detailColumnRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const mobileListScrollTopRef = useRef(0);
  const restoreMobileListScrollRef = useRef(false);
  useSourceSearchShortcut(searchInputRef);

  const { pending } = useProjectReviewComments(projectId);
  const readState = useCommitReadWatermark(projectId);

  // Pending review-comment counts for the row badges: per commit sha (commit
  // list) and, within the selected commit, per file path (file list).
  const commentCountBySha = useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of pending) {
      if (comment.anchor.revision.kind === "sha") {
        const { sha } = comment.anchor.revision;
        counts.set(sha, (counts.get(sha) ?? 0) + 1);
      }
    }
    return counts;
  }, [pending]);
  const workingTreeCommentCount = useMemo(
    () =>
      pending.filter(
        (comment) => comment.anchor.revision.kind === "uncommitted",
      ).length,
    [pending],
  );
  const fileCommentCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of pending) {
      if (
        comment.anchor.revision.kind === "sha" &&
        comment.anchor.revision.sha === selectedSha
      ) {
        counts.set(
          comment.anchor.path,
          (counts.get(comment.anchor.path) ?? 0) + 1,
        );
      }
    }
    return counts;
  }, [pending, selectedSha]);

  // Load the first page of commits when the project changes.
  useEffect(() => {
    let cancelled = false;
    setLoadingList(true);
    setListError(null);
    setCommits([]);
    setSelectedKey(null);
    api
      .getGitCommits(projectId, { limit: COMMIT_PAGE_SIZE })
      .then((res) => {
        if (cancelled) return;
        setCommits(res.commits);
        setHasMore(res.hasMore);
        setLoadingList(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setListError(
          err instanceof Error ? err.message : t("gitStatusLoading"),
        );
        setLoadingList(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, t]);

  // Desktop opens the dirty Working tree first, else the newest commit.
  // Mobile starts on the revision list and drills in only after activation.
  useEffect(() => {
    const first = displayedKeys[0];
    if (!isWideScreen || !first) return;
    setSelectedKey((current) =>
      current && displayedKeys.includes(current) ? current : first,
    );
  }, [displayedKeys, isWideScreen]);

  const loadMore = useCallback(async () => {
    try {
      const res = await api.getGitCommits(projectId, {
        limit: COMMIT_PAGE_SIZE,
        skip: commits.length,
      });
      // Commits landing between pages shift skip-based windows; dropping
      // already-listed hashes keeps rows (and React keys) unique.
      setCommits((prev) => {
        const seen = new Set(prev.map((commit) => commit.hash));
        return [
          ...prev,
          ...res.commits.filter((commit) => !seen.has(commit.hash)),
        ];
      });
      setHasMore(res.hasMore);
    } catch (err) {
      setListError(err instanceof Error ? err.message : t("gitStatusLoading"));
    }
  }, [projectId, commits.length, t]);

  const handleProjectionRequestFailure = useCallback(() => {
    setCompareToHead(false);
    setComparison(null);
    setLoadingComparison(false);
    if (compareToHead) setSelectedPath(null);
    onProjectionUnavailable();
  }, [compareToHead, onProjectionUnavailable]);

  const handleToggleComparison = useCallback(() => {
    if (compareToHead) {
      setCompareToHead(false);
      setComparison(null);
      setLoadingComparison(false);
      setSelectedPath(null);
      return;
    }
    if (!supportsProjections) {
      onProjectionUnavailable();
      return;
    }
    setCompareToHead(true);
    setSelectedPath(null);
    setMessageView(false);
  }, [compareToHead, onProjectionUnavailable, supportsProjections]);

  // Load the selected commit's changed-file list.
  useEffect(() => {
    if (!selectedSha) {
      setDetail(null);
      setLoadingDetail(false);
      setDetailError(null);
      setSelectedPath(null);
      setMessageView(false);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    setDetailError(null);
    setDetail(null);
    setSelectedPath(null);
    setMessageView(false);
    api
      .getGitCommit(projectId, selectedSha)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setLoadingDetail(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setDetailError(
          err instanceof Error ? err.message : t("gitStatusLoading"),
        );
        setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, selectedSha, t]);

  useEffect(() => {
    if (!compareToHead || !selectedSha || !supportsProjections) {
      setComparison(null);
      setLoadingComparison(false);
      if (compareToHead && !supportsProjections) {
        handleProjectionRequestFailure();
      }
      return;
    }
    let cancelled = false;
    setComparison(null);
    setLoadingComparison(true);
    api
      .getGitComparison(projectId, selectedSha)
      .then((result) => {
        if (cancelled) return;
        setComparison(result);
        setLoadingComparison(false);
      })
      .catch(() => {
        if (cancelled) return;
        handleProjectionRequestFailure();
      });
    return () => {
      cancelled = true;
    };
  }, [
    compareToHead,
    handleProjectionRequestFailure,
    projectId,
    selectedSha,
    supportsProjections,
  ]);

  const selectedFiles = compareToHead
    ? (comparison?.files ?? [])
    : (detail?.files ?? []);

  // Keep selection inside the active projection and open its first file.
  useEffect(() => {
    if (!isWideScreen) return;
    setSelectedPath((current) =>
      current && selectedFiles.some((file) => file.path === current)
        ? current
        : (selectedFiles[0]?.path ?? null),
    );
  }, [isWideScreen, selectedFiles]);

  const selectedFile: GitFileChange | null = selectedPath
    ? (selectedFiles.find((f) => f.path === selectedPath) ?? null)
    : null;
  const source =
    selectedSha && compareToHead && comparison
      ? ({
          kind: "comparison",
          baseSha: comparison.baseSha,
          headSha: comparison.headSha,
        } as const)
      : selectedSha
        ? ({ kind: "commit", sha: selectedSha } as const)
        : undefined;
  const diffFileKey =
    selectedSha && selectedFile
      ? compareToHead && comparison
        ? `${comparison.baseSha}:${comparison.headSha}:${selectedFile.path}`
        : `${selectedSha}:${selectedFile.path}`
      : null;

  // Commit-jump selector: step to the adjacent shown commit (list is
  // newest-first, so previous index = newer). Usable at any width — the mobile
  // path to move between commits without returning to the list.
  const selectedIndex = selectedKey ? displayedKeys.indexOf(selectedKey) : -1;
  const newerKey =
    selectedIndex > 0 ? displayedKeys[selectedIndex - 1] : undefined;
  const olderKey =
    selectedIndex >= 0 && selectedIndex < displayedKeys.length - 1
      ? displayedKeys[selectedIndex + 1]
      : undefined;
  // The selected commit from the loaded slice, for its author time (read
  // actions) without waiting on the detail fetch.
  const selectedCommit = selectedSha
    ? displayedCommits.find((commit) => commit.hash === selectedSha)
    : undefined;

  const openRevision = useCallback(
    (key: string) => {
      if (!isWideScreen) {
        const scroller = browserRef.current?.closest<HTMLElement>(
          ".page-scroll-container",
        );
        mobileListScrollTopRef.current = scroller?.scrollTop ?? 0;
      }
      setSelectedKey(key);
    },
    [isWideScreen],
  );

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
            onSelect: () => newer && openRevision(newer),
          },
          {
            label: t("sourceOlderCommit"),
            disabled: !older,
            onSelect: () => older && openRevision(older),
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
          onSelect: () => readState.markReadTo(commit.authorDate),
        },
        {
          label: t("sourceMarkUnreadSinceHere"),
          onSelect: () => readState.markUnreadSince(commit.authorDate),
        },
        {
          label: t("sourceNewerCommit"),
          separatorBefore: true,
          disabled: !newer,
          onSelect: () => newer && openRevision(newer),
        },
        {
          label: t("sourceOlderCommit"),
          disabled: !older,
          onSelect: () => older && openRevision(older),
        },
      ];
    },
    [displayedKeys, openRevision, readState, t],
  );

  const fileMenuActions = useCallback(
    (file: GitFileChange): SourceContextMenuAction[] => [
      {
        label: t("sourceCopyPath"),
        onSelect: () => {
          void writeClipboardText(file.path);
        },
      },
      ...(onBlameFile
        ? [
            {
              label: t("sourceBlameAtHead"),
              onSelect: () => onBlameFile(file.path),
            },
          ]
        : []),
    ],
    [onBlameFile, t],
  );

  // Selected-file actions, shown in the diff pane header (the file banner)
  // instead of on every hovered row.
  const fileActions = selectedFile ? (
    <>
      <CopyButton
        value={selectedFile.path}
        title={t("sourceCopyPath")}
        className="source-detail-action"
      />
      {onBlameFile && (
        <button
          type="button"
          className="source-detail-action"
          title={t("sourceBlameAtHead")}
          onClick={() => onBlameFile(selectedFile.path)}
        >
          {t("sourceBlameAtHeadShort")}
        </button>
      )}
    </>
  ) : null;

  const closeMobileDetail = useCallback(() => {
    restoreMobileListScrollRef.current = true;
    setSelectedKey(null);
    setSelectedPath(null);
    setMessageView(false);
  }, []);
  useMobileCommitDetailHistory(
    !isWideScreen && selectedKey !== null,
    closeMobileDetail,
  );

  const handleMobileBack = useCallback(() => {
    if (
      typeof window !== "undefined" &&
      (window.history.state as { yaCommitDetail?: boolean } | null)
        ?.yaCommitDetail
    ) {
      window.history.back();
      return;
    }
    closeMobileDetail();
  }, [closeMobileDetail]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.key !== "Escape" ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        isEditableKeyboardTarget(event.target) ||
        document.querySelector('[role="dialog"]')
      ) {
        return;
      }
      if (!isWideScreen && selectedKey) {
        event.preventDefault();
        handleMobileBack();
        return;
      }
      if (searchQuery) {
        event.preventDefault();
        setSearchQuery("");
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleMobileBack, isWideScreen, searchQuery, selectedKey]);

  useLayoutEffect(() => {
    if (isWideScreen) return;
    const scroller = browserRef.current?.closest<HTMLElement>(
      ".page-scroll-container",
    );
    if (selectedKey) {
      const detailTarget =
        detailColumnRef.current ??
        browserRef.current?.querySelector<HTMLElement>(
          ".working-tree-browser-history",
        );
      detailTarget?.scrollIntoView?.({ block: "start" });
      return;
    }
    if (restoreMobileListScrollRef.current && scroller) {
      restoreMobileListScrollRef.current = false;
      scroller.scrollTop = mobileListScrollTopRef.current;
    }
  }, [isWideScreen, selectedKey]);

  return (
    <div className="commit-browser" ref={browserRef}>
      <ResizableSourceColumns
        layout="history"
        className="commit-browser-columns"
        t={t}
      >
        {(isWideScreen || !selectedKey) && (
          <div className="commit-list-column">
            <div className="source-search-field">
              <input
                ref={searchInputRef}
                type="search"
                className="source-search-input"
                value={searchQuery}
                placeholder={t("sourceSearchCommits")}
                aria-keyshortcuts="/"
                onFocus={() => setSearchIndexRequested(true)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && searchQuery) {
                    event.preventDefault();
                    setSearchQuery("");
                  }
                }}
                onChange={(event) => {
                  setSearchIndexRequested(true);
                  setSearchQuery(event.target.value);
                }}
              />
              <kbd className="source-search-shortcut">/</kbd>
              <SourceShortcutHelp t={t} />
            </div>
            {searchIndexRequested && searchIndex.indexing && (
              <div className="source-search-index-status">
                {searchIndex.totalCount > 0
                  ? t("sourceIndexingCommits", {
                      indexed: searchIndex.indexedCount,
                      total: searchIndex.totalCount,
                    })
                  : t("sourcePreparingCommitIndex")}
              </div>
            )}
            {loadingList && !searchActive && !showWorkingTreeRevision ? (
              <div className="git-diff-loading">{t("gitStatusLoading")}</div>
            ) : listError && !searchActive && !showWorkingTreeRevision ? (
              <div className="git-diff-error">{listError}</div>
            ) : searchActive &&
              searchIndex.indexing &&
              displayedCommits.length === 0 &&
              !showWorkingTreeRevision ? (
              <div className="git-diff-loading">{t("sourceSearching")}</div>
            ) : searchActive &&
              searchIndex.error &&
              !showWorkingTreeRevision ? (
              <div className="git-diff-error">{searchIndex.error}</div>
            ) : displayedCommits.length === 0 && !showWorkingTreeRevision ? (
              <div className="git-status-empty">
                {searchActive ? t("sourceNoMatches") : t("sourceNoCommits")}
              </div>
            ) : (
              <>
                <ol className="commit-list" onKeyDown={handleSourceListKeyDown}>
                  {showWorkingTreeRevision && (
                    <li className="commit-list-row commit-list-working-tree">
                      <button
                        type="button"
                        className={`commit-list-item working-tree unread ${
                          selectedIsWorkingTree ? "selected" : ""
                        }`}
                        data-source-list-item
                        onFocus={() => {
                          if (isWideScreen) setSelectedKey(WORKING_TREE_KEY);
                        }}
                        {...revisionMenu.targetProps(
                          revisionMenuActions(WORKING_TREE_KEY),
                          () => openRevision(WORKING_TREE_KEY),
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
                                ? new Set(status.files.map((file) => file.path))
                                    .size
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
                    const commentCount =
                      commentCountBySha.get(commit.hash) ?? 0;
                    const read = readState.isRead(commit.authorDate);
                    const menuActions = revisionMenuActions(
                      commit.hash,
                      commit,
                    );
                    return (
                      <li key={commit.hash} className="commit-list-row">
                        <button
                          type="button"
                          className={`commit-list-item ${
                            selectedKey === commit.hash ? "selected" : ""
                          } ${read ? "read" : "unread"}`}
                          data-source-list-item
                          onFocus={() => {
                            if (isWideScreen) setSelectedKey(commit.hash);
                          }}
                          {...revisionMenu.targetProps(menuActions, () =>
                            openRevision(commit.hash),
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
                            <span className="commit-hash">
                              {commit.shortHash}
                            </span>
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
                    onClick={loadMore}
                  >
                    {t("sourceLoadMore")}
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {selectedIsWorkingTree && status && (
          <WorkingTreeBrowser
            projectId={projectId}
            status={status}
            isWideScreen={isWideScreen}
            embeddedInHistory
            onBackToRevisions={!isWideScreen ? handleMobileBack : undefined}
            revisionNavigation={
              <RevisionJump
                newerKey={newerKey}
                olderKey={olderKey}
                onSelect={setSelectedKey}
                t={t}
              />
            }
            onBlameFile={onBlameFile}
            ignoreWhitespace={ignoreWhitespace}
            onToggleIgnoreWhitespace={onToggleIgnoreWhitespace}
            onProjectionRequestFailure={handleProjectionRequestFailure}
            t={t}
          />
        )}

        {selectedSha && (
          <div className="commit-files-column" ref={detailColumnRef}>
            {!isWideScreen && (
              <button
                type="button"
                className="source-mobile-back"
                onClick={handleMobileBack}
              >
                ← {t("sourceBackToCommits")}
              </button>
            )}
            <div className="source-detail-banner">
              <RevisionJump
                newerKey={newerKey}
                olderKey={olderKey}
                onSelect={setSelectedKey}
                t={t}
              />
              <span className="source-detail-identity">
                <span
                  className="source-detail-subject"
                  title={detail?.subject ?? selectedCommit?.subject}
                >
                  {detail?.subject ?? selectedCommit?.subject ?? "…"}
                </span>
                <span
                  className="source-detail-title"
                  title={
                    selectedCommit
                      ? `${selectedCommit.hash}\n${formatCommitDateTime(
                          selectedCommit.authorDate,
                        )}`
                      : (selectedSha ?? undefined)
                  }
                >
                  {detail?.shortHash ?? selectedCommit?.shortHash ?? "…"}
                </span>
              </span>
              <button
                type="button"
                className={`source-detail-action source-compare-toggle ${
                  compareToHead ? "active" : ""
                }`}
                title={t("sourceCompareToHeadDescription")}
                aria-pressed={compareToHead}
                onClick={handleToggleComparison}
              >
                {t("sourceCompareToHead")}
              </button>
              <CopyButton
                value={selectedSha}
                title={t("sourceCopyCommitHash")}
                className="source-detail-action"
              />
              <button
                type="button"
                className="source-detail-action source-detail-icon-action"
                title={t("sourceMarkReadToHere")}
                aria-label={t("sourceMarkReadToHere")}
                disabled={!selectedCommit}
                onClick={() =>
                  selectedCommit &&
                  readState.markReadTo(selectedCommit.authorDate)
                }
              >
                <EyeIcon />
                <span className="source-detail-action-text">
                  {t("sourceMarkReadToHere")}
                </span>
              </button>
              <button
                type="button"
                className="source-detail-action source-detail-icon-action"
                title={t("sourceMarkUnreadSinceHere")}
                aria-label={t("sourceMarkUnreadSinceHere")}
                disabled={!selectedCommit}
                onClick={() =>
                  selectedCommit &&
                  readState.markUnreadSince(selectedCommit.authorDate)
                }
              >
                <EyeIcon crossed />
                <span className="source-detail-action-text">
                  {t("sourceMarkUnreadSinceHere")}
                </span>
              </button>
            </div>
            {loadingDetail || (compareToHead && loadingComparison) ? (
              <div className="git-diff-loading">{t("gitStatusLoading")}</div>
            ) : detailError ? (
              <div className="git-diff-error">{detailError}</div>
            ) : detail ? (
              <>
                {detail?.body && (
                  <button
                    type="button"
                    className={`commit-body ${
                      !isWideScreen ? "commit-body-mobile" : ""
                    } ${messageView ? "selected" : ""}`}
                    title={t("sourceShowFullMessage")}
                    onClick={() => setMessageView(true)}
                  >
                    {isWideScreen
                      ? reflowCommitMessage(detail.body)
                      : t("sourceShowFullMessage")}
                  </button>
                )}
                <ul
                  className="commit-file-list"
                  onKeyDown={handleSourceListKeyDown}
                >
                  {selectedFiles.map((file) => {
                    const count = fileCommentCount.get(file.path) ?? 0;
                    const isFolder = file.path.endsWith("/");
                    const menuActions = fileMenuActions(file);
                    return (
                      <li key={file.path} className="commit-file-row">
                        <button
                          type="button"
                          className={`commit-file-item ${
                            selectedPath === file.path ? "selected" : ""
                          }`}
                          disabled={isFolder}
                          data-source-list-item
                          onFocus={() => {
                            if (isWideScreen && !isFolder) {
                              setSelectedPath(file.path);
                              setMessageView(false);
                            }
                          }}
                          {...fileMenu.targetProps(menuActions, () => {
                            if (isFolder) return;
                            if (
                              selectedPath === file.path &&
                              !messageView &&
                              diffPreviewRef.current?.jumpToNextHunk()
                            ) {
                              return;
                            }
                            setSelectedPath(file.path);
                            setMessageView(false);
                          })}
                        >
                          <span
                            className={`git-status-badge git-status-${file.status.toLowerCase()}`}
                          >
                            {file.status}
                          </span>
                          <span
                            className="git-file-path"
                            title={
                              file.origPath
                                ? `${file.origPath} → ${file.path}`
                                : file.path
                            }
                          >
                            {file.origPath
                              ? `${file.origPath} → ${file.path}`
                              : file.path}
                          </span>
                          {(file.linesAdded !== null ||
                            file.linesDeleted !== null) && (
                            <span className="git-line-counts">
                              {file.linesAdded ? (
                                <span className="git-lines-added">
                                  +{file.linesAdded}
                                </span>
                              ) : null}
                              {file.linesDeleted ? (
                                <span className="git-lines-deleted">
                                  −{file.linesDeleted}
                                </span>
                              ) : null}
                            </span>
                          )}
                          {count > 0 && (
                            <span
                              className="source-comment-badge"
                              title={t("sourceCommentCount", { count })}
                            >
                              {count}
                            </span>
                          )}
                        </button>
                        {!isFolder && (
                          <SourceRowMenuTrigger
                            actions={menuActions}
                            label={t("sourceMoreActions")}
                            onOpen={fileMenu.openFromButton}
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
                {selectedFiles.length === 0 && (
                  <div className="git-status-empty">
                    {compareToHead
                      ? t("sourceNoChangesToHead")
                      : t("sourceNoFiles")}
                  </div>
                )}
              </>
            ) : null}
          </div>
        )}

        {isWideScreen &&
          (messageView && detail ? (
            <CommitMessageView detail={detail} t={t} />
          ) : selectedFile && source && diffFileKey ? (
            <GitDiffPreview
              ref={diffPreviewRef}
              file={selectedFile}
              fileKey={diffFileKey}
              projectId={projectId}
              source={source}
              headerActions={fileActions}
              ignoreWhitespace={ignoreWhitespace}
              onToggleIgnoreWhitespace={onToggleIgnoreWhitespace}
              onProjectionRequestFailure={handleProjectionRequestFailure}
              t={t}
            />
          ) : null)}
      </ResizableSourceColumns>
      {revisionMenu.menu}
      {fileMenu.menu}

      {!isWideScreen && messageView && detail && (
        <Modal
          title={detail.shortHash}
          onClose={() => setMessageView(false)}
          closeOnBackGesture
        >
          <CommitMessageView detail={detail} t={t} />
        </Modal>
      )}

      {!isWideScreen &&
        !messageView &&
        selectedFile &&
        source &&
        diffFileKey && (
          <GitDiffModal
            file={selectedFile}
            fileKey={diffFileKey}
            projectId={projectId}
            source={source}
            headerActions={fileActions}
            ignoreWhitespace={ignoreWhitespace}
            onToggleIgnoreWhitespace={onToggleIgnoreWhitespace}
            onProjectionRequestFailure={handleProjectionRequestFailure}
            t={t}
            onClose={() => setSelectedPath(null)}
          />
        )}
    </div>
  );
}

function RevisionJump({
  newerKey,
  olderKey,
  onSelect,
  t,
}: {
  newerKey?: string;
  olderKey?: string;
  onSelect: (key: string) => void;
  t: TranslationFn;
}) {
  return (
    <span className="source-detail-jump">
      <button
        type="button"
        className="commit-jump-btn"
        title={t("sourceNewerCommit")}
        aria-label={t("sourceNewerCommit")}
        disabled={!newerKey}
        onClick={() => newerKey && onSelect(newerKey)}
      >
        <span className="commit-jump-glyph" aria-hidden="true">
          ↑
        </span>
        <span className="commit-jump-touch-label">
          {t("sourceNewerCommit")}
        </span>
      </button>
      <button
        type="button"
        className="commit-jump-btn"
        title={t("sourceOlderCommit")}
        aria-label={t("sourceOlderCommit")}
        disabled={!olderKey}
        onClick={() => olderKey && onSelect(olderKey)}
      >
        <span className="commit-jump-glyph" aria-hidden="true">
          ↓
        </span>
        <span className="commit-jump-touch-label">
          {t("sourceOlderCommit")}
        </span>
      </button>
    </span>
  );
}

function useMobileCommitDetailHistory(
  open: boolean,
  onClose: () => void,
): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const priorState =
      (window.history.state as Record<string, unknown> | null) ?? {};
    window.history.pushState({ ...priorState, yaCommitDetail: true }, "");
    let dismissedByBack = false;
    const onPopState = (event: PopStateEvent) => {
      const state = event.state as { yaCommitDetail?: boolean } | null;
      // Returning from the nested mobile diff lands on the commit-detail
      // entry. Keep the revision detail open; the next Back closes it.
      if (state?.yaCommitDetail) return;
      dismissedByBack = true;
      onCloseRef.current();
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      if (
        !dismissedByBack &&
        (window.history.state as { yaCommitDetail?: boolean } | null)
          ?.yaCommitDetail
      ) {
        window.history.back();
      }
    };
  }, [open]);
}

function EyeIcon({ crossed = false }: { crossed?: boolean }) {
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
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.5" />
      {crossed && <path d="m4 4 16 16" />}
    </svg>
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

/** Full date + time for the message view and the hash tooltip. */
function formatCommitDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The selected commit's original-format message shown in the detail pane
 * (opened by clicking the commit body): the verbatim subject + body with its
 * hard line breaks preserved, plus the exact author date/time. Reuses the diff
 * pane's chrome so it slots into the same column.
 */
function CommitMessageView({
  detail,
  t,
}: {
  detail: GitCommitDetail;
  t: TranslationFn;
}) {
  const full = detail.body
    ? `${detail.subject}\n\n${detail.body}`
    : detail.subject;
  return (
    <section className="git-diff-preview-pane">
      <div className="git-diff-preview-header">
        <h3 className="git-diff-preview-title" title={detail.hash}>
          {detail.shortHash}
        </h3>
        <span className="commit-message-time">
          {formatCommitDateTime(detail.authorDate)}
        </span>
      </div>
      <div className="git-diff-preview-body">
        <div className="commit-message-view">
          <div className="commit-message-view-meta">
            {detail.authorName} · {t("sourceCommitMessage")}
          </div>
          <pre className="commit-message-full">{full}</pre>
        </div>
      </div>
    </section>
  );
}
