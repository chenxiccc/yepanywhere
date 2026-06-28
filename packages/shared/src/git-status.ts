export const GIT_STATUS_CAPABILITY = "git-status";
export const GIT_STATUS_ENHANCED_CAPABILITY = "git-status-enhanced";
export const GIT_STATUS_REMOTE_CHECK_CAPABILITY = "git-status-remote-check";

export interface GitFileChange {
  /** Relative file path within the repo */
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
  /** Last successful explicit remote check, if known by this server */
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
