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

/** Rendered hunk-content budget (characters) above which a preview is omitted. */
export const GIT_DIFF_PREVIEW_MAX_DIFF_CHARS = 256 * 1024;
/** Per-line character budget above which a preview is omitted. */
export const GIT_DIFF_PREVIEW_MAX_LINE_CHARS = 20_000;
/**
 * Source ceiling above which we decline to diff at all. This bounds only the
 * diff computation and the strings it holds — highlighting is proportional to
 * the hunks — so it sits far above the rendered budget.
 */
export const GIT_DIFF_PREVIEW_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

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

/**
 * Guard what we actually render, measured across the hunk lines: their total
 * content and the longest single line. Line prefixes (` `, `-`, `+`) are
 * excluded so the numbers describe source text.
 */
export function getPatchPreviewSkip(
  hunks: PatchHunk[],
): GitDiffPreviewSkipped | null {
  let totalChars = 0;
  let maxLineChars = 0;

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      const chars = line.length > 0 ? line.length - 1 : 0;
      totalChars += chars;
      if (chars > maxLineChars) maxLineChars = chars;
    }
  }

  if (totalChars > GIT_DIFF_PREVIEW_MAX_DIFF_CHARS) {
    return {
      reason: "content-too-large",
      totalBytes: totalChars,
      maxLineChars,
      maxTotalBytes: GIT_DIFF_PREVIEW_MAX_DIFF_CHARS,
      maxLineCharsLimit: GIT_DIFF_PREVIEW_MAX_LINE_CHARS,
    };
  }

  if (maxLineChars > GIT_DIFF_PREVIEW_MAX_LINE_CHARS) {
    return {
      reason: "line-too-long",
      totalBytes: totalChars,
      maxLineChars,
      maxTotalBytes: GIT_DIFF_PREVIEW_MAX_DIFF_CHARS,
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
