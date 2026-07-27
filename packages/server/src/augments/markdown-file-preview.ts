import { renderMarkdownToHtml } from "./markdown-augments.js";
import {
  renderSafeMarkdown,
  type SafeMarkdownRenderOptions,
} from "./safe-markdown.js";

export type MarkdownFilePreviewViewMode = "full" | "range";

export interface MarkdownSourceRange {
  end: number;
  start: number;
}

function isBlankMarkdownLine(line: string): boolean {
  return line.trim() === "";
}

function getMarkdownFenceMarker(
  line: string,
): { char: "`" | "~"; length: number } | null {
  const match = /^(`{3,}|~{3,})/.exec(line.trimStart());
  if (!match?.[1]) {
    return null;
  }
  return {
    char: match[1][0] as "`" | "~",
    length: match[1].length,
  };
}

function expandMarkdownSplitRange(
  lines: string[],
  startIndex: number,
  endIndexExclusive: number,
): { endIndexExclusive: number; startIndex: number } {
  let start = startIndex;
  let end = endIndexExclusive;

  const expandToBlankBoundaries = () => {
    while (start > 0 && !isBlankMarkdownLine(lines[start - 1] ?? "")) {
      start -= 1;
    }
    while (end < lines.length && !isBlankMarkdownLine(lines[end] ?? "")) {
      end += 1;
    }
  };

  expandToBlankBoundaries();

  let openFence: {
    char: "`" | "~";
    length: number;
    startIndex: number;
  } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const marker = getMarkdownFenceMarker(lines[index] ?? "");
    if (!marker) {
      continue;
    }
    if (
      openFence &&
      marker.char === openFence.char &&
      marker.length >= openFence.length
    ) {
      const fenceEnd = index + 1;
      if (openFence.startIndex < end && fenceEnd > start) {
        start = Math.min(start, openFence.startIndex);
        end = Math.max(end, fenceEnd);
      }
      openFence = null;
    } else if (!openFence) {
      openFence = { ...marker, startIndex: index };
    }
  }
  if (openFence && openFence.startIndex < end) {
    start = Math.min(start, openFence.startIndex);
    end = lines.length;
  }

  expandToBlankBoundaries();

  return { startIndex: start, endIndexExclusive: end };
}

function collectMarkdownDefinitionLines(lines: string[]): string[] {
  const definitions: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!/^\s{0,3}\[[^\]]+]:/.test(line)) {
      continue;
    }

    definitions.push(line);
    for (let next = index + 1; next < lines.length; next += 1) {
      const continuation = lines[next] ?? "";
      if (!/^(?:\t| {4,})\S/.test(continuation)) {
        break;
      }
      definitions.push(continuation);
      index = next;
    }
  }
  return definitions;
}

function appendMarkdownDefinitionContext(
  markdown: string,
  definitions: string[],
): string {
  if (!markdown.trim() || definitions.length === 0) {
    return markdown;
  }
  return `${markdown.replace(/\s+$/, "")}\n\n${definitions.join("\n")}`;
}

/**
 * Render a Markdown file with an optional source-aligned span.
 *
 * Markdown renderers do not expose exact source positions here, so the
 * requested source range expands to stable block/fence boundaries. Both the
 * in-app FileViewer and standalone local-file documents consume the same span
 * markers rather than maintaining separate alignment rules.
 */
export async function renderMarkdownFilePreview(
  content: string,
  options: SafeMarkdownRenderOptions,
  contentStartLine: number,
  requestedRange: MarkdownSourceRange | null,
  viewMode: MarkdownFilePreviewViewMode,
): Promise<string> {
  if (!requestedRange) {
    return await renderMarkdownToHtml(content, options);
  }

  const lines = content.split("\n");
  const startIndex = Math.max(0, requestedRange.start - contentStartLine);
  const endIndexExclusive = Math.min(
    lines.length,
    requestedRange.end - contentStartLine + 1,
  );
  if (startIndex >= endIndexExclusive) {
    return await renderMarkdownToHtml(content, options);
  }

  const snappedRange = expandMarkdownSplitRange(
    lines,
    startIndex,
    endIndexExclusive,
  );
  const spanStartLine = contentStartLine + snappedRange.startIndex;
  const spanEndLine = contentStartLine + snappedRange.endIndexExclusive - 1;
  const before = lines.slice(0, snappedRange.startIndex).join("\n");
  const span = lines
    .slice(snappedRange.startIndex, snappedRange.endIndexExclusive)
    .join("\n");
  const after = lines.slice(snappedRange.endIndexExclusive).join("\n");
  const definitionLines = collectMarkdownDefinitionLines(lines);
  const renderChunk = (markdown: string) =>
    definitionLines.length > 0
      ? renderSafeMarkdown(
          appendMarkdownDefinitionContext(markdown, definitionLines),
          options,
        )
      : renderMarkdownToHtml(markdown, options);

  const parts: string[] = [];
  if (viewMode !== "range" && before.trim()) {
    parts.push(await renderChunk(before));
  }
  parts.push(
    `<div class="markdown-preview-line-boundary markdown-preview-line-boundary-start" data-line="${spanStartLine}"></div>`,
  );
  parts.push(
    `<div class="markdown-preview-span markdown-preview-span-start" data-line-start="${spanStartLine}" data-line-end="${spanEndLine}">${await renderChunk(span)}</div>`,
  );
  parts.push(
    `<div class="markdown-preview-line-boundary markdown-preview-line-boundary-end" data-line="${spanEndLine}"></div>`,
  );
  if (viewMode !== "range" && after.trim()) {
    parts.push(await renderChunk(after));
  }

  return parts.filter(Boolean).join("\n");
}
