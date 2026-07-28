import type {
  GitCommitDetail,
  GitCommitListResult,
  GitCommitSearchManifest,
  GitCommitSearchRecord,
  GitCommitSearchRecordsResult,
  GitFileListResult,
  GitRecentCommit,
  GitSearchResult,
} from "@yep-anywhere/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { getBlame } from "../git/blame.js";
import { buildGitDiffResult } from "../git/diffResult.js";
import { buildGitFileChanges } from "../git/fileChanges.js";
import { GIT_DECODE_PATHS_ARGS, runGit } from "../git/gitExec.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { resolveProjectPath } from "./projectParam.js";

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
const SEARCH_INDEX_MAX_BUFFER = 64 * 1024 * 1024;
/** A commit-ish the browser addresses — a hex sha (short or full). */
const SHA_RE = /^[0-9a-f]{4,64}$/i;
const MAX_TRACKED_FILE_COUNT = 10_000;
const DEFAULT_FILE_LIST_LIMIT = MAX_TRACKED_FILE_COUNT;
const DEFAULT_SEARCH_COMMIT_LIMIT = 50;
const MAX_SEARCH_COMMIT_LIMIT = 200;
const SEARCH_TIMEOUT_MS = 15_000;
const MAX_SEARCH_INDEX_BATCH = 20;
const COMMIT_SEARCH_RECORD_FORMAT = "%x1e%H";
/** Manifest bound: the delta index covers at most this many recent commits. */
const MAX_SEARCH_MANIFEST_COMMITS = 50_000;

export function createGitBrowseRoutes(deps: GitBrowseDeps): Hono {
  const routes = new Hono();

  // Paged commit list for the browser's commit column.
  routes.get("/:projectId/git/commits", async (c) => {
    const projectPath = await resolveProjectPath(c, deps.scanner);
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

  // Complete lightweight history for the client-owned commit search index.
  routes.get("/:projectId/git/commit-search-manifest", async (c) => {
    const projectPath = await resolveProjectPath(c, deps.scanner);
    if (typeof projectPath !== "string") return projectPath;

    try {
      // One over the cap distinguishes "everything" from "capped".
      const { stdout } = await runGit(
        projectPath,
        [
          "log",
          "-n",
          String(MAX_SEARCH_MANIFEST_COMMITS + 1),
          `--format=${COMMIT_LOG_FORMAT}`,
        ],
        { maxBuffer: BROWSE_MAX_BUFFER },
      );
      const all = parseCommitLog(stdout);
      const truncated = all.length > MAX_SEARCH_MANIFEST_COMMITS;
      return c.json({
        head: all[0]?.hash ?? null,
        commits: truncated ? all.slice(0, MAX_SEARCH_MANIFEST_COMMITS) : all,
        ...(truncated ? { truncated } : {}),
      } satisfies GitCommitSearchManifest);
    } catch (err) {
      return gitError(c, err);
    }
  });

  // Bounded changed-line/path records. The browser requests manifest-order
  // batches once, then every typed query stays inside its client-owned index.
  routes.post("/:projectId/git/commit-search-records", async (c) => {
    const projectPath = await resolveProjectPath(c, deps.scanner);
    if (typeof projectPath !== "string") return projectPath;

    let body: { shas?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (
      !Array.isArray(body.shas) ||
      body.shas.length === 0 ||
      body.shas.length > MAX_SEARCH_INDEX_BATCH ||
      body.shas.some((sha) => typeof sha !== "string" || !SHA_RE.test(sha))
    ) {
      return c.json(
        {
          error: `shas must contain 1-${MAX_SEARCH_INDEX_BATCH} commit ids`,
        },
        400,
      );
    }

    try {
      const records = await getCommitSearchRecords(
        projectPath,
        body.shas as string[],
      );
      return c.json({
        records,
      } satisfies GitCommitSearchRecordsResult);
    } catch (err) {
      return gitError(c, err);
    }
  });

  // A commit's metadata plus the files it changed (no diffs — fetched per file).
  routes.get("/:projectId/git/commit/:sha", async (c) => {
    const projectPath = await resolveProjectPath(c, deps.scanner);
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
    const projectPath = await resolveProjectPath(c, deps.scanner);
    if (typeof projectPath !== "string") return projectPath;

    let body: {
      sha: string;
      path: string;
      status: string;
      origPath?: string;
      fullContext?: boolean;
      ignoreWhitespace?: boolean;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { sha, path, status, origPath, fullContext, ignoreWhitespace } = body;
    if (!sha || !SHA_RE.test(sha)) {
      return c.json({ error: "Invalid commit id" }, 400);
    }
    if (!path || !status) {
      return c.json({ error: "Missing required fields: path, status" }, 400);
    }
    if (
      ignoreWhitespace !== undefined &&
      typeof ignoreWhitespace !== "boolean"
    ) {
      return c.json({ error: "Invalid ignoreWhitespace" }, 400);
    }

    try {
      const { oldContent, newContent } = await getCommitFileVersions(
        projectPath,
        sha,
        path,
        status,
        origPath,
      );

      return c.json(
        await buildGitDiffResult({
          toolUseId: "git-commit-diff",
          path,
          oldContent,
          newContent,
          fullContext,
          ignoreWhitespace,
        }),
      );
    } catch (err) {
      return gitError(c, err);
    }
  });

  // Whole-file blame for the all-files provenance browser.
  routes.get("/:projectId/git/blame", async (c) => {
    const projectPath = await resolveProjectPath(c, deps.scanner);
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
    const projectPath = await resolveProjectPath(c, deps.scanner);
    if (typeof projectPath !== "string") return projectPath;

    const query = (c.req.query("q") ?? "").toLowerCase();
    const limit = clampInt(
      c.req.query("limit"),
      DEFAULT_FILE_LIST_LIMIT,
      1,
      MAX_TRACKED_FILE_COUNT,
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
    const projectPath = await resolveProjectPath(c, deps.scanner);
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
        "-z",
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
        "-z",
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
    files: buildGitFileChanges(nameStatus.stdout, numstat.stdout),
  };
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

/**
 * One record per requested sha, in request order. The batch normally comes
 * from one `git show`; when that fails (an oversized commit blowing the
 * buffer, a broken object), each missing sha degrades individually — worst
 * case an empty deltaText, leaving the commit metadata-searchable — so one
 * pathological commit can never poison its whole batch or stall indexing.
 */
async function getCommitSearchRecords(
  cwd: string,
  shas: string[],
): Promise<GitCommitSearchRecord[]> {
  const byHash = new Map<string, string>();
  try {
    for (const record of await showCommitSearchRecords(cwd, shas)) {
      byHash.set(record.hash, record.deltaText);
    }
  } catch {
    // Batch failed wholesale; fall through to per-sha recovery below.
  }
  const records: GitCommitSearchRecord[] = [];
  for (const sha of shas) {
    let deltaText = byHash.get(sha);
    if (deltaText === undefined) {
      deltaText = await singleCommitDeltaText(cwd, sha);
    }
    records.push({ hash: sha, deltaText });
  }
  return records;
}

async function showCommitSearchRecords(
  cwd: string,
  shas: string[],
): Promise<GitCommitSearchRecord[]> {
  const { stdout } = await runGit(
    cwd,
    [
      ...GIT_DECODE_PATHS_ARGS,
      "show",
      "--no-ext-diff",
      "--no-color",
      "--no-renames",
      "--unified=0",
      `--format=${COMMIT_SEARCH_RECORD_FORMAT}`,
      ...shas,
    ],
    { maxBuffer: SEARCH_INDEX_MAX_BUFFER, timeout: SEARCH_TIMEOUT_MS },
  );
  return parseCommitSearchRecords(stdout);
}

async function singleCommitDeltaText(
  cwd: string,
  sha: string,
): Promise<string> {
  try {
    const records = await showCommitSearchRecords(cwd, [sha]);
    return records[0]?.deltaText ?? "";
  } catch {
    return "";
  }
}

function parseCommitSearchRecords(stdout: string): GitCommitSearchRecord[] {
  const records: GitCommitSearchRecord[] = [];
  for (const raw of stdout.split("\x1e")) {
    const firstNewline = raw.indexOf("\n");
    if (firstNewline < 0) continue;
    const hash = raw.slice(0, firstNewline).trim();
    if (!SHA_RE.test(hash)) continue;
    records.push({
      hash,
      deltaText: extractDeltaSearchText(raw.slice(firstNewline + 1)),
    });
  }
  return records;
}

/**
 * Keep only paths and changed lines. Diff metadata and context do not affect
 * `git log -G` semantics and would inflate the browser's in-memory corpus.
 */
function extractDeltaSearchText(patch: string): string {
  const searchable: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      searchable.push(line.slice("diff --git ".length));
    } else if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      searchable.push(line.slice(4));
    } else if (
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---"))
    ) {
      searchable.push(line.slice(1));
    }
  }
  return searchable.join("\n");
}
