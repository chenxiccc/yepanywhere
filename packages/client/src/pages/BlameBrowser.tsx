import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { ResizableSourceColumns } from "../components/ResizableSourceColumns";
import {
  SourceFilePath,
  SourceFileRowButton,
} from "../components/SourceFileRow";
import {
  SourceRowMenuTrigger,
  sourceRowMenuSurface,
  type SourceContextMenuAction,
  useSourceContextMenu,
} from "../components/SourceContextMenu";
import { Modal } from "../components/ui/Modal";
import { useProjectReviewComments } from "../hooks/useProjectReviewComments";
import {
  handleSourceListKeyDown,
  useSourceSearchShortcut,
} from "../hooks/useSourceKeyboard";
import { FileSearchIndex } from "../lib/fileSearchIndex";
import { writeClipboardText } from "../lib/clipboard";
import { BlameView } from "./BlameView";
import type { TranslationFn } from "../i18n";

/**
 * The all-files blame browser (topic: source-review-to-session, stage 3): the
 * repo's tracked files (`git ls-files`) with an instant filename filter, and a
 * blame view of the selected file. A subsection of the source-control surface,
 * not a standalone browser — blame comments feed the same review accumulator.
 */
export function BlameBrowser({
  projectId,
  isWideScreen,
  initialPath,
  onOpenCommit,
  captureReviewProjections = false,
  t,
}: {
  projectId: string;
  isWideScreen: boolean;
  /** Seed the open file (the commit-diff → blame-at-HEAD bridge). */
  initialPath?: string;
  /** Open a populated blame hash in the commit browser. */
  onOpenCommit?: (sha: string) => void;
  captureReviewProjections?: boolean;
  t: TranslationFn;
}) {
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(
    initialPath ?? null,
  );
  const [naturalDetailMeasurement, setNaturalDetailMeasurement] = useState<{
    path: string;
    width: number;
  } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const fileMenu = useSourceContextMenu(t);
  useSourceSearchShortcut(searchInputRef);
  const { pending } = useProjectReviewComments(projectId);
  const pathCommentCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of pending) {
      counts.set(
        comment.anchor.path,
        (counts.get(comment.anchor.path) ?? 0) + 1,
      );
    }
    return counts;
  }, [pending]);

  // Load the file list; seed/reseed the open file from the bridge's initialPath
  // (a new initialPath means "open this file's blame", e.g. from a commit diff).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFiles([]);
    setSelectedPath(initialPath ?? null);
    api
      .listGitFiles(projectId)
      .then((result) => {
        if (cancelled) return;
        setFiles(result.files);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t("gitStatusLoading"));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, initialPath, t]);

  const fileIndex = useMemo(() => new FileSearchIndex(files), [files]);
  const filtered = useMemo(() => fileIndex.search(query), [fileIndex, query]);

  // A wide file browser is a master-detail view: keep the detail pane useful
  // by selecting the first visible file when there is no still-visible
  // selection. Mobile deliberately stays on the list until the user taps.
  useEffect(() => {
    if (!isWideScreen || loading || error || filtered.length === 0) return;
    setSelectedPath((current) =>
      current && filtered.includes(current) ? current : (filtered[0] ?? null),
    );
  }, [error, filtered, isWideScreen, loading]);

  const fileMenuActions = useCallback(
    (file: string): SourceContextMenuAction[] => [
      {
        label: t("sourceOpenFile"),
        onSelect: () => setSelectedPath(file),
      },
      {
        label: t("sourceCopyPath"),
        onSelect: () => {
          void writeClipboardText(file);
        },
      },
    ],
    [t],
  );
  const handleContentWidthChange = useCallback(
    (path: string, width: number) => {
      setNaturalDetailMeasurement({ path, width });
    },
    [],
  );
  const naturalDetailWidth =
    naturalDetailMeasurement?.path === selectedPath
      ? naturalDetailMeasurement.width
      : undefined;

  return (
    <div className="blame-browser">
      <ResizableSourceColumns
        layout="files"
        initialFilesWidth={340}
        naturalDetailWidth={isWideScreen ? naturalDetailWidth : undefined}
        className="blame-browser-columns"
        t={t}
      >
        <div className="blame-file-column">
          <div className="source-search-field">
            <input
              ref={searchInputRef}
              type="search"
              className="source-search-input"
              value={query}
              placeholder={t("sourceFilterFiles")}
              aria-keyshortcuts="/"
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.preventDefault();
                  setQuery("");
                }
              }}
              onChange={(event) => setQuery(event.target.value)}
            />
            <kbd className="source-search-shortcut">/</kbd>
          </div>
          {loading ? (
            <div className="git-diff-loading">{t("gitStatusLoading")}</div>
          ) : error ? (
            <div className="git-diff-error">{error}</div>
          ) : filtered.length === 0 ? (
            <div className="git-status-empty">{t("sourceNoFiles")}</div>
          ) : (
            <ul className="blame-file-list" onKeyDown={handleSourceListKeyDown}>
              {filtered.map((file) => {
                const count = pathCommentCount.get(file) ?? 0;
                const menuActions = fileMenuActions(file);
                return (
                  <li
                    key={file}
                    className={`commit-file-row ${sourceRowMenuSurface}`}
                  >
                    <SourceFileRowButton
                      path={file}
                      type="button"
                      className={`blame-file-item ${
                        selectedPath === file ? "selected" : ""
                      }`}
                      data-source-list-item
                      onFocus={() => {
                        if (isWideScreen) setSelectedPath(file);
                      }}
                      {...fileMenu.targetProps(menuActions, () => {
                        setSelectedPath(file);
                      })}
                    >
                      <SourceFilePath>{file}</SourceFilePath>
                      {count > 0 && (
                        <span
                          className="source-comment-badge"
                          title={t("sourceCommentCount", { count })}
                        >
                          {count}
                        </span>
                      )}
                    </SourceFileRowButton>
                    <SourceRowMenuTrigger
                      actions={menuActions}
                      label={t("sourceMoreActions")}
                      onOpen={fileMenu.openFromButton}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {isWideScreen && selectedPath && (
          <BlameView
            projectId={projectId}
            path={selectedPath}
            onOpenCommit={onOpenCommit}
            captureReviewProjections={captureReviewProjections}
            onContentWidthChange={handleContentWidthChange}
            t={t}
          />
        )}
      </ResizableSourceColumns>
      {fileMenu.menu}

      {!isWideScreen && selectedPath && (
        <Modal
          title={selectedPath}
          onClose={() => setSelectedPath(null)}
          closeOnBackGesture
        >
          <BlameView
            projectId={projectId}
            path={selectedPath}
            onOpenCommit={onOpenCommit}
            captureReviewProjections={captureReviewProjections}
            t={t}
          />
        </Modal>
      )}
    </div>
  );
}
