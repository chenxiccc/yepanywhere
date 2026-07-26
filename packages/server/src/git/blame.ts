import type { GitBlameLine, GitBlameResult } from "@yep-anywhere/shared";
import { highlightFile } from "../highlighting/index.js";
import { GIT_DECODE_PATHS_ARGS, runGit } from "./gitExec.js";

/**
 * Whole-file `git blame` for the all-files provenance browser (topic:
 * source-review-to-session, stage 3). Each source line gets its originating
 * commit; clicking a line comments into the same review with a `sha` anchor.
 *
 * The highlighted file body is reconstructed from the blame content lines and
 * run through the shared `highlightFile`, so the code column and the blame
 * gutter come from the exact same revision and align line-for-line.
 *
 * Blame is a pure function of (commit, path), so results for an explicit commit
 * sha are cached by `(sha, path)` per the topic decision. A working-tree blame
 * (no rev) can include not-yet-committed lines and drifts as the file changes,
 * so it is never cached.
 */

const BLAME_MAX_BUFFER = 32 * 1024 * 1024;
const BLAME_TIMEOUT_MS = 15_000;
/** Above this the viewer degrades to blame-only, no highlight, truncated. */
const MAX_BLAME_LINES = 20_000;
/** A hex commit-ish (short or full). */
const SHA_RE = /^[0-9a-f]{4,64}$/i;

const blameCache = new Map<string, GitBlameLine[]>();
const MAX_CACHE_ENTRIES = 200;

export async function getBlame(
  cwd: string,
  path: string,
  rev: string | undefined,
): Promise<GitBlameResult> {
  const explicitSha = rev && SHA_RE.test(rev) ? rev : null;

  let lines: GitBlameLine[] | undefined;
  let cacheKey: string | null = null;

  if (explicitSha) {
    // Resolve to a full commit sha so HEAD~2 etc. and short shas share a key.
    const resolved = await resolveCommit(cwd, explicitSha);
    if (resolved) {
      cacheKey = `${resolved}:${path}`;
      lines = blameCache.get(cacheKey);
    }
  }

  if (!lines) {
    const args = [
      ...GIT_DECODE_PATHS_ARGS,
      "blame",
      "--porcelain",
      ...(rev ? [rev] : []),
      "--",
      path,
    ];
    const { stdout } = await runGit(cwd, args, {
      maxBuffer: BLAME_MAX_BUFFER,
      timeout: BLAME_TIMEOUT_MS,
    });
    lines = parseBlamePorcelain(stdout);
    // Cache only a clean committed snapshot (no uncommitted lines).
    if (cacheKey && !lines.some((l) => l.uncommitted)) {
      if (blameCache.size >= MAX_CACHE_ENTRIES) {
        const oldest = blameCache.keys().next().value;
        if (oldest) blameCache.delete(oldest);
      }
      blameCache.set(cacheKey, lines);
    }
  }

  let truncated = false;
  if (lines.length > MAX_BLAME_LINES) {
    lines = lines.slice(0, MAX_BLAME_LINES);
    truncated = true;
  }

  const result: GitBlameResult = {
    path,
    rev: rev ?? "HEAD",
    lines,
    truncated,
  };

  if (!truncated) {
    const content = lines.map((l) => l.content).join("\n");
    const highlighted = await highlightFile(content, path);
    if (highlighted) {
      result.highlightedHtml = highlighted.html;
      result.highlightedLanguage = highlighted.language;
      if (highlighted.truncated) result.truncated = true;
    }
  }

  return result;
}

async function resolveCommit(cwd: string, rev: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(cwd, [
      "rev-parse",
      "--verify",
      `${rev}^{commit}`,
    ]);
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Parse `git blame --porcelain`: a header `<sha> <origLine> <finalLine>
 * [<count>]` starts each line entry; the full commit metadata (author,
 * author-time, summary) appears only the first time a commit is seen, so it is
 * accumulated into a per-sha map and read back when emitting each line.
 */
function parseBlamePorcelain(stdout: string): GitBlameLine[] {
  const rows = stdout.split("\n");
  const meta = new Map<
    string,
    { author: string; authorTime: string; summary: string }
  >();
  const out: GitBlameLine[] = [];

  let curSha: string | null = null;
  let curFinalLine = 0;

  for (const row of rows) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(row);
    if (header?.[1] && header[2]) {
      curSha = header[1];
      curFinalLine = Number.parseInt(header[2], 10);
      if (!meta.has(curSha)) {
        meta.set(curSha, { author: "", authorTime: "", summary: "" });
      }
      continue;
    }
    if (curSha === null) continue;

    const entry = meta.get(curSha);
    if (entry) {
      if (row.startsWith("author ")) {
        entry.author = row.slice("author ".length);
      } else if (row.startsWith("author-time ")) {
        entry.authorTime = epochToIso(row.slice("author-time ".length));
      } else if (row.startsWith("summary ")) {
        entry.summary = row.slice("summary ".length);
      }
    }

    if (row.startsWith("\t")) {
      const m = entry ?? { author: "", authorTime: "", summary: "" };
      out.push({
        line: curFinalLine,
        sha: curSha,
        shortSha: curSha.slice(0, 7),
        author: m.author,
        authorTime: m.authorTime,
        summary: m.summary,
        content: row.slice(1),
        uncommitted: /^0+$/.test(curSha),
      });
      curSha = null;
    }
  }

  return out;
}

function epochToIso(value: string): string {
  const seconds = Number.parseInt(value, 10);
  if (!Number.isFinite(seconds)) return "";
  return new Date(seconds * 1000).toISOString();
}
