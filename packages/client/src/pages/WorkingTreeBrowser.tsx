import type {
  GitFileChange,
  GitStatusInfo,
  GitUntrackedFolderInfo,
  ReviewSiteStateSummary,
} from "@yep-anywhere/shared";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { ChangesetFileFilter } from "../components/ChangesetFileFilter";
import { ResizableSourceColumns } from "../components/ResizableSourceColumns";
import { SourceFileHeaderActions } from "../components/SourceFileHeaderActions";
import {
  SourceFilePath,
  SourceFileRowButton,
  SourceFileStatusBadge,
  SourceReviewStateBadges,
} from "../components/SourceFileRow";
import {
  SourceRowMenuTrigger,
  sourceRowMenuSurface,
  type SourceContextMenuAction,
  type SourceContextMenuController,
  useSourceContextMenu,
} from "../components/SourceContextMenu";
import {
  sourceFileDisplayPath,
  useChangesetFileFilter,
} from "../hooks/useChangesetFileFilter";
import { useProjectReviewComments } from "../hooks/useProjectReviewComments";
import { handleSourceListKeyDown } from "../hooks/useSourceKeyboard";
import { useTextTooltipAttributes } from "../hooks/useTooltipAppearance";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import type { TranslationFn } from "../i18n";
import { writeClipboardText } from "../lib/clipboard";
import { CommitHistoryParentLink } from "./CommitHistoryParentLink";
import styles from "./WorkingTreeBrowser.module.css";
import {
  GitDiffModal,
  GitDiffPreview,
  type GitDiffPreviewHandle,
  type GitDiffSource,
  type GitDiffViewState,
} from "./GitStatusDiffPreview";

type WorktreeState = "staged" | "unstaged" | "both" | "untracked";
type WorktreeFileChange = GitFileChange & { worktreeState: WorktreeState };

const WORKING_TREE_SOURCE: GitDiffSource = {
  kind: "working-tree-history",
};

/**
 * Simultaneous untracked-folder expansions. Kept well under the browser's
 * per-host connection budget so foreground Source Control requests stay
 * responsive while a large untracked corpus fills in behind them.
 */
const UNTRACKED_FOLDER_CONCURRENCY = 4;

/** How long arriving expansions accumulate before one list re-render. */
const FOLDER_FLUSH_MS = 100;
const UNTRACKED_GROUP_COLLAPSE_THRESHOLD = 10;

const EMPTY_REVIEW_STATES: ReviewSiteStateSummary[] = [];

type WorktreeListEntry =
  | {
      kind: "file";
      file: WorktreeFileChange;
      displayPath: string;
    }
  | {
      kind: "folder";
      path: string;
      info?: GitUntrackedFolderInfo;
      expanded: boolean;
      children: Array<{
        file: WorktreeFileChange;
        displayPath: string;
      }>;
    };

const WorkingTreeFileRow = memo(function WorkingTreeFileRow({
  file,
  displayPath = sourceFileDisplayPath(file),
  query,
  selected,
  commentCount,
  reviewStates,
  isWideScreen,
  menuActionsForFile,
  menuTargetProps,
  onOpenMenu,
  onActivateFile,
  t,
}: {
  file: WorktreeFileChange;
  displayPath?: string;
  query: string;
  selected: boolean;
  commentCount: number;
  reviewStates: ReviewSiteStateSummary[];
  isWideScreen: boolean;
  menuActionsForFile: (file: WorktreeFileChange) => SourceContextMenuAction[];
  menuTargetProps: SourceContextMenuController["targetProps"];
  onOpenMenu: SourceContextMenuController["openFromButton"];
  onActivateFile: (file: WorktreeFileChange, selected: boolean) => void;
  t: TranslationFn;
}) {
  const isFolder = file.path.endsWith("/");
  const menuActions = menuActionsForFile(file);
  const tooltipPath =
    displayPath === sourceFileDisplayPath(file) ? displayPath : file.path;

  return (
    <li className={`commit-file-row ${sourceRowMenuSurface}`}>
      <SourceFileRowButton
        path={tooltipPath}
        type="button"
        className={`commit-file-item ${selected ? "selected" : ""}`}
        disabled={isFolder}
        data-source-list-item
        onFocus={() => {
          if (isWideScreen && !isFolder) {
            onActivateFile(file, selected);
          }
        }}
        {...menuTargetProps(menuActions, () => {
          onActivateFile(file, selected);
        })}
      >
        <SourceFileStatusBadge status={file.status} t={t} />
        <WorktreeStateMarker state={file.worktreeState} t={t} />
        <SourceFilePath query={query}>{displayPath}</SourceFilePath>
        {(file.linesAdded !== null || file.linesDeleted !== null) && (
          <span className="git-line-counts">
            {file.linesAdded ? (
              <span className="git-lines-added">+{file.linesAdded}</span>
            ) : null}
            {file.linesDeleted ? (
              <span className="git-lines-deleted">−{file.linesDeleted}</span>
            ) : null}
          </span>
        )}
        {commentCount > 0 && (
          <span
            className="source-comment-badge"
            title={t("sourceCommentCount", { count: commentCount })}
          >
            {commentCount}
          </span>
        )}
        <SourceReviewStateBadges states={reviewStates} t={t} />
      </SourceFileRowButton>
      {!isFolder && (
        <SourceRowMenuTrigger
          actions={menuActions}
          label={t("sourceMoreActions")}
          onOpen={onOpenMenu}
        />
      )}
    </li>
  );
});

/**
 * The current HEAD-to-filesystem view shared by Changes and the optional
 * Working tree revision in Commits. Both entry points therefore keep one file
 * merge, diff, comment-anchor, and refresh-survival implementation.
 */
export function WorkingTreeBrowser({
  projectId,
  status,
  isWideScreen,
  initialWorkingTreePath,
  embeddedInHistory = false,
  onBackToRevisions,
  revisionNavigation,
  onBrowseHistory,
  onBlameFile,
  captureReviewProjections = false,
  supportsLastEditor = false,
  ignoreWhitespace = false,
  onToggleIgnoreWhitespace,
  onProjectionRequestFailure,
  t,
}: {
  projectId: string;
  status: GitStatusInfo;
  isWideScreen: boolean;
  /** One-shot deep link to a dirty file from a session Edit block. */
  initialWorkingTreePath?: string;
  /** Let Commits place these same files/diff in its revision-detail columns. */
  embeddedInHistory?: boolean;
  /** Narrow-history drill-in returns to the revision list through this path. */
  onBackToRevisions?: () => void;
  /** Adjacent-revision controls supplied by the history owner. */
  revisionNavigation?: ReactNode;
  /** Open commit history while keeping Working tree as the default revision. */
  onBrowseHistory?: () => void;
  onBlameFile?: (path: string) => void;
  captureReviewProjections?: boolean;
  supportsLastEditor?: boolean;
  ignoreWhitespace?: boolean;
  onToggleIgnoreWhitespace?: () => void;
  onProjectionRequestFailure?: () => void;
  t: TranslationFn;
}) {
  const [expandedUntrackedFolders, setExpandedUntrackedFolders] = useState<
    Record<string, GitUntrackedFolderInfo>
  >({});
  const [untrackedFolderScan, setUntrackedFolderScan] = useState({
    loaded: 0,
    total: 0,
  });
  const [untrackedFolderExpansion, setUntrackedFolderExpansion] = useState<
    Record<string, boolean>
  >({});
  const [fileQuery, setFileQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [commentEditorOpen, setCommentEditorOpen] = useState(false);
  const [appliedWorkingTreeLink, setAppliedWorkingTreeLink] = useState<
    string | null
  >(null);
  const retainedFileRef = useRef<WorktreeFileChange | null>(null);
  const retainedDiffViewRef = useRef(new Map<string, GitDiffViewState>());
  const retainedScrollRatioRef = useRef(new Map<string, number>());
  const diffPreviewRef = useRef<GitDiffPreviewHandle>(null);
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);
  const navigateTo = useCallback((href: string) => {
    navigateRef.current(href);
  }, []);
  const basePath = useRemoteBasePath();
  const fileMenu = useSourceContextMenu(t);
  const { pending, siteStates } = useProjectReviewComments(
    projectId,
    captureReviewProjections,
  );

  const untrackedFolderKey = useMemo(
    () =>
      status.files
        .filter((file) => file.status === "?" && file.path.endsWith("/"))
        .map((file) => file.path)
        .join("\0"),
    [status.files],
  );

  useEffect(() => {
    let cancelled = false;
    setExpandedUntrackedFolders({});
    setUntrackedFolderExpansion({});
    const paths = untrackedFolderKey ? untrackedFolderKey.split("\0") : [];
    setUntrackedFolderScan({ loaded: 0, total: paths.length });
    if (paths.length === 0) return undefined;

    // Each expansion is a separate `git status --untracked-files=all` on the
    // server, and a repository with hundreds of untracked directories has
    // hundreds of them to run. Bound the fan-out so this background enrichment
    // never occupies the whole per-host connection budget: the foreground
    // status and the selected file's diff must not queue behind it.
    let nextPath = 0;
    let completed = 0;
    const arrived: Record<string, GitUntrackedFolderInfo> = {};
    let flushHandle: ReturnType<typeof setTimeout> | null = null;

    // Coalesce arrivals and progress: one state update per folder would rerender
    // the whole changed-file list once per request.
    const flush = () => {
      flushHandle = null;
      if (cancelled) return;
      const batch = { ...arrived };
      for (const key of Object.keys(arrived)) delete arrived[key];
      if (Object.keys(batch).length > 0) {
        setExpandedUntrackedFolders((current) => ({ ...current, ...batch }));
      }
      setUntrackedFolderScan({ loaded: completed, total: paths.length });
    };
    const scheduleFlush = () => {
      if (flushHandle === null) {
        flushHandle = setTimeout(flush, FOLDER_FLUSH_MS);
      }
    };

    const runNext = async (): Promise<void> => {
      while (!cancelled) {
        const path = paths[nextPath++];
        if (path === undefined) return;
        try {
          const info = await api.getGitUntrackedFolder(projectId, path);
          if (cancelled) return;
          arrived[path] = info;
        } catch {
          // Keep the compact folder row visible; it stays non-previewable.
        } finally {
          if (!cancelled) {
            completed += 1;
            scheduleFlush();
          }
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(UNTRACKED_FOLDER_CONCURRENCY, paths.length) },
      runNext,
    );
    void Promise.all(workers).then(() => {
      if (cancelled) return;
      if (flushHandle !== null) clearTimeout(flushHandle);
      flush();
    });

    return () => {
      cancelled = true;
      if (flushHandle !== null) clearTimeout(flushHandle);
    };
  }, [projectId, untrackedFolderKey]);

  const previousRowsRef = useRef<{
    statusFiles: GitFileChange[];
    byPath: Map<string, WorktreeFileChange>;
  } | null>(null);
  const currentFiles = useMemo(() => {
    const merged = mergeWorkingTreeFiles(
      expandUntrackedFolders(status.files, expandedUntrackedFolders),
    );
    // Untracked-folder expansions arrive in batches and rebuild every row,
    // including the rows they did not touch. A row's object identity is the
    // signal the diff pane refetches on, so handing out a fresh-but-equal
    // object for the selected file recomputed its diff once per arriving
    // batch. Reuse the previous object whenever the row's state is unchanged.
    //
    // A new status snapshot deliberately falls through to fresh objects: that
    // is exactly the live-refresh signal the diff pane must reload on, whether
    // or not the summary fields moved.
    const previous =
      previousRowsRef.current?.statusFiles === status.files
        ? previousRowsRef.current.byPath
        : null;
    const byPath = new Map<string, WorktreeFileChange>();
    const rows = merged.map((row) => {
      const prior = previous?.get(row.path);
      const kept = prior && sameWorktreeRow(prior, row) ? prior : row;
      byPath.set(row.path, kept);
      return kept;
    });
    previousRowsRef.current = { statusFiles: status.files, byPath };
    return rows;
  }, [expandedUntrackedFolders, status.files]);
  useEffect(() => {
    if (!selectedPath) return;
    const selected = currentFiles.find((file) => file.path === selectedPath);
    if (selected) retainedFileRef.current = selected;
  }, [currentFiles, selectedPath]);
  const files = useMemo(() => {
    const retained = retainedFileRef.current;
    if (
      commentEditorOpen &&
      selectedPath &&
      retained?.path === selectedPath &&
      !currentFiles.some((file) => file.path === selectedPath)
    ) {
      return [...currentFiles, retained];
    }
    return currentFiles;
  }, [commentEditorOpen, currentFiles, selectedPath]);
  const previewableFiles = useMemo(
    () => files.filter((file) => !file.path.endsWith("/")),
    [files],
  );
  const matchingFiles = useChangesetFileFilter(files, fileQuery);
  const matchingPaths = useMemo(
    () => new Set(matchingFiles.map((file) => file.path)),
    [matchingFiles],
  );
  const listEntries = useMemo(
    () =>
      buildWorktreeListEntries({
        statusFiles: status.files,
        files,
        folders: expandedUntrackedFolders,
        folderExpansion: untrackedFolderExpansion,
        matchingPaths,
        query: fileQuery,
      }),
    [
      expandedUntrackedFolders,
      fileQuery,
      files,
      matchingPaths,
      status.files,
      untrackedFolderExpansion,
    ],
  );
  const visiblePreviewableFiles = useMemo(
    () =>
      listEntries.flatMap((entry) =>
        entry.kind === "file"
          ? [entry.file]
          : entry.children.map((child) => child.file),
      ),
    [listEntries],
  );
  const selectedFile =
    previewableFiles.find((file) => file.path === selectedPath) ?? null;
  const retainedDiffView = selectedFile
    ? retainedDiffViewRef.current.get(selectedFile.path)
    : undefined;
  const retainedScrollRatio = selectedFile
    ? retainedScrollRatioRef.current.get(selectedFile.path)
    : undefined;
  const linkedFile = initialWorkingTreePath
    ? previewableFiles.find((file) => file.path === initialWorkingTreePath)
    : undefined;
  const workingTreeLinkToken = initialWorkingTreePath
    ? `${projectId}\0${initialWorkingTreePath}`
    : null;
  const shouldApplyWorkingTreeLink =
    !!workingTreeLinkToken &&
    !!linkedFile &&
    appliedWorkingTreeLink !== workingTreeLinkToken;

  // Apply an Edit-block link once. Later status polls may update the diff, but
  // closing the phone modal must not force it open again.
  useEffect(() => {
    if (!shouldApplyWorkingTreeLink || !workingTreeLinkToken || !linkedFile) {
      return;
    }
    setAppliedWorkingTreeLink(workingTreeLinkToken);
    setSelectedPath(linkedFile.path);
    const linkedFolder = Object.entries(expandedUntrackedFolders).find(
      ([, info]) => info.files.includes(linkedFile.path),
    )?.[0];
    if (linkedFolder) {
      setUntrackedFolderExpansion((current) => ({
        ...current,
        [linkedFolder]: true,
      }));
    }
  }, [
    expandedUntrackedFolders,
    linkedFile,
    shouldApplyWorkingTreeLink,
    workingTreeLinkToken,
  ]);

  useEffect(() => {
    if (shouldApplyWorkingTreeLink) return;
    const selectionCandidates = visiblePreviewableFiles;
    const nextPath =
      selectedPath &&
      selectionCandidates.some((file) => file.path === selectedPath)
        ? selectedPath
        : isWideScreen
          ? (selectionCandidates[0]?.path ?? null)
          : null;
    if (nextPath !== selectedPath) {
      setSelectedPath(nextPath);
    }
  }, [
    isWideScreen,
    selectedPath,
    shouldApplyWorkingTreeLink,
    visiblePreviewableFiles,
  ]);

  const fileCommentCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of pending) {
      if (comment.anchor.revision.kind !== "uncommitted") continue;
      counts.set(
        comment.anchor.path,
        (counts.get(comment.anchor.path) ?? 0) + 1,
      );
    }
    return counts;
  }, [pending]);
  const reviewStatesByPath = useMemo(() => {
    const states = new Map<string, typeof siteStates>();
    for (const state of siteStates) {
      const current = states.get(state.path);
      if (current) current.push(state);
      else states.set(state.path, [state]);
    }
    return states;
  }, [siteStates]);

  const toggleUntrackedFolder = useCallback(
    (path: string, expanded: boolean) => {
      setUntrackedFolderExpansion((current) => ({
        ...current,
        [path]: !expanded,
      }));
    },
    [],
  );

  const handleFileClick = useCallback(
    (file: WorktreeFileChange, selected: boolean) => {
      if (file.path.endsWith("/")) return;
      if (
        isWideScreen &&
        selected &&
        diffPreviewRef.current?.jumpToNextHunk()
      ) {
        return;
      }
      setSelectedPath(file.path);
    },
    [isWideScreen],
  );

  const retainDiffView = useCallback(
    (fileKey: string, view: GitDiffViewState) => {
      retainedDiffViewRef.current.set(fileKey, {
        ...retainedDiffViewRef.current.get(fileKey),
        ...view,
      });
    },
    [],
  );
  const retainScrollRatio = useCallback((fileKey: string, ratio: number) => {
    retainedScrollRatioRef.current.set(fileKey, ratio);
  }, []);

  const fileMenuActions = useCallback(
    (file: WorktreeFileChange): SourceContextMenuAction[] => {
      const lastEditorSessionHref =
        supportsLastEditor && file.lastEditor
          ? `${basePath}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(file.lastEditor.sessionId)}`
          : undefined;
      return [
        {
          label: t("sourceCopyPath"),
          onSelect: () => {
            void writeClipboardText(file.path);
          },
        },
        ...(lastEditorSessionHref
          ? [
              {
                label: t("sourceOpenLastEditorSession"),
                onSelect: () => navigateTo(lastEditorSessionHref),
              },
            ]
          : []),
        ...(onBlameFile
          ? [
              {
                label: t("sourceBlameAtHead"),
                onSelect: () => onBlameFile(file.path),
              },
            ]
          : []),
      ];
    },
    [basePath, navigateTo, onBlameFile, projectId, supportsLastEditor, t],
  );

  const lastEditorSessionHref =
    supportsLastEditor && selectedFile?.lastEditor
      ? `${basePath}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(selectedFile.lastEditor.sessionId)}`
      : undefined;
  const fileActions = selectedFile ? (
    <SourceFileHeaderActions
      path={selectedFile.path}
      lastEditorSessionHref={lastEditorSessionHref}
      onBlameFile={onBlameFile}
      t={t}
    />
  ) : null;
  const renderFileRow = ({
    file,
    displayPath,
  }: {
    file: WorktreeFileChange;
    displayPath: string;
  }) => (
    <WorkingTreeFileRow
      key={file.path}
      file={file}
      displayPath={displayPath}
      query={fileQuery}
      selected={selectedPath === file.path}
      commentCount={fileCommentCount.get(file.path) ?? 0}
      reviewStates={reviewStatesByPath.get(file.path) ?? EMPTY_REVIEW_STATES}
      isWideScreen={isWideScreen}
      menuActionsForFile={fileMenuActions}
      menuTargetProps={fileMenu.targetProps}
      onOpenMenu={fileMenu.openFromButton}
      onActivateFile={handleFileClick}
      t={t}
    />
  );

  const hasRetainedEditorTarget = commentEditorOpen && selectedFile !== null;
  const rootClassName = `working-tree-browser ${
    embeddedInHistory ? "working-tree-browser-history" : ""
  }`.trim();
  const openHistory = onBackToRevisions ?? onBrowseHistory;
  const historyParentLink = openHistory ? (
    <CommitHistoryParentLink onClick={openHistory} t={t} />
  ) : null;
  if (
    (status.isClean || currentFiles.length === 0) &&
    !hasRetainedEditorTarget
  ) {
    return (
      <div className={rootClassName} data-testid="working-tree-browser">
        {historyParentLink}
        {embeddedInHistory ? (
          <div className="working-tree-clean-state working-tree-history-clean">
            <span className="working-tree-clean-icon" aria-hidden="true">
              ✓
            </span>
            <div className="git-status-empty">
              {t("gitStatusWorkingTreeClean")}
            </div>
            <p>{t("sourceWorkingTreeCleanDescription")}</p>
          </div>
        ) : (
          <div className="working-tree-clean-landing">
            <div className="working-tree-clean-state">
              <span className="working-tree-clean-icon" aria-hidden="true">
                ✓
              </span>
              <div className="git-status-empty">
                {t("gitStatusWorkingTreeClean")}
              </div>
              <p>{t("sourceWorkingTreeCleanDescription")}</p>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={rootClassName} data-testid="working-tree-browser">
      {historyParentLink}
      <ResizableSourceColumns
        layout="files"
        enabled={!embeddedInHistory}
        className="working-tree-browser-columns"
        t={t}
      >
        <div className="commit-files-column working-tree-files-column">
          <div className="source-detail-banner">
            {revisionNavigation}
            {embeddedInHistory ? (
              <span className="source-detail-identity working-tree-detail-identity">
                <span className="working-tree-detail-title-row">
                  <span className="source-detail-subject">
                    {t("sourceWorkingTree")}
                  </span>
                  <span
                    className="working-tree-detail-count"
                    title={t("sourceChangedFileCount", {
                      count: files.length,
                    })}
                  >
                    {files.length}
                  </span>
                </span>
                <span
                  className="source-detail-title"
                  title={t("sourceWorkingTreeDescription")}
                >
                  {t("sourceUncommitted")}
                </span>
              </span>
            ) : (
              <>
                <span
                  className="source-detail-title"
                  title={t("sourceWorkingTreeDescription")}
                >
                  {t("sourceWorkingTree")}
                </span>
                <span className="source-detail-count">
                  {t("sourceChangedFileCount", { count: files.length })}
                </span>
              </>
            )}
            {untrackedFolderScan.total > 0 && (
              <span className={styles.scanProgress} role="status">
                {t("sourceUntrackedFolderScanProgress", {
                  loaded: untrackedFolderScan.loaded,
                  total: untrackedFolderScan.total,
                })}
              </span>
            )}
            <ChangesetFileFilter
              query={fileQuery}
              onQueryChange={setFileQuery}
              t={t}
            />
          </div>
          <ul className="commit-file-list" onKeyDown={handleSourceListKeyDown}>
            {listEntries.map((entry) =>
              entry.kind === "file" ? (
                renderFileRow(entry)
              ) : (
                <li key={entry.path} className={styles.folderGroup}>
                  <div className={styles.folderHeader}>
                    <SourceFileRowButton
                      path={entry.path}
                      type="button"
                      className="commit-file-item"
                      disabled={!entry.info || entry.info.files.length === 0}
                      aria-expanded={entry.info ? entry.expanded : undefined}
                      aria-label={t(
                        entry.info
                          ? entry.expanded
                            ? "sourceCollapseUntrackedFolder"
                            : "sourceExpandUntrackedFolder"
                          : "sourceLoadingUntrackedFolder",
                        { path: entry.path },
                      )}
                      data-source-list-item
                      onClick={() =>
                        toggleUntrackedFolder(entry.path, entry.expanded)
                      }
                    >
                      <span className={styles.disclosure} aria-hidden="true">
                        {entry.info ? (entry.expanded ? "−" : "+") : "…"}
                      </span>
                      <SourceFileStatusBadge status="?" t={t} />
                      <SourceFilePath query={fileQuery}>
                        {entry.path}
                      </SourceFilePath>
                      {entry.info && (
                        <span
                          className={styles.folderCount}
                          title={
                            entry.info.truncated
                              ? t("sourceUntrackedFolderTruncated", {
                                  count: entry.info.files.length,
                                })
                              : undefined
                          }
                        >
                          {entry.info.files.length}
                          {entry.info.truncated ? "+" : ""}
                        </span>
                      )}
                    </SourceFileRowButton>
                  </div>
                  {entry.children.length > 0 && (
                    <ul className={styles.folderChildren}>
                      {entry.children.map(renderFileRow)}
                    </ul>
                  )}
                </li>
              ),
            )}
          </ul>
          {listEntries.length === 0 && (
            <div className="git-status-empty">{t("sourceNoMatches")}</div>
          )}
        </div>

        {isWideScreen && selectedFile && (
          <GitDiffPreview
            ref={diffPreviewRef}
            file={selectedFile}
            fileKey={selectedFile.path}
            projectId={projectId}
            source={WORKING_TREE_SOURCE}
            retainedScrollRatio={retainedScrollRatio}
            retainedDiffView={retainedDiffView}
            onRetainScrollRatio={retainScrollRatio}
            onRetainDiffView={retainDiffView}
            headerActions={fileActions}
            onCommentEditorOpenChange={setCommentEditorOpen}
            captureReviewProjections={captureReviewProjections}
            ignoreWhitespace={ignoreWhitespace}
            onToggleIgnoreWhitespace={onToggleIgnoreWhitespace}
            onProjectionRequestFailure={onProjectionRequestFailure}
            t={t}
          />
        )}
      </ResizableSourceColumns>
      {fileMenu.menu}

      {!isWideScreen && selectedFile && (
        <GitDiffModal
          file={selectedFile}
          fileKey={selectedFile.path}
          projectId={projectId}
          source={WORKING_TREE_SOURCE}
          retainedScrollRatio={retainedScrollRatio}
          retainedDiffView={retainedDiffView}
          onRetainScrollRatio={retainScrollRatio}
          onRetainDiffView={retainDiffView}
          headerActions={fileActions}
          onCommentEditorOpenChange={setCommentEditorOpen}
          captureReviewProjections={captureReviewProjections}
          ignoreWhitespace={ignoreWhitespace}
          onToggleIgnoreWhitespace={onToggleIgnoreWhitespace}
          onProjectionRequestFailure={onProjectionRequestFailure}
          t={t}
          onClose={() => setSelectedPath(null)}
        />
      )}
    </div>
  );
}

function buildWorktreeListEntries({
  statusFiles,
  files,
  folders,
  folderExpansion,
  matchingPaths,
  query,
}: {
  statusFiles: GitFileChange[];
  files: WorktreeFileChange[];
  folders: Record<string, GitUntrackedFolderInfo>;
  folderExpansion: Record<string, boolean>;
  matchingPaths: ReadonlySet<string>;
  query: string;
}): WorktreeListEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  const byPath = new Map(files.map((file) => [file.path, file]));
  const emitted = new Set<string>();
  const entries: WorktreeListEntry[] = [];

  for (const statusFile of statusFiles) {
    const isCompactUntrackedFolder =
      statusFile.status === "?" && statusFile.path.endsWith("/");
    if (isCompactUntrackedFolder) {
      const info = folders[statusFile.path];
      const allChildren =
        info?.files.flatMap((path) => {
          emitted.add(path);
          const file = byPath.get(path);
          return file
            ? [
                {
                  file,
                  displayPath: path.startsWith(statusFile.path)
                    ? path.slice(statusFile.path.length)
                    : path,
                },
              ]
            : [];
        }) ?? [];
      const matchingChildren = normalizedQuery
        ? allChildren.filter(({ file }) => matchingPaths.has(file.path))
        : allChildren;
      const folderMatches = statusFile.path
        .toLowerCase()
        .includes(normalizedQuery);
      emitted.add(statusFile.path);
      if (normalizedQuery && !folderMatches && matchingChildren.length === 0) {
        continue;
      }
      const userExpanded =
        folderExpansion[statusFile.path] ??
        (info
          ? info.files.length <= UNTRACKED_GROUP_COLLAPSE_THRESHOLD
          : false);
      const expanded = normalizedQuery
        ? matchingChildren.length > 0
        : userExpanded;
      entries.push({
        kind: "folder",
        path: statusFile.path,
        ...(info ? { info } : {}),
        expanded,
        children: normalizedQuery
          ? matchingChildren
          : expanded
            ? allChildren
            : [],
      });
      continue;
    }

    const file = byPath.get(statusFile.path);
    if (!file || emitted.has(file.path)) continue;
    emitted.add(file.path);
    if (normalizedQuery && !matchingPaths.has(file.path)) continue;
    entries.push({
      kind: "file",
      file,
      displayPath: sourceFileDisplayPath(file),
    });
  }

  for (const file of files) {
    if (emitted.has(file.path) || file.path.endsWith("/")) continue;
    if (normalizedQuery && !matchingPaths.has(file.path)) continue;
    entries.push({
      kind: "file",
      file,
      displayPath: sourceFileDisplayPath(file),
    });
  }

  return entries;
}

function expandUntrackedFolders(
  files: GitFileChange[],
  expanded: Record<string, GitUntrackedFolderInfo>,
): GitFileChange[] {
  return files.flatMap((file) => {
    const folder = expanded[file.path];
    if (file.status !== "?" || !file.path.endsWith("/") || !folder) {
      return [file];
    }
    return folder.files.map((path) => {
      const lastEditor = folder.lastEditors?.[path];
      return {
        path,
        status: "?",
        staged: false,
        linesAdded: null,
        linesDeleted: null,
        ...(lastEditor ? { lastEditor } : {}),
      };
    });
  });
}

/** Whether two merged rows describe the same working-tree state for a path. */
function sameWorktreeRow(
  previous: WorktreeFileChange,
  next: WorktreeFileChange,
): boolean {
  return (
    previous.path === next.path &&
    previous.status === next.status &&
    previous.staged === next.staged &&
    previous.worktreeState === next.worktreeState &&
    previous.linesAdded === next.linesAdded &&
    previous.linesDeleted === next.linesDeleted &&
    previous.origPath === next.origPath &&
    previous.lastEditor?.sessionId === next.lastEditor?.sessionId &&
    previous.lastEditor?.observedAt === next.lastEditor?.observedAt
  );
}

/** Collapse index/worktree layers into one HEAD-to-filesystem row per path. */
function mergeWorkingTreeFiles(files: GitFileChange[]): WorktreeFileChange[] {
  const byPath = new Map<string, GitFileChange[]>();
  for (const file of files) {
    const entries = byPath.get(file.path);
    if (entries) entries.push(file);
    else byPath.set(file.path, [file]);
  }

  return Array.from(byPath.values(), (entries) => {
    const untracked = entries.find((file) => file.status === "?");
    const staged = entries.find((file) => file.staged);
    const unstaged = entries.find(
      (file) => !file.staged && file.status !== "?",
    );
    const rename = entries.find(
      (file) => file.status === "R" || file.status === "C",
    );
    const representative =
      untracked ?? rename ?? unstaged ?? staged ?? entries[0]!;
    const worktreeState: WorktreeState = untracked
      ? "untracked"
      : staged && unstaged
        ? "both"
        : staged
          ? "staged"
          : "unstaged";
    const singleLayer = entries.length === 1;
    const origPath = entries.find((file) => file.origPath)?.origPath;
    const lastEditor = entries.find((file) => file.lastEditor)?.lastEditor;
    return {
      path: representative.path,
      status: representative.status,
      staged: worktreeState === "staged",
      linesAdded: singleLayer ? representative.linesAdded : null,
      linesDeleted: singleLayer ? representative.linesDeleted : null,
      ...(origPath ? { origPath } : {}),
      ...(lastEditor ? { lastEditor } : {}),
      worktreeState,
    };
  });
}

function WorktreeStateMarker({
  state,
  t,
}: {
  state: WorktreeState;
  t: TranslationFn;
}) {
  const label =
    state === "both"
      ? t("sourceWorktreePartialDescription")
      : state === "staged"
        ? t("sourceWorktreeStaged")
        : null;
  const tooltipAttributes = useTextTooltipAttributes(label);
  if (!label) return null;

  return (
    <span
      className={`worktree-file-state worktree-file-state-${state}`}
      role="img"
      aria-label={label}
      {...tooltipAttributes}
    >
      {state === "both" ? t("sourceWorktreePartial") : "✓"}
    </span>
  );
}
