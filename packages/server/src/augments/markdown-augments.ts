/**
 * Markdown augments - Render complete markdown text blocks to HTML
 *
 * This module provides functions to render full markdown text to HTML
 * with shiki syntax highlighting. Used when loading historical messages
 * to ensure identical rendering to the streaming path.
 */

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
export async function renderMarkdownToHtml(
  markdown: string,
  safeMarkdownOptions?: SafeMarkdownRenderOptions,
): Promise<string> {
  if (!markdown.trim()) {
    return "";
  }

  const projectLinks = safeMarkdownOptions?.projectFileLinks;
  const index = projectLinks?.index;
  if (index) {
    try {
      // Before rendering, so the synchronous membership questions the inline-code
      // linker asks mid-render are answered from cache.
      await resolveShapedPaths(markdown, index);
    } catch {
      // Path links are advisory; an unavailable index must not fail the render.
    }
  }

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
    const augment = await generator.processBlock(block, i, safeMarkdownOptions);
    htmlParts.push(augment.html);
  }

  const html = htmlParts.join("\n");
  if (!index || !projectLinks) return html;
  return linkifyProjectPaths(html, {
    projectPath: projectLinks.projectPath,
    index,
    gateLookupsByShape: true,
  });
}

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
