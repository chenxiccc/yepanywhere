import type {
  GitHistoryCommitDetail,
  GitHistoryFileChange,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import { useLongPressContextMenu } from "../../hooks/useLongPressContextMenu";
import type { useI18n } from "../../i18n";
import { FileContextMenu } from "./FileContextMenu";
import type { FileContextMenuState } from "./FileContextMenu";
import { GitPreviewPane } from "./GitPreviewPane";
import { FilePathLabel, WithStatusBadge, formatAbsoluteTime } from "./utils";

type Translate = ReturnType<typeof useI18n>["t"];

interface HistoryDiffFile extends GitHistoryFileChange {
  staged: boolean;
  origPath?: string;
}

export function GitCommitHistoryPane({
  projectId,
  selectedCommitHash,
  t,
  previewInline = true,
  onCommitLoaded,
  onFileSelect,
  projectPath,
}: {
  projectId: string;
  selectedCommitHash: string | null;
  t: Translate;
  previewInline?: boolean;
  onCommitLoaded?: (commit: GitHistoryCommitDetail | null) => void;
  onFileSelect?: (
    file: HistoryDiffFile,
    historyCommit: { hash: string; previousPath?: string },
  ) => void;
  /** 项目根目录绝对路径 / Project root absolute path */
  projectPath?: string;
}) {
  const [commit, setCommit] = useState<GitHistoryCommitDetail | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedHash, setCopiedHash] = useState(false);
  const [contextMenu, setContextMenu] = useState<FileContextMenuState | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    if (!selectedCommitHash) {
      setCommit(null);
      setSelectedFilePath(null);
      setError(null);
      setLoading(false);
      setCopiedHash(false);
      onCommitLoaded?.(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .getGitHistoryCommit(projectId, selectedCommitHash)
      .then((result) => {
        if (cancelled) return;
        setCommit(result.commit);
        setSelectedFilePath(null);
        onCommitLoaded?.(result.commit);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setCommit(null);
        setSelectedFilePath(null);
        setError(err instanceof Error ? err.message : String(err));
        onCommitLoaded?.(null);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [onCommitLoaded, projectId, selectedCommitHash]);

  useEffect(() => {
    if (!copiedHash) return;

    const timeoutId = window.setTimeout(() => {
      setCopiedHash(false);
    }, 2000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [copiedHash]);

  const handleCopyHash = async () => {
    if (!commit) return;

    try {
      await navigator.clipboard.writeText(commit.hash);
      setCopiedHash(true);
    } catch (err) {
      console.error("Failed to copy commit hash:", err);
    }
  };

  if (!selectedCommitHash) {
    return null;
  }

  if (loading) {
    return <div className="git-diff-loading">{t("gitStatusLoading")}</div>;
  }

  if (error) {
    return <div className="git-diff-error">{error}</div>;
  }

  if (!commit) {
    return <div className="git-preview-empty">{t("gitStatusNoPreview")}</div>;
  }

  const selectedFile =
    previewInline && selectedFilePath
      ? (commit.files.find((file) => file.path === selectedFilePath) ?? null)
      : null;
  const previewFile = selectedFile ? toPreviewFile(selectedFile) : null;

  return (
    <div className="git-history-pane">
      <div className="git-history-content">
        <div className="git-history-sidebar-panel">
          <div className="git-history-commit-header">
            <div className="git-history-commit-copy">
              <h2 className="git-history-commit-title">{commit.message}</h2>
              <div className="git-history-commit-subtitle">
                <span className="git-history-commit-subtitle-left">
                  <span className="git-history-commit-meta-author">{commit.authorName}</span>
                  <span className="git-history-commit-meta-time">
                    {formatAbsoluteTime(commit.committedAt)}
                  </span>
                </span>
                <span className="git-history-commit-hash-group">
                  <span>{commit.shortHash}</span>
                  <button
                    type="button"
                    className={`git-history-copy-button ${copiedHash ? "copied" : ""}`}
                    onClick={handleCopyHash}
                    title={
                      copiedHash
                        ? t("gitStatusHistoryHashCopied")
                        : t("gitStatusHistoryCopyHash")
                    }
                    aria-label={
                      copiedHash
                        ? t("gitStatusHistoryHashCopied")
                        : t("gitStatusHistoryCopyHash")
                    }
                  >
                    {copiedHash ? <CheckIcon /> : <CopyIcon />}
                  </button>
                </span>
              </div>
              {commit.body ? (
                <div className="git-history-commit-body-wrapper">
                  <pre className="git-history-commit-body">{commit.body}</pre>
                </div>
              ) : null}
            </div>
          </div>

          <aside className="git-history-files-panel">
            <div className="git-history-files-header">
              <span>{t("gitStatusFilesChanged", { count: commit.files.length })}</span>
              <span className="git-history-files-header-stats">
                <span className="git-lines-added">+{commit.insertions}</span>
                <span className="git-lines-deleted">-{commit.deletions}</span>
              </span>
            </div>
            <ul className="git-history-files-list">
              {commit.files.map((file) => {
                const isSelected = file.path === selectedFilePath;
                return (
                  <HistoryFileItem
                    key={`${commit.hash}:${file.path}`}
                    file={file}
                    isSelected={isSelected}
                    onSelect={(f) => {
                      if (previewInline) {
                        setSelectedFilePath(f.path);
                        return;
                      }
                      onFileSelect?.(toPreviewFile(f), {
                        hash: commit.hash,
                        previousPath: f.previousPath,
                      });
                    }}
                    onContextMenu={setContextMenu}
                  />
                );
              })}
            </ul>
          </aside>
        </div>

        {previewInline ? (
          <section className="git-history-preview-panel">
            {previewFile ? (
              <GitPreviewPane
                file={previewFile}
                projectId={projectId}
                t={t as (key: string, vars?: Record<string, string | number>) => string}
                historyCommit={{
                  hash: commit.hash,
                  previousPath: selectedFile?.previousPath,
                }}
              />
            ) : (
              <div className="git-preview-empty">
                {t("gitStatusHistorySelectFile")}
              </div>
            )}
          </section>
        ) : null}
      </div>

      {projectPath && (
        <FileContextMenu
          menu={contextMenu}
          projectPath={projectPath}
          onClose={closeContextMenu}
          t={t as (key: string, vars?: Record<string, string | number>) => string}
        />
      )}
    </div>
  );
}

function toPreviewFile(file: GitHistoryFileChange): HistoryDiffFile {
  return {
    path: file.path,
    status: file.status,
    staged: true,
    linesAdded: file.linesAdded,
    linesDeleted: file.linesDeleted,
    origPath: file.previousPath,
  };
}

function HistoryFileItem({
  file,
  isSelected,
  onSelect,
  onContextMenu,
}: {
  file: GitHistoryFileChange;
  isSelected: boolean;
  onSelect: (file: GitHistoryFileChange) => void;
  onContextMenu: (menu: FileContextMenuState) => void;
}) {
  const openContextMenu = useCallback(
    (x: number, y: number) => {
      onContextMenu({
        path: file.path,
        name: file.path.split("/").pop() ?? file.path,
        isDirectory: false,
        x,
        y,
        showFileOperations: false,
      });
    },
    [file.path, onContextMenu],
  );

  const {
    handleContextMenu,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    wrapClick,
  } = useLongPressContextMenu(openContextMenu);

  const handleClick = wrapClick(() => onSelect(file));

  return (
    <li>
      <button
        type="button"
        className={`git-history-file-item ${isSelected ? "git-history-file-item-selected" : ""}`}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <span className="git-file-path">
          <WithStatusBadge file={toPreviewFile(file)}>
            {file.previousPath ? (
              <>
                <FilePathLabel path={file.previousPath} />
                <span className="git-file-path-arrow">→</span>
              </>
            ) : null}
            <FilePathLabel path={file.path} />
          </WithStatusBadge>
        </span>
      </button>
    </li>
  );
}

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5L6.5 12L13 4" />
    </svg>
  );
}
