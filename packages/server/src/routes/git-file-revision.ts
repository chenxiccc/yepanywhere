import type {
  GitFileRevision,
  GitFileRevisionCommit,
} from "@yep-anywhere/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { runGit } from "../git/gitExec.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { repositoryRelativePath } from "../review/repositoryPath.js";
import { resolveProjectPath } from "./projectParam.js";

const SHA_RE = /^[0-9a-f]{4,64}$/i;
const COMMIT_FORMAT = "%H%x00%h%x00%an%x00%aI%x00%s%x00%B%x00";
const MAX_MESSAGE_LINES = 50;

export interface GitFileRevisionDeps {
  scanner: ProjectScanner;
  runGit?: typeof runGit;
}

/** Read-only provenance for the file chrome shared by every file surface. */
export function createGitFileRevisionRoutes(deps: GitFileRevisionDeps): Hono {
  const routes = new Hono();
  const git = deps.runGit ?? runGit;

  routes.get("/:projectId/git/file-revision", async (c) => {
    const projectPath = await resolveProjectPath(c, deps.scanner);
    if (typeof projectPath !== "string") return projectPath;

    const rawPath = c.req.query("path");
    if (!rawPath) return c.json({ error: "path is required" }, 400);
    const path = repositoryRelativePath(rawPath);
    const rawOrigPath = c.req.query("origPath");
    const historyPath = rawOrigPath
      ? repositoryRelativePath(rawOrigPath)
      : path;
    const requestedRev = c.req.query("rev");
    if (requestedRev && !SHA_RE.test(requestedRev)) {
      return c.json({ error: "rev must be a commit hash" }, 400);
    }

    try {
      if (!(await isGitWorkingTree(git, projectPath))) {
        return c.json({
          path,
          isGitRepo: false,
          commit: null,
          dirty: false,
        } satisfies GitFileRevision);
      }

      const revision = requestedRev
        ? await resolveCommit(git, projectPath, requestedRev)
        : await resolveHead(git, projectPath);
      if (!revision) {
        return c.json({
          path,
          isGitRepo: true,
          commit: null,
          dirty: false,
        } satisfies GitFileRevision);
      }
      const commit = await lastFileRevision(
        git,
        projectPath,
        revision,
        historyPath,
      );
      const dirty =
        !requestedRev && commit
          ? await workingFileDiffers(
              git,
              projectPath,
              path,
              historyPath,
              commit.hash,
            )
          : false;
      return c.json({
        path,
        isGitRepo: true,
        commit,
        dirty,
      } satisfies GitFileRevision);
    } catch (error) {
      return gitError(c, error);
    }
  });

  return routes;
}

type GitRunner = typeof runGit;

async function isGitWorkingTree(git: GitRunner, cwd: string): Promise<boolean> {
  try {
    const { stdout } = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return stdout.trim() === "true";
  } catch (error) {
    if (isNotGitRepositoryError(error)) return false;
    throw error;
  }
}

async function resolveHead(
  git: GitRunner,
  cwd: string,
): Promise<string | null> {
  try {
    const { stdout } = await git(cwd, [
      "rev-parse",
      "--verify",
      "--quiet",
      "HEAD^{commit}",
    ]);
    return stdout.trim();
  } catch (error) {
    if (isQuietMissingObjectError(error)) return null;
    throw error;
  }
}

async function resolveCommit(
  git: GitRunner,
  cwd: string,
  rev: string,
): Promise<string> {
  const { stdout } = await git(cwd, [
    "rev-parse",
    "--verify",
    `${rev}^{commit}`,
  ]);
  return stdout.trim();
}

async function lastFileRevision(
  git: GitRunner,
  cwd: string,
  revision: string,
  path: string,
): Promise<GitFileRevisionCommit | null> {
  const { stdout } = await git(
    cwd,
    [
      "log",
      "-1",
      "--follow",
      `--format=${COMMIT_FORMAT}`,
      revision,
      "--",
      `:(literal)${path}`,
    ],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  if (!stdout) return null;
  const [hash, shortHash, authorName, authorDate, subject, rawMessage] =
    stdout.split("\0");
  if (!hash) return null;
  const lines = (rawMessage ?? subject ?? "").trimEnd().split(/\r?\n/);
  const messageTruncated = lines.length > MAX_MESSAGE_LINES;
  return {
    hash,
    shortHash: shortHash || hash.slice(0, 7),
    authorName: authorName ?? "",
    authorDate: authorDate ?? "",
    subject: subject ?? "",
    message: lines.slice(0, MAX_MESSAGE_LINES).join("\n"),
    messageTruncated,
  };
}

async function workingFileDiffers(
  git: GitRunner,
  cwd: string,
  path: string,
  historyPath: string,
  commit: string,
): Promise<boolean> {
  const [working, committed] = await Promise.allSettled([
    git(cwd, ["hash-object", `--path=${path}`, "--", path]),
    git(cwd, ["rev-parse", "--verify", "--quiet", `${commit}:${historyPath}`]),
  ]);
  if (
    working.status === "rejected" &&
    !isMissingWorkingFileError(working.reason)
  ) {
    throw working.reason;
  }
  if (
    committed.status === "rejected" &&
    !isQuietMissingObjectError(committed.reason)
  ) {
    throw committed.reason;
  }
  if (working.status === "rejected" || committed.status === "rejected") {
    return true;
  }
  return working.value.stdout.trim() !== committed.value.stdout.trim();
}

function gitErrorShape(error: unknown): {
  code?: number | string;
  stderr?: string;
} {
  return error && typeof error === "object" ? error : {};
}

function isNotGitRepositoryError(error: unknown): boolean {
  return gitErrorShape(error).stderr?.includes("not a git repository") ?? false;
}

function isQuietMissingObjectError(error: unknown): boolean {
  const { code, stderr } = gitErrorShape(error);
  return code === 1 && !(stderr ?? "").trim();
}

function isMissingWorkingFileError(error: unknown): boolean {
  const stderr = gitErrorShape(error).stderr ?? "";
  return (
    stderr.includes("could not open") &&
    stderr.includes("No such file or directory")
  );
}

function gitError(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : "git command failed";
  return c.json({ error: message }, 400);
}
