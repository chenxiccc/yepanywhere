import type {
  GitFileChange,
  GitRemoteCheckResult,
  GitRecentCommit,
  GitStatusInfo,
} from "@yep-anywhere/shared";
import {
  GIT_STATUS_ENHANCED_CAPABILITY,
  GIT_STATUS_REMOTE_CHECK_CAPABILITY,
} from "@yep-anywhere/shared";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { ProjectSelector } from "../components/ProjectSelector";
import { Modal } from "../components/ui/Modal";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useGitStatus } from "../hooks/useGitStatus";
import { useProject, useProjects } from "../hooks/useProjects";
import { useRelativeNow } from "../hooks/useRelativeNow";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import { MainContent, useNavigationLayout } from "../layouts";

interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface GitDiffResult {
  diffHtml: string;
  structuredPatch: PatchHunk[];
  markdownHtml?: string;
}

export function GitStatusPage() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = searchParams.get("projectId");
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();

  const { projects, loading: projectsLoading } = useProjects();
  const effectiveProjectId = projectId || projects[0]?.id;
  const { project } = useProject(effectiveProjectId);
  const {
    version,
    loading: versionLoading,
    error: versionError,
  } = useVersion();
  const supportsEnhancedGitStatus =
    version?.capabilities?.includes(GIT_STATUS_ENHANCED_CAPABILITY) ?? false;
  const supportsRemoteCheck =
    version?.capabilities?.includes(GIT_STATUS_REMOTE_CHECK_CAPABILITY) ??
    false;
  const { gitStatus, loading, error, refetch } = useGitStatus(
    supportsEnhancedGitStatus ? effectiveProjectId : undefined,
  );

  useDocumentTitle(project?.name, t("gitStatusTitle"));

  const handleProjectChange = (newProjectId: string) => {
    setSearchParams({ projectId: newProjectId }, { replace: true });
  };

  if (!effectiveProjectId && !projectsLoading && projects.length === 0) {
    return <div className="error">{t("gitStatusNoProjects")}</div>;
  }

  return (
    <MainContent
      isWideScreen={isWideScreen}
      innerClassName="source-control-main-content"
    >
      <PageHeader
        title={project?.name ?? t("gitStatusTitle")}
        titleElement={
          effectiveProjectId ? (
            <ProjectSelector
              currentProjectId={effectiveProjectId}
              currentProjectName={project?.name}
              onProjectChange={(p) => handleProjectChange(p.id)}
            />
          ) : undefined
        }
        onOpenSidebar={openSidebar}
        onToggleSidebar={toggleSidebar}
        isWideScreen={isWideScreen}
        isSidebarCollapsed={isSidebarCollapsed}
      />

      <main className="page-scroll-container">
        <div className="page-content-inner">
          {versionLoading || projectsLoading ? (
            <div className="loading">{t("gitStatusLoading")}</div>
          ) : versionError ? (
            <div className="error">
              {t("gitStatusErrorPrefix")} {versionError.message}
            </div>
          ) : !supportsEnhancedGitStatus ? (
            <GitStatusUpgradeRequired t={t as never} />
          ) : loading ? (
            <div className="loading">{t("gitStatusLoading")}</div>
          ) : error ? (
            <div className="error">
              {t("gitStatusErrorPrefix")} {error.message}
            </div>
          ) : gitStatus && !gitStatus.isGitRepo ? (
            <div className="git-status-empty">{t("gitStatusNotRepo")}</div>
          ) : gitStatus && effectiveProjectId ? (
            <GitStatusContent
              status={gitStatus}
              projectId={effectiveProjectId}
              isWideScreen={isWideScreen}
              supportsRemoteCheck={supportsRemoteCheck}
              onRefreshStatus={refetch}
              t={t as never}
            />
          ) : null}
        </div>
      </main>
    </MainContent>
  );
}

function GitStatusUpgradeRequired({
  t,
}: {
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div className="git-status-upgrade">
      <h2>{t("gitStatusUpgradeRequiredTitle")}</h2>
      <p>{t("gitStatusUpgradeRequiredDescription")}</p>
    </div>
  );
}

function GitStatusContent({
  status,
  projectId,
  isWideScreen,
  supportsRemoteCheck,
  onRefreshStatus,
  t,
}: {
  status: GitStatusInfo;
  projectId: string;
  isWideScreen: boolean;
  supportsRemoteCheck: boolean;
  onRefreshStatus: () => Promise<void>;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [selectedFile, setSelectedFile] = useState<GitFileChange | null>(null);
  const [remoteCheckResult, setRemoteCheckResult] =
    useState<GitRemoteCheckResult | null>(null);
  const [isCheckingRemote, setIsCheckingRemote] = useState(false);
  const [remoteCheckError, setRemoteCheckError] = useState<string | null>(null);
  const nowMs = useRelativeNow();

  const { stagedFiles, unstagedFiles, untrackedFiles, allFiles } =
    useMemo(() => {
      const staged = status.files.filter((f) => f.staged);
      const unstaged = status.files.filter(
        (f) => !f.staged && f.status !== "?",
      );
      const untracked = status.files.filter((f) => f.status === "?");
      return {
        stagedFiles: staged,
        unstagedFiles: unstaged,
        untrackedFiles: untracked,
        allFiles: [...staged, ...unstaged, ...untracked],
      };
    }, [status.files]);

  useEffect(() => {
    setSelectedFile((current) => {
      if (allFiles.length === 0) {
        return null;
      }
      if (current && allFiles.some((file) => isSameGitFile(file, current))) {
        return current;
      }
      return isWideScreen ? (allFiles[0] ?? null) : null;
    });
  }, [allFiles, isWideScreen]);

  useEffect(() => {
    setRemoteCheckResult(null);
    setRemoteCheckError(null);
    setIsCheckingRemote(false);
  }, [projectId]);

  const handleCheckRemote = useCallback(async () => {
    if (!supportsRemoteCheck || isCheckingRemote) return;

    setIsCheckingRemote(true);
    setRemoteCheckResult(null);
    setRemoteCheckError(null);
    try {
      const result = await api.checkGitRemote(projectId);
      setRemoteCheckResult(result);
      if (result.status === "checked") {
        await onRefreshStatus();
      }
    } catch (err) {
      setRemoteCheckError(
        err instanceof Error ? err.message : t("gitStatusRemoteCheckFailed"),
      );
    } finally {
      setIsCheckingRemote(false);
    }
  }, [isCheckingRemote, onRefreshStatus, projectId, supportsRemoteCheck, t]);

  const checkedRemoteAt =
    remoteCheckResult?.checkedRemoteAt ?? status.checkedRemoteAt ?? null;

  return (
    <div className="git-status">
      <div className="git-status-workspace">
        <div className="git-status-left-pane">
          <div className="git-status-branch">
            <span className="git-branch-icon">
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
            </span>
            <span className="git-branch-name">
              {status.branch ?? t("gitStatusDetachedHead")}
            </span>
            {status.upstream && (
              <span className="git-upstream"> → {status.upstream}</span>
            )}
            {(status.ahead > 0 || status.behind > 0) && (
              <span className="git-ahead-behind">
                {status.ahead > 0 && ` ↑${status.ahead}`}
                {status.behind > 0 && ` ↓${status.behind}`}
              </span>
            )}
            <span className="git-remote-check-time">
              {t("gitStatusLastCheckedRemote", {
                time: formatRemoteCheckTime(checkedRemoteAt, nowMs, t),
              })}
            </span>
            <span
              className={`git-clean-badge ${status.isClean ? "git-clean" : "git-dirty"}`}
            >
              {status.isClean ? t("gitStatusClean") : t("gitStatusDirty")}
            </span>
            {supportsRemoteCheck && (
              <button
                type="button"
                className="git-remote-check-button"
                onClick={handleCheckRemote}
                disabled={isCheckingRemote}
              >
                {isCheckingRemote
                  ? t("gitStatusCheckingRemote")
                  : t("gitStatusCheckRemote")}
              </button>
            )}
          </div>

          {(remoteCheckResult || remoteCheckError) && (
            <div
              className={`git-remote-check-message ${remoteCheckResult ? `git-remote-check-message-${remoteCheckResult.status}` : "git-remote-check-message-failed"}`}
            >
              {remoteCheckError ?? getRemoteCheckMessage(remoteCheckResult, t)}
            </div>
          )}

          <div className="git-status-file-pane">
            {status.isClean ? (
              <div className="git-status-empty">
                {t("gitStatusWorkingTreeClean")}
              </div>
            ) : (
              <>
                {stagedFiles.length > 0 && (
                  <GitFileSection
                    title={t("gitStatusStaged")}
                    files={stagedFiles}
                    selectedFile={selectedFile}
                    onFileClick={setSelectedFile}
                  />
                )}
                {unstagedFiles.length > 0 && (
                  <GitFileSection
                    title={t("gitStatusChanges")}
                    files={unstagedFiles}
                    selectedFile={selectedFile}
                    onFileClick={setSelectedFile}
                  />
                )}
                {untrackedFiles.length > 0 && (
                  <GitFileSection
                    title={t("gitStatusUntracked")}
                    files={untrackedFiles}
                    selectedFile={selectedFile}
                    onFileClick={setSelectedFile}
                  />
                )}
              </>
            )}
          </div>

          <GitRecentCommits commits={status.recentCommits ?? []} t={t} />
        </div>

        {isWideScreen && !status.isClean && (
          <GitDiffPreview file={selectedFile} projectId={projectId} t={t} />
        )}
      </div>

      {!isWideScreen && selectedFile && (
        <GitDiffModal
          file={selectedFile}
          projectId={projectId}
          t={t}
          onClose={() => setSelectedFile(null)}
        />
      )}
    </div>
  );
}

function GitFileSection({
  title,
  files,
  selectedFile,
  onFileClick,
}: {
  title: string;
  files: GitFileChange[];
  selectedFile: GitFileChange | null;
  onFileClick: (file: GitFileChange) => void;
}) {
  return (
    <div className="git-file-section">
      <h3 className="git-file-section-title">
        {title} <span className="git-file-count">({files.length})</span>
      </h3>
      <ul className="git-file-list">
        {files.map((file) => (
          <GitFileItem
            key={`${file.path}-${file.staged}`}
            file={file}
            isSelected={
              selectedFile ? isSameGitFile(file, selectedFile) : false
            }
            onClick={onFileClick}
          />
        ))}
      </ul>
    </div>
  );
}

function GitFileItem({
  file,
  isSelected,
  onClick,
}: {
  file: GitFileChange;
  isSelected: boolean;
  onClick: (file: GitFileChange) => void;
}) {
  return (
    <li className="git-file-list-row">
      <button
        type="button"
        className={`git-file-item git-file-item-clickable ${isSelected ? "git-file-item-selected" : ""}`}
        onClick={() => onClick(file)}
        aria-current={isSelected ? "true" : undefined}
      >
        <span
          className={`git-status-badge git-status-${file.status.toLowerCase()}`}
        >
          {file.status}
        </span>
        <span className="git-file-path">
          {file.origPath ? (
            <>
              {file.origPath} → {file.path}
            </>
          ) : (
            file.path
          )}
        </span>
        {(file.linesAdded !== null || file.linesDeleted !== null) && (
          <span className="git-line-counts">
            {file.linesAdded !== null && (
              <span className="git-lines-added">+{file.linesAdded}</span>
            )}
            {file.linesDeleted !== null && (
              <span className="git-lines-deleted">-{file.linesDeleted}</span>
            )}
          </span>
        )}
      </button>
    </li>
  );
}

function GitRecentCommits({
  commits,
  t,
}: {
  commits: GitRecentCommit[];
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <section className="git-recent-commits" aria-labelledby="git-recent-title">
      <h3 id="git-recent-title" className="git-recent-title">
        {t("gitStatusRecentCommits")}
      </h3>
      {commits.length === 0 ? (
        <div className="git-recent-empty">{t("gitStatusNoRecentCommits")}</div>
      ) : (
        <ol className="git-recent-list">
          {commits.map((commit) => (
            <li key={commit.hash} className="git-recent-item">
              <span className="git-recent-subject">
                {commit.subject || t("gitStatusUntitledCommit")}
              </span>
              <span className="git-recent-meta">
                <span className="git-recent-hash">{commit.shortHash}</span>
                <span className="git-recent-author">{commit.authorName}</span>
                <time
                  dateTime={commit.authorDate}
                  title={formatCommitDateTime(commit.authorDate)}
                >
                  {formatCommitDate(commit.authorDate)}
                </time>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function GitDiffPreview({
  file,
  projectId,
  t,
}: {
  file: GitFileChange | null;
  projectId: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const fileName = file ? file.path.split("/").pop() || file.path : null;

  return (
    <section className="git-diff-preview-pane">
      <div className="git-diff-preview-header">
        <h3 className="git-diff-preview-title">
          {fileName ?? t("gitStatusDiffPreview")}
        </h3>
      </div>
      <div className="git-diff-preview-body">
        {file ? (
          <GitDiffBody file={file} projectId={projectId} t={t} />
        ) : (
          <div className="git-diff-placeholder">
            {t("gitStatusSelectFileForDiff")}
          </div>
        )}
      </div>
    </section>
  );
}

function GitDiffModal({
  file,
  projectId,
  t,
  onClose,
}: {
  file: GitFileChange;
  projectId: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onClose: () => void;
}) {
  const fileName = file.path.split("/").pop() || file.path;

  return (
    <Modal title={fileName} onClose={onClose}>
      <GitDiffBody file={file} projectId={projectId} t={t} />
    </Modal>
  );
}

function GitDiffBody({
  file,
  projectId,
  t,
}: {
  file: GitFileChange;
  projectId: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [diffResult, setDiffResult] = useState<GitDiffResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDiffResult(null);
    setError(null);

    api
      .getGitDiff(projectId, {
        path: file.path,
        staged: file.staged,
        status: file.status,
      })
      .then((result) => {
        if (!cancelled) {
          setDiffResult(result);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || t("gitStatusLoadDiffFailed"));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, file.path, file.staged, file.status, t]);

  return (
    <>
      {loading && (
        <div className="git-diff-loading">{t("gitStatusLoadingDiff")}</div>
      )}
      {!loading && error && <div className="git-diff-error">{error}</div>}
      {!loading && !error && diffResult && (
        <GitDiffContent
          key={gitFileKey(file)}
          file={file}
          projectId={projectId}
          diffResult={diffResult}
          t={t}
        />
      )}
    </>
  );
}

function GitDiffContent({
  file,
  projectId,
  diffResult,
  t,
}: {
  file: GitFileChange;
  projectId: string;
  diffResult: GitDiffResult;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [showFullContext, setShowFullContext] = useState(false);
  const [fullContextResult, setFullContextResult] =
    useState<GitDiffResult | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [showMarkdownPreview, setShowMarkdownPreview] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const isMarkdown = /\.(md|markdown)$/i.test(file.path);
  const hasMarkdownPreview =
    isMarkdown &&
    !!(fullContextResult?.markdownHtml || diffResult.markdownHtml);

  const handleToggleContext = useCallback(async () => {
    if (!showFullContext && !fullContextResult) {
      setContextLoading(true);
      setContextError(null);
      try {
        const result = await api.getGitDiff(projectId, {
          path: file.path,
          staged: file.staged,
          status: file.status,
          fullContext: true,
        });
        setFullContextResult(result);
      } catch (err) {
        setContextError(
          err instanceof Error ? err.message : t("gitStatusLoadContextFailed"),
        );
        setContextLoading(false);
        return;
      }
      setContextLoading(false);
    }
    setShowFullContext(!showFullContext);
  }, [
    showFullContext,
    fullContextResult,
    projectId,
    file.path,
    file.staged,
    file.status,
    t,
  ]);

  // Scroll to first changed line when showing full context
  useEffect(() => {
    if (showFullContext && fullContextResult && contentRef.current) {
      requestAnimationFrame(() => {
        const firstChange = contentRef.current?.querySelector(
          ".line-deleted, .line-inserted",
        );
        if (firstChange) {
          firstChange.scrollIntoView({ block: "center", behavior: "instant" });
        }
      });
    }
  }, [showFullContext, fullContextResult]);

  const displayResult =
    showFullContext && fullContextResult ? fullContextResult : diffResult;

  const markdownHtml =
    fullContextResult?.markdownHtml || diffResult.markdownHtml;

  return (
    <div className="diff-modal-content" ref={contentRef}>
      <div className="diff-context-controls">
        <span className="diff-context-path">{file.path}</span>
        <div className="diff-context-buttons">
          {hasMarkdownPreview && (
            <button
              type="button"
              className={`diff-context-toggle ${showMarkdownPreview ? "active" : ""}`}
              onClick={() => setShowMarkdownPreview(!showMarkdownPreview)}
            >
              {showMarkdownPreview ? t("gitStatusDiff") : t("gitStatusPreview")}
            </button>
          )}
          {!showMarkdownPreview && (
            <button
              type="button"
              className="diff-context-toggle"
              onClick={handleToggleContext}
              disabled={contextLoading}
            >
              {contextLoading
                ? t("gitStatusLoading")
                : showFullContext
                  ? t("gitStatusDiffOnly")
                  : t("gitStatusFullContext")}
            </button>
          )}
        </div>
        {contextError && (
          <span className="diff-context-error">{contextError}</span>
        )}
      </div>

      {showMarkdownPreview && markdownHtml ? (
        <div className="markdown-preview">
          <div
            className="markdown-rendered"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
            dangerouslySetInnerHTML={{ __html: markdownHtml }}
          />
        </div>
      ) : displayResult.diffHtml ? (
        <HighlightedDiff diffHtml={displayResult.diffHtml} />
      ) : (
        <DiffLines
          lines={displayResult.structuredPatch.flatMap((h) => h.lines)}
        />
      )}
    </div>
  );
}

function isSameGitFile(left: GitFileChange, right: GitFileChange): boolean {
  return gitFileKey(left) === gitFileKey(right);
}

function gitFileKey(file: GitFileChange): string {
  return `${file.path}\0${file.staged ? "1" : "0"}\0${file.status}`;
}

function formatCommitDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatCommitDateTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatRemoteCheckTime(
  value: string | null,
  nowMs: number,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (!value) {
    return t("gitStatusRemoteNever");
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }

  const elapsedMs = Math.max(0, nowMs - timestamp);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (elapsedMs < minuteMs) {
    return t("gitStatusRemoteJustNow");
  }
  if (elapsedMs < hourMs) {
    return t("gitStatusRemoteMinutesAgo", {
      count: Math.floor(elapsedMs / minuteMs),
    });
  }
  if (elapsedMs < dayMs) {
    return t("gitStatusRemoteHoursAgo", {
      count: Math.floor(elapsedMs / hourMs),
    });
  }
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getRemoteCheckMessage(
  result: GitRemoteCheckResult | null,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  switch (result?.status) {
    case "checked":
      return t("gitStatusRemoteCheckSuccess");
    case "busy":
      return t("gitStatusRemoteCheckBusy");
    case "not-a-git-repo":
      return t("gitStatusRemoteCheckNotRepo");
    case "failed":
      return t("gitStatusRemoteCheckFailed");
    default:
      return "";
  }
}

/** Render syntax-highlighted diff HTML from server */
const HighlightedDiff = memo(function HighlightedDiff({
  diffHtml,
}: {
  diffHtml: string;
}) {
  return (
    <div
      className="highlighted-diff"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is safe
      dangerouslySetInnerHTML={{ __html: diffHtml }}
    />
  );
});

/** Fallback plain-text diff renderer */
const DiffLines = memo(function DiffLines({ lines }: { lines: string[] }) {
  return (
    <div className="diff-hunk">
      <pre className="diff-content">
        {lines.map((line, i) => {
          const prefix = line[0];
          const className =
            prefix === "-"
              ? "diff-removed"
              : prefix === "+"
                ? "diff-added"
                : "diff-context";
          return (
            <div key={`${i}-${line.slice(0, 50)}`} className={className}>
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
});
