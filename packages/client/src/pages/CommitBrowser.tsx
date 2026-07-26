import type {
  GitCommitDetail,
  GitFileChange,
  GitRecentCommit,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { CopyButton } from "../components/CopyButton";
import { Modal } from "../components/ui/Modal";
import { useCommitReadWatermark } from "../hooks/useCommitReadWatermark";
import { useProjectReviewComments } from "../hooks/useProjectReviewComments";
import {
  GitDiffModal,
  GitDiffPreview,
  type GitDiffPreviewHandle,
} from "./GitStatusDiffPreview";

type TranslationFn = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

const COMMIT_PAGE_SIZE = 50;

/**
 * The multipane commit browser (topic: source-review-to-session, stage 3):
 * commits · changed files · diff. The diff column reuses the working-tree
 * diff+comment stack ({@link GitDiffPreview}) with a `commit` source, so a
 * comment left on a commit line flows through the same review accumulator with
 * a `sha` anchor. Read-only: no checkout, just browse and comment.
 */
export function CommitBrowser({
  projectId,
  isWideScreen,
  onBlameFile,
  t,
}: {
  projectId: string;
  isWideScreen: boolean;
  /** Bridge a commit file to its blame-at-HEAD view (the files tab). */
  onBlameFile?: (path: string) => void;
  t: TranslationFn;
}) {
  const [commits, setCommits] = useState<GitRecentCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // When true, the detail pane shows the commit's original-format message
  // (verbatim, with its exact time) instead of a file diff.
  const [messageView, setMessageView] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<GitRecentCommit[] | null>(
    null,
  );
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const diffPreviewRef = useRef<GitDiffPreviewHandle>(null);
  const displayedCommits = searchResults ?? commits;

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
  const fileCommentCount = useMemo(() => {
    const counts = new Map<string, number>();
    if (!selectedSha) return counts;
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
    setSelectedSha(null);
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

  // Auto-select the newest shown commit on wide screens (mobile starts on
  // the list). Follows search results when a search is active.
  useEffect(() => {
    if (isWideScreen && selectedSha === null && displayedCommits[0]) {
      setSelectedSha(displayedCommits[0].hash);
    }
  }, [isWideScreen, selectedSha, displayedCommits]);

  const loadMore = useCallback(async () => {
    try {
      const res = await api.getGitCommits(projectId, {
        limit: COMMIT_PAGE_SIZE,
        skip: commits.length,
      });
      setCommits((prev) => [...prev, ...res.commits]);
      setHasMore(res.hasMore);
    } catch (err) {
      setListError(err instanceof Error ? err.message : t("gitStatusLoading"));
    }
  }, [projectId, commits.length, t]);

  // Debounced commit-delta search (git log -G): commits whose diff touched the
  // query. An empty query restores the paged list.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults(null);
      setSearching(false);
      setSearchError(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setSearchError(null);
    const timer = setTimeout(() => {
      api
        .searchGit(projectId, { q, kind: "delta" })
        .then((res) => {
          if (cancelled) return;
          setSearchResults(res.commits ?? []);
          setSearching(false);
        })
        .catch((err) => {
          if (cancelled) return;
          setSearchError(
            err instanceof Error ? err.message : t("gitStatusLoading"),
          );
          setSearching(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectId, searchQuery, t]);

  // Load the selected commit's changed-file list.
  useEffect(() => {
    if (!selectedSha) {
      setDetail(null);
      setSelectedPath(null);
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

  // Auto-select the first changed file on wide screens.
  useEffect(() => {
    if (isWideScreen && selectedPath === null && detail?.files[0]) {
      setSelectedPath(detail.files[0].path);
    }
  }, [isWideScreen, selectedPath, detail]);

  const selectedFile: GitFileChange | null =
    detail && selectedPath
      ? (detail.files.find((f) => f.path === selectedPath) ?? null)
      : null;
  const source = selectedSha
    ? ({ kind: "commit", sha: selectedSha } as const)
    : undefined;
  const diffFileKey =
    selectedSha && selectedFile ? `${selectedSha}:${selectedFile.path}` : null;

  // Commit-jump selector: step to the adjacent shown commit (list is
  // newest-first, so previous index = newer). Usable at any width — the mobile
  // path to move between commits without returning to the list.
  const selectedIndex = displayedCommits.findIndex(
    (commit) => commit.hash === selectedSha,
  );
  const newerCommit =
    selectedIndex > 0 ? displayedCommits[selectedIndex - 1] : undefined;
  const olderCommit =
    selectedIndex >= 0 && selectedIndex < displayedCommits.length - 1
      ? displayedCommits[selectedIndex + 1]
      : undefined;
  // The selected commit from the loaded slice, for its author time (read
  // actions) without waiting on the detail fetch.
  const selectedCommit =
    selectedIndex >= 0 ? displayedCommits[selectedIndex] : undefined;

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

  return (
    <div className="commit-browser">
      <div className="commit-browser-columns">
        <div className="commit-list-column">
          <input
            type="search"
            className="source-search-input"
            value={searchQuery}
            placeholder={t("sourceSearchCommits")}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          {loadingList && searchResults === null ? (
            <div className="git-diff-loading">{t("gitStatusLoading")}</div>
          ) : listError && searchResults === null ? (
            <div className="git-diff-error">{listError}</div>
          ) : searching ? (
            <div className="git-diff-loading">{t("sourceSearching")}</div>
          ) : searchError ? (
            <div className="git-diff-error">{searchError}</div>
          ) : displayedCommits.length === 0 ? (
            <div className="git-status-empty">
              {searchResults !== null
                ? t("sourceNoMatches")
                : t("sourceNoCommits")}
            </div>
          ) : (
            <>
              <ol className="commit-list">
                {displayedCommits.map((commit) => {
                  const commentCount = commentCountBySha.get(commit.hash) ?? 0;
                  const read = readState.isRead(commit.authorDate);
                  return (
                    <li key={commit.hash} className="commit-list-row">
                      <button
                        type="button"
                        className={`commit-list-item ${
                          selectedSha === commit.hash ? "selected" : ""
                        } ${read ? "read" : "unread"}`}
                        onClick={() => setSelectedSha(commit.hash)}
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
                    </li>
                  );
                })}
              </ol>
              {hasMore && searchResults === null && (
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

        {selectedSha && (
          <div className="commit-files-column">
            <div className="source-detail-banner">
              <span className="source-detail-jump">
                <button
                  type="button"
                  className="commit-jump-btn"
                  title={t("sourceNewerCommit")}
                  aria-label={t("sourceNewerCommit")}
                  disabled={!newerCommit}
                  onClick={() =>
                    newerCommit && setSelectedSha(newerCommit.hash)
                  }
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="commit-jump-btn"
                  title={t("sourceOlderCommit")}
                  aria-label={t("sourceOlderCommit")}
                  disabled={!olderCommit}
                  onClick={() =>
                    olderCommit && setSelectedSha(olderCommit.hash)
                  }
                >
                  ↓
                </button>
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
              <CopyButton
                value={selectedSha ?? ""}
                title={t("sourceCopyCommitHash")}
                className="source-detail-action"
              />
              <button
                type="button"
                className="source-detail-action"
                disabled={!selectedCommit}
                onClick={() =>
                  selectedCommit &&
                  readState.markReadTo(selectedCommit.authorDate)
                }
              >
                {t("sourceMarkReadToHere")}
              </button>
              <button
                type="button"
                className="source-detail-action"
                disabled={!selectedCommit}
                onClick={() =>
                  selectedCommit &&
                  readState.markUnreadSince(selectedCommit.authorDate)
                }
              >
                {t("sourceMarkUnreadSinceHere")}
              </button>
            </div>
            {loadingDetail ? (
              <div className="git-diff-loading">{t("gitStatusLoading")}</div>
            ) : detailError ? (
              <div className="git-diff-error">{detailError}</div>
            ) : detail ? (
              <>
                {detail.body && (
                  <button
                    type="button"
                    className={`commit-body ${messageView ? "selected" : ""}`}
                    title={t("sourceShowFullMessage")}
                    onClick={() => setMessageView(true)}
                  >
                    {detail.body}
                  </button>
                )}
                <ul className="commit-file-list">
                  {detail.files.map((file) => {
                    const count = fileCommentCount.get(file.path) ?? 0;
                    return (
                      <li key={file.path} className="commit-file-row">
                        <button
                          type="button"
                          className={`commit-file-item ${
                            selectedPath === file.path ? "selected" : ""
                          }`}
                          onClick={() => {
                            if (
                              selectedPath === file.path &&
                              !messageView &&
                              diffPreviewRef.current?.jumpToNextHunk()
                            ) {
                              return;
                            }
                            setSelectedPath(file.path);
                            setMessageView(false);
                          }}
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
                      </li>
                    );
                  })}
                </ul>
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
              t={t}
            />
          ) : null)}
      </div>

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
            t={t}
            onClose={() => setSelectedPath(null)}
          />
        )}
    </div>
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
