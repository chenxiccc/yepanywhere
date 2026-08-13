/**
 * Markdown augments - Render complete markdown text blocks to HTML
 *
 * This module provides functions to render full markdown text to HTML
 * with shiki syntax highlighting. Used when loading historical messages
 * to ensure identical rendering to the streaming path.
 */

import { SourceVersionedSingleFlight } from "../lib/sourceVersionedSingleFlight.js";
import {
  type AugmentGenerator,
  type AugmentGeneratorConfig,
  createAugmentGenerator,
} from "./augment-generator.js";
import { BlockDetector } from "./block-detector.js";
import {
  linkifyProjectPaths,
  resolveShapedPaths,
} from "./project-path-links.js";
import type { SafeMarkdownRenderOptions } from "./safe-markdown.js";

/**
 * Default configuration for the AugmentGenerator.
 * Should match the streaming coordinator config.
 */
const DEFAULT_CONFIG: AugmentGeneratorConfig = {
  languages: [
    "javascript",
    "js",
    "typescript",
    "ts",
    "tsx",
    "python",
    "bash",
    "json",
    "css",
    "html",
    "yaml",
    "sql",
    "go",
    "rust",
    "diff",
  ],
};

// Singleton generator instance (initialized lazily)
let generatorPromise: Promise<AugmentGenerator> | null = null;

const MAX_RETAINED_MARKDOWN_HTML_BYTES = 32 * 1024 * 1024;

interface CachedMarkdownHtml {
  html: string;
  retainedBytes: number;
  retainable: boolean;
}

function createMarkdownHtmlOwner(): SourceVersionedSingleFlight<
  string,
  CachedMarkdownHtml
> {
  return new SourceVersionedSingleFlight({
    acceptUnretainedWhenStale: true,
    maxRetainedBytes: MAX_RETAINED_MARKDOWN_HTML_BYTES,
    estimateBytes: (value) => value.retainedBytes,
    shouldRetain: (value) => value.retainable,
  });
}

let markdownHtmlOwner = createMarkdownHtmlOwner();
let fileExistsIdentityClock = 0;
let fileExistsIdentities = new WeakMap<(...args: never[]) => unknown, number>();

function fileExistsIdentity(
  fileExists:
    | ((absolutePath: string, relativePath: string) => boolean)
    | ((paths: readonly string[]) => Promise<ReadonlySet<string>>)
    | undefined,
): number | null {
  if (!fileExists) return null;
  const callback = fileExists as (...args: never[]) => unknown;
  const existing = fileExistsIdentities.get(callback);
  if (existing !== undefined) return existing;
  fileExistsIdentityClock += 1;
  fileExistsIdentities.set(callback, fileExistsIdentityClock);
  return fileExistsIdentityClock;
}

function markdownCacheKey(
  markdown: string,
  options: SafeMarkdownRenderOptions | undefined,
): string {
  const projectLinks = options?.projectFileLinks;
  return JSON.stringify([
    markdown,
    options?.localFileBasePath ?? null,
    options?.inlineLocalImages ?? false,
    options?.quartoMarkdown ?? false,
    projectLinks?.projectId ?? null,
    projectLinks?.projectPath ?? null,
    fileExistsIdentity(projectLinks?.fileExists),
    fileExistsIdentity(projectLinks?.resolveAbsoluteFilePaths),
  ]);
}

function markdownSourceVersion(
  options: SafeMarkdownRenderOptions | undefined,
): string {
  const index = options?.projectFileLinks?.index;
  return index ? `project-paths:${index.sourceRevision()}` : "static";
}

/**
 * Get or create the shared AugmentGenerator instance.
 * Uses a singleton to avoid re-loading shiki themes/languages.
 */
async function getGenerator(): Promise<AugmentGenerator> {
  if (!generatorPromise) {
    generatorPromise = createAugmentGenerator(DEFAULT_CONFIG);
  }
  return generatorPromise;
}

/**
 * Render markdown text to HTML with syntax highlighting.
 *
 * This uses the same BlockDetector and AugmentGenerator as the streaming
 * path, ensuring identical output for the same input.
 *
 * When the caller supplies a project path index, bare project-relative paths in
 * the prose become local-file links too, decided by the same membership test
 * that already governs inline-code references. That runs here rather than on the
 * streaming coordinator's per-delta path: this is per completed body, so no
 * filesystem-backed pass lands at token rate.
 *
 * @param markdown - The markdown text to render
 * @returns The rendered HTML string
 */
async function renderMarkdownToHtmlUncached(
  markdown: string,
  key: string,
  safeMarkdownOptions?: SafeMarkdownRenderOptions,
): Promise<CachedMarkdownHtml> {
  if (!markdown.trim()) {
    return {
      html: "",
      retainedBytes: Buffer.byteLength(key),
      retainable: true,
    };
  }

  const projectLinks = safeMarkdownOptions?.projectFileLinks;
  const index = projectLinks?.index;
  // Inline images embed mutable file bytes. They may share in-flight work but
  // stay outside retained Markdown HTML until they have their own content
  // revision fence.
  let retainable =
    !safeMarkdownOptions?.inlineLocalImages &&
    (!projectLinks || Boolean(index));
  const markUnversionedLookup = (): void => {
    retainable = false;
    projectLinks?.onUnversionedLookup?.();
  };
  if (index) {
    try {
      // Before rendering, so the synchronous membership questions the inline-code
      // linker asks mid-render are answered from cache.
      if (!(await resolveShapedPaths(markdown, index))) {
        markUnversionedLookup();
      }
    } catch {
      // Path links are advisory; an unavailable index must not fail the render.
      markUnversionedLookup();
    }
  }

  const renderOptions = projectLinks
    ? {
        ...safeMarkdownOptions,
        projectFileLinks: {
          ...projectLinks,
          onUnversionedLookup: markUnversionedLookup,
        },
      }
    : safeMarkdownOptions;

  const generator = await getGenerator();
  const detector = new BlockDetector();

  // Feed the entire markdown text at once
  const completedBlocks = detector.feed(markdown);

  // Flush any remaining content
  const finalBlocks = detector.flush();

  // Combine all blocks
  const allBlocks = [...completedBlocks, ...finalBlocks];

  // Render each block and concatenate HTML
  const htmlParts: string[] = [];
  for (let i = 0; i < allBlocks.length; i++) {
    const block = allBlocks[i];
    if (!block) continue;
    const augment = await generator.processBlock(block, i, renderOptions);
    htmlParts.push(augment.html);
  }

  const html = htmlParts.join("\n");
  const linkedHtml =
    index && projectLinks
      ? await linkifyProjectPaths(html, {
          projectId: projectLinks.projectId,
          projectPath: projectLinks.projectPath,
          index,
          gateLookupsByShape: true,
          onUnversionedLookup: markUnversionedLookup,
          resolveAbsoluteFilePaths: projectLinks.resolveAbsoluteFilePaths,
        })
      : html;
  return {
    html: linkedHtml,
    retainedBytes: Buffer.byteLength(key) + Buffer.byteLength(linkedHtml),
    retainable,
  };
}

export async function renderMarkdownToHtml(
  markdown: string,
  safeMarkdownOptions?: SafeMarkdownRenderOptions,
): Promise<string> {
  const key = markdownCacheKey(markdown, safeMarkdownOptions);
  const index = safeMarkdownOptions?.projectFileLinks?.index;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sourceVersion = markdownSourceVersion(safeMarkdownOptions);
    const result = await markdownHtmlOwner.run({
      key,
      sourceVersion,
      compute: async () =>
        renderMarkdownToHtmlUncached(markdown, key, safeMarkdownOptions),
      isCurrent: () =>
        !index || markdownSourceVersion(safeMarkdownOptions) === sourceVersion,
    });
    if (result.status !== "stale") return result.value.html;
  }

  // Continuous watcher churn must not prevent the response itself. The direct
  // result is deliberately outside retention after two fenced attempts.
  return (
    await renderMarkdownToHtmlUncached(markdown, key, safeMarkdownOptions)
  ).html;
}

export function markdownAugmentCacheDiagnostics() {
  return markdownHtmlOwner.getStats();
}

export const __test__ = {
  resetMarkdownHtmlCache: (): void => {
    markdownHtmlOwner.clear();
    markdownHtmlOwner = createMarkdownHtmlOwner();
    fileExistsIdentities = new WeakMap();
    fileExistsIdentityClock = 0;
  },
};

/**
 * Augment text blocks with pre-rendered HTML.
 *
 * Mutates text blocks in assistant messages, adding `_html` field
 * with rendered markdown/syntax-highlighted content.
 *
 * @param messages - Array of messages from session (mutated in place)
 */
export async function augmentTextBlocks(
  messages: Array<{
    type?: string;
    message?: { content?: unknown };
    content?: unknown;
  }>,
  safeMarkdownOptions?: SafeMarkdownRenderOptions,
): Promise<void> {
  // Process all messages in parallel
  const messagePromises = messages.map(async (msg) => {
    // Only process assistant messages
    if (msg.type !== "assistant") return;

    // Get content from nested message object (SDK structure) or top-level
    const content = msg.message?.content ?? msg.content;
    if (typeof content === "string") {
      if (!content.trim()) return;
      try {
        const html = await renderMarkdownToHtml(content, safeMarkdownOptions);
        (msg as { _html?: string })._html = html;
        if (msg.message && typeof msg.message === "object") {
          (msg.message as { _html?: string })._html = html;
        }
      } catch {
        // Ignore errors during augmentation
      }
      return;
    }

    if (!Array.isArray(content)) return;

    // Process all text blocks in the message
    const blockPromises = content.map(async (block) => {
      if (
        block?.type === "text" &&
        typeof block.text === "string" &&
        block.text.trim() !== ""
      ) {
        try {
          const html = await renderMarkdownToHtml(
            block.text,
            safeMarkdownOptions,
          );
          (block as { _html?: string })._html = html;
        } catch {
          // Ignore errors during augmentation
        }
      }
    });

    await Promise.all(blockPromises);
  });

  await Promise.all(messagePromises);
}
