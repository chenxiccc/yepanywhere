import type {
  GitFileChange,
  GitStatusInfo,
  GitUntrackedFolderInfo,
} from "@yep-anywhere/shared";
import {
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
import {
  GitDiffModal,
  GitDiffPreview,
  type GitDiffPreviewHandle,
  type GitDiffSource,
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
  const [fileQuery, setFileQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [commentEditorOpen, setCommentEditorOpen] = useState(false);
  const [appliedWorkingTreeLink, setAppliedWorkingTreeLink] = useState<
    string | null
  >(null);
  const retainedFileRef = useRef<WorktreeFileChange | null>(null);
  const diffPreviewRef = useRef<GitDiffPreviewHandle>(null);
  const navigate = useNavigate();
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
    const paths = untrackedFolderKey ? untrackedFolderKey.split("\0") : [];
    if (paths.length === 0) return undefined;

    // Each expansion is a separate `git status --untracked-files=all` on the
    // server, and a repository with hundreds of untracked directories has
    // hundreds of them to run. Bound the fan-out so this background enrichment
    // never occupies the whole per-host connection budget: the foreground
    // status and the selected file's diff must not queue behind it.
    let nextPath = 0;
    const arrived: Record<string, GitUntrackedFolderInfo> = {};
    let flushHandle: ReturnType<typeof setTimeout> | null = null;

    // Coalesce arrivals: one state update per folder would re-render the whole
    // changed-file list once per request.
    const flush = () => {
      flushHandle = null;
      if (cancelled) return;
      const batch = { ...arrived };
      for (const key of Object.keys(arrived)) delete arrived[key];
      setExpandedUntrackedFolders((current) => ({ ...current, ...batch }));
    };
    const scheduleFlush = () => {
      if (flushHandle === null) flushHandle = setTimeout(flush, FOLDER_FLUSH_MS);
    };

    const runNext = async (): Promise<void> => {
      while (!cancelled) {
        const path = paths[nextPath++];
        if (path === undefined) return;
        try {
          const info = await api.getGitUntrackedFolder(projectId, path);
          if (cancelled) return;
          arrived[path] = info;
          scheduleFlush();
        } catch {
          // Keep the compact folder row visible; it stays non-previewable.
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(UNTRACKED_FOLDER_CONCURRENCY, paths.length) },
      runNext,
    );
    void Promise.all(workers);

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
  const filteredFiles = useChangesetFileFilter(files, fileQuery);
  const visiblePreviewableFiles = useMemo(
    () => filteredFiles.filter((file) => !file.path.endsWith("/")),
    [filteredFiles],
  );
  const selectedFile =
    previewableFiles.find((file) => file.path === selectedPath) ?? null;
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
  }, [linkedFile, shouldApplyWorkingTreeLink, workingTreeLinkToken]);

  useEffect(() => {
    if (shouldApplyWorkingTreeLink) return;
    const selectionCandidates = fileQuery.trim()
      ? visiblePreviewableFiles
      : previewableFiles;
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
    fileQuery,
    previewableFiles,
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

  const handleFileClick = useCallback(
    (file: WorktreeFileChange) => {
      if (file.path.endsWith("/")) return;
      if (
        isWideScreen &&
        selectedPath === file.path &&
        diffPreviewRef.current?.jumpToNextHunk()
      ) {
        return;
      }
      setSelectedPath(file.path);
    },
    [isWideScreen, selectedPath],
  );

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
                onSelect: () => navigate(lastEditorSessionHref),
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
    [basePath, navigate, onBlameFile, projectId, supportsLastEditor, t],
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
            <ChangesetFileFilter
              query={fileQuery}
              onQueryChange={setFileQuery}
              t={t}
            />
          </div>
          <ul className="commit-file-list" onKeyDown={handleSourceListKeyDown}>
            {filteredFiles.map((file) => {
              const count = fileCommentCount.get(file.path) ?? 0;
              const isFolder = file.path.endsWith("/");
              const menuActions = fileMenuActions(file);
              const displayPath = sourceFileDisplayPath(file);
              return (
                <li
                  key={file.path}
                  className={`commit-file-row ${sourceRowMenuSurface}`}
                >
                  <SourceFileRowButton
                    path={displayPath}
                    type="button"
                    className={`commit-file-item ${
                      selectedPath === file.path ? "selected" : ""
                    }`}
                    disabled={isFolder}
                    data-source-list-item
                    onFocus={() => {
                      if (isWideScreen && !isFolder) {
                        setSelectedPath(file.path);
                      }
                    }}
                    {...fileMenu.targetProps(menuActions, () => {
                      handleFileClick(file);
                    })}
                  >
                    <SourceFileStatusBadge status={file.status} t={t} />
                    <WorktreeStateMarker state={file.worktreeState} t={t} />
                    <SourceFilePath>{displayPath}</SourceFilePath>
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
                    <SourceReviewStateBadges
                      states={reviewStatesByPath.get(file.path) ?? []}
                      t={t}
                    />
                  </SourceFileRowButton>
                  {!isFolder && (
                    <SourceRowMenuTrigger
                      actions={menuActions}
                      label={t("sourceMoreActions")}
                      onOpen={fileMenu.openFromButton}
                    />
                  )}
                </li>
              );
            })}
          </ul>
          {filteredFiles.length === 0 && (
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
