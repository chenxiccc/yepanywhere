import type { FileContentResponse } from "@yep-anywhere/shared";
import { isMarkdownLikeFile } from "./markdownFiles";
import {
  getSemanticHtmlClipboardPayloadFromHtml,
  type SemanticHtmlClipboardPayload,
} from "./semanticHtmlClipboard";

function isHtmlLikeFile(filePath: string, mimeType: string): boolean {
  return (
    /\.(?:html?|xhtml)$/i.test(filePath) ||
    mimeType === "text/html" ||
    mimeType === "application/xhtml+xml"
  );
}

export function getRenderedFileClipboardPayload(
  filePath: string,
  file: FileContentResponse,
  renderedMarkdownHtml = file.renderedMarkdownHtml,
): SemanticHtmlClipboardPayload | null {
  const html = isMarkdownLikeFile(filePath)
    ? renderedMarkdownHtml
    : isHtmlLikeFile(filePath, file.metadata.mimeType)
      ? file.content
      : undefined;
  return html ? getSemanticHtmlClipboardPayloadFromHtml(html) : null;
}

export function requireRenderedFileClipboardPayload(
  filePath: string,
  file: FileContentResponse,
): SemanticHtmlClipboardPayload {
  const payload = getRenderedFileClipboardPayload(filePath, file);
  if (!payload) {
    throw new Error("Rendered file contents are unavailable");
  }
  return payload;
}

export function requireRenderedHtmlClipboardPayload(
  html: string,
): SemanticHtmlClipboardPayload {
  const payload = getSemanticHtmlClipboardPayloadFromHtml(html);
  if (!payload) {
    throw new Error("Rendered contents are unavailable");
  }
  return payload;
}
