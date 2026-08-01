/**
 * Relocate source-review anchors against the current tree (topic:
 * source-review-to-session).
 *
 * Drafts live for hours or days while agents keep committing, so a comment's
 * anchor drifts: its line moves, changes, or vanishes. At submit time each
 * anchor is relocated against the working tree — find the clicked line by
 * content (nearest to its recorded position), else declare it gone. A removed
 * (`-`-side) line is gone by definition; its SHA is cited. Blame gives a
 * relocated line its current commit, so an `uncommitted` anchor whose change
 * has since been committed acquires that SHA.
 *
 * Uses git plumbing but is a standalone module (no routes) — the submit
 * endpoint (P5) is thin glue over this. Tested against a fixture repo.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  DEFAULT_SNIPPET_CONTEXT_RADIUS,
  MAX_REVIEW_SNIPPET_LENGTH,
  type ReviewCommentAnchor,
} from "@yep-anywhere/shared";
import {
  repositoryFilePathIfExists,
  repositoryRelativePath,
} from "./repositoryPath.js";

const execFileAsync = promisify(execFile);

export interface RelocatedAnchor {
  status: "relocated";
  path: string;
  /** Current 1-based line number of the clicked line. */
  line: number;
  /** Refreshed context read from the current file. */
  snippet: string;
  /** Blame SHA of the relocated line, or null if it is uncommitted in the tree. */
  currentSha: string | null;
  /** True when the line relocated away from its recorded number. */
  moved: boolean;
}

export interface GoneAnchor {
  status: "gone";
  path: string;
  /** SHA to cite so the agent can find the historical line, when known. */
  citeSha: string | null;
  /** The original snippet (historical context — the line is gone now). */
  snippet: string;
}

export type AnchorRelocation = RelocatedAnchor | GoneAnchor;

function normalize(line: string): string {
  return line.replace(/\s+$/u, "");
}

function anchorSha(anchor: ReviewCommentAnchor): string | null {
  return anchor.revision.kind === "sha" ? anchor.revision.sha : null;
}

/** Relocate one anchor against `projectPath`'s working tree. */
export async function relocateAnchor(
  projectPath: string,
  anchor: ReviewCommentAnchor,
): Promise<AnchorRelocation> {
  const safePath = repositoryRelativePath(anchor.path);
  const citeSha = anchorSha(anchor);

  // A `-`-side line is about code no longer in the new tree — gone by
  // definition, SHA implied.
  if (anchor.newLine === null) {
    return {
      status: "gone",
      path: safePath,
      citeSha,
      snippet: anchor.snippet,
    };
  }

  const filePath = await repositoryFilePathIfExists(projectPath, safePath);
  if (!filePath) {
    return {
      status: "gone",
      path: safePath,
      citeSha,
      snippet: anchor.snippet,
    };
  }
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return {
      status: "gone",
      path: safePath,
      citeSha,
      snippet: anchor.snippet,
    };
  }

  const lines = content.split("\n");
  const snippetLines = anchor.snippet.split("\n");
  const offset = Math.min(
    Math.max(0, anchor.snippetAnchorOffset ?? 0),
    Math.max(0, snippetLines.length - 1),
  );
  const target = normalize(snippetLines[offset] ?? "");

  const candidates: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (normalize(lines[i] ?? "") === target) candidates.push(i + 1);
  }
  if (candidates.length === 0) {
    return {
      status: "gone",
      path: anchor.path,
      citeSha,
      snippet: anchor.snippet,
    };
  }

  // Prefer the occurrence nearest the recorded line — the common case is
  // "unchanged" (exact hit) or "shifted by an edit above" (small delta).
  const recorded = anchor.newLine;
  let best = candidates[0] as number;
  for (const line of candidates) {
    if (Math.abs(line - recorded) < Math.abs(best - recorded)) best = line;
  }

  return {
    status: "relocated",
    path: safePath,
    line: best,
    snippet: refreshSnippet(lines, best),
    currentSha: await blameSha(projectPath, safePath, best),
    moved: best !== recorded,
  };
}

/** Each relocation can spawn a `git blame`; keep the process fan-out sane. */
const RELOCATE_CONCURRENCY = 8;

export async function relocateAnchors(
  projectPath: string,
  anchors: ReviewCommentAnchor[],
): Promise<AnchorRelocation[]> {
  const results: AnchorRelocation[] = new Array(anchors.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      const anchor = anchors[index];
      if (anchor === undefined) return;
      results[index] = await relocateAnchor(projectPath, anchor);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(RELOCATE_CONCURRENCY, anchors.length) },
      worker,
    ),
  );
  return results;
}

/** ±radius lines of current-file context around `line1` (1-based). */
function refreshSnippet(
  lines: string[],
  line1: number,
  radius = DEFAULT_SNIPPET_CONTEXT_RADIUS,
): string {
  const idx = line1 - 1;
  const start = Math.max(0, idx - radius);
  const end = Math.min(lines.length, idx + radius + 1);
  return lines.slice(start, end).join("\n").slice(0, MAX_REVIEW_SNIPPET_LENGTH);
}

/**
 * Blame a single line in the working tree. Returns the originating commit SHA,
 * or null when the line is not yet committed (blame reports all-zeros) or blame
 * fails. Best-effort — provenance, never correctness-critical.
 */
async function blameSha(
  projectPath: string,
  path: string,
  line: number,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        projectPath,
        "blame",
        "-L",
        `${line},${line}`,
        "--porcelain",
        "--",
        path,
      ],
      { timeout: 5000 },
    );
    const sha = stdout.split(/\s/u)[0] ?? "";
    if (!/^[0-9a-f]{7,40}$/u.test(sha) || /^0+$/u.test(sha)) return null;
    return sha;
  } catch {
    return null;
  }
}
