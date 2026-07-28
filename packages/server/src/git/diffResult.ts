import { extname } from "node:path";
import type { GitDiffResult } from "@yep-anywhere/shared";
import { computeEditAugment } from "../augments/edit-augments.js";
import { renderMarkdownToHtml } from "../augments/markdown-augments.js";
import {
  getDiffPreviewSkip,
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
