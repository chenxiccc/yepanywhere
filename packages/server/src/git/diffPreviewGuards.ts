import type {
  GitDiffPreviewSkipped,
  GitDiffResult,
} from "@yep-anywhere/shared";

/**
 * Byte/line-length guards shared by the working-tree diff (`git-status.ts`)
 * and the commit diff (`git-browse.ts`): a preview above these budgets is
 * omitted rather than rendered, because highlighting a huge or single-giant-
 * line file is slow and can wedge the client.
 */

/** Source-content byte budget (old+new) above which a preview is omitted. */
export const GIT_DIFF_PREVIEW_MAX_TOTAL_BYTES = 256 * 1024;
/** Per-line character budget above which a preview is omitted. */
export const GIT_DIFF_PREVIEW_MAX_LINE_CHARS = 20_000;

/** Longest line in `content`, measured in JavaScript string characters. */
export function longestLineChars(content: string): number {
  let longest = 0;
  let current = 0;

  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10) {
      longest = Math.max(longest, current);
      current = 0;
    } else {
      current++;
    }
  }

  return Math.max(longest, current);
}

/**
 * Decide whether a diff of `oldContent`→`newContent` is unsafe to render,
 * returning the bounded skip metadata, or null when it is fine to render.
 */
export function getDiffPreviewSkip(
  oldContent: string,
  newContent: string,
): GitDiffPreviewSkipped | null {
  const oldBytes = Buffer.byteLength(oldContent, "utf8");
  const newBytes = Buffer.byteLength(newContent, "utf8");
  const totalBytes = oldBytes + newBytes;
  const maxLineChars = Math.max(
    longestLineChars(oldContent),
    longestLineChars(newContent),
  );

  if (totalBytes > GIT_DIFF_PREVIEW_MAX_TOTAL_BYTES) {
    return {
      reason: "content-too-large",
      totalBytes,
      maxLineChars,
      maxTotalBytes: GIT_DIFF_PREVIEW_MAX_TOTAL_BYTES,
      maxLineCharsLimit: GIT_DIFF_PREVIEW_MAX_LINE_CHARS,
    };
  }

  if (maxLineChars > GIT_DIFF_PREVIEW_MAX_LINE_CHARS) {
    return {
      reason: "line-too-long",
      totalBytes,
      maxLineChars,
      maxTotalBytes: GIT_DIFF_PREVIEW_MAX_TOTAL_BYTES,
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
