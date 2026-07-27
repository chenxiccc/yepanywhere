import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseLineColumn } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { renderMarkdownFilePreview } from "../augments/markdown-file-preview.js";
import type { ProjectScanner } from "../projects/scanner.js";
import {
  createLocalResourcePathPolicy,
  LOCAL_FILE_CONTENT_TYPES,
  LOCAL_MEDIA_EXTENSIONS,
} from "./local-resource-policy.js";

interface LocalFileDeps {
  allowedPaths: string[] | (() => string[]);
  scanner?: Pick<ProjectScanner, "listProjects">;
  includeProjects?: () => boolean;
}

interface LocalFileReference {
  filePath: string;
  lineNumber?: number;
  columnNumber?: number;
  hadInlineLocation: boolean;
}

function isMarkdownPath(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return ext === ".md" || ext === ".markdown";
}

function isHtmlPath(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return ext === ".html" || ext === ".htm";
}

function getLocalFileContentType(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  if (LOCAL_MEDIA_EXTENSIONS.has(ext)) {
    return null;
  }
  return LOCAL_FILE_CONTENT_TYPES[ext] ?? "text/plain; charset=utf-8";
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseLocalFileReference(
  rawPath: string,
  explicitLine?: number,
  explicitColumn?: number,
): LocalFileReference {
  const parsed = parseLineColumn(rawPath);
  return {
    filePath: parsed.path,
    lineNumber: explicitLine ?? parsed.line,
    columnNumber: explicitColumn ?? parsed.column,
    hadInlineLocation: parsed.path !== rawPath,
  };
}

function localFileHref(
  filePath: string,
  options: {
    renderMarkdown?: boolean;
    rawMarkdown?: boolean;
    lineNumber?: number;
    columnNumber?: number;
  } = {},
): string {
  const parsed = parseLocalFileReference(
    filePath,
    options.lineNumber,
    options.columnNumber,
  );
  const params = new URLSearchParams({ path: parsed.filePath });
  if (options.renderMarkdown && isMarkdownPath(parsed.filePath)) {
    params.set("render", "1");
  } else if (options.rawMarkdown && isMarkdownPath(parsed.filePath)) {
    params.set("render", "0");
  }
  if (parsed.lineNumber !== undefined) {
    params.set("line", String(parsed.lineNumber));
  }
  if (parsed.columnNumber !== undefined) {
    params.set("column", String(parsed.columnNumber));
  }
  return `/api/local-file?${params.toString()}`;
}

function localMediaHref(filePath: string): string {
  return `/api/local-image?path=${encodeURIComponent(filePath)}`;
}

function rewriteLocalHtmlReferences(html: string, filePath: string): string {
  let basePath = dirname(filePath);
  const withoutLocalBase = html.replace(
    /<base\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>/gi,
    (match, _quote: string, href: string) => {
      const resolvedBase = resolveHtmlLocalReference(href, basePath);
      if (!resolvedBase || !href.trim().toLowerCase().startsWith("file:")) {
        return match;
      }
      basePath = href.trim().endsWith("/")
        ? resolvedBase.filePath
        : dirname(resolvedBase.filePath);
      return "";
    },
  );

  return withoutLocalBase.replace(
    /\b(src|href|poster)\s*=\s*(["'])(.*?)\2/gi,
    (match, attr: string, quote: string, href: string) => {
      const rewritten = rewriteHtmlLocalReference(href, basePath, attr);
      return rewritten ? `${attr}=${quote}${rewritten}${quote}` : match;
    },
  );
}

function rewriteHtmlLocalReference(
  href: string,
  basePath: string,
  attr: string,
): string | null {
  const resolvedReference = resolveHtmlLocalReference(href, basePath);
  if (!resolvedReference) {
    return null;
  }

  const ext = extname(resolvedReference.filePath).toLowerCase();
  if (LOCAL_MEDIA_EXTENSIONS.has(ext)) {
    return localMediaHref(resolvedReference.filePath);
  }

  if (getLocalFileContentType(resolvedReference.filePath)) {
    const rewrittenHref = escapeHtml(
      localFileHref(resolvedReference.filePath, {
        renderMarkdown: isMarkdownPath(resolvedReference.filePath),
      }),
    );
    return attr.toLowerCase() === "href"
      ? `${rewrittenHref}${resolvedReference.hash}`
      : rewrittenHref;
  }

  return null;
}

function resolveHtmlLocalReference(
  href: string,
  basePath: string,
): { filePath: string; hash: string } | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) {
    return null;
  }
  if (/^(?:https?|mailto|data|blob|javascript):/i.test(trimmed)) {
    return null;
  }

  try {
    const baseUrl = pathToFileURL(`${basePath}/`);
    const url = new URL(trimmed, baseUrl);
    if (url.protocol !== "file:") {
      return null;
    }
    return {
      filePath: resolve(fileURLToPath(url)),
      hash: url.hash,
    };
  } catch {
    return null;
  }
}

function renderMarkdownDocument(
  filePath: string,
  bodyHtml: string,
  lineTarget: number | undefined,
): string {
  const title = basename(filePath);
  const rawUrl = localFileHref(filePath, {
    rawMarkdown: true,
    lineNumber: lineTarget,
  });
  const bodyClass =
    lineTarget === undefined ? "" : ' class="has-line-target-arrival"';
  const lineTargetScript =
    lineTarget === undefined
      ? ""
      : `
  <script>
    (() => {
      const target = document.querySelector(".markdown-preview-span-start");
      const rawLink = document.querySelector(".document-actions__raw");
      if (!target) return;

      const dismissArrivalHighlight = () => {
        document.body.classList.remove("has-line-target-arrival");
      };
      const jumpToTarget = () => {
        target.scrollIntoView({ block: "start" });
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            window.addEventListener("scroll", dismissArrivalHighlight, {
              once: true,
              passive: true,
            });
          });
        });
      };

      rawLink?.addEventListener("click", (event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }

        const rawWindow = window.open(rawLink.href, "_blank");
        if (!rawWindow) {
          return;
        }
        event.preventDefault();
        rawWindow.focus();

        const startedAt = Date.now();
        let timer;
        const stopTrying = () => {
          if (timer !== undefined) {
            window.clearInterval(timer);
          }
        };
        const jumpRawWindow = () => {
          if (rawWindow.closed || Date.now() - startedAt > 10_000) {
            stopTrying();
            return;
          }

          let pre;
          try {
            if (rawWindow.document.readyState === "loading") {
              return;
            }
            pre = rawWindow.document.querySelector("pre");
          } catch {
            return;
          }
          if (!pre) {
            return;
          }

          const text = pre.textContent || "";
          let startOffset = 0;
          for (let currentLine = 1; currentLine < ${lineTarget}; currentLine += 1) {
            const newlineOffset = text.indexOf("\\n", startOffset);
            if (newlineOffset < 0) {
              stopTrying();
              return;
            }
            startOffset = newlineOffset + 1;
          }

          if (startOffset === text.length) {
            rawWindow.scrollTo(0, pre.scrollHeight);
            stopTrying();
            return;
          }

          const newlineOffset = text.indexOf("\\n", startOffset);
          let endOffset =
            newlineOffset < 0 ? text.length : newlineOffset;
          if (endOffset === startOffset && endOffset < text.length) {
            endOffset += 1;
          }

          const locateTextOffset = (absoluteOffset) => {
            let remaining = absoluteOffset;
            for (const node of pre.childNodes) {
              if (node.nodeType !== 3) continue;
              const length = node.textContent?.length || 0;
              if (remaining <= length) {
                return { node, offset: remaining };
              }
              remaining -= length;
            }
            const lastNode = pre.lastChild;
            return lastNode
              ? { node: lastNode, offset: lastNode.textContent?.length || 0 }
              : null;
          };

          const start = locateTextOffset(startOffset);
          const end = locateTextOffset(endOffset);
          if (!start || !end) {
            stopTrying();
            return;
          }

          const range = rawWindow.document.createRange();
          range.setStart(start.node, start.offset);
          range.setEnd(end.node, end.offset);
          const rect = range.getBoundingClientRect();
          if (rect.height > 0) {
            rawWindow.scrollTo(
              0,
              Math.max(
                0,
                rawWindow.scrollY + rect.top - rawWindow.innerHeight * 0.1,
              ),
            );
          }
          stopTrying();
        };

        timer = window.setInterval(jumpRawWindow, 50);
        jumpRawWindow();
      });

      if (document.readyState === "complete") {
        jumpToTarget();
      } else {
        window.addEventListener("load", jumpToTarget, { once: true });
      }
    })();
  </script>`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      background: Canvas;
      color: CanvasText;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.55;
    }
    .document-actions {
      position: fixed;
      top: 0.75rem;
      right: 0.75rem;
      z-index: 1;
      display: flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.25rem;
      border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
      border-radius: 6px;
      background: color-mix(in srgb, Canvas 88%, transparent);
      box-shadow: 0 4px 20px color-mix(in srgb, CanvasText 12%, transparent);
      backdrop-filter: blur(8px);
    }
    .document-actions.is-docked {
      position: absolute;
    }
    .document-actions a,
    .document-actions__dock {
      border: 0;
      border-radius: 4px;
      background: transparent;
      padding: 0.25rem 0.55rem;
      font: inherit;
      text-decoration: none;
      cursor: pointer;
    }
    .document-actions a {
      color: LinkText;
    }
    .document-actions__dock {
      width: 1.6rem;
      color: color-mix(in srgb, CanvasText 72%, transparent);
    }
    .document-actions a:hover,
    .document-actions__dock:hover {
      background: color-mix(in srgb, CanvasText 10%, transparent);
    }
    .document-actions.is-docked .document-actions__dock {
      display: none;
    }
    main {
      box-sizing: border-box;
      max-width: 980px;
      margin: 0 auto;
      padding: 1.25rem;
    }
    .markdown-preview-span-start {
      position: relative;
      scroll-margin-block-start: 10vh;
      transition:
        background-color 700ms ease,
        box-shadow 700ms ease;
    }
    .markdown-preview-span-start::before {
      position: absolute;
      top: 0.8em;
      right: calc(100% + 0.35rem);
      width: 0.8rem;
      height: 2px;
      border-radius: 999px;
      background: color-mix(in srgb, LinkText 68%, transparent);
      content: "";
    }
    .has-line-target-arrival .markdown-preview-span-start {
      background: color-mix(in srgb, Highlight 14%, transparent);
      box-shadow: 0 0 0 0.4rem color-mix(in srgb, Highlight 14%, transparent);
    }
    h1, h2, h3, h4, h5, h6 {
      line-height: 1.25;
      margin: 1.4em 0 0.5em;
    }
    h1:first-child, h2:first-child { margin-top: 0; }
    code, pre {
      font-family: ui-monospace, SFMono-Regular, Monaco, Consolas, monospace;
    }
    code {
      border-radius: 3px;
      background: color-mix(in srgb, CanvasText 10%, transparent);
      padding: 0.1em 0.3em;
    }
    pre {
      overflow: auto;
      border-radius: 6px;
      background: color-mix(in srgb, CanvasText 8%, transparent);
      padding: 0.85rem;
    }
    pre code { background: transparent; padding: 0; }
    table {
      width: 100%;
      margin: 1rem 0;
      border-collapse: collapse;
    }
    th, td {
      border: 1px solid color-mix(in srgb, CanvasText 24%, transparent);
      padding: 0.45rem 0.6rem;
      text-align: left;
    }
    blockquote {
      margin: 1rem 0;
      border-left: 4px solid color-mix(in srgb, CanvasText 24%, transparent);
      padding-left: 1rem;
      color: color-mix(in srgb, CanvasText 72%, transparent);
    }
    img {
      max-width: 100%;
      height: auto;
    }
    @media print {
      .document-actions { display: none; }
      main {
        max-width: none;
        padding: 0;
      }
    }
  </style>
</head>
<body${bodyClass}>
  <nav class="document-actions" aria-label="Document actions">
    <a class="document-actions__raw" href="${escapeHtml(rawUrl)}">Raw</a>
    <button class="document-actions__dock" type="button" aria-label="Keep raw link at document top" title="Keep at document top" onclick="this.closest('.document-actions').classList.add('is-docked')">&times;</button>
  </nav>
  <main class="markdown-rendered">
${bodyHtml}
  </main>
${lineTargetScript}
</body>
</html>`;
}

/**
 * Create routes for serving local files from allowed paths.
 *
 * Security: Only serves files that:
 * 1. Are not handled by the media route
 * 2. Resolve (after symlink resolution) to a path under an allowed prefix
 * 3. Are regular files (not directories, devices, etc.)
 *
 * Unknown non-media extensions are served as text/plain with nosniff so source
 * files and logs do not fail just because the extension map is incomplete.
 */
export function createLocalFileRoutes(deps: LocalFileDeps) {
  const routes = new Hono();
  const pathPolicy = createLocalResourcePathPolicy(deps);

  routes.get("/", async (c) => {
    const rawFilePath = c.req.query("path");
    if (!rawFilePath) {
      return c.json({ error: "Missing path parameter" }, 400);
    }
    const requested = parseLocalFileReference(
      rawFilePath,
      parsePositiveInteger(c.req.query("line")),
      parsePositiveInteger(c.req.query("column")),
    );
    const filePath = requested.filePath;

    if (!pathPolicy.isAbsolutePath(filePath)) {
      return c.json({ error: "Path must be absolute" }, 400);
    }

    const contentType = getLocalFileContentType(filePath);
    if (!contentType) {
      return c.json({ error: "Not a supported local file" }, 415);
    }

    try {
      const resolved = await pathPolicy.resolveAllowedFilePath(filePath);
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, resolved.status);
      }
      const { resolvedPath, stats } = resolved.file;

      if (
        (c.req.query("render") === "1" || requested.hadInlineLocation) &&
        isMarkdownPath(resolvedPath)
      ) {
        const markdown = await readFile(resolvedPath, "utf-8");
        const requestedRange =
          requested.lineNumber === undefined
            ? null
            : {
                start: requested.lineNumber,
                end: requested.lineNumber,
              };
        const html = await renderMarkdownFilePreview(
          markdown,
          {
            localFileBasePath: dirname(resolvedPath),
            inlineLocalImages: true,
          },
          1,
          requestedRange,
          "full",
        );
        const hasLineTarget =
          requestedRange !== null &&
          html.includes(
            'class="markdown-preview-span markdown-preview-span-start"',
          );

        c.header("Content-Type", "text/html; charset=utf-8");
        c.header("Content-Disposition", "inline");
        c.header("Cache-Control", "private, max-age=60");
        c.header("X-Content-Type-Options", "nosniff");
        return c.html(
          renderMarkdownDocument(
            resolvedPath,
            html,
            hasLineTarget ? requested.lineNumber : undefined,
          ),
        );
      }

      if (isHtmlPath(resolvedPath)) {
        const html = await readFile(resolvedPath, "utf-8");
        const rewrittenHtml = rewriteLocalHtmlReferences(html, resolvedPath);

        c.header("Content-Type", contentType);
        c.header("Content-Disposition", "inline");
        c.header("Cache-Control", "private, max-age=60");
        c.header("X-Content-Type-Options", "nosniff");
        return c.html(rewrittenHtml);
      }

      c.header("Content-Type", contentType);
      c.header("Content-Length", stats.size.toString());
      c.header("Content-Disposition", "inline");
      c.header("Cache-Control", "private, max-age=60");
      c.header("X-Content-Type-Options", "nosniff");

      return stream(c, async (s) => {
        const readable = createReadStream(resolvedPath);
        for await (const chunk of readable) {
          await s.write(chunk);
        }
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return c.json({ error: "File not found" }, 404);
      }
      console.error("[LocalFile] Error serving file:", err);
      return c.json({ error: "Internal error" }, 500);
    }
  });

  return routes;
}
