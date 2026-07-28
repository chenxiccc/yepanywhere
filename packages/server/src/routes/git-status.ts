import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type GitDiffPreviewSkipped,
  type GitFileChange,
  type GitIntegrationOptionReason,
  type GitIntegrationOptionsResult,
  type GitPullResult,
  type GitPushResult,
  type GitRemoteCheckResult,
  type GitRecentCommit,
  type GitStatusInfo,
  type GitUntrackedFolderInfo,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { ProjectScanner } from "../projects/scanner.js";
import {
  GIT_DIFF_PREVIEW_MAX_LINE_CHARS,
  GIT_DIFF_PREVIEW_MAX_TOTAL_BYTES,
  skippedGitDiffResult,
} from "../git/diffPreviewGuards.js";
import { buildGitDiffResult } from "../git/diffResult.js";
import { GIT_DECODE_PATHS_ARGS, runGit } from "../git/gitExec.js";

export interface GitStatusDeps {
  scanner: ProjectScanner;
}

const NOT_A_GIT_REPO: GitStatusInfo = {
  isGitRepo: false,
  branch: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  isClean: true,
  files: [],
  recentCommits: [],
  checkedRemoteAt: null,
};

const remoteCheckedAtByProjectPath = new Map<string, string>();
const gitOperationsByProjectPath = new Set<string>();
const UNTRACKED_FOLDER_FILE_LIMIT = 500;

export function createGitStatusRoutes(deps: GitStatusDeps): Hono {
  const routes = new Hono();

  routes.get("/:projectId/git", async (c) => {
    const projectId = c.req.param("projectId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    try {
      const result = await getGitStatusWithRemoteCheckTime(project.path);
      return c.json(result);
    } catch (err) {
      if (isNotGitRepoError(err)) {
        return c.json(NOT_A_GIT_REPO);
      }
      return c.json({ error: "Failed to get git status" }, 500);
    }
  });

  /**
   * GET /:projectId/git/untracked-folder?path=dir/
   * Expand one compact untracked directory on demand.
   */
  routes.get("/:projectId/git/untracked-folder", async (c) => {
    const projectId = c.req.param("projectId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const path = c.req.query("path");
    if (!path || !isValidUntrackedFolderPath(path)) {
      return c.json({ error: "Invalid untracked folder path" }, 400);
    }

    try {
      return c.json(await getUntrackedFolderInfo(project.path, path));
    } catch (err) {
      if (isNotGitRepoError(err)) {
        return c.json({ error: "Not a git repository" }, 400);
      }
      return c.json({ error: "Failed to expand untracked folder" }, 500);
    }
  });

  /**
   * POST /:projectId/git/check-remote
   * Explicitly fetch remote refs and update the last-checked timestamp.
   */
  routes.post("/:projectId/git/check-remote", async (c) => {
    const projectId = c.req.param("projectId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const checkedRemoteAt = await getCheckedRemoteAt(project.path);
    if (gitOperationsByProjectPath.has(project.path)) {
      const result: GitRemoteCheckResult = {
        status: "busy",
        checkedRemoteAt,
        gitStatus: await getGitStatusSnapshot(project.path),
      };
      return c.json(result);
    }

    gitOperationsByProjectPath.add(project.path);
    try {
      await runGit(project.path, ["fetch"], {
        timeout: 30_000,
        disableTerminalPrompt: true,
      });
      const nextCheckedRemoteAt = new Date().toISOString();
      remoteCheckedAtByProjectPath.set(project.path, nextCheckedRemoteAt);

      const result: GitRemoteCheckResult = {
        status: "checked",
        checkedRemoteAt: nextCheckedRemoteAt,
        gitStatus: await getGitStatusWithRemoteCheckTime(project.path),
      };
      return c.json(result);
    } catch (err) {
      if (isNotGitRepoError(err)) {
        const result: GitRemoteCheckResult = {
          status: "not-a-git-repo",
          checkedRemoteAt: null,
          gitStatus: NOT_A_GIT_REPO,
        };
        return c.json(result);
      }

      const result: GitRemoteCheckResult = {
        status: "failed",
        checkedRemoteAt: await getCheckedRemoteAt(project.path),
        gitStatus: await getGitStatusSnapshot(project.path),
        detail: getGitErrorDetail(err),
      };
      return c.json(result);
    } finally {
      gitOperationsByProjectPath.delete(project.path);
    }
  });

  /**
   * GET /:projectId/git/integration-options
   * Inspect whether automatic diverged-branch options can be offered.
   *
   * This is intentionally read-only: it does not fetch, rebase, merge, stash, or
   * otherwise mutate the repository.
   */
  routes.get("/:projectId/git/integration-options", async (c) => {
    const projectId = c.req.param("projectId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const checkedRemoteAt = await getCheckedRemoteAt(project.path);
    if (gitOperationsByProjectPath.has(project.path)) {
      const status = await getGitStatusSnapshot(project.path);
      const result: GitIntegrationOptionsResult = {
        ...buildGitIntegrationOptionsResult(status, checkedRemoteAt, false),
        status: "busy",
        canAutoRebase: false,
        canAutoMerge: false,
        reasons: ["operation-running"],
      };
      return c.json(result);
    }

    try {
      const status = await getGitStatusWithRemoteCheckTime(project.path);
      const hasSequencerState = await hasGitSequencerState(project.path);
      return c.json(
        buildGitIntegrationOptionsResult(
          status,
          checkedRemoteAt,
          hasSequencerState,
        ),
      );
    } catch (err) {
      if (isNotGitRepoError(err)) {
        const result: GitIntegrationOptionsResult = {
          status: "not-a-git-repo",
          checkedRemoteAt: null,
          gitStatus: NOT_A_GIT_REPO,
          canAutoRebase: false,
          canAutoMerge: false,
          reasons: ["not-a-git-repo"],
          ahead: 0,
          behind: 0,
          upstream: null,
          isClean: true,
          hasSequencerState: false,
        };
        return c.json(result);
      }

      const snapshot = await getGitStatusSnapshot(project.path);
      const result: GitIntegrationOptionsResult = {
        status: "failed",
        checkedRemoteAt: await getCheckedRemoteAt(project.path),
        gitStatus: snapshot,
        canAutoRebase: false,
        canAutoMerge: false,
        reasons: ["status-unavailable"],
        ahead: snapshot.ahead,
        behind: snapshot.behind,
        upstream: snapshot.upstream,
        isClean: snapshot.isClean,
        hasSequencerState: false,
        detail: getGitErrorDetail(err),
      };
      return c.json(result);
    }
  });

  /**
   * POST /:projectId/git/pull
   * Try a safe fast-forward pull without opening interactive prompts.
   */
  routes.post("/:projectId/git/pull", async (c) => {
    const projectId = c.req.param("projectId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const checkedRemoteAt = await getCheckedRemoteAt(project.path);
    if (gitOperationsByProjectPath.has(project.path)) {
      const result: GitPullResult = {
        status: "busy",
        checkedRemoteAt,
        gitStatus: await getGitStatusSnapshot(project.path),
      };
      return c.json(result);
    }

    gitOperationsByProjectPath.add(project.path);
    try {
      await runGit(project.path, ["pull", "--ff-only"], {
        timeout: 60_000,
        disableTerminalPrompt: true,
      });
      const nextCheckedRemoteAt = new Date().toISOString();
      remoteCheckedAtByProjectPath.set(project.path, nextCheckedRemoteAt);

      const result: GitPullResult = {
        status: "pulled",
        checkedRemoteAt: nextCheckedRemoteAt,
        gitStatus: await getGitStatusWithRemoteCheckTime(project.path),
      };
      return c.json(result);
    } catch (err) {
      if (isNotGitRepoError(err)) {
        const result: GitPullResult = {
          status: "not-a-git-repo",
          checkedRemoteAt: null,
          gitStatus: NOT_A_GIT_REPO,
        };
        return c.json(result);
      }

      const result: GitPullResult = {
        status: "failed",
        checkedRemoteAt: await getCheckedRemoteAt(project.path),
        gitStatus: await getGitStatusSnapshot(project.path),
        detail: getGitErrorDetail(err),
      };
      return c.json(result);
    } finally {
      gitOperationsByProjectPath.delete(project.path);
    }
  });

  /**
   * POST /:projectId/git/push
   * Push the current branch, publishing to origin for simple no-upstream cases.
   */
  routes.post("/:projectId/git/push", async (c) => {
    const projectId = c.req.param("projectId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const checkedRemoteAt = await getCheckedRemoteAt(project.path);
    if (gitOperationsByProjectPath.has(project.path)) {
      const result: GitPushResult = {
        status: "busy",
        checkedRemoteAt,
        gitStatus: await getGitStatusSnapshot(project.path),
      };
      return c.json(result);
    }

    gitOperationsByProjectPath.add(project.path);
    try {
      const status = await getGitStatusWithRemoteCheckTime(project.path);
      const pushArgs = status.upstream
        ? ["push"]
        : status.branch && (await hasGitRemote(project.path, "origin"))
          ? ["push", "-u", "origin", "HEAD"]
          : null;

      if (!pushArgs) {
        const result: GitPushResult = {
          status: "no-upstream",
          checkedRemoteAt,
          gitStatus: status,
        };
        return c.json(result);
      }

      const pushResult = await runGit(project.path, pushArgs, {
        timeout: 60_000,
        disableTerminalPrompt: true,
      });

      const result: GitPushResult = {
        status: status.upstream
          ? isPushAlreadyUpToDateOutput(pushResult)
            ? "up-to-date"
            : "pushed"
          : "published",
        checkedRemoteAt: await getCheckedRemoteAt(project.path),
        gitStatus: await getGitStatusWithRemoteCheckTime(project.path),
      };
      return c.json(result);
    } catch (err) {
      if (isNotGitRepoError(err)) {
        const result: GitPushResult = {
          status: "not-a-git-repo",
          checkedRemoteAt: null,
          gitStatus: NOT_A_GIT_REPO,
        };
        return c.json(result);
      }

      const result: GitPushResult = {
        status: isPushRejectedError(err) ? "rejected" : "failed",
        checkedRemoteAt: await getCheckedRemoteAt(project.path),
        gitStatus: await getGitStatusSnapshot(project.path),
        detail: getGitErrorDetail(err),
      };
      return c.json(result);
    } finally {
      gitOperationsByProjectPath.delete(project.path);
    }
  });

  /**
   * POST /:projectId/git/diff
   * Get syntax-highlighted diff for a specific file.
   * Body: { path, staged, status, againstHead?, origPath?, fullContext? }
   */
  routes.post("/:projectId/git/diff", async (c) => {
    const projectId = c.req.param("projectId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    let body: {
      path: string;
      staged: boolean;
      status: string;
      againstHead?: boolean;
      origPath?: string;
      fullContext?: boolean;
      ignoreWhitespace?: boolean;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const {
      path,
      staged,
      status,
      againstHead,
      origPath,
      fullContext,
      ignoreWhitespace,
    } = body;
    if (!path || typeof staged !== "boolean" || !status) {
      return c.json(
        { error: "Missing required fields: path, staged, status" },
        400,
      );
    }
    if (
      ignoreWhitespace !== undefined &&
      typeof ignoreWhitespace !== "boolean"
    ) {
      return c.json({ error: "Invalid ignoreWhitespace" }, 400);
    }
    if (status === "?" && path.endsWith("/")) {
      return c.json(
        { error: "Diff preview is not available for untracked folders" },
        400,
      );
    }

    try {
      const untrackedSizeSkip =
        status === "?"
          ? await getUntrackedDiffPreviewSizeSkip(project.path, path)
          : null;
      if (untrackedSizeSkip) {
        return c.json(skippedGitDiffResult(untrackedSizeSkip));
      }

      const { oldContent, newContent } = await getFileVersions(
        project.path,
        path,
        staged,
        status,
        againstHead,
        origPath,
      );

      return c.json(
        await buildGitDiffResult({
          toolUseId: "git-diff",
          path,
          oldContent,
          newContent,
          fullContext,
          ignoreWhitespace,
        }),
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to compute diff";
      return c.json({ error: message }, 500);
    }
  });

  return routes;
}

async function getUntrackedDiffPreviewSizeSkip(
  cwd: string,
  path: string,
): Promise<GitDiffPreviewSkipped | null> {
  const stats = await stat(resolve(cwd, path));
  if (!stats.isFile() || stats.size <= GIT_DIFF_PREVIEW_MAX_TOTAL_BYTES) {
    return null;
  }

  return {
    reason: "content-too-large",
    totalBytes: stats.size,
    maxTotalBytes: GIT_DIFF_PREVIEW_MAX_TOTAL_BYTES,
    maxLineCharsLimit: GIT_DIFF_PREVIEW_MAX_LINE_CHARS,
  };
}

/**
 * Get old and new file content for computing a diff.
 * Handles all git status codes (M, A, D, ?, R, etc.).
 */
/** `git show HEAD:path` can exceed runGit's 1 MB default for large files. */
const AGAINST_HEAD_SHOW_MAX_BUFFER = 16 * 1024 * 1024;

async function getFileVersions(
  cwd: string,
  path: string,
  staged: boolean,
  status: string,
  againstHead = false,
  origPath?: string,
): Promise<{ oldContent: string; newContent: string }> {
  if (againstHead) {
    const oldPath =
      (status === "R" || status === "C") && origPath ? origPath : path;
    const [oldContent, newContent] = await Promise.all([
      status === "?" || status === "A"
        ? Promise.resolve("")
        : runGit(cwd, ["show", `HEAD:${oldPath}`], {
            maxBuffer: AGAINST_HEAD_SHOW_MAX_BUFFER,
          }).then(
            (result) => result.stdout,
            (error) => {
              // Only "absent at HEAD" (file added since) may read as empty.
              // A too-big HEAD version must fail loudly — an empty fallback
              // would render the file as fully added instead of hitting the
              // preview-size skip.
              if (
                (error as NodeJS.ErrnoException).code ===
                "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
              ) {
                throw error;
              }
              return "";
            },
          ),
      readFile(resolve(cwd, path), "utf-8").catch(() => ""),
    ]);
    return { oldContent, newContent };
  }

  // Untracked: entire file is new
  if (status === "?") {
    const content = await readFile(resolve(cwd, path), "utf-8");
    return { oldContent: "", newContent: content };
  }

  // Added (staged): new file in index
  if (status === "A") {
    if (staged) {
      const { stdout } = await runGit(cwd, ["show", `:${path}`]);
      return { oldContent: "", newContent: stdout };
    }
    // Unstaged add shouldn't normally happen, but handle it
    const content = await readFile(resolve(cwd, path), "utf-8");
    return { oldContent: "", newContent: content };
  }

  // Deleted
  if (status === "D") {
    const ref = staged ? `HEAD:${path}` : `:${path}`;
    const { stdout } = await runGit(cwd, ["show", ref]);
    return { oldContent: stdout, newContent: "" };
  }

  // Modified or other statuses
  if (staged) {
    // Staged: compare HEAD to index
    const [oldResult, newResult] = await Promise.all([
      runGit(cwd, ["show", `HEAD:${path}`]).catch(() => ({
        stdout: "",
        stderr: "",
      })),
      runGit(cwd, ["show", `:${path}`]),
    ]);
    return { oldContent: oldResult.stdout, newContent: newResult.stdout };
  }

  // Unstaged: compare index to working tree
  const [oldResult, newContent] = await Promise.all([
    runGit(cwd, ["show", `:${path}`]).catch(() => ({
      stdout: "",
      stderr: "",
    })),
    readFile(resolve(cwd, path), "utf-8").catch(() => ""),
  ]);
  return { oldContent: oldResult.stdout, newContent };
}

async function getCheckedRemoteAt(projectPath: string): Promise<string | null> {
  return latestIsoTimestamp(
    remoteCheckedAtByProjectPath.get(projectPath) ?? null,
    await getRecordedFetchAt(projectPath),
  );
}

async function getGitStatusWithRemoteCheckTime(
  projectPath: string,
): Promise<GitStatusInfo> {
  return getGitStatus(projectPath, await getCheckedRemoteAt(projectPath));
}

async function getGitStatusSnapshot(
  projectPath: string,
): Promise<GitStatusInfo> {
  try {
    return await getGitStatusWithRemoteCheckTime(projectPath);
  } catch (err) {
    if (isNotGitRepoError(err)) {
      return NOT_A_GIT_REPO;
    }
    return {
      ...NOT_A_GIT_REPO,
      checkedRemoteAt: await getCheckedRemoteAt(projectPath),
    };
  }
}

function buildGitIntegrationOptionsResult(
  status: GitStatusInfo,
  checkedRemoteAt: string | null,
  hasSequencerState: boolean,
): GitIntegrationOptionsResult {
  const reasons: GitIntegrationOptionReason[] = [];

  if (!status.isGitRepo) {
    reasons.push("not-a-git-repo");
  }
  if (!status.branch) {
    reasons.push("detached-head");
  }
  if (!status.upstream) {
    reasons.push("missing-upstream");
  }
  if (!(status.ahead > 0 && status.behind > 0)) {
    reasons.push("not-diverged");
  }
  if (!status.isClean) {
    reasons.push("dirty-worktree");
  }
  if (hasSequencerState) {
    reasons.push("sequencer-in-progress");
  }

  const available = reasons.length === 0;
  return {
    status: available ? "available" : "unavailable",
    checkedRemoteAt,
    gitStatus: status,
    canAutoRebase: available,
    canAutoMerge: available,
    reasons,
    ahead: status.ahead,
    behind: status.behind,
    upstream: status.upstream,
    isClean: status.isClean,
    hasSequencerState,
  };
}

async function hasGitSequencerState(projectPath: string): Promise<boolean> {
  const gitStatePaths = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
  ];
  const checks = await Promise.all(
    gitStatePaths.map((gitPath) => gitPathExists(projectPath, gitPath)),
  );
  return checks.some(Boolean);
}

async function gitPathExists(
  projectPath: string,
  gitPath: string,
): Promise<boolean> {
  try {
    const { stdout } = await runGit(projectPath, [
      "rev-parse",
      "--git-path",
      gitPath,
    ]);
    const resolvedPath = stdout.trim();
    if (!resolvedPath) {
      return false;
    }
    await stat(resolve(projectPath, resolvedPath));
    return true;
  } catch {
    return false;
  }
}

async function getRecordedFetchAt(projectPath: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(projectPath, [
      "rev-parse",
      "--git-path",
      "FETCH_HEAD",
    ]);
    const fetchHeadPath = stdout.trim();
    if (!fetchHeadPath) {
      return null;
    }

    const fetchHeadStat = await stat(resolve(projectPath, fetchHeadPath));
    if (!fetchHeadStat.isFile() || !Number.isFinite(fetchHeadStat.mtimeMs)) {
      return null;
    }
    return fetchHeadStat.mtime.toISOString();
  } catch {
    return null;
  }
}

function latestIsoTimestamp(
  first: string | null,
  second: string | null,
): string | null {
  if (!first) return second;
  if (!second) return first;

  const firstTime = Date.parse(first);
  const secondTime = Date.parse(second);
  if (!Number.isFinite(firstTime)) return second;
  if (!Number.isFinite(secondTime)) return first;
  return secondTime > firstTime ? second : first;
}

function getGitErrorDetail(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }

  const gitError = err as {
    message?: string;
    stderr?: string;
    stdout?: string;
  };
  const detail = gitError.stderr || gitError.stdout || gitError.message;
  return detail?.trim().slice(0, 1200) || undefined;
}

async function hasGitRemote(
  projectPath: string,
  remoteName: string,
): Promise<boolean> {
  try {
    await runGit(projectPath, ["remote", "get-url", remoteName]);
    return true;
  } catch {
    return false;
  }
}

function isNotGitRepoError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as { code?: number | string; stderr?: string };
    if (
      typeof e.stderr === "string" &&
      e.stderr.includes("not a git repository")
    )
      return true;
  }
  return false;
}

function isPushRejectedError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }

  const gitError = err as {
    stderr?: string;
    stdout?: string;
  };
  const output = `${gitError.stderr ?? ""}\n${gitError.stdout ?? ""}`;
  return (
    output.includes("[rejected]") ||
    output.includes("non-fast-forward") ||
    output.includes("fetch first")
  );
}

function isPushAlreadyUpToDateOutput(result: {
  stdout: string;
  stderr: string;
}): boolean {
  return `${result.stdout}\n${result.stderr}`.includes("Everything up-to-date");
}

/** Parse `git diff --numstat` output into a map of path → {added, deleted} */
function parseNumstat(
  output: string,
): Map<string, { added: number | null; deleted: number | null }> {
  const map = new Map<
    string,
    { added: number | null; deleted: number | null }
  >();
  for (const line of output.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const addedStr = parts[0] ?? "";
    const deletedStr = parts[1] ?? "";
    const path = parts.slice(2).join("\t");
    const added = addedStr === "-" ? null : Number.parseInt(addedStr, 10);
    const deleted = deletedStr === "-" ? null : Number.parseInt(deletedStr, 10);
    map.set(path, { added, deleted });
  }
  return map;
}

function isValidUntrackedFolderPath(path: string): boolean {
  if (!path.endsWith("/") || path.includes("\0")) {
    return false;
  }
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    return false;
  }

  const segments = path.slice(0, -1).split("/");
  return (
    segments.length > 0 &&
    segments.every((segment) => segment !== "" && segment !== "..")
  );
}

async function getUntrackedFolderInfo(
  projectPath: string,
  folderPath: string,
): Promise<GitUntrackedFolderInfo> {
  const { files, truncated } = await collectUntrackedFolderFiles(
    projectPath,
    folderPath,
    UNTRACKED_FOLDER_FILE_LIMIT,
  );

  files.sort((a, b) => a.localeCompare(b));
  return {
    path: folderPath,
    files,
    truncated,
    limit: UNTRACKED_FOLDER_FILE_LIMIT,
  };
}

async function collectUntrackedFolderFiles(
  projectPath: string,
  folderPath: string,
  limit: number,
): Promise<{ files: string[]; truncated: boolean }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", [
      "-C",
      projectPath,
      ...GIT_DECODE_PATHS_ARGS,
      "status",
      "--porcelain=v2",
      "--untracked-files=all",
      "--",
      folderPath,
    ]);
    const files: string[] = [];
    let stdoutRemainder = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    let stdoutBytes = 0;
    let timeout: ReturnType<typeof setTimeout>;

    const settle = (
      resolve: boolean,
      value: { files: string[]; truncated: boolean } | Error,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (resolve) {
        resolvePromise(value as { files: string[]; truncated: boolean });
      } else {
        rejectPromise(value);
      }
    };

    const stopAsTruncated = () => {
      if (truncated) return;
      truncated = true;
      child.kill("SIGTERM");
    };

    const readStatusLine = (line: string) => {
      if (!line.startsWith("? ")) return;

      const path = line.slice(2);
      if (!path.startsWith(folderPath) || path.endsWith("/")) return;

      if (files.length >= limit) {
        stopAsTruncated();
        return;
      }
      files.push(path);
      if (files.length >= limit) {
        stopAsTruncated();
      }
    };

    timeout = setTimeout(stopAsTruncated, 10_000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      stdoutRemainder += chunk;
      const lines = stdoutRemainder.split("\n");
      stdoutRemainder = lines.pop() ?? "";
      for (const line of lines) {
        readStatusLine(line);
      }
      if (stdoutBytes > 1024 * 1024) {
        stopAsTruncated();
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      settle(false, err);
    });

    child.on("close", (code) => {
      if (stdoutRemainder) {
        readStatusLine(stdoutRemainder);
      }
      if (code === 0 || truncated) {
        settle(true, { files, truncated });
        return;
      }

      const err = new Error(stderr.trim() || `git exited with code ${code}`);
      Object.assign(err, { stderr });
      settle(false, err);
    });
  });
}

/** Status letter from the XY field for a given position */
function statusChar(xy: string | undefined, index: 0 | 1): string | null {
  if (!xy) return null;
  const ch = xy[index];
  return ch && ch !== "." ? ch : null;
}

async function getGitStatus(
  projectPath: string,
  checkedRemoteAt: string | null,
): Promise<GitStatusInfo> {
  // Run local read-only commands in parallel.
  const [statusResult, numstatUnstaged, numstatStaged, logResult] =
    await Promise.all([
      runGit(projectPath, [
        ...GIT_DECODE_PATHS_ARGS,
        "status",
        "--porcelain=v2",
        "--branch",
      ]),
      runGit(projectPath, [
        ...GIT_DECODE_PATHS_ARGS,
        "diff",
        "--numstat",
      ]).catch(() => ({
        stdout: "",
        stderr: "",
      })),
      runGit(projectPath, [
        ...GIT_DECODE_PATHS_ARGS,
        "diff",
        "--cached",
        "--numstat",
      ]).catch(() => ({
        stdout: "",
        stderr: "",
      })),
      runGit(projectPath, [
        "log",
        "-n",
        "5",
        "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e",
      ]).catch(() => ({
        stdout: "",
        stderr: "",
      })),
    ]);

  const unstagedStats = parseNumstat(numstatUnstaged.stdout);
  const stagedStats = parseNumstat(numstatStaged.stdout);
  const recentCommits = parseRecentCommits(logResult.stdout);

  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitFileChange[] = [];

  for (const line of statusResult.stdout.split("\n")) {
    if (!line) continue;

    // Branch headers
    if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length);
      branch = value === "(detached)" ? null : value;
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length);
    } else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+) -(\d+)/);
      if (match?.[1] && match[2]) {
        ahead = Number.parseInt(match[1], 10);
        behind = Number.parseInt(match[2], 10);
      }
    }
    // Ordinary changed entry: "1 XY sub mH mI mW hH hI path"
    else if (line.startsWith("1 ")) {
      const parts = line.split(" ");
      const xy = parts[1];
      const path = parts.slice(8).join(" ");

      const stagedStatus = statusChar(xy, 0);
      const unstagedStatus = statusChar(xy, 1);

      if (stagedStatus) {
        const stats = stagedStats.get(path);
        files.push({
          path,
          status: stagedStatus,
          staged: true,
          linesAdded: stats?.added ?? null,
          linesDeleted: stats?.deleted ?? null,
        });
      }
      if (unstagedStatus) {
        const stats = unstagedStats.get(path);
        files.push({
          path,
          status: unstagedStatus,
          staged: false,
          linesAdded: stats?.added ?? null,
          linesDeleted: stats?.deleted ?? null,
        });
      }
    }
    // Renamed/copied entry: "2 XY sub mH mI mW hH hI X score path\torigPath"
    else if (line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1];
      const pathAndOrig = parts.slice(9).join(" ");
      const tabIdx = pathAndOrig.indexOf("\t");
      const path = tabIdx >= 0 ? pathAndOrig.slice(0, tabIdx) : pathAndOrig;
      const origPath = tabIdx >= 0 ? pathAndOrig.slice(tabIdx + 1) : undefined;

      const stagedStatus = statusChar(xy, 0);
      const unstagedStatus = statusChar(xy, 1);

      if (stagedStatus) {
        const stats = stagedStats.get(path);
        files.push({
          path,
          status: stagedStatus,
          staged: true,
          linesAdded: stats?.added ?? null,
          linesDeleted: stats?.deleted ?? null,
          origPath,
        });
      }
      if (unstagedStatus) {
        const stats = unstagedStats.get(path);
        files.push({
          path,
          status: unstagedStatus,
          staged: false,
          linesAdded: stats?.added ?? null,
          linesDeleted: stats?.deleted ?? null,
          origPath,
        });
      }
    }
    // Untracked: "? path". Git reports a whole untracked directory as
    // "path/" until the caller explicitly asks for --untracked-files=all.
    else if (line.startsWith("? ")) {
      const path = line.slice(2);
      files.push({
        path,
        status: "?",
        staged: false,
        linesAdded: null,
        linesDeleted: null,
      });
    }
    // Unmerged: "u XY sub m1 m2 m3 mW h1 h2 h3 path"
    else if (line.startsWith("u ")) {
      const parts = line.split(" ");
      const path = parts.slice(10).join(" ");
      files.push({
        path,
        status: "U",
        staged: false,
        linesAdded: null,
        linesDeleted: null,
      });
    }
  }

  return {
    isGitRepo: true,
    branch,
    upstream,
    ahead,
    behind,
    isClean: files.length === 0,
    files,
    recentCommits,
    checkedRemoteAt,
  };
}

function parseRecentCommits(output: string): GitRecentCommit[] {
  const commits: GitRecentCommit[] = [];

  for (const rawRecord of output.split("\x1e")) {
    const record = rawRecord.replace(/^\n/, "").replace(/\n$/, "");
    if (!record) continue;

    const [hash, shortHash, authorName, authorDate, ...subjectParts] =
      record.split("\x1f");
    const subject = subjectParts.join("\x1f");

    if (!hash || !shortHash || !authorName || !authorDate) {
      continue;
    }

    commits.push({
      hash,
      shortHash,
      authorName,
      authorDate,
      subject,
    });
  }

  return commits;
}
