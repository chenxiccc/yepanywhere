import { statSync } from "node:fs";
import { isAbsolute, normalize, posix, win32 } from "node:path";
import { parseLineColumn } from "@yep-anywhere/shared";
import katex from "katex";
import {
  Marked,
  type RendererObject,
  type RendererThis,
  type Token,
  type Tokens,
  type TokensList,
} from "marked";
import sanitizeHtml from "sanitize-html";

const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const ALLOWED_IMAGE_PROTOCOLS = new Set(["http:", "https:"]);

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "tif",
  "svg",
]);

const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "avi", "mkv", "ogv"]);

const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

export interface SafeMarkdownRenderOptions {
  /**
   * Directory that relative local markdown links are resolved against.
   *
   * Relative links containing `..` are left as ordinary text/links. Project
   * file endpoints still perform their own containment checks; this renderer
   * only resolves same-directory or child-directory links for previews.
   */
  localFileBasePath?: string;
  /**
   * Emit direct <img> tags for local images instead of the interactive YA
   * inline-media placeholder. Used by standalone rendered documents that do
   * not run the React inline-preview hydrator.
   */
  inlineLocalImages?: boolean;
  /**
   * Project context for turning assistant inline-code filename references into
   * authenticated project-file viewer links. Omit for public shares.
   */
  projectFileLinks?: ProjectFileLinkOptions;
}

let activeRenderOptions: SafeMarkdownRenderOptions = {};
let projectFileCodeLinkCache = new Map<string, ProjectFileCodeLink | null>();

export interface ProjectFileLinkOptions {
  projectId: string;
  projectPath: string;
  fileExists?: (absolutePath: string, relativePath: string) => boolean;
}

interface LocalPathReference {
  filePath: string;
  lineNumber?: number;
  columnNumber?: number;
}

interface LocalResourceAttributeOptions {
  mediaType?: "image" | "video";
  renderMarkdown?: boolean;
}

interface ProjectFileCodeLink {
  absolutePath: string;
  columnNumber?: number;
  lineNumber?: number;
  relativePath: string;
}

function stripHrefSuffix(href: string): string {
  return href.split(/[?#]/, 1)[0] ?? "";
}

function parseLocalPathReference(path: string): LocalPathReference {
  const parsed = parseLineColumn(stripHrefSuffix(path.trim()));
  return {
    filePath: parsed.path,
    lineNumber: parsed.line,
    columnNumber: parsed.column,
  };
}

function toLocalPathReference(
  reference: LocalPathReference | string,
): LocalPathReference {
  return typeof reference === "string"
    ? parseLocalPathReference(reference)
    : reference;
}

function formatLocalPathReference(reference: LocalPathReference): string {
  let display = reference.filePath;
  if (reference.lineNumber !== undefined) {
    display += `:${reference.lineNumber}`;
    if (reference.columnNumber !== undefined) {
      display += `:${reference.columnNumber}`;
    }
  }
  return display;
}

/**
 * Check if a string looks like an absolute local file path.
 * Must be a POSIX or Windows absolute path and contain a file extension.
 */
function isLocalFilePath(href: string): boolean {
  const trimmed = parseLocalPathReference(href).filePath;
  const isPosixAbsolute = trimmed.startsWith("/") && !trimmed.startsWith("//");
  const isWindowsDriveAbsolute = isWindowsDriveAbsolutePath(trimmed);
  if (!isPosixAbsolute && !isWindowsDriveAbsolute) return false;

  // Must have a file extension after the last path separator.
  const basename = trimmed.split(/[\\/]/).pop() ?? "";
  return basename.includes(".");
}

/**
 * Get the file extension from a path (lowercase, without the dot).
 */
function getExtension(path: string): string {
  return (
    parseLocalPathReference(path).filePath.split(".").pop() ?? ""
  ).toLowerCase();
}

/**
 * Get the filename from a path.
 */
function getFileName(path: string): string {
  return parseLocalPathReference(path).filePath.split(/[\\/]/).pop() ?? path;
}

function isMarkdownExtension(ext: string): boolean {
  return MARKDOWN_EXTENSIONS.has(ext);
}

function isWindowsDriveAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

interface RawMarkdownDestination {
  enclosed: boolean;
  pathStart: number;
}

function findRawWindowsDriveDestination(
  raw: string,
  kind: "definition" | "inline",
): RawMarkdownDestination | null {
  const match =
    kind === "definition"
      ? /^ {0,3}\[(?:\\.|[^\]\\])+\]:[ \t]*(<?)([A-Za-z]:[\\/])/.exec(raw)
      : /\]\([ \t]*(<?)([A-Za-z]:[\\/])/.exec(raw);
  if (!match || match.index === undefined) {
    return null;
  }

  const drivePrefix = match[2];
  if (!drivePrefix) {
    return null;
  }

  return {
    enclosed: match[1] === "<",
    pathStart: match.index + match[0].length - drivePrefix.length,
  };
}

function canonicalizeRawWindowsDriveDestination(
  raw: string,
  kind: "definition" | "inline",
): string | null {
  const destination = findRawWindowsDriveDestination(raw, kind);
  if (!destination) {
    return null;
  }

  let pathEnd = destination.pathStart;
  let parenthesisDepth = 0;
  while (pathEnd < raw.length) {
    const character = raw[pathEnd];
    if (destination.enclosed) {
      if (character === ">") break;
    } else {
      if (/\s/.test(character ?? "") && parenthesisDepth === 0) break;
      if (character === "(") {
        parenthesisDepth += 1;
      } else if (character === ")") {
        if (parenthesisDepth === 0) break;
        parenthesisDepth -= 1;
      }
    }
    pathEnd += 1;
  }

  const filePath = raw.slice(destination.pathStart, pathEnd);
  if (!filePath.includes("\\") || !isWindowsDriveAbsolutePath(filePath)) {
    return null;
  }

  return filePath.replace(/\\+/g, "/");
}

function walkMarkdownTokenTree(
  tokens: Token[],
  visit: (token: Token) => void,
): void {
  for (const token of tokens) {
    visit(token);

    if ("tokens" in token && Array.isArray(token.tokens)) {
      walkMarkdownTokenTree(token.tokens, visit);
    }

    if (token.type === "list") {
      walkMarkdownTokenTree(token.items, visit);
    } else if (token.type === "table") {
      for (const cell of [...token.header, ...token.rows.flat()]) {
        walkMarkdownTokenTree(cell.tokens, visit);
      }
    }
  }
}

/**
 * Marked applies CommonMark backslash escapes before renderer callbacks. Repair
 * only recognized drive-letter destinations from each token's untouched raw
 * syntax so path separators before punctuation cannot disappear.
 */
function repairWindowsDriveMarkdownDestinations(
  tokens: Token[] | TokensList,
): Token[] | TokensList {
  const referenceCorrections = new Map<string, string | null>();
  const links = "links" in tokens ? tokens.links : undefined;

  walkMarkdownTokenTree(tokens, (token) => {
    if (token.type === "def") {
      const corrected = canonicalizeRawWindowsDriveDestination(
        token.raw,
        "definition",
      );
      if (!corrected || corrected === token.href) return;

      const originalHref = token.href;
      const existing = referenceCorrections.get(originalHref);
      referenceCorrections.set(
        originalHref,
        existing === undefined || existing === corrected ? corrected : null,
      );
      token.href = corrected;
      const link = links?.[token.tag];
      if (link) {
        link.href = corrected;
      }
      return;
    }

    if (token.type !== "link" && token.type !== "image") return;
    const corrected = canonicalizeRawWindowsDriveDestination(
      token.raw,
      "inline",
    );
    if (corrected) {
      token.href = corrected;
    }
  });

  if (referenceCorrections.size > 0) {
    walkMarkdownTokenTree(tokens, (token) => {
      if (token.type !== "link" && token.type !== "image") return;
      const referenceCorrection = referenceCorrections.get(token.href);
      if (referenceCorrection) {
        token.href = referenceCorrection;
      }
    });
  }

  return tokens;
}

function getProjectPathFlavor(path: string): "posix" | "windows" {
  return isWindowsDriveAbsolutePath(path) || path.includes("\\")
    ? "windows"
    : "posix";
}

function isProjectAbsolutePath(
  path: string,
  flavor: "posix" | "windows",
): boolean {
  return flavor === "windows" ? win32.isAbsolute(path) : posix.isAbsolute(path);
}

function resolveProjectPath(
  basePath: string,
  path: string,
  flavor: "posix" | "windows",
): string {
  return flavor === "windows"
    ? win32.resolve(basePath, path)
    : posix.resolve(basePath, path.replaceAll("\\", "/"));
}

function relativeProjectPath(
  fromPath: string,
  toPath: string,
  flavor: "posix" | "windows",
): string {
  return flavor === "windows"
    ? win32.relative(fromPath, toPath)
    : posix.relative(fromPath, toPath);
}

function isPathInsideProject(
  absolutePath: string,
  projectRoot: string,
  flavor: "posix" | "windows",
): boolean {
  const relativePath = relativeProjectPath(projectRoot, absolutePath, flavor);
  return (
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !isProjectAbsolutePath(relativePath, flavor)
  );
}

function resolveLocalRelativePath(
  basePath: string,
  relativePath: string,
): string {
  if (isWindowsDriveAbsolutePath(basePath) || basePath.includes("\\")) {
    return win32.resolve(basePath, relativePath);
  }
  return posix.resolve(basePath, relativePath.replaceAll("\\", "/"));
}

/**
 * Rewrite a local media path to the local-image API endpoint.
 */
function localMediaApiUrl(path: string): string {
  return `/api/local-image?path=${encodeURIComponent(
    parseLocalPathReference(path).filePath,
  )}`;
}

/**
 * Rewrite a local text file path to the local-file API endpoint.
 */
function localFileApiUrl(
  reference: LocalPathReference | string,
  options: { renderMarkdown?: boolean } = {},
): string {
  const parsed = toLocalPathReference(reference);
  let url = `/api/local-file?path=${encodeURIComponent(parsed.filePath)}`;
  if (options.renderMarkdown) {
    url += "&render=1";
  }
  if (parsed.lineNumber !== undefined) {
    url += `&line=${parsed.lineNumber}`;
  }
  if (parsed.columnNumber !== undefined) {
    url += `&column=${parsed.columnNumber}`;
  }
  return url;
}

function localResourceDataAttributes(
  kind: "local-file" | "local-media",
  reference: LocalPathReference | string,
  options: LocalResourceAttributeOptions = {},
): string {
  const parsed = toLocalPathReference(reference);
  const attributes: Array<[string, string]> = [
    ["data-ya-resource", kind],
    ["data-ya-path", parsed.filePath],
  ];

  if (parsed.lineNumber !== undefined) {
    attributes.push(["data-ya-line", String(parsed.lineNumber)]);
  }
  if (parsed.columnNumber !== undefined) {
    attributes.push(["data-ya-column", String(parsed.columnNumber)]);
  }
  if (options.renderMarkdown !== undefined) {
    attributes.push([
      "data-ya-render-markdown",
      options.renderMarkdown ? "true" : "false",
    ]);
  }
  if (options.mediaType) {
    attributes.push(["data-ya-media-type", options.mediaType]);
  }

  return attributes
    .map(([name, value]) => `${name}="${escapeHtml(value)}"`)
    .join(" ");
}

function renderLocalFileLink(
  reference: LocalPathReference | string,
  labelHtml: string,
  options: { renderMarkdown?: boolean; title?: string } = {},
): string {
  const parsed = toLocalPathReference(reference);
  const apiUrl = escapeHtml(
    localFileApiUrl(parsed, { renderMarkdown: options.renderMarkdown }),
  );
  const title = options.title ?? formatLocalPathReference(parsed);
  const titleAttr = ` title="${escapeHtml(title)}"`;
  const resourceAttrs = localResourceDataAttributes("local-file", parsed, {
    renderMarkdown: options.renderMarkdown,
  });
  return `<a href="${apiUrl}"${titleAttr} ${resourceAttrs}>${labelHtml}</a>`;
}

function defaultProjectFileExists(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

function resolveProjectFileCodeReference(
  text: string,
  options: ProjectFileLinkOptions,
): ProjectFileCodeLink | null {
  const trimmed = text.trim();
  if (
    !trimmed ||
    trimmed.includes("\n") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("//")
  ) {
    return null;
  }

  const parsed = parseLocalPathReference(trimmed);
  const filePath = parsed.filePath;
  if (
    !filePath ||
    filePath === "." ||
    filePath.endsWith("/") ||
    filePath.endsWith("\\") ||
    (/^[a-z][a-z0-9+.-]*:/i.test(filePath) &&
      !isWindowsDriveAbsolutePath(filePath))
  ) {
    return null;
  }

  const cacheKey = `${options.projectId}\0${options.projectPath}\0${trimmed}`;
  if (projectFileCodeLinkCache.has(cacheKey)) {
    return projectFileCodeLinkCache.get(cacheKey) ?? null;
  }

  const flavor = getProjectPathFlavor(options.projectPath);
  const projectRoot = resolveProjectPath(options.projectPath, "", flavor);
  const absolutePath = isProjectAbsolutePath(filePath, flavor)
    ? resolveProjectPath(filePath, "", flavor)
    : resolveProjectPath(projectRoot, filePath, flavor);

  if (!isPathInsideProject(absolutePath, projectRoot, flavor)) {
    projectFileCodeLinkCache.set(cacheKey, null);
    return null;
  }

  const relativePath = relativeProjectPath(
    projectRoot,
    absolutePath,
    flavor,
  ).replaceAll("\\", "/");
  if (!relativePath || relativePath.startsWith("..")) {
    projectFileCodeLinkCache.set(cacheKey, null);
    return null;
  }

  const exists = options.fileExists
    ? options.fileExists(absolutePath, relativePath)
    : defaultProjectFileExists(absolutePath);
  if (!exists) {
    projectFileCodeLinkCache.set(cacheKey, null);
    return null;
  }

  const target: ProjectFileCodeLink = {
    absolutePath,
    relativePath,
    lineNumber: parsed.lineNumber,
    columnNumber: parsed.columnNumber,
  };
  projectFileCodeLinkCache.set(cacheKey, target);
  return target;
}

function projectFileViewerHref(
  projectId: string,
  target: ProjectFileCodeLink,
): string {
  const params = new URLSearchParams({ path: target.relativePath });
  if (target.lineNumber !== undefined) {
    params.set("line", String(target.lineNumber));
  }
  if (target.columnNumber !== undefined) {
    params.set("column", String(target.columnNumber));
  }
  return `/projects/${encodeURIComponent(projectId)}/file?${params}`;
}

function renderProjectFileCodeLink(text: string): string | null {
  const options = activeRenderOptions.projectFileLinks;
  if (!options) {
    return null;
  }

  const target = resolveProjectFileCodeReference(text, options);
  if (!target) {
    return null;
  }

  const attributes: Array<[string, string]> = [
    ["class", "fixed-font-file-link"],
    ["href", projectFileViewerHref(options.projectId, target)],
    ["data-ya-resource", "project-file"],
    ["data-ya-project-id", options.projectId],
    ["data-ya-path", target.relativePath],
    ["data-ya-private-project-file-link", "true"],
    [
      "title",
      `${target.relativePath}${target.lineNumber !== undefined ? `:${target.lineNumber}` : ""}\nClick to view, or use a browser link gesture to open this file`,
    ],
  ];
  if (target.lineNumber !== undefined) {
    attributes.push(["data-ya-line", String(target.lineNumber)]);
  }
  if (target.columnNumber !== undefined) {
    attributes.push(["data-ya-column", String(target.columnNumber)]);
  }

  const attrs = attributes
    .map(([name, value]) => `${name}="${escapeHtml(value)}"`)
    .join(" ");
  return `<a ${attrs}><code>${escapeHtml(text)}</code></a>`;
}

/**
 * Render a local media file as a clickable placeholder link.
 * The client intercepts clicks on .local-media-link to open a modal.
 */
function renderLocalMediaLink(
  reference: LocalPathReference | string,
  label: string,
  ext: string,
): string {
  const parsed = toLocalPathReference(reference);
  const apiUrl = escapeHtml(localMediaApiUrl(parsed.filePath));
  const escapedPath = escapeHtml(parsed.filePath);
  const escapedLabel = escapeHtml(label || getFileName(parsed.filePath));
  const mediaType = VIDEO_EXTENSIONS.has(ext) ? "video" : "image";
  const typeLabel = VIDEO_EXTENSIONS.has(ext) ? "video" : "image";
  const defaultExpanded = false;
  const toggleVerb = defaultExpanded ? "Collapse" : "Expand";
  const toggleTitle = defaultExpanded
    ? "Collapse inline preview"
    : "Expand inline preview";
  const toggleText = defaultExpanded ? "-" : "+";
  const resourceAttrs = localResourceDataAttributes("local-media", parsed, {
    mediaType,
  });
  return `<span class="local-media-link-group"><button type="button" class="local-media-inline-toggle" data-media-path="${escapedPath}" data-media-type="${mediaType}" data-expanded="${defaultExpanded}" aria-label="${toggleVerb} ${mediaType}" aria-expanded="${defaultExpanded}" title="${toggleTitle}">${toggleText}</button><a href="${apiUrl}" class="local-media-link" data-media-type="${mediaType}" ${resourceAttrs}>${escapedLabel}<span class="local-media-type">(${typeLabel})</span></a></span><span class="local-media-inline-preview" data-media-path="${escapedPath}" data-media-type="${mediaType}" data-expanded="${defaultExpanded}"></span>`;
}

function renderDirectLocalImage(path: string, altText: string, title?: string) {
  const src = escapeHtml(localMediaApiUrl(path));
  const parsed = parseLocalPathReference(path);
  const ext = getExtension(path);
  const mediaType = VIDEO_EXTENSIONS.has(ext) ? "video" : "image";
  const altAttr = altText ? ` alt="${escapeHtml(altText)}"` : ' alt=""';
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  const resourceAttrs = localResourceDataAttributes("local-media", parsed, {
    mediaType,
  });
  return `<img src="${src}"${altAttr}${titleAttr} ${resourceAttrs}>`;
}

function resolveLocalMarkdownHref(href: string): LocalPathReference | null {
  const trimmed = href.trim();
  if (!trimmed) {
    return null;
  }

  if (isLocalFilePath(trimmed)) {
    return parseLocalPathReference(trimmed);
  }

  const basePath = activeRenderOptions.localFileBasePath;
  if (!basePath) {
    return null;
  }

  if (
    isAbsolute(trimmed) ||
    trimmed.startsWith("#") ||
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  ) {
    return null;
  }

  const parsed = parseLocalPathReference(trimmed);
  const normalized = normalize(parsed.filePath);
  const segments = normalized.split(/[\\/]+/);
  if (
    !normalized ||
    normalized === "." ||
    segments.some((segment) => segment === "..")
  ) {
    return null;
  }

  return {
    filePath: resolveLocalRelativePath(basePath, normalized),
    lineNumber: parsed.lineNumber,
    columnNumber: parsed.columnNumber,
  };
}

const MARKDOWN_SANITIZE_OPTIONS = {
  allowedTags: [
    "a",
    "blockquote",
    "br",
    "button",
    "code",
    "del",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "img",
    "input",
    "li",
    "ol",
    "p",
    "pre",
    "span",
    "strong",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul",
  ],
  allowedAttributes: {
    a: [
      "href",
      "title",
      "class",
      "data-media-type",
      "data-ya-resource",
      "data-ya-path",
      "data-ya-project-id",
      "data-ya-private-project-file-link",
      "data-ya-line",
      "data-ya-line-end",
      "data-ya-column",
      "data-ya-render-markdown",
      "data-ya-download",
      "data-ya-media-type",
    ],
    button: [
      "type",
      "class",
      "data-media-path",
      "data-media-type",
      "data-expanded",
      "aria-label",
      "aria-expanded",
      "title",
    ],
    code: ["class"],
    img: [
      "src",
      "alt",
      "title",
      "data-ya-resource",
      "data-ya-path",
      "data-ya-media-type",
    ],
    input: ["type", "checked", "disabled"],
    ol: ["start"],
    span: ["class", "data-media-path", "data-media-type", "data-expanded"],
    td: ["align"],
    th: ["align"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: {
    a: ["http", "https", "mailto"],
    img: ["http", "https"],
  },
  allowedSchemesAppliedToAttributes: ["href", "src"],
  allowProtocolRelative: false,
  disallowedTagsMode: "escape" as const,
};

const renderer: RendererObject<string, string> = {
  html({ text }) {
    // Disable raw HTML passthrough from markdown by escaping it.
    return escapeHtml(text);
  },
  link(
    this: RendererThis<string, string>,
    { href, title, tokens }: Tokens.Link,
  ) {
    const localPath = resolveLocalMarkdownHref(href);
    if (localPath) {
      const ext = getExtension(localPath.filePath);
      const renderedText = this.parser.parseInline(tokens);

      if (MEDIA_EXTENSIONS.has(ext)) {
        return renderLocalMediaLink(localPath, renderedText, ext);
      }
      return renderLocalFileLink(localPath, renderedText, {
        renderMarkdown: isMarkdownExtension(ext),
        title: title ?? formatLocalPathReference(localPath),
      });
    }

    const safeHref = sanitizeUrl(href);
    const renderedText = this.parser.parseInline(tokens);

    if (!safeHref) {
      // Keep readable text when URL protocol is unsafe.
      return renderedText;
    }

    const escapedHref = escapeHtml(safeHref);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapedHref}"${titleAttr}>${renderedText}</a>`;
  },
  codespan({ text }: Tokens.Codespan) {
    return (
      renderProjectFileCodeLink(text) ?? `<code>${escapeHtml(text)}</code>`
    );
  },
  image({ href, title, text }: Tokens.Image) {
    const localPath = resolveLocalMarkdownHref(href);
    if (localPath) {
      const ext = getExtension(localPath.filePath);

      if (MEDIA_EXTENSIONS.has(ext)) {
        if (
          activeRenderOptions.inlineLocalImages &&
          IMAGE_EXTENSIONS.has(ext)
        ) {
          return renderDirectLocalImage(
            localPath.filePath,
            text,
            title ?? undefined,
          );
        }
        return renderLocalMediaLink(localPath, text, ext);
      }
      // Unrecognized extension — just show text
      return escapeHtml(text || getFileName(localPath.filePath));
    }

    const safeSrc = sanitizeUrl(href, ALLOWED_IMAGE_PROTOCOLS);
    if (!safeSrc) {
      return escapeHtml(text);
    }

    const escapedSrc = escapeHtml(safeSrc);
    const altAttr = text ? ` alt="${escapeHtml(text)}"` : ' alt=""';
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<img src="${escapedSrc}"${altAttr}${titleAttr}>`;
  },
};

const markdownRenderer = new Marked({
  async: false,
  gfm: true,
});

markdownRenderer.use({
  hooks: {
    processAllTokens: repairWindowsDriveMarkdownDestinations,
  },
});

// KaTeX output is generated inside the marked renderer and stashed in
// this buffer; the renderer emits placeholder spans that survive
// sanitize-html unchanged, and we substitute the real HTML back in
// after sanitization. This keeps katex's complex span/svg markup out
// of the sanitize allowlist while still running the rest of the
// markdown through strict sanitization.
//
// Safe as module state because `renderSafeMarkdown` is synchronous and
// Node is single-threaded — no interleaving is possible between reset
// and substitute.
let katexBuffer: string[] = [];

function renderKatexPlaceholder(tex: string, displayMode: boolean): string {
  let html: string;
  try {
    html = katex.renderToString(tex, {
      throwOnError: false,
      displayMode,
      output: "html",
      strict: "ignore",
      trust: false,
    });
  } catch {
    html = `<span class="katex-error">${escapeHtml(tex)}</span>`;
  }
  const id = katexBuffer.length;
  katexBuffer.push(html);
  return `<span class="yepkatex-placeholder yepkatex-id-${id}"></span>`;
}

function findUnescapedDelimiter(
  source: string,
  delimiter: string,
  start = 0,
): number | undefined {
  let index = source.indexOf(delimiter, start);
  while (index >= 0) {
    let precedingBackslashes = 0;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (source[cursor] !== "\\") {
        break;
      }
      precedingBackslashes += 1;
    }
    if (precedingBackslashes % 2 === 0) {
      return index;
    }
    index = source.indexOf(delimiter, index + delimiter.length);
  }
  return undefined;
}

markdownRenderer.use({
  extensions: [
    {
      name: "mathBracketBlock",
      level: "block",
      start(src: string) {
        return findUnescapedDelimiter(src, "\\[");
      },
      tokenizer(src: string) {
        if (!src.startsWith("\\[")) return undefined;
        const closing = findUnescapedDelimiter(src, "\\]", 2);
        if (closing === undefined) return undefined;
        const suffix = /^[ \t]*(?:\n|$)/.exec(src.slice(closing + 2));
        const tex = src.slice(2, closing).trim();
        if (!suffix || !tex) return undefined;
        const rawEnd = closing + 2 + suffix[0].length;
        return {
          type: "mathBracketBlock",
          raw: src.slice(0, rawEnd),
          text: tex,
        };
      },
      renderer(token) {
        const tex = (token as { text?: string }).text ?? "";
        return renderKatexPlaceholder(tex, true);
      },
    },
    {
      name: "mathBlock",
      level: "block",
      start(src: string) {
        const idx = src.indexOf("$$");
        return idx < 0 ? undefined : idx;
      },
      tokenizer(src: string) {
        const match = /^\$\$\s*([\s\S]+?)\s*\$\$(?:\n|$)/.exec(src);
        if (!match) return undefined;
        return {
          type: "mathBlock",
          raw: match[0],
          text: match[1] ?? "",
        };
      },
      renderer(token) {
        const tex = (token as { text?: string }).text ?? "";
        return renderKatexPlaceholder(tex, true);
      },
    },
    {
      name: "mathBracketInline",
      level: "inline",
      start(src: string) {
        return findUnescapedDelimiter(src, "\\(");
      },
      tokenizer(src: string) {
        if (!src.startsWith("\\(")) return undefined;
        const closing = findUnescapedDelimiter(src, "\\)", 2);
        if (closing === undefined) return undefined;
        const tex = src.slice(2, closing).trim();
        if (!tex || tex.includes("\n")) return undefined;
        return {
          type: "mathBracketInline",
          raw: src.slice(0, closing + 2),
          text: tex,
        };
      },
      renderer(token) {
        const tex = (token as { text?: string }).text ?? "";
        return renderKatexPlaceholder(tex, false);
      },
    },
    {
      name: "mathInline",
      level: "inline",
      start(src: string) {
        const idx = src.indexOf("$");
        return idx < 0 ? undefined : idx;
      },
      tokenizer(src: string) {
        // Require non-space immediately after opening $ and before
        // closing $; require non-digit/non-$ after closing $ to avoid
        // matching prices like "$100 and $200".
        const match = /^\$(?!\s)([^\n$]+?)(?<!\s)\$(?![\d$])/.exec(src);
        if (!match) return undefined;
        return {
          type: "mathInline",
          raw: match[0],
          text: match[1] ?? "",
        };
      },
      renderer(token) {
        const tex = (token as { text?: string }).text ?? "";
        return renderKatexPlaceholder(tex, false);
      },
    },
  ],
});

markdownRenderer.use({ renderer });

/**
 * Return a safe absolute URL for markdown links, or null for unsupported schemes.
 */
export function sanitizeUrl(
  url: string,
  allowedProtocols: ReadonlySet<string> = ALLOWED_LINK_PROTOCOLS,
): string | null {
  const trimmed = url.trim();
  if (!trimmed || /\p{C}/u.test(trimmed)) {
    return null;
  }

  const normalized = trimmed.replace(/\s+/g, "");
  if (!normalized) {
    return null;
  }

  try {
    const parsed = new URL(normalized);
    if (!allowedProtocols.has(parsed.protocol.toLowerCase())) {
      return null;
    }
  } catch {
    return null;
  }

  return normalized;
}

/**
 * Render markdown to sanitized HTML with raw HTML disabled.
 */
export function renderSafeMarkdown(
  markdown: string,
  options: SafeMarkdownRenderOptions = {},
): string {
  activeRenderOptions = options;
  projectFileCodeLinkCache = new Map();
  katexBuffer = [];
  try {
    const rendered = markdownRenderer.parse(markdown, { async: false });
    const html = typeof rendered === "string" ? rendered : "";
    const sanitized = sanitizeHtml(html, MARKDOWN_SANITIZE_OPTIONS);
    const substituted = sanitized.replace(
      /<span class="yepkatex-placeholder yepkatex-id-(\d+)"><\/span>/g,
      (_match, idxStr) => katexBuffer[Number(idxStr)] ?? "",
    );
    return substituted.trim();
  } finally {
    katexBuffer = [];
    projectFileCodeLinkCache = new Map();
    activeRenderOptions = {};
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export {
  getExtension as getLocalPathExtension,
  IMAGE_EXTENSIONS,
  isLocalFilePath,
  localFileApiUrl,
  localMediaApiUrl,
  localResourceDataAttributes,
  MEDIA_EXTENSIONS,
  renderLocalFileLink,
  renderLocalMediaLink,
  VIDEO_EXTENSIONS,
};
