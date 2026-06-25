import type {
  GitFileChange,
  GitStashDetail,
  GitStashFileChange,
} from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { useI18n } from "../../i18n";
import { Button } from "../ui/Button";
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
}) {
  const [stash, setStash] = useState<GitStashDetail | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        {t("gitStatusStashedSelectStash")}
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
    return <div className="git-preview-empty">{t("gitStatusNoPreview")}</div>;
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
                {stash.createdByApp ? t("gitStatusStashedTitle") : stash.message}
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
                    : t("gitStatusStashedDiscard")}
                </Button>
                <Button
                  variant="primary"
                  className="git-stash-restore-button"
                  onClick={() => onRestore(stash.ref)}
                  disabled={busyAction !== null}
                >
                  {busyAction === "restoreStash"
                    ? t("gitStatusLoading")
                    : t("gitStatusStashedRestore")}
                </Button>
              </div>
            </div>
          </div>

          <aside className="git-history-files-panel">
            <div className="git-history-files-header">
              {t("gitStatusFilesChanged", { count: stash.files.length })}
            </div>
            <ul className="git-history-files-list">
              {stash.files.map((file) => {
                const isSelected = file.path === selectedFilePath;
                return (
                  <li key={`${stash.ref}:${file.path}`}>
                    <button
                      type="button"
                      className={`git-history-file-item ${isSelected ? "git-history-file-item-selected" : ""}`}
                      onClick={() => {
                        if (previewInline) {
                          setSelectedFilePath(file.path);
                          return;
                        }

                        onFileSelect?.(toPreviewFile(file), {
                          ref: stash.ref,
                          previousPath: file.previousPath,
                        });
                      }}
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
                t={t}
                stashRef={{
                  ref: stash.ref,
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
    </div>
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
