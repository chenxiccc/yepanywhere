import { extname } from "node:path";
import type { GitDiffResult } from "@yep-anywhere/shared";
import {
  computeEditDiffHtml,
  computeEditPatch,
} from "../augments/edit-augments.js";
import { renderMarkdownToHtml } from "../augments/markdown-augments.js";
import { decodeLikelyUtf8Text } from "../utils/utf8Text.js";
import {
  abortedDiffPreviewSkip,
  GIT_DIFF_PREVIEW_MAX_DIFF_CHARS,
  getPatchPreviewSkip,
  getSourceDiffPreviewSkip,
  skippedBinaryGitDiffResult,
  skippedGitDiffResult,
} from "./diffPreviewGuards.js";

export interface BuildGitDiffResultInput {
  path: string;
  oldContent: string;
  newContent: string;
  fullContext?: boolean;
  ignoreWhitespace?: boolean;
}

export interface BuildGitDiffResultFromBytesInput
  extends Omit<BuildGitDiffResultInput, "oldContent" | "newContent"> {
  oldContent: Uint8Array;
  newContent: Uint8Array;
}

/**
 * Build every Source Control diff through one renderer and preview policy.
 *
 * The patch is computed first and guarded second, so the decision to render is
 * made against the diff we would actually ship rather than the size of the file
 * it came from. `fullContext` folds into the same rule: asking for the whole
 * file makes the whole file the diff, so a large one is declined here.
 */
export async function buildGitDiffResult(
  input: BuildGitDiffResultInput,
): Promise<GitDiffResult> {
  const sourceSkip = getSourceDiffPreviewSkip(
    input.oldContent,
    input.newContent,
  );
  if (sourceSkip) return skippedGitDiffResult(sourceSkip);

  const editInput = {
    file_path: input.path,
    old_string: input.oldContent,
    new_string: input.newContent,
  };
  const hunks = computeEditPatch(editInput, input.fullContext ? 999999 : 3, {
    ignoreWhitespace: input.ignoreWhitespace,
  });
  if (hunks === null) {
    return skippedGitDiffResult(
      abortedDiffPreviewSkip(input.oldContent, input.newContent),
    );
  }

  const patchSkip = getPatchPreviewSkip(hunks);
  if (patchSkip) return skippedGitDiffResult(patchSkip);

  const result: GitDiffResult = {
    diffHtml: await computeEditDiffHtml(editInput, hunks),
    structuredPatch: hunks,
  };

  const ext = extname(input.path).toLowerCase();
  if (
    (ext === ".md" || ext === ".markdown") &&
    input.newContent &&
    // Unlike the diff, a markdown preview renders the whole file.
    input.newContent.length <= GIT_DIFF_PREVIEW_MAX_DIFF_CHARS
  ) {
    try {
      result.markdownHtml = await renderMarkdownToHtml(input.newContent);
    } catch {
      // Markdown preview is optional; the source diff remains usable.
    }
  }

  return result;
}

/**
 * Classify raw file versions before constructing a text diff. This catches
 * malformed UTF-8 and control-heavy content even when Git attributes force a
 * file through its text diff path.
 */
export async function buildGitDiffResultFromBytes(
  input: BuildGitDiffResultFromBytesInput,
): Promise<GitDiffResult> {
  const totalBytes = input.oldContent.length + input.newContent.length;
  const oldContent = decodeLikelyUtf8Text(input.oldContent);
  const newContent = decodeLikelyUtf8Text(input.newContent);
  if (oldContent === null || newContent === null) {
    return skippedBinaryGitDiffResult(totalBytes);
  }

  return buildGitDiffResult({
    ...input,
    oldContent,
    newContent,
  });
}
