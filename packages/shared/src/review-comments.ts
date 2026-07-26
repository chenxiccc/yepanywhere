import type { PatchHunk } from "./types.js";

/**
 * Source-review draft comments (topic: source-review-to-session).
 *
 * A reviewer clicks a diff line and leaves a comment; comments accumulate as
 * server-owned drafts in `{projectPath}/.yep/review-comments.json` until
 * "submit review" drains the pending set into an agent session. This module is
 * the wire/persistence contract shared by client and server: the anchor model,
 * a defensive parser (the file outlives bundle versions and is user-visible on
 * disk), and the pure `anchorFromPatch` helper that turns a clicked diff line
 * into an anchor from `structuredPatch` alone — never from the DOM.
 */

export const REVIEW_COMMENTS_FILE_VERSION = 1 as const;

/** Bounds — the file is user-visible on disk and must reject hostile shapes. */
export const MAX_REVIEW_COMMENTS = 2000;
export const MAX_REVIEW_BATCHES = 2000;
export const MAX_REVIEW_COMMENT_TEXT_LENGTH = 20000;
export const MAX_REVIEW_SNIPPET_LENGTH = 8000;
export const MAX_REVIEW_PATH_LENGTH = 4096;

/** How many neighbouring diff lines flank the clicked line in the snippet. */
export const DEFAULT_SNIPPET_CONTEXT_RADIUS = 3;

/**
 * Which side of the diff a commented line belongs to. A removed line is
 * `"old"` (gone from the current tree → its SHA is always cited); an added
 * line is `"new"`. A context line exists on both sides — the clicked column
 * decides, defaulting to `"new"` since it is present in the current tree.
 */
export type ReviewCommentSide = "old" | "new";

/**
 * The revision the anchor's line numbers and snippet were captured against.
 * `sha` covers a reviewed commit, a blame origin, or HEAD-at-comment-time;
 * `uncommitted` is a working-tree change with no SHA, timestamped instead.
 */
export type ReviewCommentRevision =
  | { kind: "sha"; sha: string }
  | { kind: "uncommitted"; savedAt: string };

export interface ReviewCommentAnchor {
  /** Repo-relative path of the file the commented line lives in. */
  path: string;
  /** Revision the line numbers and snippet were captured against. */
  revision: ReviewCommentRevision;
  /** Which side of the diff was clicked (see {@link ReviewCommentSide}). */
  side: ReviewCommentSide;
  /**
   * 1-based line number in the old file, or null when the line is purely
   * added. `newLine === null` marks a removed line (gone from the tree).
   */
  oldLine: number | null;
  /**
   * 1-based line number in the new file, or null when the line is purely
   * removed. Used as the primary relocation target for lines still in the tree.
   */
  newLine: number | null;
  /**
   * The clicked line plus a little surrounding diff context, prefixes
   * stripped and newline-joined. Fuels fuzzy relocation and inline display in
   * the seeded turn.
   */
  snippet: string;
}

export type ReviewCommentStatus = "pending" | "archived";

export interface ReviewComment {
  /** Stable id, assigned by the server on creation. */
  id: string;
  anchor: ReviewCommentAnchor;
  /** The reviewer's comment text. */
  text: string;
  /** `pending` until a submit consumes it, then `archived`. */
  status: ReviewCommentStatus;
  /** ISO 8601 creation time. */
  createdAt: string;
  /** ISO 8601 time the comment was consumed into a batch (archived only). */
  archivedAt?: string;
  /** Batch this comment was consumed by (archived only). */
  batchId?: string;
  /** Session the batch was delivered to (archived only). */
  targetSessionId?: string;
}

/** A consumed submit: the pending comments drained into one review turn. */
export interface ReviewBatch {
  id: string;
  /** ISO 8601 submit time. */
  submittedAt: string;
  /** Session the review turn went to. */
  targetSessionId: string;
  /** Comments consumed by this batch. */
  commentIds: string[];
}

export interface ReviewCommentsFile {
  version: typeof REVIEW_COMMENTS_FILE_VERSION;
  comments: ReviewComment[];
  batches: ReviewBatch[];
}

export function emptyReviewCommentsFile(): ReviewCommentsFile {
  return {
    version: REVIEW_COMMENTS_FILE_VERSION,
    comments: [],
    batches: [],
  };
}

function isIsoLikeString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}

function parseRevision(value: unknown): ReviewCommentRevision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "sha") {
    if (typeof record.sha !== "string" || !/^[0-9a-f]{7,64}$/i.test(record.sha))
      return null;
    return { kind: "sha", sha: record.sha };
  }
  if (record.kind === "uncommitted") {
    if (!isIsoLikeString(record.savedAt)) return null;
    return { kind: "uncommitted", savedAt: record.savedAt };
  }
  return null;
}

function parseOptionalLine(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return value;
  }
  return undefined; // signals invalid
}

/**
 * Validate an anchor from the wire (the client sends one when creating a
 * comment) or from disk. Returns a normalized anchor or null — the single
 * validation entry point shared by the parser and the create-comment route.
 */
export function parseReviewCommentAnchor(
  value: unknown,
): ReviewCommentAnchor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  if (
    typeof record.path !== "string" ||
    record.path.length === 0 ||
    record.path.length > MAX_REVIEW_PATH_LENGTH
  ) {
    return null;
  }
  const revision = parseRevision(record.revision);
  if (!revision) return null;
  if (record.side !== "old" && record.side !== "new") return null;

  const oldLine = parseOptionalLine(record.oldLine);
  const newLine = parseOptionalLine(record.newLine);
  if (oldLine === undefined || newLine === undefined) return null;
  // A line must exist on at least one side.
  if (oldLine === null && newLine === null) return null;

  if (
    typeof record.snippet !== "string" ||
    record.snippet.length > MAX_REVIEW_SNIPPET_LENGTH
  ) {
    return null;
  }

  return {
    path: record.path,
    revision,
    side: record.side,
    oldLine,
    newLine,
    snippet: record.snippet,
  };
}

function parseComment(value: unknown): ReviewComment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  if (typeof record.id !== "string" || record.id.length === 0) return null;
  const anchor = parseReviewCommentAnchor(record.anchor);
  if (!anchor) return null;
  if (
    typeof record.text !== "string" ||
    record.text.length > MAX_REVIEW_COMMENT_TEXT_LENGTH
  ) {
    return null;
  }
  if (record.status !== "pending" && record.status !== "archived") return null;
  if (!isIsoLikeString(record.createdAt)) return null;

  const comment: ReviewComment = {
    id: record.id,
    anchor,
    text: record.text,
    status: record.status,
    createdAt: record.createdAt,
  };

  if (record.status === "archived") {
    if (record.archivedAt !== undefined) {
      if (!isIsoLikeString(record.archivedAt)) return null;
      comment.archivedAt = record.archivedAt;
    }
    if (record.batchId !== undefined) {
      if (typeof record.batchId !== "string") return null;
      comment.batchId = record.batchId;
    }
    if (record.targetSessionId !== undefined) {
      if (typeof record.targetSessionId !== "string") return null;
      comment.targetSessionId = record.targetSessionId;
    }
  }

  return comment;
}

function parseBatch(value: unknown): ReviewBatch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  if (!isIsoLikeString(record.submittedAt)) return null;
  if (typeof record.targetSessionId !== "string") return null;
  if (!Array.isArray(record.commentIds)) return null;
  const commentIds: string[] = [];
  for (const entry of record.commentIds) {
    if (typeof entry !== "string") return null;
    commentIds.push(entry);
  }
  return {
    id: record.id,
    submittedAt: record.submittedAt,
    targetSessionId: record.targetSessionId,
    commentIds,
  };
}

/**
 * Parse the persisted `.yep/review-comments.json` shape defensively. Garbage,
 * truncated, or wrong-version files reject to an empty store rather than
 * throwing — a malformed draft file must never wedge the review surface. A
 * single malformed comment/batch drops that entry, not the whole file.
 */
export function parseReviewCommentsFile(value: unknown): ReviewCommentsFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return emptyReviewCommentsFile();
  }
  const record = value as Record<string, unknown>;
  if (record.version !== REVIEW_COMMENTS_FILE_VERSION) {
    return emptyReviewCommentsFile();
  }

  const comments: ReviewComment[] = [];
  if (Array.isArray(record.comments)) {
    const seen = new Set<string>();
    for (const raw of record.comments) {
      if (comments.length >= MAX_REVIEW_COMMENTS) break;
      const comment = parseComment(raw);
      if (comment && !seen.has(comment.id)) {
        seen.add(comment.id);
        comments.push(comment);
      }
    }
  }

  const batches: ReviewBatch[] = [];
  if (Array.isArray(record.batches)) {
    const seen = new Set<string>();
    for (const raw of record.batches) {
      if (batches.length >= MAX_REVIEW_BATCHES) break;
      const batch = parseBatch(raw);
      if (batch && !seen.has(batch.id)) {
        seen.add(batch.id);
        batches.push(batch);
      }
    }
  }

  return { version: REVIEW_COMMENTS_FILE_VERSION, comments, batches };
}

/** The line-geometry an anchor derives from a clicked diff line. */
export interface PatchLineLocation {
  side: ReviewCommentSide;
  oldLine: number | null;
  newLine: number | null;
  snippet: string;
}

/**
 * Total real diff lines across all hunks — the domain of the flat line index.
 * Hunk headers are not counted (they carry no `data-diff-line`).
 */
export function patchLineCount(hunks: PatchHunk[]): number {
  let total = 0;
  for (const hunk of hunks) total += hunk.lines.length;
  return total;
}

/**
 * Invert the flat line index (see the P1↔P2 contract in task 046 / the topic
 * doc) into a diff-line anchor, using only `structuredPatch` data — the Shiki
 * HTML stays presentation-only, so anchoring is testable without a browser and
 * cannot drift from what is displayed.
 *
 * The flat index enumerates every hunk's `lines` in order, skipping hunk
 * headers. `contextSide` decides the side for a context line (both sides
 * exist); removed/added lines ignore it.
 */
export function anchorFromPatch(
  hunks: PatchHunk[],
  flatIndex: number,
  contextRadius = DEFAULT_SNIPPET_CONTEXT_RADIUS,
  contextSide: ReviewCommentSide = "new",
): PatchLineLocation | null {
  if (!Number.isInteger(flatIndex) || flatIndex < 0) return null;

  let acc = 0;
  for (const hunk of hunks) {
    if (flatIndex < acc + hunk.lines.length) {
      return locateInHunk(hunk, flatIndex - acc, contextRadius, contextSide);
    }
    acc += hunk.lines.length;
  }
  return null;
}

function locateInHunk(
  hunk: PatchHunk,
  within: number,
  contextRadius: number,
  contextSide: ReviewCommentSide,
): PatchLineLocation {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (let i = 0; i < within; i++) {
    const prefix = hunk.lines[i]?.[0];
    if (prefix === "-") oldLine++;
    else if (prefix === "+") newLine++;
    else {
      oldLine++;
      newLine++;
    }
  }

  const prefix = hunk.lines[within]?.[0];
  let side: ReviewCommentSide;
  let resolvedOld: number | null;
  let resolvedNew: number | null;
  if (prefix === "-") {
    side = "old";
    resolvedOld = oldLine;
    resolvedNew = null;
  } else if (prefix === "+") {
    side = "new";
    resolvedOld = null;
    resolvedNew = newLine;
  } else {
    // Context line: present on both sides; the clicked column decides.
    side = contextSide;
    resolvedOld = oldLine;
    resolvedNew = newLine;
  }

  return {
    side,
    oldLine: resolvedOld,
    newLine: resolvedNew,
    snippet: buildSnippet(hunk.lines, within, contextRadius),
  };
}

/** Clicked line ± radius, prefixes stripped, newline-joined, bounded. */
function buildSnippet(
  lines: string[],
  within: number,
  contextRadius: number,
): string {
  const start = Math.max(0, within - contextRadius);
  const end = Math.min(lines.length, within + contextRadius + 1);
  const out: string[] = [];
  for (let i = start; i < end; i++) {
    // Strip the leading ' '/'-'/'+' diff prefix.
    out.push((lines[i] ?? "").slice(1));
  }
  return out.join("\n").slice(0, MAX_REVIEW_SNIPPET_LENGTH);
}
