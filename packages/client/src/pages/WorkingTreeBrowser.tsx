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
import { api } from "../api/client";
import { CopyButton } from "../components/CopyButton";
import { useProjectReviewComments } from "../hooks/useProjectReviewComments";
import { handleSourceListKeyDown } from "../hooks/useSourceKeyboard";
import type { MessageKey, TranslationFn } from "../i18n";
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
  t: TranslationFn;
}) {
  const [expandedUntrackedFolders, setExpandedUntrackedFolders] = useState<
    Record<string, GitUntrackedFolderInfo>
  >({});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [commentEditorOpen, setCommentEditorOpen] = useState(false);
  const [appliedWorkingTreeLink, setAppliedWorkingTreeLink] = useState<
    string | null
  >(null);
  const retainedFileRef = useRef<WorktreeFileChange | null>(null);
  const diffPreviewRef = useRef<GitDiffPreviewHandle>(null);
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
    if (
      !shouldApplyWorkingTreeLink ||
      !workingTreeLinkToken ||
      !linkedFile
    ) {
      return;
    }
    setAppliedWorkingTreeLink(workingTreeLinkToken);
    setSelectedPath(linkedFile.path);
  }, [linkedFile, shouldApplyWorkingTreeLink, workingTreeLinkToken]);

  useEffect(() => {
    if (shouldApplyWorkingTreeLink) return;
    const nextPath =
      selectedPath &&
      previewableFiles.some((file) => file.path === selectedPath)
        ? selectedPath
        : isWideScreen
          ? (previewableFiles[0]?.path ?? null)
          : null;
    if (nextPath !== selectedPath) {
      setSelectedPath(nextPath);
    }
  }, [
    isWideScreen,
    previewableFiles,
    selectedPath,
    shouldApplyWorkingTreeLink,
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

  const fileActions = selectedFile ? (
    <>
      <CopyButton
        value={selectedFile.path}
        title={t("sourceCopyPath")}
        className="source-detail-action"
      />
      {onBlameFile && (
        <button
          type="button"
          className="source-detail-action"
          title={t("sourceBlameAtHead")}
          onClick={() => onBlameFile(selectedFile.path)}
        >
          {t("sourceBlameAtHeadShort")}
        </button>
      )}
    </>
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
        <div className="git-status-empty">{t("gitStatusWorkingTreeClean")}</div>
      </div>
    );
  }

  return (
    <div className={rootClassName} data-testid="working-tree-browser">
      {backToRevisions}
      <div className="working-tree-browser-columns">
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
          </div>
          <ul
            className="commit-file-list"
            onKeyDown={handleSourceListKeyDown}
          >
            {files.map((file) => {
              const count = fileCommentCount.get(file.path) ?? 0;
              const isFolder = file.path.endsWith("/");
              return (
                <li key={file.path} className="commit-file-row">
                  <button
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
                    onClick={() => handleFileClick(file)}
                  >
                    <span
                      className={`git-status-badge git-status-${file.status.toLowerCase()}`}
                    >
                      {file.status}
                    </span>
                    <span className="worktree-file-state">
                      {t(worktreeStateLabelKey(file.worktreeState))}
                    </span>
                    <span className="git-file-path" title={file.path}>
                      {file.origPath
                        ? `${file.origPath} → ${file.path}`
                        : file.path}
                    </span>
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
                  </button>
                </li>
              );
            })}
          </ul>
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
            t={t}
          />
        )}
      </div>

      {!isWideScreen && selectedFile && (
        <GitDiffModal
          file={selectedFile}
          fileKey={selectedFile.path}
          projectId={projectId}
          source={WORKING_TREE_SOURCE}
          headerActions={fileActions}
          onCommentEditorOpenChange={setCommentEditorOpen}
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

function worktreeStateLabelKey(state: WorktreeState): MessageKey {
  switch (state) {
    case "staged":
      return "sourceWorktreeStaged";
    case "both":
      return "sourceWorktreeBoth";
    case "untracked":
      return "sourceWorktreeUntracked";
    default:
      return "sourceWorktreeUnstaged";
  }
}
