/**
 * AugmentGenerator - Renders completed markdown blocks to HTML
 *
 * Uses shiki for syntax highlighting of code blocks and markdown-it for
 * rendering other markdown blocks. Also provides lightweight inline
 * formatting for pending/incomplete text during streaming.
 */

import {
  hasAnsiEscapes,
  looksLikeToon,
  parseToonDocument,
  renderAnsiToHtml,
  toonDocumentToMarkdown,
} from "@yep-anywhere/shared";
import {
  type BundledLanguage,
  bundledLanguages,
  createHighlighter,
  type Highlighter,
} from "shiki";
import { createCssVariablesTheme } from "shiki/core";
import type {
  CompletedBlock,
  StreamingCodeBlock,
  StreamingList,
} from "./block-detector.js";
import {
  getLocalPathExtension,
  isLocalFilePath,
  MEDIA_EXTENSIONS,
  renderLocalFileLink,
  renderLocalMediaLink,
  renderSafeMarkdown,
  type SafeMarkdownRenderOptions,
  sanitizeUrl,
} from "./safe-markdown.js";

/** CSS variables theme - outputs `style="color: var(--shiki-...)"` */
const cssVarsTheme = createCssVariablesTheme({
  name: "css-variables",
  variablePrefix: "--shiki-",
  fontStyle: true,
});

export interface Augment {
  blockIndex: number;
  html: string;
  type: CompletedBlock["type"];
}

export interface AugmentGeneratorConfig {
  languages: string[]; // Languages to pre-load for sync highlighting
}

export interface AugmentGenerator {
  processBlock(
    block: CompletedBlock,
    blockIndex: number,
    safeMarkdownOptions?: SafeMarkdownRenderOptions,
  ): Promise<Augment>;
  renderPending(pending: string): string; // Lightweight inline formatting for trailing text
  renderStreamingCodeBlock(
    block: StreamingCodeBlock,
    blockIndex: number,
  ): Promise<Augment>; // Render incomplete code block optimistically
  renderStreamingList(
    block: StreamingList,
    blockIndex: number,
    safeMarkdownOptions?: SafeMarkdownRenderOptions,
  ): Augment; // Render incomplete list optimistically
}

/**
 * Creates an AugmentGenerator instance with pre-loaded syntax highlighting.
 *
 * @param config - Configuration for languages and theme
 * @returns Promise that resolves to an AugmentGenerator
 */
export async function createAugmentGenerator(
  config: AugmentGeneratorConfig,
): Promise<AugmentGenerator> {
  // Filter languages to only include valid bundled languages
  const validLanguages = config.languages.filter(
    (lang) => lang in bundledLanguages,
  ) as BundledLanguage[];

  // Create highlighter with CSS variables theme for light/dark mode support
  const highlighter = await createHighlighter({
    themes: [cssVarsTheme],
    langs:
      validLanguages.length > 0 ? validLanguages : ["javascript", "typescript"],
  });

  // Track loaded languages for sync checking
  const loadedLanguages = new Set<string>(validLanguages);

  return {
    async processBlock(
      block: CompletedBlock,
      blockIndex: number,
      safeMarkdownOptions?: SafeMarkdownRenderOptions,
    ): Promise<Augment> {
      if (block.type === "code") {
        const html = await renderCodeBlock(block, highlighter, loadedLanguages);
        return { blockIndex, html, type: block.type };
      }

      const html = renderMarkdownBlock(block, safeMarkdownOptions);
      return { blockIndex, html, type: block.type };
    },

    renderPending(pending: string): string {
      return renderInlineFormatting(pending);
    },

    async renderStreamingCodeBlock(
      block: StreamingCodeBlock,
      blockIndex: number,
    ): Promise<Augment> {
      const code = extractStreamingCodeContent(block.content);
      const lang = block.lang ?? "";

      // Avoid running Shiki over the whole growing code block on every token.
      // Completed code blocks still get full syntax highlighting through
      // processBlock once the closing fence arrives.
      const html = renderPlainCodeBlock(code, lang);
      return { blockIndex, html, type: "code" };
    },

    renderStreamingList(
      block: StreamingList,
      blockIndex: number,
      safeMarkdownOptions?: SafeMarkdownRenderOptions,
    ): Augment {
      const html = renderMarkdownBlock(
        {
          type: "list",
          content: block.content,
          startOffset: block.startOffset,
          endOffset: block.startOffset + block.content.length,
        },
        safeMarkdownOptions,
      );
      return { blockIndex, html, type: "list" };
    },
  };
}

/**
 * Extract code content from a code block, removing the fence markers.
 */
function extractCodeContent(content: string): string {
  const lines = content.split("\n");
  if (lines.length < 2) return "";

  // Remove first line (opening fence) and last line (closing fence if present)
  const hasClosingFence =
    lines.length > 1 &&
    /^(`{3,}|~{3,})$/.test((lines[lines.length - 1] ?? "").trim());

  const codeLines = hasClosingFence ? lines.slice(1, -1) : lines.slice(1);

  return codeLines.join("\n");
}

/**
 * Extract code content from a streaming code block (no closing fence).
 */
function extractStreamingCodeContent(content: string): string {
  const lines = content.split("\n");
  if (lines.length < 2) return "";

  // Remove first line (opening fence), keep everything else
  return lines.slice(1).join("\n");
}

/**
 * Render code with syntax highlighting (shared by completed and streaming code blocks).
 */
async function renderCodeWithHighlighter(
  code: string,
  lang: string,
  highlighter: Highlighter,
  loadedLanguages: Set<string>,
): Promise<string> {
  // Route colored terminal output through the ANSI renderer when the
  // fence is tagged `ansi` or contains raw CSI bytes; otherwise shiki
  // would render the escapes literally.
  if (lang === "ansi" || hasAnsiEscapes(code)) {
    return renderAnsiBlock(code);
  }

  // TOON flat tables (acli's opt-in tabular format) render as real tables
  // via the existing markdown pipeline; a failed strict parse falls through
  // to ordinary highlighting.
  if (lang === "toon" || (!lang && looksLikeToon(code))) {
    const tables = parseToonDocument(code);
    if (tables) {
      return renderSafeMarkdown(toonDocumentToMarkdown(tables));
    }
  }

  // Check if language is loaded and valid
  const isValidLang = lang && lang in bundledLanguages;

  if (isValidLang && !loadedLanguages.has(lang)) {
    // Load the language dynamically
    try {
      await highlighter.loadLanguage(lang as BundledLanguage);
      loadedLanguages.add(lang);
    } catch {
      // Language loading failed, fall back to plain text
      return renderPlainCodeBlock(code, lang);
    }
  }

  if (isValidLang && loadedLanguages.has(lang)) {
    try {
      const html = highlighter.codeToHtml(code, {
        lang: lang as BundledLanguage,
        theme: "css-variables",
      });
      return html;
    } catch {
      // Highlighting failed, fall back to plain text
      return renderPlainCodeBlock(code, lang);
    }
  }

  // Unknown or empty language - render as plain code block
  return renderPlainCodeBlock(code, lang);
}

/**
 * Render a code block with syntax highlighting.
 */
async function renderCodeBlock(
  block: CompletedBlock,
  highlighter: Highlighter,
  loadedLanguages: Set<string>,
): Promise<string> {
  const code = extractCodeContent(block.content);
  const lang = block.lang ?? "";
  return renderCodeWithHighlighter(code, lang, highlighter, loadedLanguages);
}

/**
 * Render a plain code block without syntax highlighting.
 */
function renderPlainCodeBlock(code: string, lang: string): string {
  const escapedCode = escapeHtml(code);
  const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
  return `<pre class="shiki"><code${langClass}>${escapedCode}</code></pre>`;
}

/**
 * Render an ANSI-colored code block. The inner renderer already escapes
 * HTML special characters, so we just wrap its output in a matching
 * `<pre class="shiki"><code>` shell for styling parity with shiki.
 */
function renderAnsiBlock(code: string): string {
  const innerHtml = renderAnsiToHtml(code);
  return `<pre class="shiki ansi-block"><code class="language-ansi">${innerHtml}</code></pre>`;
}

/**
 * Render a non-code markdown block with raw HTML disabled and sanitization.
 */
function renderMarkdownBlock(
  block: CompletedBlock,
  safeMarkdownOptions?: SafeMarkdownRenderOptions,
): string {
  return renderSafeMarkdown(block.content, safeMarkdownOptions);
}

/**
 * Render lightweight inline formatting for pending/streaming text.
 * Handles: **bold**, *italic*, `code`, [text](url)
 */
function renderInlineFormatting(text: string): string {
  // Escape HTML first
  let result = escapeHtml(text);

  // Bold: **text**
  result = result.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  // Italic: *text* (but not if it's actually bold marker)
  // Use negative lookbehind/lookahead to avoid matching inside bold
  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");

  // Inline code: `text`
  result = result.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Links: [text](url) — handle local file paths and regular URLs
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
    if (isLocalFilePath(href)) {
      const ext = getLocalPathExtension(href);
      if (MEDIA_EXTENSIONS.has(ext)) {
        return renderLocalMediaLink(href, label, ext);
      }
      return renderLocalFileLink(href, label, {
        renderMarkdown: ext === "md" || ext === "markdown",
      });
    }
    const safeHref = sanitizeUrl(href);
    if (!safeHref) {
      return `[${label}](${href})`;
    }

    return `<a href="${escapeHtml(safeHref)}">${label}</a>`;
  });

  return result;
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
