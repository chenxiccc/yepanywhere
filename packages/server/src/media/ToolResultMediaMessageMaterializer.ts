import type { ToolResultMedia } from "@yep-anywhere/shared";
import type {
  ToolResultMediaContext,
  ToolResultMediaStore,
} from "./ToolResultMediaStore.js";
import {
  TOOL_RESULT_MEDIA_CANDIDATES,
  type ToolResultMediaCandidate,
  type ToolResultMediaCandidateCarrier,
  sanitizeInlineImageData,
} from "./inlineImageData.js";

interface ToolUseContext {
  name: string;
  input: unknown;
}

type MessageLike = Record<string, unknown> & {
  message?: Record<string, unknown>;
  toolUseResult?: unknown;
  toolResultMedia?: ToolResultMedia[];
};

export class ToolResultMediaMessageMaterializer {
  private readonly toolUses = new Map<string, ToolUseContext>();

  constructor(
    private readonly store: ToolResultMediaStore,
    private readonly context: ToolResultMediaContext,
  ) {}

  async materializeMessages<T extends object>(
    messages: readonly T[],
  ): Promise<T[]> {
    const materialized: T[] = [];
    for (const message of messages) {
      materialized.push(await this.materializeMessage(message));
    }
    return materialized;
  }

  async materializeMessage<T extends object>(input: T): Promise<T> {
    const message = input as MessageLike;
    const blocks = getContentBlocks(message);
    for (const block of blocks) {
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        this.toolUses.set(block.id, { name: block.name, input: block.input });
      }
    }

    const resultBlocks = blocks.filter(
      (block) =>
        block.type === "tool_result" && typeof block.tool_use_id === "string",
    );
    if (resultBlocks.length === 0) return input;

    const existingMedia = message.toolResultMedia;
    if (Array.isArray(existingMedia) && existingMedia.length > 0) {
      for (const block of resultBlocks) {
        this.toolUses.delete(String(block.tool_use_id));
      }
      return input;
    }

    const candidatesByToolCallId = new Map<
      string,
      ToolResultMediaCandidate[]
    >();
    for (const block of resultBlocks) {
      candidatesByToolCallId.set(String(block.tool_use_id), []);
    }
    const primaryToolCallId = String(resultBlocks[0]?.tool_use_id ?? "");
    const primaryCandidates =
      candidatesByToolCallId.get(primaryToolCallId) ?? [];
    primaryCandidates.push(...getAttachedCandidates(message));

    let toolUseResult = message.toolUseResult;
    const sanitizedResult = sanitizeInlineImageData(toolUseResult);
    toolUseResult = sanitizedResult.value;
    primaryCandidates.push(...sanitizedResult.candidates);
    candidatesByToolCallId.set(primaryToolCallId, primaryCandidates);

    let contentChanged = false;
    const nextBlocks = blocks.map((block) => {
      if (block.type !== "tool_result" || !Object.hasOwn(block, "content")) {
        return block;
      }
      const sanitized = sanitizeInlineImageData(block.content);
      if (typeof block.tool_use_id === "string") {
        const blockCandidates =
          candidatesByToolCallId.get(block.tool_use_id) ?? [];
        blockCandidates.push(...sanitized.candidates);
        candidatesByToolCallId.set(block.tool_use_id, blockCandidates);
      }
      if (!sanitized.changed) return block;
      contentChanged = true;
      return { ...block, content: sanitized.value };
    });

    const media: ToolResultMedia[] = [];
    for (const [toolCallId, candidates] of candidatesByToolCallId) {
      const toolUse = this.toolUses.get(toolCallId);
      const originalPath = getToolPath(toolUse?.input);
      const normalizedCandidates = deduplicateCandidates(
        candidates.map((candidate) => ({
          ...candidate,
          ...(candidate.originalPath || !originalPath ? {} : { originalPath }),
          ...(candidate.filename || !originalPath
            ? {}
            : { filename: basenameForAnyPlatform(originalPath) }),
        })),
      );

      if (
        normalizedCandidates.length === 0 &&
        toolUse &&
        isPathBackedImageResult(
          toolUse.name,
          toolCallId === primaryToolCallId ? toolUseResult : undefined,
        ) &&
        originalPath
      ) {
        normalizedCandidates.push({
          originalPath,
          filename: basenameForAnyPlatform(originalPath),
        });
      }

      media.push(
        ...(await Promise.all(
          normalizedCandidates.map((candidate, index) =>
            this.store.capture(candidate, this.context, toolCallId, index),
          ),
        )),
      );
      this.toolUses.delete(toolCallId);
    }

    const next = {
      ...message,
      ...(toolUseResult !== message.toolUseResult ? { toolUseResult } : {}),
      ...(contentChanged
        ? {
            message: {
              ...(message.message ?? {}),
              content: nextBlocks,
            },
          }
        : {}),
      ...(media.length > 0 ? { toolResultMedia: media } : {}),
    } as MessageLike & ToolResultMediaCandidateCarrier;
    delete next[TOOL_RESULT_MEDIA_CANDIDATES];
    return next as T;
  }
}

function getAttachedCandidates(
  message: MessageLike,
): ToolResultMediaCandidate[] {
  return (
    (message as ToolResultMediaCandidateCarrier)[
      TOOL_RESULT_MEDIA_CANDIDATES
    ] ?? []
  );
}

function getContentBlocks(message: MessageLike): Record<string, unknown>[] {
  const content = message.message?.content;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function isPathBackedImageResult(
  toolName: string,
  toolUseResult: unknown,
): boolean {
  const normalizedName = toolName.toLowerCase();
  if (
    normalizedName === "viewimage" ||
    normalizedName === "view_image" ||
    normalizedName === "imageview"
  ) {
    return true;
  }
  return isRecord(toolUseResult) && toolUseResult.type === "image";
}

function getToolPath(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of ["path", "file_path", "filePath"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function basenameForAnyPlatform(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function deduplicateCandidates(
  candidates: readonly ToolResultMediaCandidate[],
): ToolResultMediaCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.dataUrl
      ? `data:${candidate.dataUrl}`
      : candidate.originalPath
        ? `path:${candidate.originalPath}`
        : JSON.stringify(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
