import type {
  GitCommitDetail,
  GitFileChange,
  GitRecentCommit,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { CopyButton } from "../components/CopyButton";
import { GitDiffModal, GitDiffPreview } from "./GitStatusDiffPreview";

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
  t,
}: {
  projectId: string;
  isWideScreen: boolean;
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
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<GitRecentCommit[] | null>(
    null,
  );
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const displayedCommits = searchResults ?? commits;

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
                {displayedCommits.map((commit) => (
                  <li key={commit.hash} className="commit-list-row">
                    <button
                      type="button"
                      className={`commit-list-item ${
                        selectedSha === commit.hash ? "selected" : ""
                      }`}
                      onClick={() => setSelectedSha(commit.hash)}
                    >
                      <span className="commit-subject">{commit.subject}</span>
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
                    <CopyButton
                      value={commit.hash}
                      title={t("sourceCopyCommitHash")}
                      className="source-row-copy"
                    />
                  </li>
                ))}
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
            <div className="commit-jump">
              <button
                type="button"
                className="commit-jump-btn"
                disabled={!newerCommit}
                onClick={() => newerCommit && setSelectedSha(newerCommit.hash)}
              >
                {t("sourceNewerCommit")}
              </button>
              <span className="commit-jump-current">
                {detail?.shortHash ?? "…"}
              </span>
              <button
                type="button"
                className="commit-jump-btn"
                disabled={!olderCommit}
                onClick={() => olderCommit && setSelectedSha(olderCommit.hash)}
              >
                {t("sourceOlderCommit")}
              </button>
            </div>
            {loadingDetail ? (
              <div className="git-diff-loading">{t("gitStatusLoading")}</div>
            ) : detailError ? (
              <div className="git-diff-error">{detailError}</div>
            ) : detail ? (
              <>
                {detail.body && <p className="commit-body">{detail.body}</p>}
                <ul className="commit-file-list">
                  {detail.files.map((file) => (
                    <li key={file.path} className="commit-file-row">
                      <button
                        type="button"
                        className={`commit-file-item ${
                          selectedPath === file.path ? "selected" : ""
                        }`}
                        onClick={() => setSelectedPath(file.path)}
                      >
                        <span
                          className={`git-status-badge git-status-${file.status.toLowerCase()}`}
                        >
                          {file.status}
                        </span>
                        <span className="git-file-path">
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
                      </button>
                      <CopyButton
                        value={file.path}
                        title={t("sourceCopyPath")}
                        className="source-row-copy"
                      />
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        )}

        {isWideScreen && selectedFile && source && diffFileKey && (
          <GitDiffPreview
            file={selectedFile}
            fileKey={diffFileKey}
            projectId={projectId}
            source={source}
            t={t}
          />
        )}
      </div>

      {!isWideScreen && selectedFile && source && diffFileKey && (
        <GitDiffModal
          file={selectedFile}
          fileKey={diffFileKey}
          projectId={projectId}
          source={source}
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
