import type {
  GitIncomingCommitListResult,
  GitRecentCommit,
} from "@yep-anywhere/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { runGit } from "../git/gitExec.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { resolveProjectPath } from "./projectParam.js";

const DEFAULT_INCOMING_COMMIT_LIMIT = 100;
const MAX_INCOMING_COMMIT_LIMIT = 200;
const INCOMING_COMMIT_MAX_BUFFER = 4 * 1024 * 1024;
const INCOMING_COMMIT_FORMAT = "%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e";

export interface GitIncomingCommitsDeps {
  scanner: ProjectScanner;
}

/**
 * Commits observed on the local upstream tracking ref after the most recent
 * explicit fetch. This route never contacts a remote.
 */
export function createGitIncomingCommitsRoutes(
  deps: GitIncomingCommitsDeps,
): Hono {
  const routes = new Hono();

  routes.get("/:projectId/git/incoming-commits", async (c) => {
    const projectPath = await resolveProjectPath(c, deps.scanner);
    if (typeof projectPath !== "string") return projectPath;
    const limit = clampLimit(c.req.query("limit"));

    try {
      const upstream = await resolveUpstream(projectPath);
      if (!upstream) return c.json({ error: "No upstream configured" }, 404);
      return c.json(await listIncomingCommits(projectPath, upstream, limit));
    } catch (error) {
      return gitError(c, error);
    }
  });

  return routes;
}

export async function listIncomingCommits(
  cwd: string,
  upstream: string,
  limit = DEFAULT_INCOMING_COMMIT_LIMIT,
): Promise<GitIncomingCommitListResult> {
  const [head, remote] = await Promise.all([
    runGit(cwd, ["rev-parse", "HEAD"]),
    runGit(cwd, ["rev-parse", upstream]),
  ]);
  const headSha = head.stdout.trim();
  const upstreamSha = remote.stdout.trim();
  const log = await runGit(
    cwd,
    [
      "log",
      "-n",
      String(limit + 1),
      `--format=${INCOMING_COMMIT_FORMAT}`,
      `${headSha}..${upstreamSha}`,
    ],
    { maxBuffer: INCOMING_COMMIT_MAX_BUFFER },
  );
  const all = parseIncomingCommitLog(log.stdout);
  const truncated = all.length > limit;
  return {
    upstream,
    headSha,
    upstreamSha,
    commits: truncated ? all.slice(0, limit) : all,
    truncated,
    limit,
  };
}

async function resolveUpstream(cwd: string): Promise<string | null> {
  const { stdout } = await runGit(cwd, [
    "for-each-ref",
    "--format=%(HEAD)%09%(upstream:short)",
    "refs/heads",
  ]);
  const current = stdout.split("\n").find((line) => line.startsWith("*\t"));
  return current?.slice(2).trim() || null;
}

function parseIncomingCommitLog(stdout: string): GitRecentCommit[] {
  return stdout
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, shortHash, authorName, authorDate, ...subjectParts] =
        record.split("\x1f");
      return {
        hash: hash ?? "",
        shortHash: shortHash ?? "",
        authorName: authorName ?? "",
        authorDate: authorDate ?? "",
        subject: subjectParts.join("\x1f"),
      };
    })
    .filter((commit) => commit.hash.length > 0);
}

function clampLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_INCOMING_COMMIT_LIMIT;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return DEFAULT_INCOMING_COMMIT_LIMIT;
  return Math.min(MAX_INCOMING_COMMIT_LIMIT, Math.max(1, value));
}

function gitError(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : "git command failed";
  return c.json({ error: message }, 500);
}
