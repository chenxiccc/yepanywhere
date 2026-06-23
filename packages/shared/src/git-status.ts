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
  /** Commits ahead of upstream */
  ahead: number;
  /** Commits behind upstream */
  behind: number;
  /** Whether the working tree is clean */
  isClean: boolean;
  /** Changed files with status and line counts */
  files: GitFileChange[];
}

/** 文件树节点 / File tree node */
export interface FileNode {
  name: string;
  /** 相对于项目根目录的路径 / Path relative to project root */
  path: string;
  isDirectory: boolean;
  /** 文件大小（仅文件有）/ File size in bytes (files only) */
  size?: number;
  /** ISO 8601 修改时间（仅文件有）/ Last modified time (files only) */
  modifiedAt?: string;
  isSymlink?: boolean;
  symlinkTarget?: string;
}

/** 目录列表响应 / Directory listing response */
export interface FileListResponse {
  children: FileNode[];
}

/** 分支信息 / Branch information */
export interface BranchInfo {
  isGitRepo: boolean;
  /** 当前分支名 / Current branch name */
  current: string;
  /** 本地分支列表 / Local branch names */
  local: string[];
  /** 远程分支列表（已去 origin/ 前缀）/ Remote branch names (origin/ prefix stripped) */
  remote: string[];
  /** 上游分支 / Upstream branch (e.g. "origin/main") */
  upstream: string | null;
}

/** Git 提交记录 / Git commit entry */
export interface GitCommit {
  /** 完整 commit hash */
  hash: string;
  /** 提交消息第一行 / First line of commit message */
  message: string;
  /** 作者名 / Author name */
  author: string;
  /** ISO 8601 日期 / ISO 8601 date */
  date: string;
}

/** Git 提交详情（含变更文件列表）/ Git commit detail (with changed files) */
export interface GitCommitDetail {
  /** 完整 commit hash */
  hash: string;
  /** 提交消息第一行 / First line of commit message */
  message: string;
  /** 提交消息完整内容（含 body）/ Full commit message body */
  body: string;
  /** 作者名 / Author name */
  author: string;
  /** ISO 8601 日期 / ISO 8601 date */
  date: string;
  /** 提交所属分支列表 / Branches that contain this commit */
  branches: string[];
  /** 变更文件数 / Number of files changed */
  filesChanged: number;
  /** 新增行数 / Lines added */
  additions: number;
  /** 删除行数 / Lines deleted */
  deletions: number;
  /** 变更的文件列表 / Changed files */
  files: GitFileChange[];
}

/** 分支切换/创建结果 / Branch checkout/create result */
export interface CheckoutResult {
  success: boolean;
  branch: string;
  error?: string;
}