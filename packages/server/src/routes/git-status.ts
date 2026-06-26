import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  type GitBranchInfo,
  type GitCommitRequest,
  type GitFileChange,
  type GitHistoryCommitDetail,
  type GitHistoryCommitSummary,
  type GitHistoryFileChange,
  type GitLocalCommitInfo,
  type GitMergeBranchRequest,
  type GitMergePreviewRequest,
  type GitMergePreviewResult,
  type GitMergeStrategy,
  type GitStashDetail,
  type GitStashEntry,
  type GitStashFileChange,
  type GitStatusInfo,
  type GitCreateBranchRequest,
  type GitSwitchBranchRequest,
  type GitUndoCommitResponse,
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
  remote: null,
  ahead: 0,
  behind: 0,
  isClean: true,
  stashes: [],
  files: [],
};

export function createGitStatusRoutes(deps: GitStatusDeps): Hono {
  const routes = new Hono();

  routes.get("/:projectId/git", async (c) => {
    try {
      const projectPath = await getProjectPath(deps, c.req.param("projectId"));
      if (!projectPath) return c.json({ error: "Project not found" }, 404);
      const result = await getGitStatus(projectPath);
      return c.json(result);
    } catch (err) {
      if (isNotGitRepoError(err)) {
        return c.json(NOT_A_GIT_REPO);
      }
      return c.json({ error: "Failed to get git status" }, 500);
    }
  });

  routes.post("/:projectId/git/commit", async (c) => {
    const body = await readJsonBody<GitCommitRequest>(c);
    if (!body) return c.json({ error: "Invalid JSON body" }, 400);
    if (!body.message?.trim()) {
      return c.json({ error: "Commit message is required" }, 400);
    }

    try {
      const projectPath = await getProjectPath(deps, c.req.param("projectId"));
      if (!projectPath) return c.json({ error: "Project not found" }, 404);
      const status = await getGitStatus(projectPath);
      const hasExplicitSelection = Array.isArray(body.selectedPaths);
      const selectedFiles = hasExplicitSelection
        ? status.files.filter((file) => body.selectedPaths?.includes(file.path))
        : status.files;
      if (selectedFiles.length === 0) {
        return c.json({ error: "No files selected to commit" }, 400);
      }

      const pathspecs = Array.from(
        new Set(
          selectedFiles.flatMap((file) =>
            file.origPath ? [file.origPath, file.path] : [file.path],
          ),
        ),
      );

      await runGit(projectPath, ["add", "-A", "--", ...pathspecs]);
      await runGit(projectPath, [
        "commit",
        "-m",
        body.message.trim(),
        "--",
        ...pathspecs,
      ]);
      return c.json({ status: await getGitStatus(projectPath) });
    } catch (err) {
      return gitActionError(err, "Failed to commit changes");
    }
  });

  routes.post("/:projectId/git/undo", async (c) => {
    try {
      const projectPath = await getProjectPath(deps, c.req.param("projectId"));
      if (!projectPath) return c.json({ error: "Project not found" }, 404);
      const status = await getGitStatus(projectPath);
      if (status.ahead < 1) {
        return c.json({ error: "No unpushed local commit to undo" }, 400);
      }
      const undoneCommitMessage = (
        await runGit(projectPath, ["log", "-1", "--pretty=%B"])
      ).stdout.trim();
      await runGit(projectPath, ["reset", "--mixed", "HEAD~1"]);
      const response: GitUndoCommitResponse = {
        status: await getGitStatus(projectPath),
        undoneCommitMessage,
      };
      return c.json(response);
    } catch (err) {
      return gitActionError(err, "Failed to undo commit");
    }
  });

  routes.post("/:projectId/git/stash", async (c) => {
    const body = await readJsonBody<{ selectedPaths: string[] }>(c);
    if (!body || !Array.isArray(body.selectedPaths)) {
      return c.json({ error: "Selected paths are required" }, 400);
    }

    try {
      const projectPath = await getProjectPath(deps, c.req.param("projectId"));
      if (!projectPath) return c.json({ error: "Project not found" }, 404);
      const status = await getGitStatus(projectPath);
      const selectedFiles = getSelectedGitFiles(
        status.files,
        body.selectedPaths,
      );
      if (selectedFiles.length === 0) {
        return c.json({ status });
      }

      const currentBranch = (await getCurrentBranch(projectPath)) ?? "detached";
      const pathspecs = getGitPathspecs(selectedFiles);
      await runGit(projectPath, [
        "stash",
        "push",
        "--include-untracked",
        "-m",
        `yepanywhere:${currentBranch}`,
        "--",
        ...pathspecs,
      ]);

      return c.json({ status: await getGitStatus(projectPath) });
    } catch (err) {
      return gitActionError(err, "Failed to stash changes");
    }
  });

  routes.post("/:projectId/git/stashes/restore", async (c) => {
    const body = await readJsonBody<{ stashRef: string }>(c);
    if (!body?.stashRef?.trim()) {
      return c.json({ error: "Stash ref is required" }, 400);
    }

    try {
      const projectPath = await getProjectPath(deps, c.req.param("projectId"));
      if (!projectPath) return c.json({ error: "Project not found" }, 404);
      await runGit(projectPath, ["stash", "pop", "--index", body.stashRef]);
      return c.json({ status: await getGitStatus(projectPath) });
    } catch (err) {
      return gitActionError(err, "Failed to restore stash");
    }
  });

  routes.post("/:projectId/git/stashes/discard", async (c) => {
    const body = await readJsonBody<{ stashRef: string }>(c);
    if (!body?.stashRef?.trim()) {
      return c.json({ error: "Stash ref is required" }, 400);
    }

    try {
      const projectPath = await getProjectPath(deps, c.req.param("projectId"));
      if (!projectPath) return c.json({ error: "Project not found" }, 404);
      await runGit(projectPath, ["stash", "drop", body.stashRef]);
      return c.json({ status: await getGitStatus(projectPath) });
    } catch (err) {
      return gitActionError(err, "Failed to discard stash");
    }
  });

  routes.post("/:projectId/git/stashes/detail", async (c) => {
    const body = await readJsonBody<{ stashRef: string }>(c);
    if (!body?.stashRef?.trim()) {
      return c.json({ error: "Stash ref is required" }, 400);
    }

    try {
      const projectPath = await getProjectPath(deps, c.req.param("projectId"));
      if (!projectPath) return c.json({ error: "Project not found" }, 404);
      return c.json({
        stash: await getGitStashDetail(projectPath, body.stashRef),
      });
    } catch (err) {
      return gitActionError(err, "Failed to load stash detail");
    }
  });

  routes.post("/:projectId/git/stashes/diff", async (c) => {
    const project = await deps.scanner.getProject(c.req.param("projectId"));
    if (!project) return c.json({ error: "Project not found" }, 404);

    let body: {
      stashRef: string;
      path: string;
      status: string;
      previousPath?: string;
      fullContext?: boolean;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { stashRef, path, status, previousPath, fullContext } = body;
    if (!stashRef || !path || !status) {
      return c.json(
        { error: "Missing required fields: stashRef, path, status" },
        400,
      );
    }

    try {
      const { oldContent, newContent } = await getStashFileVersions(
        project.path,
        stashRef,
        path,
        status,
        previousPath,
      );

      const contextLines = fullContext ? 999999 : 3;
      const augment = await computeEditAugment(
        "git-stash-diff",
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
        err instanceof Error ? err.message : "Failed to compute stash diff";
      return c.json({ error: message }, 500);
    }
  });

  routes.post("/:projectId/git/discard", async (c) => {
    const body = await readJsonBody<{ selectedPaths: string[] }>(c);
    if (!body || !Array.isArray(body.selectedPaths)) {
      return c.json({ error: "Selected paths are required" }, 400);
    }

    try {
      const projectPath = await getProjectPath(deps, c.req.param("projectId"));
      if (!projectPath) return c.json({ error: "Project not found" }, 404);
      const status = await getGitStatus(projectPath);
      const selectedFiles = getSelectedGitFiles(
        status.files,
        body.selectedPaths,
      );
      if (selectedFiles.length === 0) {
        return c.json({ status });
      }

      const trackedFiles = selectedFiles.filter((file) => file.status !== "?");
      const untrackedFiles = selectedFiles.filter(
        (file) => file.status === "?",
      );
      if (trackedFiles.length > 0) {
        await runGit(projectPath, [
          "restore",
          "--source=HEAD",
          "--staged",
          "--worktree",
          "--",
          ...getGitPathspecs(trackedFiles),
        ]);
      }

      for (const file of untrackedFiles) {
        await rm(resolve(projectPath, file.path), {
          force: true,
          recursive: true,
        });
      }

      return c.json({ status: await getGitStatus(projectPath) });
    } catch (err) {
      return gitActionError(err, "Failed to discard changes");
    }
  });

  routes.post("/:projectId/git/push", async (c) => {
    try {
      const projectPath = await getProjectPath(deps, c.req.param("projectId"));
      if (!projectPath) return c.json({ error: "Project not found" }, 404);
      const upstream = await getGitUpstream(projectPath);
      const remoteName = await getDefaultRemoteName(projectPath, upstream);
      if (upstream) {
        await runGit(projectPath, ["push"]);
      } else {
        await runGit(projectPath, ["push", "-u", remoteName, "HEAD"]);
      }
      return c.json({ status: await getGitStatus(projectPath) });
    } catch (err) {
      return gitActionError(err, "Failed to push");
    }
  });

  routes.post("/:projectId/git/fetch", async (c) => {
    try {
      const projectPath = await getProjectPath(deps, c.req.param("projectId"));
      if (!projectPath) return c.json({ error: "Project not found" }, 404);
      const upstream = await getGitUpstream(projectPath);
      if (upstream) {
        await runGit(projectPath, ["pull", "--ff-only"]);
      } else {
        const remoteName = await getDefaultRemoteName(projectPath, upstream);
        await runGit(projectPath, ["fetch", remoteName]);
      }
      return c.json({ status: await getGitStatus(projectPath) });
    } catch (err) {
      return gitActionError(err, "Failed to fetch");
    }
  });

  routes.get("/:projectId/git/branches", async (c) => {
    try {
      const projectPath = await getProjectPath(deps, c.req.param("projectId"));
      if (!projectPath) return c.json({ error: "Project not found" }, 404);
      return c.json({ branches: await getGitBranches(projectPath) });
    } catch (err) {
      return gitActionError(err, "Failed to list branches");
    }
  });

  routes.post("/:projectId/git/create-branch", async (c) => {
    const body = await readJsonBody<GitCreateBranchRequest>(c);
    if (!body?.branchName?.trim()) {
      return c.json({ error: "Branch name is required" }, 400);
    }

    try {
      const projectPath = await getProjectPath(deps, c.req.param("projectId"));
      if (!projectPath) return c.json({ error: "Project not found" }, 404);

      const branchName = body.branchName.trim();
      const baseBranch = body.baseBranch?.trim();

      await runGit(projectPath, ["check-ref-format", "--branch", branchName]);
      if (await hasLocalBranch(projectPath, branchName)) {
        return c.json({ error: `Branch ${branchName} already exists.` }, 400);
      }

      await runGit(projectPath, [
        "branch",
        branchName,
        ...(baseBranch ? [baseBranch] : []),
      ]);
      return c.json({ status: await getGitStatus(projectPath) });
    } catch (err) {
      return gitActionError(err, "Failed to create branch");
    }
  });

  routes.post("/:projectId/git/switch-branch", async (c) => {
    const body = await readJsonBody<GitSwitchBranchRequest>(c);
    if (!body?.targetBranch?.trim()) {
      return c.json({ error: "Target branch is required" }, 400);
    }

    try {
      const projectPath = await getProjectPath(deps, c.req.param("projectId"));
      if (!projectPath) return c.json({ error: "Project not found" }, 404);

      if (body.stashCurrentChanges) {
        const currentBranch =
          (await getCurrentBranch(projectPath)) ?? "detached";
        await runGit(projectPath, [
          "stash",
          "push",
          "--include-untracked",
          "-m",
          `yepanywhere:${currentBranch}`,
        ]);
      }

      const targetBranch = body.targetBranch.trim();
      const branchArgs = (await hasLocalBranch(projectPath, targetBranch))
        ? ["switch", targetBranch]
        : isRemoteBranchName(targetBranch)
          ? ["switch", "--track", targetBranch]
          : ["switch", targetBranch];
      await runGit(projectPath, branchArgs);
      return c.json({ status: await getGitStatus(projectPath) });
    } catch (err) {
      return gitActionError(err, "Failed to switch branch");
    }
  });

  routes.post("/:projectId/git/merge-branch", async (c) => {
    const body = await readJsonBody<GitMergeBranchRequest>(c);
    if (!body?.sourceBranch?.trim() || !body.strategy) {
      return c.json({ error: "Source branch and strategy are required" }, 400);
    }

    try {
      const projectPath = await getProjectPath(deps, c.req.param("projectId"));
      if (!projectPath) return c.json({ error: "Project not found" }, 404);

      const sourceBranch = body.sourceBranch.trim();
      const strategy = body.strategy;
      const currentBranch = await getCurrentBranch(projectPath);
      if (!currentBranch) {
        return c.json(
          {
            error:
              "Cannot merge while HEAD is detached. Switch to a branch first.",
          },
          400,
        );
      }

      if (sourceBranch === currentBranch) {
        return c.json(
          {
            error: `Choose a different branch to merge into ${currentBranch}.`,
          },
          400,
        );
      }

      const status = await getGitStatus(projectPath);
      if (status.files.length > 0) {
        return c.json(
          {
            error:
              "Cannot merge with uncommitted changes. Commit, stash, or discard them first.",
          },
          400,
        );
      }

      const preview = await getGitMergePreview(
        projectPath,
        currentBranch,
        sourceBranch,
        strategy,
      );
      if (preview.state === "up_to_date") {
        return c.json(
          {
            error: `${currentBranch} is already up to date with ${sourceBranch}.`,
          },
          400,
        );
      }
      if (preview.state === "conflict") {
        return c.json(
          {
            error: buildConflictMessage(
              currentBranch,
              sourceBranch,
              preview.conflictedFiles,
            ),
          },
          409,
        );
      }

      try {
        const resultCommit = await performGitMerge(
          projectPath,
          currentBranch,
          sourceBranch,
          strategy,
        );
        await runGit(projectPath, ["merge", "--ff-only", resultCommit]);
      } catch (err) {
        const message =
          getGitErrorMessage(err) ??
          `Cannot merge ${sourceBranch} into ${currentBranch}.`;
        return c.json({ error: message }, 409);
      }

      return c.json({ status: await getGitStatus(projectPath) });
    } catch (err) {
      return gitActionError(err, "Failed to merge branch");
    }
  });

  routes.post("/:projectId/git/merge-preview", async (c) => {
    const body = await readJsonBody<GitMergePreviewRequest>(c);
    if (!body?.sourceBranch?.trim() || !body.strategy) {
      return c.json({ error: "Source branch and strategy are required" }, 400);
    }

    try {
      const projectPath = await getProjectPath(deps, c.req.param("projectId"));
      if (!projectPath) return c.json({ error: "Project not found" }, 404);

      const currentBranch = await getCurrentBranch(projectPath);
      if (!currentBranch) {
        return c.json(
          {
            error:
              "Cannot preview merge while HEAD is detached. Switch to a branch first.",
          },
          400,
        );
      }

      const result = await getGitMergePreview(
        projectPath,
        currentBranch,
        body.sourceBranch.trim(),
        body.strategy,
      );

      return c.json({ result });
    } catch (err) {
      return gitActionError(err, "Failed to preview merge");
    }
  });

  routes.get("/:projectId/git/history", async (c) => {
    try {
      const projectPath = await getProjectPath(deps, c.req.param("projectId"));
      if (!projectPath) return c.json({ error: "Project not found" }, 404);
      const cursor = Number.parseInt(c.req.query("cursor") ?? "", 10);
      const limitParam = Number.parseInt(c.req.query("limit") ?? "", 10);
      const limit = Number.isFinite(limitParam)
        ? Math.min(Math.max(limitParam, 1), 100)
        : 25;
      const offset = Number.isFinite(cursor) ? Math.max(cursor, 0) : 0;
      const { commits, hasMore, nextCursor } = await getGitHistory(
        projectPath,
        offset,
        limit,
      );
      return c.json({ commits, hasMore, nextCursor });
    } catch (err) {
      return gitActionError(err, "Failed to load git history");
    }
  });

  routes.get("/:projectId/git/history/:commit", async (c) => {
    try {
      const projectPath = await getProjectPath(deps, c.req.param("projectId"));
      if (!projectPath) return c.json({ error: "Project not found" }, 404);
      return c.json({
        commit: await getGitHistoryCommitDetail(
          projectPath,
          c.req.param("commit"),
        ),
      });
    } catch (err) {
      return gitActionError(err, "Failed to load commit details");
    }
  });

  routes.post("/:projectId/git/history/diff", async (c) => {
    const body = await readJsonBody<{
      commit: string;
      path: string;
      status: string;
      previousPath?: string;
      fullContext?: boolean;
    }>(c);
    if (!body?.commit || !body.path || !body.status) {
      return c.json({ error: "Commit, path, and status are required" }, 400);
    }

    try {
      const projectPath = await getProjectPath(deps, c.req.param("projectId"));
      if (!projectPath) return c.json({ error: "Project not found" }, 404);

      const { oldContent, newContent } = await getCommitFileVersions(
        projectPath,
        body.commit,
        body.path,
        body.status,
        body.previousPath,
      );

      const contextLines = body.fullContext ? 999999 : 3;
      const augment = await computeEditAugment(
        "git-history-diff",
        {
          file_path: body.path,
          old_string: oldContent,
          new_string: newContent,
        },
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

      const ext = extname(body.path).toLowerCase();
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

  return routes;
}

function getSelectedGitFiles(
  files: GitFileChange[],
  selectedPaths: string[],
): GitFileChange[] {
  const selectedPathSet = new Set(selectedPaths);
  return files.filter((file) => selectedPathSet.has(file.path));
}

function getGitPathspecs(files: GitFileChange[]): string[] {
  return Array.from(
    new Set(
      files.flatMap((file) =>
        file.origPath ? [file.origPath, file.path] : [file.path],
      ),
    ),
  );
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

async function getCommitFileVersions(
  cwd: string,
  commit: string,
  path: string,
  status: string,
  previousPath?: string,
): Promise<{ oldContent: string; newContent: string }> {
  const parentCommit = await getFirstParentCommit(cwd, commit);
  const oldPath = previousPath ?? path;

  if (status === "A") {
    return {
      oldContent: "",
      newContent: await getGitFileContent(cwd, commit, path),
    };
  }

  if (status === "D") {
    return {
      oldContent: parentCommit
        ? await getGitFileContent(cwd, parentCommit, oldPath)
        : "",
      newContent: "",
    };
  }

  const oldContent = parentCommit
    ? await getGitFileContent(cwd, parentCommit, oldPath)
    : "";
  const newContent = await getGitFileContent(cwd, commit, path);
  return { oldContent, newContent };
}

async function getFirstParentCommit(
  cwd: string,
  commit: string,
): Promise<string | null> {
  const result = await runGit(cwd, [
    "rev-list",
    "--parents",
    "-n",
    "1",
    commit,
  ]);
  const parts = result.stdout.trim().split(" ").filter(Boolean);
  return parts[1] ?? null;
}

async function getGitFileContent(
  cwd: string,
  revision: string,
  path: string,
): Promise<string> {
  try {
    const result = await runGit(cwd, ["show", `${revision}:${path}`]);
    return result.stdout;
  } catch (err) {
    const message = getGitErrorMessage(err) ?? "";
    if (
      message.includes("exists on disk, but not in") ||
      message.includes("does not exist in")
    ) {
      return "";
    }
    throw err;
  }
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

async function getProjectPath(
  deps: GitStatusDeps,
  projectId: string,
): Promise<string | null> {
  if (!isUrlProjectId(projectId)) {
    return null;
  }

  const project = await deps.scanner.getProject(projectId);
  return project?.path ?? null;
}

async function readJsonBody<T extends object>(c: {
  req: { json: () => Promise<unknown> };
}): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

function gitActionError(err: unknown, fallbackMessage: string) {
  const message = getGitErrorMessage(err) || fallbackMessage;
  return new Response(JSON.stringify({ error: message }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  });
}

function getGitErrorMessage(err: unknown): string | null {
  if (err && typeof err === "object") {
    const gitErr = err as {
      stderr?: string;
      stdout?: string;
      message?: string;
    };
    const stderr = gitErr.stderr?.trim();
    if (stderr) return stderr;
    const stdout = gitErr.stdout?.trim();
    if (stdout) return stdout;
    const message = gitErr.message?.trim();
    if (message) return message;
  }

  return null;
}

function isGitEmptyHistoryError(err: unknown): boolean {
  const message = getGitErrorMessage(err) ?? "";
  return message.includes("does not have any commits yet");
}

function isRemoteBranchName(branchName: string): boolean {
  return /^[^/]+\/.+$/.test(branchName);
}

async function hasLocalBranch(
  projectPath: string,
  branchName: string,
): Promise<boolean> {
  const result = await runGit(projectPath, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branchName}`,
  ]).catch(() => null);
  return result !== null;
}

async function getGitUpstream(projectPath: string): Promise<string | null> {
  const result = await runGit(projectPath, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]).catch(() => null);
  return result?.stdout.trim() || null;
}

function getRemoteNameFromBranchName(branchName: string | null): string | null {
  if (!branchName) return null;
  const slashIndex = branchName.indexOf("/");
  if (slashIndex <= 0) return null;
  return branchName.slice(0, slashIndex);
}

async function getDefaultRemoteName(
  projectPath: string,
  upstream: string | null,
): Promise<string> {
  const upstreamRemote = getRemoteNameFromBranchName(upstream);
  if (upstreamRemote) {
    return upstreamRemote;
  }

  const remoteHead = await runGit(projectPath, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]).catch(() => null);
  const originHeadRemote = getRemoteNameFromBranchName(
    remoteHead?.stdout.trim() ?? null,
  );
  if (originHeadRemote) {
    return originHeadRemote;
  }

  const allRemoteHeads = await runGit(projectPath, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/remotes/*/HEAD",
  ]).catch(() => null);

  for (const line of allRemoteHeads?.stdout.split("\n") ?? []) {
    const remoteName = getRemoteNameFromBranchName(line.trim());
    if (remoteName) return remoteName;
  }

  const remotes = await runGit(projectPath, ["remote"]).catch(() => null);
  const remoteNames =
    remotes?.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean) ?? [];
  if (remoteNames.includes("origin")) {
    return "origin";
  }
  return remoteNames[0] ?? "origin";
}

async function getCurrentBranch(projectPath: string): Promise<string | null> {
  const result = await runGit(projectPath, ["branch", "--show-current"]).catch(
    () => null,
  );
  const branch = result?.stdout.trim();
  return branch || null;
}

async function getGitMergePreview(
  projectPath: string,
  currentBranch: string,
  sourceBranch: string,
  strategy: GitMergeStrategy,
): Promise<GitMergePreviewResult> {
  const commitCount = await getGitCommitCount(
    projectPath,
    currentBranch,
    sourceBranch,
  );
  if (commitCount === 0) {
    return {
      state: "up_to_date",
      targetBranch: currentBranch,
      sourceBranch,
      strategy,
      commitCount: 0,
      conflictedFiles: 0,
    };
  }

  const conflictedFiles = await getGitPreviewConflictCount(
    projectPath,
    currentBranch,
    sourceBranch,
    strategy,
  );

  return {
    state: conflictedFiles > 0 ? "conflict" : "mergeable",
    targetBranch: currentBranch,
    sourceBranch,
    strategy,
    commitCount,
    conflictedFiles,
  };
}

async function getGitCommitCount(
  projectPath: string,
  currentBranch: string,
  sourceBranch: string,
): Promise<number> {
  const result = await runGit(projectPath, [
    "rev-list",
    "--count",
    `${currentBranch}..${sourceBranch}`,
  ]);
  return Number.parseInt(result.stdout.trim() || "0", 10) || 0;
}

async function getGitPreviewConflictCount(
  projectPath: string,
  currentBranch: string,
  sourceBranch: string,
  strategy: GitMergeStrategy,
): Promise<number> {
  const currentRef = await getGitRef(projectPath, currentBranch);

  return withTemporaryGitWorktree(projectPath, currentRef, async (tempPath) => {
    try {
      if (strategy === "merge") {
        await runGit(tempPath, [
          "merge",
          "--no-commit",
          "--no-ff",
          sourceBranch,
        ]);
      } else if (strategy === "squash") {
        await runGit(tempPath, ["merge", "--squash", sourceBranch]);
      } else {
        const tempBranch = createTemporaryBranchName("rebase-preview");
        await runGit(tempPath, ["switch", "-c", tempBranch, sourceBranch]);
        await runGit(tempPath, ["rebase", currentRef]);
      }

      return 0;
    } catch (err) {
      const conflictCount = await getGitConflictedFileCount(tempPath);
      if (conflictCount > 0) {
        return conflictCount;
      }
      throw err;
    } finally {
      await cleanupTemporaryGitOperation(tempPath, strategy);
    }
  });
}

async function performGitMerge(
  projectPath: string,
  currentBranch: string,
  sourceBranch: string,
  strategy: GitMergeStrategy,
): Promise<string> {
  const currentRef = await getGitRef(projectPath, currentBranch);

  return withTemporaryGitWorktree(projectPath, currentRef, async (tempPath) => {
    try {
      if (strategy === "merge") {
        await runGit(tempPath, ["merge", "--no-ff", "--no-edit", sourceBranch]);
      } else if (strategy === "squash") {
        await runGit(tempPath, ["merge", "--squash", sourceBranch]);
        await runGit(tempPath, [
          "commit",
          "-m",
          `Squash merge ${sourceBranch} into ${currentBranch}`,
        ]);
      } else {
        const tempBranch = createTemporaryBranchName("rebase");
        await runGit(tempPath, ["switch", "-c", tempBranch, sourceBranch]);
        await runGit(tempPath, ["rebase", currentRef]);
      }

      return await getGitRef(tempPath, "HEAD");
    } catch (err) {
      const conflictCount = await getGitConflictedFileCount(tempPath);
      if (conflictCount > 0) {
        throw new Error(
          buildConflictMessage(currentBranch, sourceBranch, conflictCount),
        );
      }

      throw err;
    } finally {
      await cleanupTemporaryGitOperation(tempPath, strategy);
    }
  });
}

function buildConflictMessage(
  currentBranch: string,
  sourceBranch: string,
  conflictedFiles: number,
): string {
  return `There will be ${conflictedFiles} conflicted files when merging ${sourceBranch} into ${currentBranch}.`;
}

async function getGitRef(projectPath: string, ref: string): Promise<string> {
  const result = await runGit(projectPath, ["rev-parse", ref]);
  return result.stdout.trim();
}

async function getGitConflictedFileCount(projectPath: string): Promise<number> {
  const conflictedFiles = await runGit(projectPath, [
    "diff",
    "--name-only",
    "--diff-filter=U",
  ]).catch(() => null);

  return (
    conflictedFiles?.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean).length ?? 0
  );
}

async function cleanupTemporaryGitOperation(
  projectPath: string,
  strategy: GitMergeStrategy,
): Promise<void> {
  if (strategy === "rebase") {
    await runGit(projectPath, ["rebase", "--abort"]).catch(() => null);
    return;
  }

  const hasMergeHead = await runGit(projectPath, [
    "rev-parse",
    "--verify",
    "-q",
    "MERGE_HEAD",
  ]).catch(() => null);

  if (hasMergeHead) {
    await runGit(projectPath, ["merge", "--abort"]).catch(() => null);
  }

  if (strategy === "squash") {
    await runGit(projectPath, ["reset", "--hard", "HEAD"]).catch(() => null);
  }
}

async function withTemporaryGitWorktree<T>(
  projectPath: string,
  ref: string,
  callback: (tempPath: string) => Promise<T>,
): Promise<T> {
  const tempPath = await mkdtemp(join(tmpdir(), "yepanywhere-merge-"));
  await runGit(projectPath, [
    "worktree",
    "add",
    "--detach",
    "--quiet",
    tempPath,
    ref,
  ]);

  try {
    return await callback(tempPath);
  } finally {
    await runGit(projectPath, [
      "worktree",
      "remove",
      "--force",
      tempPath,
    ]).catch(() => null);
    await rm(tempPath, { recursive: true, force: true }).catch(() => null);
  }
}

function createTemporaryBranchName(prefix: string): string {
  return `yepanywhere-${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

async function getGitBranches(projectPath: string): Promise<GitBranchInfo[]> {
  const upstream = await getGitUpstream(projectPath);
  const defaultRemote = await getDefaultRemoteName(projectPath, upstream);
  const { stdout } = await runGit(projectPath, [
    "for-each-ref",
    "--format=%(refname:short)\t%(HEAD)\t%(refname)\t%(committerdate:iso8601-strict)",
    "refs/heads",
    "refs/remotes",
  ]);

  const branches = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", head = "", refname = "", updatedAt = ""] =
        line.split("\t");
      return {
        name,
        current: head.trim() === "*",
        remote: refname.startsWith("refs/remotes/"),
        updatedAt: updatedAt.trim() || null,
      };
    })
    .filter((branch) => !branch.name.endsWith("/HEAD"));

  const localBranches = branches.filter((branch) => !branch.remote);
  const localBranchNames = new Set(localBranches.map((branch) => branch.name));
  const currentLocalBranch = localBranches.find(
    (branch) => branch.current,
  )?.name;
  const defaultBranches = await getDefaultLocalBranches(
    projectPath,
    localBranchNames,
  );
  const recentBranches = await getRecentLocalBranches(
    projectPath,
    localBranchNames,
    defaultBranches,
    currentLocalBranch,
  );
  const recentOrder = new Map(
    recentBranches.map((branchName, index) => [branchName, index]),
  );

  const entries = [
    ...localBranches.map((branch) => ({
      ...branch,
      group: defaultBranches.has(branch.name)
        ? ("default" as const)
        : recentOrder.has(branch.name)
          ? ("recent" as const)
          : ("other" as const),
    })),
    ...branches
      .filter((branch) => branch.remote)
      .filter(
        (branch) =>
          isRemoteBranchName(branch.name) &&
          !(
            getRemoteNameFromBranchName(branch.name) === defaultRemote &&
            localBranchNames.has(getRemoteShortBranchName(branch.name))
          ),
      )
      .map((branch) => ({
        ...branch,
        group: "other" as const,
      })),
  ];

  const groupOrder = { default: 0, recent: 1, other: 2 };

  return entries.sort((left, right) => {
    if (groupOrder[left.group] !== groupOrder[right.group]) {
      return groupOrder[left.group] - groupOrder[right.group];
    }
    if (left.group === "recent" && right.group === "recent") {
      const leftIndex = recentOrder.get(left.name) ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = recentOrder.get(right.name) ?? Number.MAX_SAFE_INTEGER;
      if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    }
    if (left.current !== right.current) return left.current ? -1 : 1;
    if ((left.remote ?? false) !== (right.remote ?? false)) {
      return left.remote ? 1 : -1;
    }
    return left.name.localeCompare(right.name);
  });
}

async function getDefaultLocalBranches(
  projectPath: string,
  localBranchNames: Set<string>,
): Promise<Set<string>> {
  const defaults = new Set<string>();
  const upstream = await getGitUpstream(projectPath);
  const defaultRemote = await getDefaultRemoteName(projectPath, upstream);
  const remoteHead = await runGit(projectPath, [
    "symbolic-ref",
    "--quiet",
    "--short",
    `refs/remotes/${defaultRemote}/HEAD`,
  ]).catch(() => null);
  const remoteDefaultName = remoteHead?.stdout.trim();
  if (remoteDefaultName) {
    const localName = getRemoteShortBranchName(remoteDefaultName);
    if (localBranchNames.has(localName)) {
      defaults.add(localName);
    }
  }

  if (defaults.size > 0) {
    return defaults;
  }

  for (const candidate of ["main", "master"]) {
    if (localBranchNames.has(candidate)) {
      defaults.add(candidate);
      break;
    }
  }

  return defaults;
}

async function getRecentLocalBranches(
  projectPath: string,
  localBranchNames: Set<string>,
  defaultBranches: Set<string>,
  currentLocalBranch: string | undefined,
): Promise<string[]> {
  const recent = new Set<string>();

  const addBranch = (branchName: string | undefined) => {
    if (!branchName) return;
    if (!localBranchNames.has(branchName)) return;
    if (defaultBranches.has(branchName)) return;
    recent.add(branchName);
  };

  addBranch(currentLocalBranch);

  const reflog = await runGit(projectPath, [
    "reflog",
    "show",
    "--format=%gs",
    "--max-count=80",
    "HEAD",
  ]).catch(() => null);

  for (const line of reflog?.stdout.split("\n") ?? []) {
    const match = /^checkout: moving from .* to (.+)$/.exec(line.trim());
    if (!match) continue;
    addBranch(match[1]?.trim());
    if (recent.size >= 5) break;
  }

  if (recent.size < 5) {
    const fallback = await runGit(projectPath, [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname:short)",
      "refs/heads",
    ]).catch(() => null);

    for (const branchName of fallback?.stdout.split("\n") ?? []) {
      addBranch(branchName.trim());
      if (recent.size >= 5) break;
    }
  }

  return [...recent].slice(0, 5);
}

function getRemoteShortBranchName(branchName: string): string {
  const slashIndex = branchName.indexOf("/");
  return slashIndex === -1 ? branchName : branchName.slice(slashIndex + 1);
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

/** Status letter from the XY field for a given position */
function statusChar(xy: string | undefined, index: 0 | 1): string | null {
  if (!xy) return null;
  const ch = xy[index];
  return ch && ch !== "." ? ch : null;
}

async function getGitStatus(projectPath: string): Promise<GitStatusInfo> {
  // Run all three commands in parallel
  const [statusResult, numstatUnstaged, numstatStaged, upstreamRef, stashes] =
    await Promise.all([
      runGit(projectPath, [
        "status",
        "--porcelain=v2",
        "--branch",
        "--untracked-files=all",
      ]),
      runGit(projectPath, ["diff", "--numstat"]).catch(() => ({
        stdout: "",
        stderr: "",
      })),
      runGit(projectPath, ["diff", "--cached", "--numstat"]).catch(() => ({
        stdout: "",
        stderr: "",
      })),
      getGitUpstream(projectPath),
      getGitStashes(projectPath),
    ]);
  const remote = await getDefaultRemoteName(projectPath, upstreamRef);

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
        const untrackedStats = await getUntrackedFileStats(projectPath, path);
        files.push({
          path,
          status: "?",
          staged: false,
          linesAdded: untrackedStats.added,
          linesDeleted: untrackedStats.deleted,
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

  const latestLocalCommit =
    ahead > 0 ? await getLatestLocalCommit(projectPath) : null;

  return {
    isGitRepo: true,
    branch,
    upstream,
    remote,
    ahead,
    behind,
    isClean: files.length === 0,
    latestLocalCommit,
    stashes,
    files,
  };
}

async function getGitStashes(projectPath: string): Promise<GitStashEntry[]> {
  const result = await runGit(projectPath, [
    "stash",
    "list",
    "--format=%gd%x00%gs%x00%cI",
  ]).catch(() => null);
  const output = result?.stdout.trim();
  if (!output) return [];

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [ref = "", subject = "", createdAt = ""] = line.split("\0");
      if (!ref || !subject || !createdAt) return [];

      const { branch, message, createdByApp } = parseGitStashSubject(subject);
      return [
        {
          ref,
          branch,
          message,
          createdAt,
          createdByApp,
        },
      ];
    });
}

async function getGitStashDetail(
  projectPath: string,
  stashRef: string,
): Promise<GitStashDetail> {
  const stashes = await getGitStashes(projectPath);
  const stash = stashes.find((entry) => entry.ref === stashRef);
  if (!stash) {
    throw new Error("Stash not found");
  }

  const [nameStatusResult, numstatResult] = await Promise.all([
    runGit(projectPath, [
      "stash",
      "show",
      "--format=",
      "--name-status",
      "--find-renames",
      "--include-untracked",
      stashRef,
    ]),
    runGit(projectPath, [
      "stash",
      "show",
      "--format=",
      "--numstat",
      "--find-renames",
      "--include-untracked",
      stashRef,
    ]),
  ]);

  return {
    ...stash,
    files: parseGitStashFiles(nameStatusResult.stdout, numstatResult.stdout),
  };
}

function parseGitStashFiles(
  nameStatusOutput: string,
  numstatOutput: string,
): GitStashFileChange[] {
  const statsByPath = parseNumstat(numstatOutput);

  return nameStatusOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const parts = line.split("\t");
      const statusToken = parts[0] ?? "";
      const status = statusToken[0] ?? "";

      if (!status) return [];

      if (status === "R" && parts[1] && parts[2]) {
        const path = parts[2];
        const stats = statsByPath.get(path);
        return [
          {
            path,
            status,
            previousPath: parts[1],
            linesAdded: stats?.added ?? null,
            linesDeleted: stats?.deleted ?? null,
          },
        ];
      }

      const path = parts[1];
      if (!path) return [];
      const stats = statsByPath.get(path);
      return [
        {
          path,
          status,
          linesAdded: stats?.added ?? null,
          linesDeleted: stats?.deleted ?? null,
        },
      ];
    });
}

function parseGitStashSubject(subject: string): {
  branch: string | null;
  message: string;
  createdByApp: boolean;
} {
  const onBranchMatch = subject.match(/^(?:On|WIP on) (.+?):\s*(.*)$/);
  const branch = onBranchMatch?.[1]?.trim() || null;
  const rawMessage = onBranchMatch?.[2]?.trim() || subject.trim();
  const createdByApp = rawMessage.startsWith("yepanywhere:");

  return {
    branch,
    message: rawMessage,
    createdByApp,
  };
}

async function getStashFileVersions(
  cwd: string,
  stashRef: string,
  path: string,
  status: string,
  previousPath?: string,
): Promise<{ oldContent: string; newContent: string }> {
  const parentRef = `${stashRef}^1`;
  const oldPath = previousPath ?? path;

  if (status === "A" || status === "?") {
    return {
      oldContent: "",
      newContent: await getGitStashFileContent(cwd, stashRef, path, true),
    };
  }

  if (status === "D") {
    return {
      oldContent: await getGitFileContent(cwd, parentRef, oldPath),
      newContent: "",
    };
  }

  return {
    oldContent: await getGitFileContent(cwd, parentRef, oldPath),
    newContent: await getGitStashFileContent(cwd, stashRef, path, false),
  };
}

async function getGitStashFileContent(
  cwd: string,
  stashRef: string,
  path: string,
  allowUntrackedParentFallback: boolean,
): Promise<string> {
  const direct = await getGitFileContent(cwd, stashRef, path).catch(() => "");
  if (direct || !allowUntrackedParentFallback) {
    return direct;
  }

  return getGitFileContent(cwd, `${stashRef}^3`, path).catch(() => "");
}

async function getLatestLocalCommit(
  projectPath: string,
): Promise<GitLocalCommitInfo | null> {
  const result = await runGit(projectPath, [
    "log",
    "-1",
    "--pretty=%s%x00%cI",
  ]).catch(() => null);
  const output = result?.stdout.trim();
  if (!output) return null;

  const [message = "", committedAt = ""] = output.split("\0");
  if (!message || !committedAt) return null;

  return { message, committedAt };
}

async function getGitHistory(
  projectPath: string,
  offset: number,
  limit: number,
): Promise<{
  commits: GitHistoryCommitSummary[];
  hasMore: boolean;
  nextCursor: string | null;
}> {
  const result = await runGit(projectPath, [
    "log",
    "--skip",
    String(offset),
    "-n",
    String(limit + 1),
    "--date=iso-strict",
    "--pretty=format:__COMMIT__%n%H%x00%h%x00%s%x00%an%x00%ae%x00%cI%x00%D",
    "--numstat",
  ]).catch((err) => {
    if (isGitEmptyHistoryError(err)) {
      return { stdout: "", stderr: "" };
    }
    throw err;
  });

  const commitsWithExtra = parseGitHistoryLog(result.stdout);
  const hasMore = commitsWithExtra.length > limit;
  const commits = commitsWithExtra.slice(0, limit);

  return {
    commits,
    hasMore,
    nextCursor: hasMore ? String(offset + commits.length) : null,
  };
}

async function getGitHistoryCommitDetail(
  projectPath: string,
  commit: string,
): Promise<GitHistoryCommitDetail> {
  const [summaryResult, statusResult, numstatResult] = await Promise.all([
    runGit(projectPath, [
      "show",
      "-s",
      "--date=iso-strict",
      "--pretty=format:%H%x00%h%x00%s%x00%b%x00%an%x00%ae%x00%cI%x00%D",
      commit,
    ]),
    runGit(projectPath, [
      "show",
      "--format=",
      "--name-status",
      "--find-renames",
      commit,
    ]),
    runGit(projectPath, ["show", "--format=", "--numstat", commit]),
  ]);

  const [
    hash = "",
    shortHash = "",
    message = "",
    body = "",
    authorName = "",
    authorEmail = "",
    committedAt = "",
    refs = "",
  ] = summaryResult.stdout.split("\0");

  const files = parseGitHistoryFiles(statusResult.stdout, numstatResult.stdout);
  const aggregate = summarizeHistoryFiles(files);

  return {
    hash,
    shortHash,
    message,
    body: body.trim(),
    authorName,
    authorEmail,
    committedAt,
    refs: refs
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    filesChanged: files.length,
    insertions: aggregate.insertions,
    deletions: aggregate.deletions,
    files,
  };
}

function parseGitHistoryLog(output: string): GitHistoryCommitSummary[] {
  const blocks = output
    .split("__COMMIT__\n")
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.map((block) => {
    const [headerLine = "", ...statLines] = block.split("\n");
    const [
      hash = "",
      shortHash = "",
      message = "",
      authorName = "",
      authorEmail = "",
      committedAt = "",
      refs = "",
    ] = headerLine.split("\0");

    const stats = parseNumstatLines(statLines);

    return {
      hash,
      shortHash,
      message,
      authorName,
      authorEmail,
      committedAt,
      refs: refs
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      filesChanged: stats.filesChanged,
      insertions: stats.insertions,
      deletions: stats.deletions,
    };
  });
}

function parseNumstatLines(lines: string[]): {
  filesChanged: number;
  insertions: number;
  deletions: number;
} {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [addedText, deletedText] = trimmed.split("\t");
    if (addedText === undefined || deletedText === undefined) continue;

    filesChanged += 1;
    const added = Number.parseInt(addedText, 10);
    const deleted = Number.parseInt(deletedText, 10);
    if (Number.isFinite(added)) insertions += added;
    if (Number.isFinite(deleted)) deletions += deleted;
  }

  return { filesChanged, insertions, deletions };
}

function parseGitHistoryFiles(
  statusOutput: string,
  numstatOutput: string,
): GitHistoryFileChange[] {
  const files = new Map<string, GitHistoryFileChange>();

  for (const rawLine of statusOutput.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const parts = line.split("\t");

    const status = parts[0] ?? "";
    if (status.startsWith("R") && parts.length >= 3) {
      const previousPath = parts[1];
      const path = parts[2];
      if (!previousPath || !path) continue;
      files.set(path, {
        path,
        status: "R",
        previousPath,
        linesAdded: null,
        linesDeleted: null,
      });
      continue;
    }

    if (parts.length >= 2) {
      const path = parts[1];
      if (!path) continue;
      files.set(path, {
        path,
        status: normalizeGitHistoryStatus(status),
        linesAdded: null,
        linesDeleted: null,
      });
    }
  }

  for (const rawLine of numstatOutput.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const parts = line.split("\t");
    if (
      parts.length < 3 ||
      !isNumstatField(parts[0]) ||
      !isNumstatField(parts[1])
    ) {
      continue;
    }

    const path = parts.at(-1) ?? "";
    const existing = files.get(path);
    if (!existing) continue;

    const added = parts[0];
    const deleted = parts[1];
    if (!added || !deleted) continue;

    existing.linesAdded = parseNumstatValue(added);
    existing.linesDeleted = parseNumstatValue(deleted);
  }

  return Array.from(files.values());
}

function isNumstatField(value: string | undefined): boolean {
  return value === "-" || /^\d+$/.test(value ?? "");
}

function parseNumstatValue(value: string): number | null {
  if (value === "-") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeGitHistoryStatus(status: string): string {
  if (!status) return "M";
  if (status.startsWith("R")) return "R";
  if (status.startsWith("C")) return "A";
  return status[0] ?? "M";
}

function summarizeHistoryFiles(files: GitHistoryFileChange[]): {
  insertions: number;
  deletions: number;
} {
  let insertions = 0;
  let deletions = 0;

  for (const file of files) {
    if (typeof file.linesAdded === "number") insertions += file.linesAdded;
    if (typeof file.linesDeleted === "number") deletions += file.linesDeleted;
  }

  return { insertions, deletions };
}

async function getUntrackedFileStats(
  projectPath: string,
  path: string,
): Promise<{ added: number | null; deleted: number | null }> {
  try {
    const content = await readFile(resolve(projectPath, path), "utf-8");
    return {
      added: countLines(content),
      deleted: 0,
    };
  } catch {
    return { added: null, deleted: null };
  }
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split("\n").length;
}
