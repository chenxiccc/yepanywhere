import { extname } from "node:path";
import type { GitDiffResult } from "@yep-anywhere/shared";
import { computeEditAugment } from "../augments/edit-augments.js";
import { renderMarkdownToHtml } from "../augments/markdown-augments.js";
import { decodeLikelyUtf8Text } from "../utils/utf8Text.js";
import {
  getDiffPreviewSkip,
  skippedBinaryGitDiffResult,
  skippedGitDiffResult,
} from "./diffPreviewGuards.js";

export interface BuildGitDiffResultInput {
  toolUseId: string;
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

/** Build every Source Control diff through one renderer and preview policy. */
export async function buildGitDiffResult(
  input: BuildGitDiffResultInput,
): Promise<GitDiffResult> {
  const previewSkip = getDiffPreviewSkip(input.oldContent, input.newContent);
  if (previewSkip) return skippedGitDiffResult(previewSkip);

  const augment = await computeEditAugment(
    input.toolUseId,
    {
      file_path: input.path,
      old_string: input.oldContent,
      new_string: input.newContent,
    },
    input.fullContext ? 999999 : 3,
    { ignoreWhitespace: input.ignoreWhitespace },
  );
  const result: GitDiffResult = {
    diffHtml: augment.diffHtml,
    structuredPatch: augment.structuredPatch,
  };

  const ext = extname(input.path).toLowerCase();
  if ((ext === ".md" || ext === ".markdown") && input.newContent) {
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
