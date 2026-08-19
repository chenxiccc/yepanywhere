import type {
  GitDiffPreviewSkipped,
  GitDiffResult,
  PatchHunk,
} from "@yep-anywhere/shared";

/**
 * Budgets shared by the working-tree diff (`git-status.ts`) and the commit
 * diff (`git-browse.ts`): a preview above these is omitted rather than
 * rendered.
 *
 * The budgets measure the *diff*, not the file it came from. Rendering cost is
 * proportional to the hunk lines we highlight and ship, so a three-line change
 * inside a large file previews normally and only an unreasonable diff — or a
 * file too big to diff at all — is skipped.
 */

/** Plain hunk-content budget above which a preview is omitted. */
export const GIT_DIFF_PREVIEW_MAX_DIFF_CHARS = 16 * 1024 * 1024;
/** Hunk-line budget above which browser layout is omitted. */
export const GIT_DIFF_PREVIEW_MAX_DIFF_LINES = 20_000;
/** Per-line character budget above which a preview is omitted. */
export const GIT_DIFF_PREVIEW_MAX_LINE_CHARS = 20_000;
/** Hunk-content budget above which syntax highlighting is omitted. */
export const GIT_DIFF_PREVIEW_MAX_HIGHLIGHT_CHARS = 32 * 1024;
/** Highlighted HTML budget above which the plain projection is used. */
export const GIT_DIFF_PREVIEW_MAX_HTML_CHARS = 1_000_000;
/** Whole-document Markdown budget, independent of the plain diff budget. */
export const GIT_DIFF_PREVIEW_MAX_MARKDOWN_CHARS = 256 * 1024;
/**
 * Source ceiling above which we decline to diff at all. This bounds only the
 * diff computation and the strings it holds — highlighting is proportional to
 * the hunks — so it sits far above the rendered budget.
 */
export const GIT_DIFF_PREVIEW_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/**
 * Guard the diff computation itself, before `structuredPatch` runs. Returns
 * the bounded skip metadata, or null when the source is worth diffing.
 */
export function getSourceDiffPreviewSkip(
  oldContent: string,
  newContent: string,
): GitDiffPreviewSkipped | null {
  const totalBytes =
    Buffer.byteLength(oldContent, "utf8") +
    Buffer.byteLength(newContent, "utf8");

  if (totalBytes <= GIT_DIFF_PREVIEW_MAX_TOTAL_BYTES) return null;

  return {
    reason: "content-too-large",
    totalBytes,
    maxTotalBytes: GIT_DIFF_PREVIEW_MAX_TOTAL_BYTES,
    maxLineCharsLimit: GIT_DIFF_PREVIEW_MAX_LINE_CHARS,
  };
}

/**
 * The skip reported when diffing aborted on its time budget — the file is
 * small enough to read but too thoroughly rewritten to diff.
 */
export function abortedDiffPreviewSkip(
  oldContent: string,
  newContent: string,
): GitDiffPreviewSkipped {
  return {
    reason: "content-too-large",
    totalBytes:
      Buffer.byteLength(oldContent, "utf8") +
      Buffer.byteLength(newContent, "utf8"),
    maxTotalBytes: GIT_DIFF_PREVIEW_MAX_TOTAL_BYTES,
    maxLineCharsLimit: GIT_DIFF_PREVIEW_MAX_LINE_CHARS,
  };
}

export interface PatchPreviewMetrics {
  totalChars: number;
  totalLines: number;
  maxLineChars: number;
}

/** Measure the source text represented by the rendered hunks. */
export function measurePatchPreview(hunks: PatchHunk[]): PatchPreviewMetrics {
  let totalChars = 0;
  let totalLines = 0;
  let maxLineChars = 0;

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      const chars = line.length > 0 ? line.length - 1 : 0;
      totalChars += chars;
      totalLines += 1;
      if (chars > maxLineChars) maxLineChars = chars;
    }
  }

  return { totalChars, totalLines, maxLineChars };
}

/** Guard the plain browser projection by characters, lines, and line length. */
export function getPatchPreviewSkip(
  metrics: PatchPreviewMetrics,
): GitDiffPreviewSkipped | null {
  const { totalChars, totalLines, maxLineChars } = metrics;

  if (
    totalChars > GIT_DIFF_PREVIEW_MAX_DIFF_CHARS ||
    totalLines > GIT_DIFF_PREVIEW_MAX_DIFF_LINES
  ) {
    return {
      reason: "content-too-large",
      totalChars,
      totalLines,
      maxLineChars,
      maxTotalChars: GIT_DIFF_PREVIEW_MAX_DIFF_CHARS,
      maxTotalLines: GIT_DIFF_PREVIEW_MAX_DIFF_LINES,
      maxLineCharsLimit: GIT_DIFF_PREVIEW_MAX_LINE_CHARS,
    };
  }

  if (maxLineChars > GIT_DIFF_PREVIEW_MAX_LINE_CHARS) {
    return {
      reason: "line-too-long",
      totalChars,
      totalLines,
      maxLineChars,
      maxTotalChars: GIT_DIFF_PREVIEW_MAX_DIFF_CHARS,
      maxTotalLines: GIT_DIFF_PREVIEW_MAX_DIFF_LINES,
      maxLineCharsLimit: GIT_DIFF_PREVIEW_MAX_LINE_CHARS,
    };
  }

  return null;
}

/** The empty {@link GitDiffResult} carrying only the skip metadata. */
export function skippedGitDiffResult(
  previewSkipped: GitDiffPreviewSkipped,
): GitDiffResult {
  return {
    diffHtml: "",
    structuredPatch: [],
    previewSkipped,
  };
}

export function skippedBinaryGitDiffResult(totalBytes?: number): GitDiffResult {
  return skippedGitDiffResult({
    reason: "binary",
    ...(totalBytes === undefined ? {} : { totalBytes }),
  });
}
