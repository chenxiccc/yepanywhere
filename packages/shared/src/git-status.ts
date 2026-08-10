import type {
  ReviewCommentSide,
  ReviewSourceProjection,
} from "./review-comments.js";
import type { PatchHunk } from "./types.js";

export {
  GIT_DIRTY_FILE_EDITOR_CAPABILITY,
  GIT_FILE_DIFF_PROJECTIONS_CAPABILITY,
  GIT_SOURCE_REVIEW_CAPABILITY,
  GIT_SOURCE_REVIEW_PROJECTIONS_CAPABILITY,
  GIT_SOURCE_REVIEW_SUBMISSIONS_CAPABILITY,
  GIT_STATUS_CAPABILITY,
  GIT_STATUS_ENHANCED_CAPABILITY,
  GIT_STATUS_INTEGRATION_OPTIONS_CAPABILITY,
  GIT_STATUS_PULL_CAPABILITY,
  GIT_STATUS_PUSH_CAPABILITY,
  GIT_STATUS_REMOTE_CHECK_CAPABILITY,
} from "./server-capabilities.js";

/** Last YA session observed successfully mutating a still-dirty file. */
export interface GitFileEditor {
  sessionId: string;
  /** Successful tool-result observation time, as ISO 8601. */
  observedAt: string;
}

export interface GitFileChange {
  /** Relative path within the repo. May be a compact untracked directory. */
  path: string;
  /** Git status code: M, A, D, ?, R, T, U */
  status: string;
  /** Whether the change is staged (in the index) */
  staged: boolean;
  /** Lines added (null for binary or untracked files) */
  linesAdded: number | null;
  /** Lines deleted (null for binary or untracked files) */
  linesDeleted: number | null;
  /** Original path (for renames) */
  origPath?: string;
  /** Last YA session observed successfully mutating this dirty path. */
  lastEditor?: GitFileEditor;
}

export interface GitRecentCommit {
  /** Full commit hash */
  hash: string;
  /** Short commit hash for display */
  shortHash: string;
  /** Commit subject line */
  subject: string;
  /** Author display name */
  authorName: string;
  /** Author timestamp as an ISO 8601 string */
  authorDate: string;
}

/**
 * A commit's metadata plus the files it changed (topic:
 * source-review-to-session, stage 3 commit browser). Diffs are fetched per
 * file via `POST /git/commit-diff`, mirroring the working-tree diff flow.
 */
export interface GitCommitDetail extends GitRecentCommit {
  /** Full commit message body (may be empty or multi-line). */
  body: string;
  /** Files changed by the commit. Reuses {@link GitFileChange} with `staged` always false. */
  files: GitFileChange[];
}

/** A direct two-tree comparison from a selected revision to a pinned HEAD. */
export interface GitRevisionComparison {
  /** Resolved full SHA of the selected revision. */
  baseSha: string;
  /** Resolved full SHA of HEAD when the comparison was created. */
  headSha: string;
  /** Files whose content differs between the two revisions. */
  files: GitFileChange[];
}

export type GitFileDiffMode = "worktree" | "cumulative";

/** Exact file-change corpora backing file-viewer diff selectors. */
export interface GitFileProjectionManifest {
  /** Resolved HEAD used as the ordinary worktree baseline. */
  headSha: string | null;
  /** Resolved first parent of HEAD used as the cumulative baseline. */
  baseSha: string | null;
  /** Net changes from HEAD through the current filesystem. */
  worktreeFiles: GitFileChange[];
  /** Net changes from HEAD^1 through the current filesystem. */
  cumulativeFiles: GitFileChange[];
}

/** One page of commits for the commit browser. */
export interface GitCommitListResult {
  commits: GitRecentCommit[];
  /** True when more commits exist past this page (for "load more"). */
  hasMore: boolean;
}

/**
 * Complete commit order for the on-demand browser search index. Metadata is
 * intentionally small; changed-line text is fetched in bounded batches.
 */
export interface GitCommitSearchManifest {
  /** Current repository HEAD, or null for an empty repository. */
  head: string | null;
  /** Reachable commits, newest first, up to the server's manifest bound. */
  commits: GitRecentCommit[];
  /** Set when history exceeded the bound: the index covers a recent prefix. */
  truncated?: boolean;
}

/** Searchable changed-line/path text for one commit. */
export interface GitCommitSearchRecord {
  hash: string;
  deltaText: string;
}

export interface GitCommitSearchRecordsResult {
  records: GitCommitSearchRecord[];
}

/** One source line's blame in the all-files provenance browser. */
export interface GitBlameLine {
  /** 1-based line number in the blamed revision. */
  line: number;
  /** Originating commit sha (40-hex; all-zero when not yet committed). */
  sha: string;
  shortSha: string;
  author: string;
  /**
   * Stable project-owned hue preference. Older servers omit it; clients then
   * derive a deterministic preference from the author display name.
   */
  authorColorSeed?: number;
  /** ISO 8601 author time, or "" when unknown. */
  authorTime: string;
  /** First line of the originating commit's message. */
  summary: string;
  /** The line's text (diff prefix stripped; it is plain file content). */
  content: string;
  /** True when the line is a working-tree change with no commit yet. */
  uncommitted: boolean;
}

/** Whole-file blame plus the highlighted file body for the viewer. */
export interface GitBlameResult {
  path: string;
  /** The blamed revision: a resolved full sha, or "working-tree". */
  rev: string;
  lines: GitBlameLine[];
  /** Shiki HTML of the file (per-line spans), aligned to `lines` by order. */
  highlightedHtml?: string;
  highlightedLanguage?: string;
  /** True when the file was too large to blame/highlight in full. */
  truncated?: boolean;
}

/** Tracked-file list for the all-files tree / filename search. */
export interface GitFileListResult {
  /** Repo-relative paths (`git ls-files`), optionally filtered by a query. */
  files: string[];
  /** True when the list was capped by the server limit. */
  truncated: boolean;
}

/** Rudimentary commit-delta / filename search results. */
export interface GitSearchResult {
  /** Matching file paths (filename search). */
  files?: string[];
  /** Commits whose diff touched the query (delta search). */
  commits?: GitRecentCommit[];
  /** True when results were capped by the server limit. */
  truncated: boolean;
}

export interface GitUntrackedFolderInfo {
  /** Compact untracked directory path, with trailing slash */
  path: string;
  /** Expanded untracked file paths within the directory */
  files: string[];
  /** Last-editor attribution for expanded paths that have it. */
  lastEditors?: Record<string, GitFileEditor>;
  /** Whether the list was capped by the server */
  truncated: boolean;
  /** Maximum number of files returned before truncation */
  limit: number;
}

export type GitDiffPreviewSkippedReason =
  | "binary"
  | "content-too-large"
  | "line-too-long"
  | "html-too-large";

export interface GitDiffPreviewSkipped {
  /** Why the preview was omitted or downgraded. */
  reason: GitDiffPreviewSkippedReason;
  /** Size of the content the guard measured — the diff, or the source it refused to diff. */
  totalBytes?: number;
  /** Longest measured line in JavaScript string characters, when known. */
  maxLineChars?: number;
  /** Highlighted HTML size in JavaScript string characters, for client guards. */
  htmlChars?: number;
  /** Source content byte budget that triggered this guard. */
  maxTotalBytes?: number;
  /** Per-line character budget that triggered this guard. */
  maxLineCharsLimit?: number;
  /** Highlighted HTML character budget that triggered this guard. */
  maxHtmlChars?: number;
}

export interface GitDiffResult {
  /** Syntax-highlighted diff HTML, omitted when previewSkipped is present. */
  diffHtml: string;
  /** Structured diff hunks for normal small previews. */
  structuredPatch: PatchHunk[];
  /** Rendered markdown preview HTML for small markdown files. */
  markdownHtml?: string;
  /** Bounded omission metadata for previews that are unsafe to render. */
  previewSkipped?: GitDiffPreviewSkipped;
  /** Exact source object rendered on each clickable diff side. */
  reviewProjections?: Partial<
    Record<ReviewCommentSide, ReviewSourceProjection>
  >;
}

export interface GitStatusInfo {
  /** Whether the project path is a git repository */
  isGitRepo: boolean;
  /** Current branch name (null if detached HEAD) */
  branch: string | null;
  /** Upstream branch (e.g. "origin/main") */
  upstream: string | null;
  /** Commits ahead of upstream */
  ahead: number;
  /** Commits behind upstream */
  behind: number;
  /** Whether the working tree is clean */
  isClean: boolean;
  /** Changed files with status and line counts */
  files: GitFileChange[];
  /** Recent commits on the current HEAD */
  recentCommits?: GitRecentCommit[];
  /** Last successful remote fetch/check detected from this server or git metadata */
  checkedRemoteAt?: string | null;
}

export type GitRemoteCheckStatus =
  | "checked"
  | "busy"
  | "not-a-git-repo"
  | "failed";

export interface GitRemoteCheckResult {
  status: GitRemoteCheckStatus;
  checkedRemoteAt: string | null;
  gitStatus?: GitStatusInfo;
  detail?: string;
}

export type GitPullStatus = "pulled" | "busy" | "not-a-git-repo" | "failed";

export interface GitPullResult {
  status: GitPullStatus;
  checkedRemoteAt: string | null;
  gitStatus?: GitStatusInfo;
  /** Commits by which the local branch advanced; omitted by older servers or when unavailable. */
  commitsAdvanced?: number;
  detail?: string;
}

export type GitPushStatus =
  | "pushed"
  | "published"
  | "up-to-date"
  | "busy"
  | "no-upstream"
  | "rejected"
  | "not-a-git-repo"
  | "failed";

export interface GitPushResult {
  status: GitPushStatus;
  checkedRemoteAt: string | null;
  gitStatus?: GitStatusInfo;
  /** Commits by which the remote branch advanced; omitted by older servers or when unavailable. */
  commitsAdvanced?: number;
  detail?: string;
}

export type GitIntegrationOptionsStatus =
  | "available"
  | "unavailable"
  | "busy"
  | "not-a-git-repo"
  | "failed";

export type GitIntegrationOptionReason =
  | "not-diverged"
  | "missing-upstream"
  | "detached-head"
  | "dirty-worktree"
  | "sequencer-in-progress"
  | "operation-running"
  | "not-a-git-repo"
  | "status-unavailable";

export interface GitIntegrationOptionsResult {
  status: GitIntegrationOptionsStatus;
  checkedRemoteAt: string | null;
  gitStatus?: GitStatusInfo;
  canAutoRebase: boolean;
  canAutoMerge: boolean;
  reasons: GitIntegrationOptionReason[];
  ahead: number;
  behind: number;
  upstream: string | null;
  isClean: boolean;
  hasSequencerState: boolean;
  detail?: string;
}
