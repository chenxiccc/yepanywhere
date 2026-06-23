import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  type GitCommitDetail,
  type GitFileChange,
  type GitStatusInfo,
  type PatchHunk,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { computeEditAugment } from "../augments/edit-augments.js";
import { renderMarkdownToHtml } from "../augments/markdown-augments.js";
import type { ProjectScanner } from "../projects/scanner.js";

const execFileAsync = promisify(execFile);

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
};

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
      const result = await getGitStatus(project.path);
      return c.json(result);
    } catch (err) {
      if (isNotGitRepoError(err)) {
        return c.json(NOT_A_GIT_REPO);
      }
      return c.json({ error: "Failed to get git status" }, 500);
    }
  });

  /**
   * POST /:projectId/git/diff
   * Get syntax-highlighted diff for a specific file.
   * Body: { path, staged, status, fullContext? }
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
      fullContext?: boolean;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { path, staged, status, fullContext } = body;
    if (!path || typeof staged !== "boolean" || !status) {
      return c.json(
        { error: "Missing required fields: path, staged, status" },
        400,
      );
    }

    try {
      const { oldContent, newContent } = await getFileVersions(
        project.path,
        path,
        staged,
        status,
      );

      const contextLines = fullContext ? 999999 : 3;
      const augment = await computeEditAugment(
        "git-diff",
        { file_path: path, old_string: oldContent, new_string: newContent },
        contextLines,
      );

      const result: {
        diffHtml: string;
        structuredPatch: PatchHunk[];
        markdownHtml?: string;
      } = {
        diffHtml: augment.diffHtml,
        structuredPatch: augment.structuredPatch,
      };

      // Render markdown preview for .md files
      const ext = extname(path).toLowerCase();
      if ((ext === ".md" || ext === ".markdown") && newContent) {
        try {
          result.markdownHtml = await renderMarkdownToHtml(newContent);
        } catch {
          // Ignore markdown rendering errors
        }
      }

      return c.json(result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to compute diff";
      return c.json({ error: message }, 500);
    }
  });

  // ===== 分支 API / Branch APIs =====

  /**
   * GET /:projectId/git/branches
   * 获取分支列表（本地 + 远程）/ Get branch list (local + remote).
   */
  routes.get("/:projectId/git/branches", async (c) => {
    const projectId = c.req.param("projectId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    try {
      // 并行获取本地和远程分支 / Fetch local and remote branches in parallel
      const [localResult, remoteResult] = await Promise.all([
        runGit(project.path, [
          "branch",
          "--format=%(refname:short)",
        ]).catch(() => ({ stdout: "", stderr: "" })),
        runGit(project.path, [
          "branch",
          "-r",
          "--format=%(refname:short)",
        ]).catch(() => ({ stdout: "", stderr: "" })),
      ]);

      const local = localResult.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

      // 去重远程分支（去掉 origin/ 前缀）/ Deduplicate remote branches (strip origin/ prefix)
      const remoteRaw = remoteResult.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const remote = [
        ...new Set(
          remoteRaw.map((r) => {
            // 去掉 origin/ 前缀，保留分支名 / Strip origin/ prefix, keep branch name
            const withoutOrigin = r.startsWith("origin/")
              ? r.slice("origin/".length)
              : r;
            return withoutOrigin;
          }),
        ),
      ];

      // 获取当前分支 / Get current branch
      const currentResult = await runGit(project.path, [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]).catch(() => ({ stdout: "", stderr: "" }));
      const current = currentResult.stdout.trim() || "HEAD";

      // 获取上游分支 / Get upstream branch
      let upstream: string | null = null;
      try {
        const upstreamResult = await runGit(project.path, [
          "rev-parse",
          "--abbrev-ref",
          "@{upstream}",
        ]);
        upstream = upstreamResult.stdout.trim() || null;
      } catch {
        upstream = null;
      }

      return c.json({
        isGitRepo: true,
        current,
        local,
        remote,
        upstream,
      });
    } catch (err) {
      if (isNotGitRepoError(err)) {
        return c.json({ isGitRepo: false, current: "", local: [], remote: [], upstream: null });
      }
      return c.json({ error: "Failed to get branches" }, 500);
    }
  });

  /**
   * POST /:projectId/git/checkout
   * 切换分支 / Checkout a branch.
   */
  routes.post("/:projectId/git/checkout", async (c) => {
    const projectId = c.req.param("projectId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    let body: { branch: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { branch } = body;

    // 安全检查：验证分支名 / Security: validate branch name
    if (!branch || typeof branch !== "string") {
      return c.json({ error: "Missing branch name" }, 400);
    }
    // 拒绝包含 shell 特殊字符的分支名 / Reject branch names with shell special chars
    if (/[;&|`$\\]/.test(branch)) {
      return c.json({ error: "Invalid branch name" }, 400);
    }

    try {
      await runGit(project.path, ["checkout", branch]);
      return c.json({ success: true, branch });
    } catch (err) {
      const message =
        err instanceof Error
          ? (err as Error & { stderr?: string }).stderr || err.message
          : "Failed to checkout branch";
      return c.json({ success: false, branch, error: message }, 500);
    }
  });

  /**
   * POST /:projectId/git/create-branch
   * 创建并切换分支 / Create and checkout a new branch.
   */
  routes.post("/:projectId/git/create-branch", async (c) => {
    const projectId = c.req.param("projectId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    let body: { branch: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { branch } = body;

    if (!branch || typeof branch !== "string") {
      return c.json({ error: "Missing branch name" }, 400);
    }
    if (/[;&|`$\\]/.test(branch)) {
      return c.json({ error: "Invalid branch name" }, 400);
    }

    try {
      await runGit(project.path, ["checkout", "-b", branch]);
      return c.json({ success: true, branch });
    } catch (err) {
      const message =
        err instanceof Error
          ? (err as Error & { stderr?: string }).stderr || err.message
          : "Failed to create branch";
      return c.json({ success: false, branch, error: message }, 500);
    }
  });

  // ===== 提交历史 API / Commit history API =====

  /**
   * GET /:projectId/git/log
   * 获取提交历史 / Get commit history.
   * Query params:
   *   - limit: max commits to return (default 50)
   *   - skip: number of commits to skip (default 0)
   */
  routes.get("/:projectId/git/log", async (c) => {
    const projectId = c.req.param("projectId");
    const limit = Math.min(
      Math.max(Number.parseInt(c.req.query("limit") || "50", 10) || 50, 1),
      100,
    );
    const skip = Math.max(
      Number.parseInt(c.req.query("skip") || "0", 10) || 0,
      0,
    );

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    try {
      const { stdout } = await runGit(project.path, [
        "log",
        `--format=%H%x00%s%x00%an%x00%aI`,
        `--max-count=${limit}`,
        `--skip=${skip}`,
      ]);

      const commits = stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [hash, message, author, date] = line.split("\0");
          return { hash: hash ?? "", message: message ?? "", author: author ?? "", date: date ?? "" };
        });

      return c.json({ commits });
    } catch (err) {
      if (isNotGitRepoError(err)) {
        return c.json({ commits: [] });
      }
      return c.json({ error: "Failed to get commit log" }, 500);
    }
  });

  // ===== 提交详情 API / Commit detail API =====

  /**
   * GET /:projectId/git/commit/:hash
   * 获取某次提交的详情（含变更文件列表）/ Get commit detail with changed files.
   */
  routes.get("/:projectId/git/commit/:hash", async (c) => {
    const projectId = c.req.param("projectId");
    const hash = c.req.param("hash");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }
    // 安全检查：拒绝包含 shell 特殊字符的 hash / Security: reject hash with shell special chars
    if (!hash || /[;&|`$\\]/.test(hash)) {
      return c.json({ error: "Invalid commit hash" }, 400);
    }

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    try {
      // 并行获取提交信息、文件变更、分支和统计 / Fetch in parallel
      const [showResult, numstatResult, bodyResult, branchesResult, shortstatResult] = await Promise.all([
        runGit(project.path, [
          "show",
          "--name-status",
          "--format=%H%x00%s%x00%an%x00%aI",
          hash,
        ]).catch(() => ({ stdout: "", stderr: "" })),
        runGit(project.path, [
          "diff",
          "--numstat",
          `${hash}^`,
          hash,
        ]).catch(() => ({ stdout: "", stderr: "" })),
        runGit(project.path, [
          "log",
          "--format=%B",
          "-n",
          "1",
          hash,
        ]).catch(() => ({ stdout: "", stderr: "" })),
        runGit(project.path, [
          "branch",
          "--contains",
          hash,
          "--format=%(refname:short)",
        ]).catch(() => ({ stdout: "", stderr: "" })),
        runGit(project.path, [
          "diff",
          "--shortstat",
          `${hash}^`,
          hash,
        ]).catch(() => ({ stdout: "", stderr: "" })),
      ]);

      const { commit, files } = parseCommitDetail(
        showResult.stdout,
        numstatResult.stdout,
        bodyResult.stdout,
        branchesResult.stdout,
        shortstatResult.stdout,
      );

      return c.json({ commit, files });
    } catch (err) {
      if (isNotGitRepoError(err)) {
        return c.json({ error: "Not a git repository" }, 400);
      }
      return c.json({ error: "Failed to get commit detail" }, 500);
    }
  });

  /**
   * POST /:projectId/git/commit/:hash/diff
   * 获取某次提交中某个文件的 diff / Get diff for a file in a specific commit.
   * Body: { path: string }
   */
  routes.post("/:projectId/git/commit/:hash/diff", async (c) => {
    const projectId = c.req.param("projectId");
    const hash = c.req.param("hash");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }
    if (!hash || /[;&|`$\\]/.test(hash)) {
      return c.json({ error: "Invalid commit hash" }, 400);
    }

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    let body: { path: string; fullContext?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { path, fullContext } = body;
    if (!path || typeof path !== "string") {
      return c.json({ error: "Missing required field: path" }, 400);
    }

    try {
      // 获取该文件在提交前后的内容 / Get file content before and after the commit
      const [oldResult, newResult] = await Promise.all([
        runGit(project.path, ["show", `${hash}^:${path}`]).catch(() => ({
          stdout: "",
          stderr: "",
        })),
        runGit(project.path, ["show", `${hash}:${path}`]).catch(() => ({
          stdout: "",
          stderr: "",
        })),
      ]);

      const oldContent = oldResult.stdout;
      const newContent = newResult.stdout;

      const contextLines = fullContext ? 999999 : 3;
      const augment = await computeEditAugment(
        "git-diff",
        { file_path: path, old_string: oldContent, new_string: newContent },
        contextLines,
      );

      const result: {
        diffHtml: string;
        structuredPatch: PatchHunk[];
        markdownHtml?: string;
      } = {
        diffHtml: augment.diffHtml,
        structuredPatch: augment.structuredPatch,
      };

      // Render markdown preview for .md files
      const ext = extname(path).toLowerCase();
      if ((ext === ".md" || ext === ".markdown") && newContent) {
        try {
          result.markdownHtml = await renderMarkdownToHtml(newContent);
        } catch {
          // Ignore markdown rendering errors
        }
      }

      return c.json(result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to compute commit diff";
      return c.json({ error: message }, 500);
    }
  });

  return routes;
}

/**
 * Get old and new file content for computing a diff.
 * Handles all git status codes (M, A, D, ?, R, etc.).
 */
async function getFileVersions(
  cwd: string,
  path: string,
  staged: boolean,
  status: string,
): Promise<{ oldContent: string; newContent: string }> {
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

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
}

function isNotGitRepoError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as { code?: number | string; stderr?: string };
    if (e.code === 128) return true;
    if (
      typeof e.stderr === "string" &&
      e.stderr.includes("not a git repository")
    )
      return true;
  }
  return false;
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

/**
 * Parse `git show --name-status --format=...` output into a commit detail.
 * 解析 git show 输出为提交详情
 *
 * showResult format:
 *   <hash>|<subject>|<author>|<date>
 *   (blank line)
 *   <status>\t<path>          (for M/A/D status)
 *   <status>\t<origPath>\t<path>  (for R status, may have extra fields)
 *
 * numstatResult format:
 *   <added>\t<deleted>\t<path>
 *
 * bodyResult format:
 *   <full commit message body>
 */
function parseCommitDetail(
  showOutput: string,
  numstatOutput: string,
  bodyOutput: string,
  branchesOutput: string,
  shortstatOutput: string,
): { commit: GitCommitDetail; files: GitFileChange[] } {
  const numstat = parseNumstat(numstatOutput);
  const lines = showOutput.split("\n").filter((l) => l.length > 0);

  // 第一行是 format 行: hash\0subject\0author\0date
  const headerLine = lines[0] ?? "";
  const headerParts = headerLine.split("\0");
  const hash = headerParts[0] ?? "";
  const message = headerParts[1] ?? "";
  const author = headerParts[2] ?? "";
  const date = headerParts[3] ?? "";

  // 解析 body：去掉第一行 subject（body 的第一行和 subject 相同）
  const body = bodyOutput
    .trim()
    .split("\n")
    .slice(1) // 跳过第一行（与 subject 相同）
    .join("\n")
    .trim();

  // 解析分支列表 / Parse branches
  // git branch --contains 列出所有包含该提交的分支
  const branches = branchesOutput
    .split("\n")
    .map((b) => b.trim())
    .filter(Boolean);

  // 解析 shortstat / Parse shortstat
  // 格式: " X files changed, Y insertions(+), Z deletions(-)"
  const shortstatMatch = shortstatOutput.trim().match(
    /(\d+)\s+files?\s+changed(?:,\s*(\d+)\s+insertions?\(\+\))?(?:,\s*(\d+)\s+deletions?\(-\))?/,
  );
  const filesChanged = shortstatMatch?.[1] ? Number.parseInt(shortstatMatch[1], 10) : 0;
  const additions = shortstatMatch?.[2] ? Number.parseInt(shortstatMatch[2], 10) : 0;
  const deletions = shortstatMatch?.[3] ? Number.parseInt(shortstatMatch[3], 10) : 0;

  // 文件变更行从第二行开始 / File change lines start from line 2
  const files: GitFileChange[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line) continue;

    // 解析 status 和 path / Parse status and path
    const parts = line.split("\t");
    const statusCode = parts[0] ?? "";

    // 处理重命名：R<similarity> origPath \t newPath
    // 或 R<similarity> origPath \t newPath \t extra
    // 简化：取第一个字母作为 status
    const status = statusCode.charAt(0);

    // 对于重命名，path 取最后一个非空段
    let path: string;
    let origPath: string | undefined;

    if (status === "R" || status === "C") {
      // 跳过相似度百分比，如 "R100"
      // parts[0] = "R100", parts[1] = origPath, parts[2] = newPath
      origPath = parts[1] ?? "";
      path = parts[2] ?? "";
    } else {
      // parts[0] = "M"/"A"/"D", parts[1] = path
      path = parts[1] ?? "";
    }

    const stats = numstat.get(path);
    files.push({
      path,
      status,
      staged: false, // 历史提交中的文件都是 unstaged
      linesAdded: stats?.added ?? null,
      linesDeleted: stats?.deleted ?? null,
      origPath,
    });
  }

  return {
    commit: { hash, message, body, author, date, branches, filesChanged, additions, deletions, files },
    files,
  };
}

/** Status letter from the XY field for a given position */
function statusChar(xy: string | undefined, index: 0 | 1): string | null {
  if (!xy) return null;
  const ch = xy[index];
  return ch && ch !== "." ? ch : null;
}

async function getGitStatus(projectPath: string): Promise<GitStatusInfo> {
  // Run all three commands in parallel
  const [statusResult, numstatUnstaged, numstatStaged] = await Promise.all([
    runGit(projectPath, ["status", "--porcelain=v2", "--branch"]),
    runGit(projectPath, ["diff", "--numstat"]).catch(() => ({
      stdout: "",
      stderr: "",
    })),
    runGit(projectPath, ["diff", "--cached", "--numstat"]).catch(() => ({
      stdout: "",
      stderr: "",
    })),
  ]);

  const unstagedStats = parseNumstat(numstatUnstaged.stdout);
  const stagedStats = parseNumstat(numstatStaged.stdout);

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
    // Untracked: "? path" (skip directories — they end with /)
    else if (line.startsWith("? ")) {
      const path = line.slice(2);
      if (!path.endsWith("/")) {
        files.push({
          path,
          status: "?",
          staged: false,
          linesAdded: null,
          linesDeleted: null,
        });
      }
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
  };
}
