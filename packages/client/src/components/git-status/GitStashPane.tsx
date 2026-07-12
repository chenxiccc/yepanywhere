import type {
  GitFileChange,
  GitStashDetail,
  GitStashFileChange,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import { useLongPressContextMenu } from "../../hooks/useLongPressContextMenu";
import type { useI18n } from "../../i18n";
import { Button } from "../ui/Button";
import { FileContextMenu } from "./FileContextMenu";
import type { FileContextMenuState } from "./FileContextMenu";
import { GitPreviewPane } from "./GitPreviewPane";
import { FilePathLabel, WithStatusBadge, formatRelativeTime } from "./utils";

type Translate = ReturnType<typeof useI18n>["t"];

export function GitStashPane({
  projectId,
  selectedStashRef,
  busyAction,
  t,
  onDiscard,
  onRestore,
  previewInline = true,
  onStashLoaded,
  onFileSelect,
  projectPath,
}: {
  projectId: string;
  selectedStashRef: string | null;
  busyAction: string | null;
  t: Translate;
  onDiscard: (stashRef: string) => void;
  onRestore: (stashRef: string) => void;
  previewInline?: boolean;
  onStashLoaded?: (stash: GitStashDetail | null) => void;
  onFileSelect?: (
    file: GitFileChange,
    stashRef: { ref: string; previousPath?: string },
  ) => void;
  /** 项目根目录绝对路径 / Project root absolute path */
  projectPath?: string;
}) {
  const [stash, setStash] = useState<GitStashDetail | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<FileContextMenuState | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    if (!selectedStashRef) {
      setStash(null);
      setSelectedFilePath(null);
      setError(null);
      setLoading(false);
      onStashLoaded?.(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .getGitStashDetail(projectId, selectedStashRef)
      .then((result) => {
        if (cancelled) return;
        setStash(result.stash);
        setSelectedFilePath(null);
        onStashLoaded?.(result.stash);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setStash(null);
        setSelectedFilePath(null);
        setError(err instanceof Error ? err.message : String(err));
        onStashLoaded?.(null);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [onStashLoaded, projectId, selectedStashRef]);

  if (!selectedStashRef) {
    return (
      <div className="git-preview-empty">
        {t("sourceManagerStashedSelectStash")}
      </div>
    );
  }

  if (loading) {
    return <div className="git-diff-loading">{t("gitStatusLoading")}</div>;
  }

  if (error) {
    return <div className="git-diff-error">{error}</div>;
  }

  if (!stash) {
    return <div className="git-preview-empty">{t("sourceManagerNoPreview")}</div>;
  }

  const selectedFile =
    previewInline && selectedFilePath
      ? (stash.files.find((file) => file.path === selectedFilePath) ?? null)
      : null;
  const previewFile = selectedFile ? toPreviewFile(selectedFile) : null;

  return (
    <div className="git-history-pane">
      <div className="git-history-content">
        <div className="git-history-sidebar-panel">
          <div className="git-history-commit-header">
            <div className="git-history-commit-copy">
              <h2 className="git-history-commit-title">
                {stash.createdByApp ? t("sourceManagerStashedTitle") : stash.message}
              </h2>
              <div className="git-history-commit-meta">
                {stash.branch ? <span>{stash.branch}</span> : null}
                <span>{stash.ref}</span>
                <span>{formatRelativeTime(stash.createdAt, t)}</span>
              </div>
              <div className="git-stash-actions">
                <Button
                  variant="secondary"
                  className="git-stash-discard-button"
                  onClick={() => onDiscard(stash.ref)}
                  disabled={busyAction !== null}
                >
                  {busyAction === "discardStash"
                    ? t("gitStatusLoading")
                    : t("sourceManagerStashedDiscard")}
                </Button>
                <Button
                  variant="primary"
                  className="git-stash-restore-button"
                  onClick={() => onRestore(stash.ref)}
                  disabled={busyAction !== null}
                >
                  {busyAction === "restoreStash"
                    ? t("gitStatusLoading")
                    : t("sourceManagerStashedRestore")}
                </Button>
              </div>
            </div>
          </div>

          <aside className="git-history-files-panel">
            <div className="git-history-files-header">
              {t("sourceManagerFilesChanged", { count: stash.files.length })}
            </div>
            <ul className="git-history-files-list">
              {stash.files.map((file) => {
                const isSelected = file.path === selectedFilePath;
                return (
                  <StashFileItem
                    key={`${stash.ref}:${file.path}`}
                    file={file}
                    isSelected={isSelected}
                    onSelect={(f) => {
                      if (previewInline) {
                        setSelectedFilePath(f.path);
                        return;
                      }
                      onFileSelect?.(toPreviewFile(f), {
                        ref: stash.ref,
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
                stashRef={{
                  ref: stash.ref,
                  previousPath: selectedFile?.previousPath,
                }}
              />
            ) : (
              <div className="git-preview-empty">
                {t("sourceManagerHistorySelectFile")}
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

function StashFileItem({
  file,
  isSelected,
  onSelect,
  onContextMenu,
}: {
  file: GitStashFileChange;
  isSelected: boolean;
  onSelect: (file: GitStashFileChange) => void;
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

function toPreviewFile(file: GitStashFileChange): GitFileChange {
  return {
    path: file.path,
    status: file.status,
    staged: true,
    linesAdded: file.linesAdded,
    linesDeleted: file.linesDeleted,
    origPath: file.previousPath,
  };
}
