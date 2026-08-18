import type { GitStatusInfo, GitWorkingTreeFile } from "@yep-anywhere/shared";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../api/client";
import { FileViewer } from "../components/FileViewer";
import {
  SourceFileOutline,
  SourceFileSectionDivider,
  type SourceOutlinePathProps,
} from "../components/SourceFileOutline";
import { ResizableSourceColumns } from "../components/ResizableSourceColumns";
import {
  SourceFilePath,
  SourceFileRowButton,
  SourceFileStatusBadge,
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
import styles from "./BlameBrowser.module.css";

/**
 * The Source Control file surface. New servers expose the live Working Tree —
 * dirty, untracked, and tracked-unchanged files — with current content first
 * and blame as an optional projection. Older servers retain the released
 * tracked-only blame browser without making the new request.
 */
export function BlameBrowser({
  projectId,
  isWideScreen,
  initialPath,
  status,
  supportsWorkingTreeFiles = false,
  onOpenCommit,
  captureReviewProjections = false,
  t,
}: {
  projectId: string;
  isWideScreen: boolean;
  /** Seed the open file (the commit-diff → file bridge). */
  initialPath?: string;
  status?: GitStatusInfo;
  supportsWorkingTreeFiles?: boolean;
  /** Open a populated blame hash in the commit browser. */
  onOpenCommit?: (sha: string) => void;
  captureReviewProjections?: boolean;
  t: TranslationFn;
}) {
  const [files, setFiles] = useState<string[]>([]);
  const [workingTreeFiles, setWorkingTreeFiles] = useState<
    GitWorkingTreeFile[]
  >([]);
  const [inventoryTruncated, setInventoryTruncated] = useState(false);
  const [detailMode, setDetailMode] = useState<"contents" | "blame">(
    "contents",
  );
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

  // Seed/reseed the open file from the bridge's initialPath. Capability gating
  // is also the request boundary: older servers only see the released route.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFiles([]);
    setWorkingTreeFiles([]);
    setInventoryTruncated(false);
    setSelectedPath(initialPath ?? null);
    const request = supportsWorkingTreeFiles
      ? api.listGitWorkingTreeFiles(projectId).then((result) => ({
          files: result.files.map((file) => file.path),
          workingTreeFiles: result.files,
          truncated: result.truncated,
        }))
      : api.listGitFiles(projectId).then((result) => ({
          files: result.files,
          workingTreeFiles: [],
          truncated: result.truncated,
        }));
    request
      .then((result) => {
        if (cancelled) return;
        setFiles(result.files);
        setWorkingTreeFiles(result.workingTreeFiles);
        setInventoryTruncated(result.truncated);
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
  }, [projectId, initialPath, supportsWorkingTreeFiles, t]);

  const fileIndex = useMemo(() => new FileSearchIndex(files), [files]);
  const filtered = useMemo(() => fileIndex.search(query), [fileIndex, query]);
  const workingTreeFileByPath = useMemo(
    () => new Map(workingTreeFiles.map((file) => [file.path, file])),
    [workingTreeFiles],
  );
  const dirtyStatusByPath = useMemo(() => {
    const dirty = new Map<string, string>();
    for (const file of status?.files ?? []) dirty.set(file.path, file.status);
    return dirty;
  }, [status?.files]);
  const trackedChangedFiles = useMemo(
    () =>
      filtered.filter((path) => {
        const file = workingTreeFileByPath.get(path);
        return file?.tracked && dirtyStatusByPath.has(path);
      }),
    [dirtyStatusByPath, filtered, workingTreeFileByPath],
  );
  const untrackedFiles = useMemo(
    () => filtered.filter((path) => !workingTreeFileByPath.get(path)?.tracked),
    [filtered, workingTreeFileByPath],
  );
  const unchangedFiles = useMemo(
    () =>
      filtered.filter((path) => {
        const file = workingTreeFileByPath.get(path);
        return file?.tracked && !dirtyStatusByPath.has(path);
      }),
    [dirtyStatusByPath, filtered, workingTreeFileByPath],
  );
  const selectedWorkingTreeFile = selectedPath
    ? workingTreeFileByPath.get(selectedPath)
    : undefined;

  useEffect(() => {
    if (selectedPath !== null) setDetailMode("contents");
  }, [selectedPath]);

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
  const renderFileRow = (
    file: string,
    visiblePath = file,
    pathProps?: SourceOutlinePathProps,
  ): ReactNode => {
    const count = pathCommentCount.get(file) ?? 0;
    const menuActions = fileMenuActions(file);
    const inventoryEntry = workingTreeFileByPath.get(file);
    const fileStatus =
      dirtyStatusByPath.get(file) ??
      (inventoryEntry && !inventoryEntry.tracked ? "?" : undefined);
    return (
      <li key={file} className={`commit-file-row ${sourceRowMenuSurface}`}>
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
          <SourceFilePath {...pathProps} query={query} fullPath={file}>
            {visiblePath}
          </SourceFilePath>
          {fileStatus && <SourceFileStatusBadge status={fileStatus} t={t} />}
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
  };

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
          ) : supportsWorkingTreeFiles ? (
            <WorkingTreeFileList
              trackedChangedFiles={trackedChangedFiles}
              untrackedFiles={untrackedFiles}
              unchangedFiles={unchangedFiles}
              scopeKey={projectId}
              query={query}
              truncated={inventoryTruncated}
              renderFile={renderFileRow}
              t={t}
            />
          ) : (
            <ul className="blame-file-list" onKeyDown={handleSourceListKeyDown}>
              {filtered.map((file) => renderFileRow(file))}
            </ul>
          )}
        </div>

        {isWideScreen &&
          selectedPath &&
          (supportsWorkingTreeFiles ? (
            <WorkingTreeFileDetail
              projectId={projectId}
              path={selectedPath}
              tracked={selectedWorkingTreeFile?.tracked ?? false}
              mode={detailMode}
              onModeChange={setDetailMode}
              onOpenCommit={onOpenCommit}
              captureReviewProjections={captureReviewProjections}
              t={t}
            />
          ) : (
            <BlameView
              projectId={projectId}
              path={selectedPath}
              onOpenCommit={onOpenCommit}
              captureReviewProjections={captureReviewProjections}
              onContentWidthChange={handleContentWidthChange}
              t={t}
            />
          ))}
      </ResizableSourceColumns>
      {fileMenu.menu}

      {!isWideScreen && selectedPath && (
        <Modal
          title={selectedPath}
          onClose={() => setSelectedPath(null)}
          closeOnBackGesture
        >
          {supportsWorkingTreeFiles ? (
            <WorkingTreeFileDetail
              projectId={projectId}
              path={selectedPath}
              tracked={selectedWorkingTreeFile?.tracked ?? false}
              mode={detailMode}
              onModeChange={setDetailMode}
              onOpenCommit={onOpenCommit}
              captureReviewProjections={captureReviewProjections}
              t={t}
            />
          ) : (
            <BlameView
              projectId={projectId}
              path={selectedPath}
              onOpenCommit={onOpenCommit}
              captureReviewProjections={captureReviewProjections}
              t={t}
            />
          )}
        </Modal>
      )}
    </div>
  );
}

function WorkingTreeFileList({
  trackedChangedFiles,
  untrackedFiles,
  unchangedFiles,
  scopeKey,
  query,
  truncated,
  renderFile,
  t,
}: {
  trackedChangedFiles: string[];
  untrackedFiles: string[];
  unchangedFiles: string[];
  scopeKey: string;
  query: string;
  truncated: boolean;
  renderFile: (
    path: string,
    visiblePath?: string,
    pathProps?: SourceOutlinePathProps,
  ) => ReactNode;
  t: TranslationFn;
}) {
  const searching = query.trim().length > 0;
  const renderOutline = (files: string[], section: string) => (
    <SourceFileOutline
      className="blame-file-list"
      items={files.map((path) => ({
        id: path,
        path,
        displayPath: path,
        value: path,
      }))}
      scopeKey={`${scopeKey}:${section}`}
      query={query}
      renderFile={(item, visiblePath, pathProps) =>
        renderFile(item.value, visiblePath, pathProps)
      }
      t={t}
    />
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: delegates arrow traversal across the sectioned file lists to their nested controls
    <div className={styles.inventory} onKeyDown={handleSourceListKeyDown}>
      {trackedChangedFiles.length > 0 &&
        renderOutline(trackedChangedFiles, "tracked-changes")}
      {untrackedFiles.length > 0 && (
        <>
          <SourceFileSectionDivider>
            {t("sourceUntrackedFiles")}
          </SourceFileSectionDivider>
          {renderOutline(untrackedFiles, "untracked")}
        </>
      )}
      {unchangedFiles.length > 0 && (
        <>
          <SourceFileSectionDivider>
            {t("sourceUnchangedFiles")}
          </SourceFileSectionDivider>
          {renderOutline(unchangedFiles, "unchanged")}
        </>
      )}
      {truncated && !searching && (
        <div className={styles.truncated} role="status">
          {t("sourceWorkingTreeFilesTruncated", {
            count:
              trackedChangedFiles.length +
              untrackedFiles.length +
              unchangedFiles.length,
          })}
        </div>
      )}
    </div>
  );
}

function WorkingTreeFileDetail({
  projectId,
  path,
  tracked,
  mode,
  onModeChange,
  onOpenCommit,
  captureReviewProjections,
  t,
}: {
  projectId: string;
  path: string;
  tracked: boolean;
  mode: "contents" | "blame";
  onModeChange: (mode: "contents" | "blame") => void;
  onOpenCommit?: (sha: string) => void;
  captureReviewProjections: boolean;
  t: TranslationFn;
}) {
  const effectiveMode = tracked ? mode : "contents";
  return (
    <section className={styles.detail}>
      {tracked && (
        <div className={styles.detailModes} role="group">
          <button
            type="button"
            className={effectiveMode === "contents" ? styles.activeMode : ""}
            aria-pressed={effectiveMode === "contents"}
            onClick={() => onModeChange("contents")}
          >
            {t("sourceViewContents")}
          </button>
          <button
            type="button"
            className={effectiveMode === "blame" ? styles.activeMode : ""}
            aria-pressed={effectiveMode === "blame"}
            onClick={() => onModeChange("blame")}
          >
            {t("sourceViewBlame")}
          </button>
        </div>
      )}
      {effectiveMode === "blame" ? (
        <BlameView
          projectId={projectId}
          path={path}
          onOpenCommit={onOpenCommit}
          captureReviewProjections={captureReviewProjections}
          t={t}
        />
      ) : (
        <FileViewer projectId={projectId} filePath={path} />
      )}
    </section>
  );
}
