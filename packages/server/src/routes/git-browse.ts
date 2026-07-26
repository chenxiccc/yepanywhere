import { extname } from "node:path";
import {
  type GitCommitDetail,
  type GitCommitListResult,
  type GitDiffResult,
  type GitFileChange,
  type GitFileListResult,
  type GitRecentCommit,
  type GitSearchResult,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { computeEditAugment } from "../augments/edit-augments.js";
import { renderMarkdownToHtml } from "../augments/markdown-augments.js";
import { getBlame } from "../git/blame.js";
import {
  getDiffPreviewSkip,
  skippedGitDiffResult,
} from "../git/diffPreviewGuards.js";
import { GIT_DECODE_PATHS_ARGS, runGit } from "../git/gitExec.js";
import type { ProjectScanner } from "../projects/scanner.js";

/**
 * Read-only git browse surface (topic: source-review-to-session, stage 3):
 * a paged commit list, a commit's changed-file list, and a per-file commit
 * diff. Kept out of `git-status.ts` (already 1200 lines) but built from the
 * same primitives — `runGit`, the diff-preview guards, and `computeEditAugment`
 * — so a commit diff renders with the identical `data-diff-line` addressing the
 * working-tree diff uses, and comments anchor against it unchanged (with a
 * `sha` revision instead of `uncommitted`).
 *
 * Everything here is read-only: no checkout, no mutation. Blame, the all-files
 * tree, and search land in later stage-3 milestones.
 */

export interface GitBrowseDeps {
  scanner: ProjectScanner;
}

/** `hash | shortHash | authorName | authorDate | subject`, records `\x1e`-joined. */
const COMMIT_LOG_FORMAT = "%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e";
const COMMIT_DETAIL_FORMAT = "%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%b";
const DEFAULT_COMMIT_LIMIT = 50;
const MAX_COMMIT_LIMIT = 200;
const MAX_COMMIT_SKIP = 1_000_000;
/** `git log`/`git show` output can exceed the 1 MB default. */
const BROWSE_MAX_BUFFER = 16 * 1024 * 1024;
/** A commit-ish the browser addresses — a hex sha (short or full). */
const SHA_RE = /^[0-9a-f]{4,64}$/i;
const DEFAULT_FILE_LIST_LIMIT = 2000;
const DEFAULT_SEARCH_COMMIT_LIMIT = 50;
const MAX_SEARCH_COMMIT_LIMIT = 200;
const SEARCH_TIMEOUT_MS = 15_000;

export function createGitBrowseRoutes(deps: GitBrowseDeps): Hono {
  const routes = new Hono();

  // Paged commit list for the browser's commit column.
  routes.get("/:projectId/git/commits", async (c) => {
    const projectPath = await resolveProjectPath(c, deps);
    if (typeof projectPath !== "string") return projectPath;

    const limit = clampInt(
      c.req.query("limit"),
      DEFAULT_COMMIT_LIMIT,
      1,
      MAX_COMMIT_LIMIT,
    );
    const skip = clampInt(c.req.query("skip"), 0, 0, MAX_COMMIT_SKIP);

    try {
      // Fetch one extra to learn whether a further page exists.
      const { stdout } = await runGit(
        projectPath,
        [
          "log",
          "-n",
          String(limit + 1),
          `--skip=${skip}`,
          `--format=${COMMIT_LOG_FORMAT}`,
        ],
        { maxBuffer: BROWSE_MAX_BUFFER },
      );
      const all = parseCommitLog(stdout);
      const hasMore = all.length > limit;
      const result: GitCommitListResult = {
        commits: hasMore ? all.slice(0, limit) : all,
        hasMore,
      };
      return c.json(result);
    } catch (err) {
      return gitError(c, err);
    }
  });

  // A commit's metadata plus the files it changed (no diffs — fetched per file).
  routes.get("/:projectId/git/commit/:sha", async (c) => {
    const projectPath = await resolveProjectPath(c, deps);
    if (typeof projectPath !== "string") return projectPath;

    const sha = c.req.param("sha");
    if (!SHA_RE.test(sha)) return c.json({ error: "Invalid commit id" }, 400);

    try {
      const detail = await getCommitDetail(projectPath, sha);
      return c.json(detail);
    } catch (err) {
      return gitError(c, err);
    }
  });

  // One changed file's diff within a commit — mirrors POST /git/diff.
  routes.post("/:projectId/git/commit-diff", async (c) => {
    const projectPath = await resolveProjectPath(c, deps);
    if (typeof projectPath !== "string") return projectPath;

    let body: {
      sha: string;
      path: string;
      status: string;
      origPath?: string;
      fullContext?: boolean;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { sha, path, status, origPath, fullContext } = body;
    if (!sha || !SHA_RE.test(sha)) {
      return c.json({ error: "Invalid commit id" }, 400);
    }
    if (!path || !status) {
      return c.json({ error: "Missing required fields: path, status" }, 400);
    }

    try {
      const { oldContent, newContent } = await getCommitFileVersions(
        projectPath,
        sha,
        path,
        status,
        origPath,
      );

      const previewSkip = getDiffPreviewSkip(oldContent, newContent);
      if (previewSkip) return c.json(skippedGitDiffResult(previewSkip));

      const contextLines = fullContext ? 999999 : 3;
      const augment = await computeEditAugment(
        "git-commit-diff",
        { file_path: path, old_string: oldContent, new_string: newContent },
        contextLines,
      );
      const result: GitDiffResult = {
        diffHtml: augment.diffHtml,
        structuredPatch: augment.structuredPatch,
      };

      const ext = extname(path).toLowerCase();
      if ((ext === ".md" || ext === ".markdown") && newContent) {
        try {
          result.markdownHtml = await renderMarkdownToHtml(newContent);
        } catch {
          // Ignore markdown rendering errors — the diff still renders.
        }
      }

      return c.json(result);
    } catch (err) {
      return gitError(c, err);
    }
  });

  // Whole-file blame for the all-files provenance browser.
  routes.get("/:projectId/git/blame", async (c) => {
    const projectPath = await resolveProjectPath(c, deps);
    if (typeof projectPath !== "string") return projectPath;

    const path = c.req.query("path");
    if (!path) return c.json({ error: "Missing path parameter" }, 400);
    const rev = c.req.query("rev");
    if (rev && rev !== "HEAD" && !SHA_RE.test(rev)) {
      return c.json({ error: "Invalid rev" }, 400);
    }

    try {
      const result = await getBlame(projectPath, path, rev || undefined);
      return c.json(result);
    } catch (err) {
      return gitError(c, err);
    }
  });

  // Tracked-file list for the all-files tree + filename search.
  routes.get("/:projectId/git/files", async (c) => {
    const projectPath = await resolveProjectPath(c, deps);
    if (typeof projectPath !== "string") return projectPath;

    const query = (c.req.query("q") ?? "").toLowerCase();
    const limit = clampInt(
      c.req.query("limit"),
      DEFAULT_FILE_LIST_LIMIT,
      1,
      DEFAULT_FILE_LIST_LIMIT,
    );
    try {
      const result = await listRepoFiles(projectPath, query, limit);
      return c.json(result);
    } catch (err) {
      return gitError(c, err);
    }
  });

  // Rudimentary filename / commit-delta search.
  routes.get("/:projectId/git/search", async (c) => {
    const projectPath = await resolveProjectPath(c, deps);
    if (typeof projectPath !== "string") return projectPath;

    const query = c.req.query("q") ?? "";
    const kind = c.req.query("kind") === "delta" ? "delta" : "filename";
    if (query.trim().length === 0) {
      return c.json({ truncated: false } satisfies GitSearchResult);
    }
    const limit = clampInt(
      c.req.query("limit"),
      DEFAULT_SEARCH_COMMIT_LIMIT,
      1,
      MAX_SEARCH_COMMIT_LIMIT,
    );

    try {
      if (kind === "filename") {
        const list = await listRepoFiles(
          projectPath,
          query.toLowerCase(),
          DEFAULT_FILE_LIST_LIMIT,
        );
        return c.json({
          files: list.files,
          truncated: list.truncated,
        } satisfies GitSearchResult);
      }
      const delta = await searchCommitDelta(projectPath, query, limit);
      return c.json({
        commits: delta.commits,
        truncated: delta.truncated,
      } satisfies GitSearchResult);
    } catch (err) {
      return gitError(c, err);
    }
  });

  return routes;
}

/** Resolve `:projectId` to its filesystem path, or an error Response. */
async function resolveProjectPath(
  c: Context,
  deps: GitBrowseDeps,
): Promise<string | Response> {
  const projectId = c.req.param("projectId");
  if (!projectId || !isUrlProjectId(projectId)) {
    return c.json({ error: "Invalid project ID format" }, 400);
  }
  const project = await deps.scanner.getProject(projectId);
  if (!project) return c.json({ error: "Project not found" }, 404);
  return project.path;
}

function gitError(c: Context, err: unknown): Response {
  const message = err instanceof Error ? err.message : "git command failed";
  return c.json({ error: message }, 500);
}

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

async function getCommitDetail(
  cwd: string,
  sha: string,
): Promise<GitCommitDetail> {
  const [meta, nameStatus, numstat] = await Promise.all([
    runGit(cwd, ["show", "-s", `--format=${COMMIT_DETAIL_FORMAT}`, sha], {
      maxBuffer: BROWSE_MAX_BUFFER,
    }),
    runGit(
      cwd,
      [
        ...GIT_DECODE_PATHS_ARGS,
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "-r",
        "-M",
        sha,
      ],
      { maxBuffer: BROWSE_MAX_BUFFER },
    ),
    runGit(
      cwd,
      [
        ...GIT_DECODE_PATHS_ARGS,
        "diff-tree",
        "--no-commit-id",
        "--numstat",
        "-r",
        "-M",
        sha,
      ],
      { maxBuffer: BROWSE_MAX_BUFFER },
    ).catch(() => ({ stdout: "", stderr: "" })),
  ]);

  const raw = meta.stdout.replace(/\n$/, "");
  const [hash, shortHash, authorName, authorDate, subject, ...bodyParts] =
    raw.split("\x1f");
  const body = bodyParts.join("\x1f").trim();

  return {
    hash: hash ?? sha,
    shortHash: shortHash ?? sha.slice(0, 7),
    authorName: authorName ?? "",
    authorDate: authorDate ?? "",
    subject: subject ?? "",
    body,
    files: buildCommitFiles(nameStatus.stdout, numstat.stdout),
  };
}

interface NameStatusEntry {
  status: string;
  path: string;
  origPath?: string;
}

/**
 * `--name-status` and `--numstat` list the same files in the same order for a
 * given diff-tree, so counts are zipped by index — sidestepping numstat's
 * awkward `old => new` rename path form entirely.
 */
function buildCommitFiles(
  nameStatus: string,
  numstat: string,
): GitFileChange[] {
  const entries = parseNameStatus(nameStatus);
  const counts = parseNumstatCounts(numstat);
  return entries.map((entry, index) => {
    const file: GitFileChange = {
      path: entry.path,
      status: entry.status,
      staged: false,
      linesAdded: counts[index]?.added ?? null,
      linesDeleted: counts[index]?.deleted ?? null,
    };
    if (entry.origPath) file.origPath = entry.origPath;
    return file;
  });
}

function parseNameStatus(stdout: string): NameStatusEntry[] {
  const out: NameStatusEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const letter = (parts[0] ?? "M")[0] ?? "M";
    if (letter === "R" || letter === "C") {
      const origPath = parts[1];
      const path = parts[2];
      if (!path) continue;
      out.push({ status: letter, path, origPath });
    } else {
      const path = parts[1];
      if (!path) continue;
      out.push({ status: letter, path });
    }
  }
  return out;
}

function parseNumstatCounts(
  stdout: string,
): Array<{ added: number | null; deleted: number | null }> {
  const out: Array<{ added: number | null; deleted: number | null }> = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const added = parts[0];
    const deleted = parts[1];
    out.push({
      added: added === "-" || added === undefined ? null : toCount(added),
      deleted:
        deleted === "-" || deleted === undefined ? null : toCount(deleted),
    });
  }
  return out;
}

function toCount(value: string): number | null {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Old/new content for one file in a commit, keyed off its `name-status` letter.
 * A root commit has no parent, so `<sha>^:path` fails and the file reads as
 * fully added (old = "").
 */
async function getCommitFileVersions(
  cwd: string,
  sha: string,
  path: string,
  status: string,
  origPath: string | undefined,
): Promise<{ oldContent: string; newContent: string }> {
  const letter = status[0]?.toUpperCase() ?? "M";

  if (letter === "A") {
    const cur = await showAt(cwd, `${sha}:${path}`);
    return { oldContent: "", newContent: cur };
  }
  if (letter === "D") {
    const prev = await showAt(cwd, `${sha}^:${path}`);
    return { oldContent: prev, newContent: "" };
  }

  // Modified / renamed / copied / type-changed: parent's old vs. this commit's new.
  const oldPath =
    (letter === "R" || letter === "C") && origPath ? origPath : path;
  const [oldContent, newContent] = await Promise.all([
    showAt(cwd, `${sha}^:${oldPath}`),
    showAt(cwd, `${sha}:${path}`),
  ]);
  return { oldContent, newContent };
}

/** `git show <rev>:<path>`, resolving to "" when the object is absent. */
async function showAt(cwd: string, spec: string): Promise<string> {
  try {
    const { stdout } = await runGit(cwd, ["show", spec], {
      maxBuffer: BROWSE_MAX_BUFFER,
    });
    return stdout;
  } catch {
    return "";
  }
}

function parseCommitLog(stdout: string): GitRecentCommit[] {
  const commits: GitRecentCommit[] = [];
  for (const rawRecord of stdout.split("\x1e")) {
    const record = rawRecord.replace(/^\n/, "").replace(/\n$/, "");
    if (!record) continue;
    const [hash, shortHash, authorName, authorDate, ...subjectParts] =
      record.split("\x1f");
    const subject = subjectParts.join("\x1f");
    if (!hash || !shortHash || !authorName || !authorDate) continue;
    commits.push({ hash, shortHash, authorName, authorDate, subject });
  }
  return commits;
}

/** Tracked files (`git ls-files -z`), optionally substring-filtered. */
async function listRepoFiles(
  cwd: string,
  queryLower: string,
  limit: number,
): Promise<GitFileListResult> {
  const { stdout } = await runGit(cwd, ["ls-files", "-z"], {
    maxBuffer: BROWSE_MAX_BUFFER,
  });
  const all = stdout.split("\0").filter((p) => p.length > 0);
  const matched = queryLower
    ? all.filter((p) => p.toLowerCase().includes(queryLower))
    : all;
  const truncated = matched.length > limit;
  return {
    files: truncated ? matched.slice(0, limit) : matched,
    truncated,
  };
}

/**
 * Commits whose diff added or removed a line matching `query` (git's `-G`
 * pickaxe; `query` is a POSIX regex, case-insensitive). Rudimentary by intent
 * — enough to find the commit to comment on.
 */
async function searchCommitDelta(
  cwd: string,
  query: string,
  limit: number,
): Promise<{ commits: GitRecentCommit[]; truncated: boolean }> {
  const { stdout } = await runGit(
    cwd,
    [
      "log",
      `-G${query}`,
      "--regexp-ignore-case",
      "-n",
      String(limit + 1),
      `--format=${COMMIT_LOG_FORMAT}`,
    ],
    { maxBuffer: BROWSE_MAX_BUFFER, timeout: SEARCH_TIMEOUT_MS },
  );
  const all = parseCommitLog(stdout);
  const truncated = all.length > limit;
  return {
    commits: truncated ? all.slice(0, limit) : all,
    truncated,
  };
}
