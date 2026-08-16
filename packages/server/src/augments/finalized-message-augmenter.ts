import {
  computeEditAugment,
  computeStructuredPatchDiffHtml,
} from "./edit-augments.js";
import {
  extractRawPatchFromEditInput,
  parseRawEditPatch,
} from "./edit-raw-patch.js";
import {
  augmentTextBlocks,
  renderMarkdownToHtml,
} from "./markdown-augments.js";
import { getMessageContent } from "./message-utils.js";
import { resolveProjectPathTextLinks } from "./project-path-links.js";
import { computeReadAugment } from "./read-augments.js";
import type { SafeMarkdownRenderOptions } from "./safe-markdown.js";
import type {
  EditInputWithAugment,
  ExitPlanModeInput,
  ExitPlanModeResult,
  ReadResultWithAugment,
  WriteInputWithAugment,
} from "./types.js";
import { computeWriteAugment } from "./write-augments.js";

export type FinalizedMessageAugmentErrorHandler = (
  error: unknown,
  context: string,
) => void;

export interface FinalizedMessageAugmentOptions {
  onError?: FinalizedMessageAugmentErrorHandler;
  safeMarkdownOptions?: SafeMarkdownRenderOptions;
}

function reportError(
  onError: FinalizedMessageAugmentErrorHandler | undefined,
  error: unknown,
  context: string,
): void {
  onError?.(error, context);
}

export async function augmentEditToolUsesInMessage(
  message: Record<string, unknown>,
  onError?: FinalizedMessageAugmentErrorHandler,
): Promise<void> {
  if (message.type !== "assistant") return;

  const content = getMessageContent(message);
  if (!content) return;

  for (const block of content) {
    if (
      typeof block !== "object" ||
      block === null ||
      (block as Record<string, unknown>).type !== "tool_use" ||
      (block as Record<string, unknown>).name !== "Edit"
    ) {
      continue;
    }

    const toolUseBlock = block as Record<string, unknown>;
    const rawInput = toolUseBlock.input;
    const input =
      typeof rawInput === "object" &&
      rawInput !== null &&
      !Array.isArray(rawInput)
        ? (rawInput as EditInputWithAugment)
        : undefined;

    if (
      typeof toolUseBlock.id === "string" &&
      typeof input?.file_path === "string" &&
      typeof input.old_string === "string" &&
      typeof input.new_string === "string" &&
      !input._structuredPatch
    ) {
      try {
        const augment = await computeEditAugment(toolUseBlock.id, {
          file_path: input.file_path,
          old_string: input.old_string,
          new_string: input.new_string,
        });
        input._structuredPatch = augment.structuredPatch;
        input._diffHtml = augment.diffHtml;
      } catch (error) {
        reportError(onError, error, "Failed to compute edit augment");
      }
      continue;
    }

    const rawPatch = extractRawPatchFromEditInput(rawInput);
    if (!rawPatch) continue;

    const targetInput =
      input ??
      ({
        file_path: "",
        old_string: "",
        new_string: "",
      } as EditInputWithAugment);

    if (!input) {
      toolUseBlock.input = targetInput;
    }
    targetInput._rawPatch ||= rawPatch;

    const parsedPatch = parseRawEditPatch(rawPatch);
    if (!parsedPatch) continue;

    if (!targetInput.file_path && parsedPatch.filePath) {
      targetInput.file_path = parsedPatch.filePath;
    }
    if (
      !targetInput._structuredPatch &&
      parsedPatch.structuredPatch.length > 0
    ) {
      targetInput._structuredPatch = parsedPatch.structuredPatch;
    }
    if (
      targetInput._diffHtml ||
      !targetInput._structuredPatch ||
      targetInput._structuredPatch.length === 0
    ) {
      continue;
    }

    try {
      const diffHtml = await computeStructuredPatchDiffHtml(
        targetInput.file_path || parsedPatch.filePath || "",
        targetInput._structuredPatch,
      );
      if (diffHtml) {
        targetInput._diffHtml = diffHtml;
      }
    } catch (error) {
      reportError(onError, error, "Failed to compute raw patch edit augment");
    }
  }
}

export async function augmentWriteToolUsesInMessage(
  message: Record<string, unknown>,
  onError?: FinalizedMessageAugmentErrorHandler,
): Promise<void> {
  if (message.type !== "assistant") return;

  const content = getMessageContent(message);
  if (!content) return;

  for (const block of content) {
    if (
      typeof block !== "object" ||
      block === null ||
      (block as Record<string, unknown>).type !== "tool_use" ||
      (block as Record<string, unknown>).name !== "Write"
    ) {
      continue;
    }

    const input = (block as Record<string, unknown>)
      .input as WriteInputWithAugment;
    if (
      typeof input?.file_path !== "string" ||
      typeof input.content !== "string" ||
      input._highlightedContentHtml
    ) {
      continue;
    }

    try {
      const augment = await computeWriteAugment({
        file_path: input.file_path,
        content: input.content,
      });
      if (!augment) continue;
      input._highlightedContentHtml = augment.highlightedHtml;
      input._highlightedLanguage = augment.language;
      input._highlightedTruncated = augment.truncated;
      if (augment.renderedMarkdownHtml) {
        input._renderedMarkdownHtml = augment.renderedMarkdownHtml;
      }
    } catch (error) {
      reportError(onError, error, "Failed to compute write augment");
    }
  }
}

export async function augmentExitPlanModeAndReadResultsInMessage(
  message: Record<string, unknown>,
  onError?: FinalizedMessageAugmentErrorHandler,
): Promise<void> {
  if (message.type === "assistant") {
    const content = getMessageContent(message);
    if (!content) return;

    for (const block of content) {
      if (
        typeof block !== "object" ||
        block === null ||
        (block as Record<string, unknown>).type !== "tool_use" ||
        (block as Record<string, unknown>).name !== "ExitPlanMode"
      ) {
        continue;
      }
      const input = (block as Record<string, unknown>)
        .input as ExitPlanModeInput;
      if (!input?.plan || input._renderedHtml) continue;
      try {
        input._renderedHtml = await renderMarkdownToHtml(input.plan);
      } catch (error) {
        reportError(onError, error, "Failed to render ExitPlanMode plan HTML");
      }
    }
    return;
  }

  if (message.type !== "user") return;

  const result = (message.tool_use_result ?? message.toolUseResult) as
    | ExitPlanModeResult
    | undefined;
  if (result?.plan && !result._renderedHtml) {
    try {
      result._renderedHtml = await renderMarkdownToHtml(result.plan);
    } catch (error) {
      reportError(
        onError,
        error,
        "Failed to render ExitPlanMode result plan HTML",
      );
    }
  }

  const readResult = result as ReadResultWithAugment | undefined;
  if (
    readResult?.type !== "text" ||
    !readResult.file?.filePath ||
    !readResult.file.content ||
    readResult._highlightedContentHtml
  ) {
    return;
  }

  try {
    const augment = await computeReadAugment({
      file_path: readResult.file.filePath,
      content: readResult.file.content,
    });
    if (!augment) return;
    readResult._highlightedContentHtml = augment.highlightedHtml;
    readResult._highlightedLanguage = augment.language;
    readResult._highlightedTruncated = augment.truncated;
    if (augment.renderedMarkdownHtml) {
      readResult._renderedMarkdownHtml = augment.renderedMarkdownHtml;
    }
  } catch (error) {
    reportError(onError, error, "Failed to compute read augment");
  }
}

function isShellToolName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const normalized = name.toLowerCase();
  return (
    normalized === "bash" ||
    normalized === "exec_command" ||
    normalized === "shell_command"
  );
}

function getShellCommand(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (typeof record.command === "string") return record.command;
  return typeof record.cmd === "string" ? record.cmd : null;
}

function getUserPromptText(message: Record<string, unknown>): string | null {
  const innerMessage = message.message as Record<string, unknown> | undefined;
  const role = innerMessage?.role ?? message.role;
  if (message.type !== "user" && role !== "user") return null;

  const content = innerMessage?.content ?? message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const text = content
    .filter(
      (block): block is { text: string; type: "text" } =>
        !!block &&
        typeof block === "object" &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
  return text || null;
}

/**
 * Attach exact file targets to raw tool text without shipping a project path
 * corpus to the client. The field is optional so older servers and public
 * shares retain their existing plain-text behavior.
 */
export async function augmentProjectPathLinksInMessage(
  message: Record<string, unknown>,
  safeMarkdownOptions?: SafeMarkdownRenderOptions,
): Promise<void> {
  const projectLinks = safeMarkdownOptions?.projectFileLinks;
  if (!projectLinks?.index) return;
  const index = projectLinks.index;

  const content = getMessageContent(message);
  const resolveText = (text: string) =>
    resolveProjectPathTextLinks(text, {
      index,
      projectId: projectLinks.projectId,
      projectPath: projectLinks.projectPath,
      gateLookupsByShape: true,
      onUnversionedLookup: projectLinks.onUnversionedLookup,
      resolveAbsoluteFilePaths: projectLinks.resolveAbsoluteFilePaths,
    });

  const userPromptText = getUserPromptText(message);
  if (userPromptText !== null) {
    const targets = await resolveText(userPromptText);
    if (targets.length > 0) message._projectPathLinks = targets;
    else delete message._projectPathLinks;
  }

  if (!content) return;

  await Promise.all(
    content.map(async (rawBlock) => {
      if (!rawBlock || typeof rawBlock !== "object") return;
      const block = rawBlock as Record<string, unknown>;

      if (block.type === "tool_use" && isShellToolName(block.name)) {
        const command = getShellCommand(block.input);
        const input = block.input as Record<string, unknown> | undefined;
        if (!command || !input) return;
        const targets = await resolveText(command);
        if (targets.length > 0) input._projectPathLinks = targets;
        else delete input._projectPathLinks;
        return;
      }

      if (block.type === "tool_result" && typeof block.content === "string") {
        const targets = await resolveText(block.content);
        if (targets.length > 0) block._projectPathLinks = targets;
        else delete block._projectPathLinks;
      }
    }),
  );
}

export async function augmentFinalizedMessage(
  message: Record<string, unknown>,
  options: FinalizedMessageAugmentOptions = {},
): Promise<void> {
  await augmentEditToolUsesInMessage(message, options.onError);
  await augmentWriteToolUsesInMessage(message, options.onError);
  await augmentTextBlocks([message], options.safeMarkdownOptions);
  await augmentExitPlanModeAndReadResultsInMessage(message, options.onError);
  await augmentProjectPathLinksInMessage(message, options.safeMarkdownOptions);
}

export function getFinalMarkdownHtml(
  message: Record<string, unknown>,
): string | null {
  if (message.type !== "assistant") return null;

  const innerMessage = message.message as Record<string, unknown> | undefined;
  const content = innerMessage?.content ?? message.content;
  if (typeof content === "string") {
    const html = innerMessage?._html ?? message._html;
    return typeof html === "string" && html.length > 0 ? html : null;
  }
  if (!Array.isArray(content)) return null;

  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { _html?: unknown })._html === "string"
    ) {
      return (block as { _html: string })._html;
    }
  }
  return null;
}
