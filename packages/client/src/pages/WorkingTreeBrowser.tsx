import type {
  GitFileChange,
  GitRecentCommit,
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
import { api } from "../api/client";
import { ChangesetFileFilter } from "../components/ChangesetFileFilter";
import { ResizableSourceColumns } from "../components/ResizableSourceColumns";
import { SourceFileHeaderActions } from "../components/SourceFileHeaderActions";
import {
  SourceFilePath,
  SourceFileRowButton,
  SourceFileStatusBadge,
} from "../components/SourceFileRow";
import {
  SourceRowMenuTrigger,
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
import type { TranslationFn } from "../i18n";
import { writeClipboardText } from "../lib/clipboard";
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
  onBlameFile,
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
  onBlameFile?: (path: string) => void;
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
  const fileMenu = useSourceContextMenu(t);
  const { pending } = useProjectReviewComments(projectId);

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
    for (const path of untrackedFolderKey
      ? untrackedFolderKey.split("\0")
      : []) {
      api
        .getGitUntrackedFolder(projectId, path)
        .then((info) => {
          if (cancelled) return;
          setExpandedUntrackedFolders((current) => ({
            ...current,
            [path]: info,
          }));
        })
        .catch(() => {
          // Keep the compact folder row visible; it stays non-previewable.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [projectId, untrackedFolderKey]);

  const currentFiles = useMemo(
    () =>
      mergeWorkingTreeFiles(
        expandUntrackedFolders(status.files, expandedUntrackedFolders),
      ),
    [expandedUntrackedFolders, status.files],
  );
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
    (file: WorktreeFileChange): SourceContextMenuAction[] => [
      {
        label: t("sourceCopyPath"),
        onSelect: () => {
          void writeClipboardText(file.path);
        },
      },
      ...(onBlameFile
        ? [
            {
              label: t("sourceBlameAtHead"),
              onSelect: () => onBlameFile(file.path),
            },
          ]
        : []),
    ],
    [onBlameFile, t],
  );

  const fileActions = selectedFile ? (
    <SourceFileHeaderActions
      path={selectedFile.path}
      onBlameFile={onBlameFile}
      t={t}
    />
  ) : null;

  const hasRetainedEditorTarget = commentEditorOpen && selectedFile !== null;
  const rootClassName = `working-tree-browser ${
    embeddedInHistory ? "working-tree-browser-history" : ""
  }`.trim();
  const backToRevisions = onBackToRevisions ? (
    <button
      type="button"
      className="source-mobile-back"
      onClick={onBackToRevisions}
    >
      ← {t("sourceBackToCommits")}
    </button>
  ) : null;
  if (
    (status.isClean || currentFiles.length === 0) &&
    !hasRetainedEditorTarget
  ) {
    return (
      <div className={rootClassName} data-testid="working-tree-browser">
        {backToRevisions}
        {embeddedInHistory ? (
          <div className="git-status-empty">
            {t("gitStatusWorkingTreeClean")}
          </div>
        ) : (
          <div className="working-tree-clean-landing">
            <div className="git-status-empty">
              {t("gitStatusWorkingTreeClean")}
            </div>
            <RecentCommits commits={status.recentCommits ?? []} t={t} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={rootClassName} data-testid="working-tree-browser">
      {backToRevisions}
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
                <li key={file.path} className="commit-file-row">
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
          {!embeddedInHistory && (
            <RecentCommits commits={status.recentCommits ?? []} t={t} />
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

function RecentCommits({
  commits,
  t,
}: {
  commits: GitRecentCommit[];
  t: TranslationFn;
}) {
  return (
    <section
      className="git-recent-commits"
      aria-label={t("gitStatusRecentCommits")}
    >
      <h3 className="git-recent-title">{t("gitStatusRecentCommits")}</h3>
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

function expandUntrackedFolders(
  files: GitFileChange[],
  expanded: Record<string, GitUntrackedFolderInfo>,
): GitFileChange[] {
  return files.flatMap((file) => {
    const folder = expanded[file.path];
    if (file.status !== "?" || !file.path.endsWith("/") || !folder) {
      return [file];
    }
    return folder.files.map((path) => ({
      path,
      status: "?",
      staged: false,
      linesAdded: null,
      linesDeleted: null,
    }));
  });
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
    return {
      path: representative.path,
      status: representative.status,
      staged: worktreeState === "staged",
      linesAdded: singleLayer ? representative.linesAdded : null,
      linesDeleted: singleLayer ? representative.linesDeleted : null,
      ...(origPath ? { origPath } : {}),
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

function formatCommitDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatCommitDateTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
