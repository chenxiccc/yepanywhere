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

export interface GitStatusInfo {
  /** Whether the project path is a git repository */
  isGitRepo: boolean;
  /** Current branch name (null if detached HEAD) */
  branch: string | null;
  /** Upstream branch (e.g. "origin/main") */
  upstream: string | null;
  /** Default remote name for fetch/push (e.g. "origin") */
  remote: string | null;
  /** Commits ahead of upstream */
  ahead: number;
  /** Commits behind upstream */
  behind: number;
  /** Whether the working tree is clean */
  isClean: boolean;
  /** Latest local commit that can be undone from this branch state */
  latestLocalCommit?: GitLocalCommitInfo | null;
  /** Stashed changes, newest first */
  stashes: GitStashEntry[];
  /** Changed files with status and line counts */
  files: GitFileChange[];
}

export interface GitLocalCommitInfo {
  message: string;
  committedAt: string;
}

export interface GitStashEntry {
  ref: string;
  message: string;
  branch: string | null;
  createdAt: string;
  createdByApp: boolean;
}

export interface GitStashFileChange {
  path: string;
  status: string;
  previousPath?: string;
  linesAdded: number | null;
  linesDeleted: number | null;
}

export interface GitStashDetail extends GitStashEntry {
  files: GitStashFileChange[];
}

export interface GitHistoryCommitSummary {
  hash: string;
  shortHash: string;
  message: string;
  authorName: string;
  authorEmail: string;
  committedAt: string;
  refs: string[];
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface GitHistoryFileChange {
  path: string;
  status: string;
  previousPath?: string;
  linesAdded: number | null;
  linesDeleted: number | null;
}

export interface GitHistoryCommitDetail extends GitHistoryCommitSummary {
  body: string;
  files: GitHistoryFileChange[];
}

export interface GitCommitRequest {
  message: string;
  selectedPaths?: string[];
}

export interface GitUndoCommitResponse {
  status: GitStatusInfo;
  undoneCommitMessage: string;
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
  remote?: boolean;
  group: "default" | "recent" | "other";
  updatedAt?: string | null;
}

export interface GitCreateBranchRequest {
  branchName: string;
  baseBranch?: string;
}

export type GitMergeStrategy = "merge" | "squash" | "rebase";

export interface GitSwitchBranchRequest {
  targetBranch: string;
  stashCurrentChanges: boolean;
}

export interface GitMergeBranchRequest {
  sourceBranch: string;
  strategy: GitMergeStrategy;
}

export interface GitMergePreviewRequest {
  sourceBranch: string;
  strategy: GitMergeStrategy;
}

export interface GitMergePreviewResult {
  state: "up_to_date" | "conflict" | "mergeable";
  targetBranch: string;
  sourceBranch: string;
  strategy: GitMergeStrategy;
  commitCount: number;
  conflictedFiles: number;
}
