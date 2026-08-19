import type {
  GitStatusInfo,
  GitWorkingTreeFile,
  GitWorkingTreePathKind,
  GitWorktreeCoverage,
} from "@yep-anywhere/shared";
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
import { ResizableSourceColumns } from "../components/ResizableSourceColumns";
import {
  type SourceContextMenuAction,
  SourceRowMenuTrigger,
  sourceRowMenuSurface,
  useSourceContextMenu,
} from "../components/SourceContextMenu";
import {
  SourceFileOutline,
  SourceFileSectionDivider,
  type SourceOutlinePathProps,
} from "../components/SourceFileOutline";
import {
  SourceFilePath,
  SourceFileRowButton,
  SourceFileStatusBadge,
} from "../components/SourceFileRow";
import { Modal } from "../components/ui/Modal";
import { useProjectReviewComments } from "../hooks/useProjectReviewComments";
import { useProjectWorktree } from "../hooks/useProjectWorktree";
import {
  handleSourceListKeyDown,
  useSourceSearchShortcut,
} from "../hooks/useSourceKeyboard";
import type { TranslationFn } from "../i18n";
import { writeClipboardText } from "../lib/clipboard";
import { FileSearchIndex } from "../lib/fileSearchIndex";
import styles from "./BlameBrowser.module.css";
import { BlameView } from "./BlameView";

const DEFAULT_WORKTREE_COVERAGE: GitWorktreeCoverage = {
  tracked: true,
  untracked: true,
  ignored: false,
};

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
  supportsWorktreeSections = false,
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
  supportsWorktreeSections?: boolean;
  /** Open a populated blame hash in the commit browser. */
  onOpenCommit?: (sha: string) => void;
  captureReviewProjections?: boolean;
  t: TranslationFn;
}) {
  const [files, setFiles] = useState<string[]>([]);
  const [workingTreeFiles, setWorkingTreeFiles] = useState<
    GitWorkingTreeFile[]
  >([]);
  const [coverage, setCoverage] = useState<GitWorktreeCoverage>(
    DEFAULT_WORKTREE_COVERAGE,
  );
  const [pointerMoving, setPointerMoving] = useState(false);
  const pointerQuietTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlePointerMove = useCallback(() => {
    setPointerMoving(true);
    if (pointerQuietTimer.current) clearTimeout(pointerQuietTimer.current);
    pointerQuietTimer.current = setTimeout(() => {
      pointerQuietTimer.current = null;
      setPointerMoving(false);
    }, 200);
  }, []);
  useEffect(
    () => () => {
      if (pointerQuietTimer.current) clearTimeout(pointerQuietTimer.current);
    },
    [],
  );
  const liveWorktree = useProjectWorktree(
    projectId,
    coverage,
    supportsWorktreeSections,
    undefined,
    pointerMoving,
  );
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
    if (supportsWorktreeSections) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFiles([]);
    setWorkingTreeFiles([]);
    setInventoryTruncated(false);
    setSelectedPath((current) => initialPath ?? current);
    const request = supportsWorkingTreeFiles
      ? api
          .listGitWorkingTreeFiles(
            projectId,
            supportsWorktreeSections ? coverage : undefined,
          )
          .then((result) => ({
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
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    coverage,
    projectId,
    initialPath,
    supportsWorkingTreeFiles,
    supportsWorktreeSections,
  ]);

  const effectiveWorkingTreeFiles = useMemo(
    () =>
      supportsWorktreeSections
        ? liveWorktree.files.filter(
            (file) =>
              file.present !== false &&
              coverage[workingTreeKind(file) ?? "untracked"],
          )
        : workingTreeFiles,
    [coverage, liveWorktree.files, supportsWorktreeSections, workingTreeFiles],
  );
  const effectiveFiles = useMemo(
    () =>
      supportsWorktreeSections
        ? effectiveWorkingTreeFiles.map((file) => file.path)
        : files,
    [effectiveWorkingTreeFiles, files, supportsWorktreeSections],
  );
  const effectiveLoading = supportsWorktreeSections
    ? liveWorktree.loading
    : loading;
  const effectiveError = supportsWorktreeSections
    ? (liveWorktree.error?.message ?? null)
    : error;
  const effectiveInventoryTruncated = supportsWorktreeSections
    ? liveWorktree.truncated
    : inventoryTruncated;
  const fileIndex = useMemo(
    () => new FileSearchIndex(effectiveFiles),
    [effectiveFiles],
  );
  const filtered = useMemo(() => fileIndex.search(query), [fileIndex, query]);
  const workingTreeFileByPath = useMemo(
    () =>
      new Map(
        effectiveWorkingTreeFiles.map((file) => [file.path, file] as const),
      ),
    [effectiveWorkingTreeFiles],
  );
  const dirtyStatusByPath = useMemo(() => {
    const dirty = new Map<string, string>();
    if (supportsWorktreeSections) {
      for (const file of liveWorktree.files) {
        const change = file.worktreeChanges?.at(-1);
        if (change) dirty.set(file.path, change.status);
      }
    } else {
      for (const file of status?.files ?? []) dirty.set(file.path, file.status);
    }
    return dirty;
  }, [liveWorktree.files, status?.files, supportsWorktreeSections]);
  const trackedFiles = useMemo(
    () =>
      filtered.filter(
        (path) =>
          workingTreeKind(workingTreeFileByPath.get(path)) === "tracked",
      ),
    [filtered, workingTreeFileByPath],
  );
  const untrackedFiles = useMemo(
    () =>
      filtered.filter(
        (path) =>
          workingTreeKind(workingTreeFileByPath.get(path)) === "untracked",
      ),
    [filtered, workingTreeFileByPath],
  );
  const ignoredFiles = useMemo(
    () =>
      filtered.filter(
        (path) =>
          workingTreeKind(workingTreeFileByPath.get(path)) === "ignored",
      ),
    [filtered, workingTreeFileByPath],
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
    if (
      !isWideScreen ||
      effectiveLoading ||
      effectiveError ||
      filtered.length === 0
    ) {
      return;
    }
    setSelectedPath((current) =>
      current && filtered.includes(current) ? current : (filtered[0] ?? null),
    );
  }, [effectiveError, effectiveLoading, filtered, isWideScreen]);

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
  const toggleCoverage = useCallback((kind: GitWorkingTreePathKind) => {
    setCoverage((current) => ({ ...current, [kind]: !current[kind] }));
  }, []);
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
      (workingTreeKind(inventoryEntry) === "untracked" ? "?" : undefined);
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
        <div
          className="blame-file-column"
          onPointerMove={
            supportsWorktreeSections ? handlePointerMove : undefined
          }
        >
          {supportsWorktreeSections && (
            <WorktreeSectionControls
              coverage={coverage}
              onToggle={toggleCoverage}
              t={t}
            />
          )}
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
          {effectiveLoading ? (
            <div className="git-diff-loading">{t("gitStatusLoading")}</div>
          ) : effectiveError ? (
            <div className="git-diff-error">{effectiveError}</div>
          ) : supportsWorkingTreeFiles ? (
            <WorkingTreeFileList
              trackedFiles={trackedFiles}
              untrackedFiles={untrackedFiles}
              ignoredFiles={ignoredFiles}
              coverage={coverage}
              sectionsEnabled={supportsWorktreeSections}
              onToggle={toggleCoverage}
              scopeKey={projectId}
              query={query}
              truncated={effectiveInventoryTruncated}
              renderFile={renderFileRow}
              t={t}
            />
          ) : filtered.length === 0 ? (
            <div className="git-status-empty">{t("sourceNoFiles")}</div>
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

function WorktreeSectionControls({
  coverage,
  onToggle,
  t,
}: {
  coverage: GitWorktreeCoverage;
  onToggle: (kind: GitWorkingTreePathKind) => void;
  t: TranslationFn;
}) {
  const sections: Array<{
    kind: GitWorkingTreePathKind;
    label: string;
  }> = [
    { kind: "tracked", label: t("sourceTrackedFiles") },
    { kind: "untracked", label: t("sourceUntrackedFiles") },
    { kind: "ignored", label: t("sourceIgnoredFiles") },
  ];
  return (
    <fieldset
      className={styles.sectionControls}
      aria-label={t("sourceWorkingTreeSections")}
    >
      {sections.map(({ kind, label }) => (
        <button
          key={kind}
          type="button"
          className={`${styles.sectionToggle} ${
            coverage[kind] ? styles.activeSectionToggle : ""
          }`}
          aria-pressed={coverage[kind]}
          onClick={() => onToggle(kind)}
        >
          <span aria-hidden="true">{coverage[kind] ? "●" : "○"}</span>
          {label}
        </button>
      ))}
    </fieldset>
  );
}

function WorkingTreeFileList({
  trackedFiles,
  untrackedFiles,
  ignoredFiles,
  coverage,
  sectionsEnabled,
  onToggle,
  scopeKey,
  query,
  truncated,
  renderFile,
  t,
}: {
  trackedFiles: string[];
  untrackedFiles: string[];
  ignoredFiles: string[];
  coverage: GitWorktreeCoverage;
  sectionsEnabled: boolean;
  onToggle: (kind: GitWorkingTreePathKind) => void;
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
  const sections: Array<{
    kind: GitWorkingTreePathKind;
    label: string;
    files: string[];
  }> = [
    {
      kind: "tracked",
      label: t("sourceTrackedFiles"),
      files: trackedFiles,
    },
    {
      kind: "untracked",
      label: t("sourceUntrackedFiles"),
      files: untrackedFiles,
    },
    {
      kind: "ignored",
      label: t("sourceIgnoredFiles"),
      files: ignoredFiles,
    },
  ];

  if (!sectionsEnabled) {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: delegates arrow traversal across the sectioned file lists to their nested controls
      <div className={styles.inventory} onKeyDown={handleSourceListKeyDown}>
        {trackedFiles.length > 0 && renderOutline(trackedFiles, "tracked")}
        {untrackedFiles.length > 0 && (
          <>
            <SourceFileSectionDivider>
              {t("sourceUntrackedFiles")}
            </SourceFileSectionDivider>
            {renderOutline(untrackedFiles, "untracked")}
          </>
        )}
      </div>
    );
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: delegates arrow traversal across the sectioned file lists to their nested controls
    <div className={styles.inventory} onKeyDown={handleSourceListKeyDown}>
      {sections.map(({ kind, label, files }) => (
        <div key={kind}>
          <SourceFileSectionDivider
            expanded={coverage[kind]}
            onToggle={() => onToggle(kind)}
          >
            {label}
          </SourceFileSectionDivider>
          {coverage[kind] && files.length > 0 && renderOutline(files, kind)}
        </div>
      ))}
      {truncated && !searching && (
        <div className={styles.truncated} role="status">
          {t("sourceWorkingTreeFilesTruncated", {
            count:
              trackedFiles.length + untrackedFiles.length + ignoredFiles.length,
          })}
        </div>
      )}
    </div>
  );
}

function workingTreeKind(
  file: GitWorkingTreeFile | undefined,
): GitWorkingTreePathKind | undefined {
  return (
    file?.kind ?? (file ? (file.tracked ? "tracked" : "untracked") : undefined)
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
        <fieldset
          className={styles.detailModes}
          aria-label={t("sourceViewMode")}
        >
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
        </fieldset>
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
