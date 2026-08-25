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
}

/** Read-only provenance for the file chrome shared by every file surface. */
export function createGitFileRevisionRoutes(deps: GitFileRevisionDeps): Hono {
  const routes = new Hono();

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

    if (!(await isGitWorkingTree(projectPath))) {
      return c.json({
        path,
        isGitRepo: false,
        commit: null,
        dirty: false,
      } satisfies GitFileRevision);
    }

    try {
      const revision = requestedRev
        ? await resolveCommit(projectPath, requestedRev)
        : await resolveHead(projectPath);
      if (!revision) {
        return c.json({
          path,
          isGitRepo: true,
          commit: null,
          dirty: false,
        } satisfies GitFileRevision);
      }
      const commit = await lastFileRevision(projectPath, revision, historyPath);
      const dirty =
        !requestedRev && commit
          ? await workingFileDiffers(
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

async function isGitWorkingTree(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(cwd, [
      "rev-parse",
      "--is-inside-work-tree",
    ]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function resolveHead(cwd: string): Promise<string | null> {
  try {
    return await resolveCommit(cwd, "HEAD");
  } catch {
    return null;
  }
}

async function resolveCommit(cwd: string, rev: string): Promise<string> {
  const { stdout } = await runGit(cwd, [
    "rev-parse",
    "--verify",
    `${rev}^{commit}`,
  ]);
  return stdout.trim();
}

async function lastFileRevision(
  cwd: string,
  revision: string,
  path: string,
): Promise<GitFileRevisionCommit | null> {
  const { stdout } = await runGit(
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
  cwd: string,
  path: string,
  historyPath: string,
  commit: string,
): Promise<boolean> {
  try {
    const [working, committed] = await Promise.all([
      runGit(cwd, ["hash-object", `--path=${path}`, "--", path]),
      runGit(cwd, ["rev-parse", `${commit}:${historyPath}`]),
    ]);
    return working.stdout.trim() !== committed.stdout.trim();
  } catch {
    // A missing working file or historical blob differs from the last known
    // revision. Other Git failures are surfaced by the metadata commands.
    return true;
  }
}

function gitError(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : "git command failed";
  return c.json({ error: message }, 400);
}
