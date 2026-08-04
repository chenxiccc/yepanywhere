import { statSync } from "node:fs";
import { isAbsolute, normalize, posix, win32 } from "node:path";
import { katex as markdownItKatex } from "@mdit/plugin-katex";
import { parseLineColumn } from "@yep-anywhere/shared";
import MarkdownIt, {
  type Env,
  type Renderer,
  type RendererRule,
  type StateCore,
  type Token,
} from "markdown-it";
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

function repairWindowsDriveInlineDestinations(source: string): string {
  let result = "";
  let cursor = 0;

  while (cursor < source.length) {
    if (source[cursor] === "`") {
      let markerEnd = cursor + 1;
      while (source[markerEnd] === "`") markerEnd += 1;
      const marker = source.slice(cursor, markerEnd);
      const closing = source.indexOf(marker, markerEnd);
      if (closing >= 0) {
        const end = closing + marker.length;
        result += source.slice(cursor, end);
        cursor = end;
        continue;
      }
      result += marker;
      cursor = markerEnd;
      continue;
    }

    const remainder = source.slice(cursor);
    const destination = findRawWindowsDriveDestination(remainder, "inline");
    if (!destination) {
      result += remainder;
      break;
    }

    const nextBacktick = source.indexOf("`", cursor);
    if (nextBacktick >= 0 && nextBacktick - cursor < destination.pathStart) {
      result += source.slice(cursor, nextBacktick);
      cursor = nextBacktick;
      continue;
    }

    const corrected = canonicalizeRawWindowsDriveDestination(
      remainder,
      "inline",
    );
    if (!corrected) {
      result += remainder;
      break;
    }

    const pathStart = cursor + destination.pathStart;
    let pathEnd = pathStart;
    let parenthesisDepth = 0;
    while (pathEnd < source.length) {
      const character = source[pathEnd];
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

    result += source.slice(cursor, pathStart);
    result += corrected;
    cursor = pathEnd;
  }

  return result;
}

/**
 * Repair drive-letter destinations before markdown-it consumes backslash
 * escapes. Block parsing has already excluded fenced/indented code; the inline
 * scanner additionally skips matching backtick spans.
 */
function repairWindowsDriveMarkdownDestinations(state: StateCore): void {
  const seenReferences = new Set<string>();
  let lineStarts: number[] | undefined;

  for (const token of state.tokens) {
    if (token.type === "inline") {
      token.content = repairWindowsDriveInlineDestinations(token.content);
      continue;
    }

    if (token.type !== "reference_definition" || !token.map) continue;
    const label = token.meta?.label;
    if (typeof label !== "string" || seenReferences.has(label)) continue;
    seenReferences.add(label);

    lineStarts ??= sourceLineStartOffsets(state.src);
    const start = lineStarts[token.map[0]] ?? state.src.length;
    const end = lineStarts[token.map[1]] ?? state.src.length;
    const raw = state.src.slice(start, end);
    const corrected = canonicalizeRawWindowsDriveDestination(raw, "definition");
    const reference = state.env.references?.[label];
    if (corrected && reference) {
      reference.href = corrected;
    }
  }
}

function sourceLineStartOffsets(source: string): number[] {
  const starts = [0];
  let newline = source.indexOf("\n");
  while (newline >= 0) {
    starts.push(newline + 1);
    newline = source.indexOf("\n", newline + 1);
  }
  if (starts[starts.length - 1] !== source.length) {
    starts.push(source.length);
  }
  return starts;
}

const LITERAL_MATH_META = "yaLiteralMath";

function preserveUnclosedMathBlocks(state: StateCore): void {
  let lineStarts: number[] | undefined;
  for (const token of state.tokens) {
    if (token.type !== "math_block" || !token.map) continue;
    lineStarts ??= sourceLineStartOffsets(state.src);
    const start = lineStarts[token.map[0]] ?? state.src.length;
    const end = lineStarts[token.map[1]] ?? state.src.length;
    const raw = state.src.slice(start, end);
    const closing = token.markup === "\\[" ? "\\]" : token.markup;
    const trimmed = raw.trimEnd();
    if (trimmed.length > closing.length && trimmed.endsWith(closing)) continue;

    token.meta ??= {};
    token.meta[LITERAL_MATH_META] = raw;
  }
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
  return `${renderLocalFileLinkOpen(reference, options)}${labelHtml}</a>`;
}

function renderLocalFileLinkOpen(
  reference: LocalPathReference | string,
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
  return `<a href="${apiUrl}"${titleAttr} ${resourceAttrs}>`;
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

function renderProjectFileLinkOpen(
  options: ProjectFileLinkOptions,
  target: ProjectFileCodeLink,
  linkOptions: {
    className?: string;
    privateReference?: boolean;
    title?: string;
  } = {},
): string {
  const attributes: Array<[string, string]> = [
    ["href", projectFileViewerHref(options.projectId, target)],
    ["data-ya-resource", "project-file"],
    ["data-ya-project-id", options.projectId],
    ["data-ya-path", target.relativePath],
    [
      "title",
      linkOptions.title ??
        `${target.relativePath}${target.lineNumber !== undefined ? `:${target.lineNumber}` : ""}\nClick to view, or use a browser link gesture to open this file`,
    ],
  ];
  if (linkOptions.className) {
    attributes.unshift(["class", linkOptions.className]);
  }
  if (linkOptions.privateReference) {
    attributes.push(["data-ya-private-project-file-link", "true"]);
  }
  if (target.lineNumber !== undefined) {
    attributes.push(["data-ya-line", String(target.lineNumber)]);
  }
  if (target.columnNumber !== undefined) {
    attributes.push(["data-ya-column", String(target.columnNumber)]);
  }

  const attrs = attributes
    .map(([name, value]) => `${name}="${escapeHtml(value)}"`)
    .join(" ");
  return `<a ${attrs}>`;
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
  const open = renderProjectFileLinkOpen(options, target, {
    className: "fixed-font-file-link",
    privateReference: true,
  });
  return `${open}<code>${escapeHtml(text)}</code></a>`;
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
  const parts = renderLocalMediaLinkParts(reference, ext);
  const parsed = toLocalPathReference(reference);
  const escapedLabel = escapeHtml(label || getFileName(parsed.filePath));
  return `${parts.open}${escapedLabel}${parts.close}`;
}

function renderLocalMediaLinkParts(
  reference: LocalPathReference | string,
  ext: string,
): { close: string; open: string } {
  const parsed = toLocalPathReference(reference);
  const apiUrl = escapeHtml(localMediaApiUrl(parsed.filePath));
  const escapedPath = escapeHtml(parsed.filePath);
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
  return {
    open: `<span class="local-media-link-group"><button type="button" class="local-media-inline-toggle" data-media-path="${escapedPath}" data-media-type="${mediaType}" data-expanded="${defaultExpanded}" aria-label="${toggleVerb} ${mediaType}" aria-expanded="${defaultExpanded}" title="${toggleTitle}">${toggleText}</button><a href="${apiUrl}" class="local-media-link" data-media-type="${mediaType}" ${resourceAttrs}>`,
    close: `<span class="local-media-type">(${typeLabel})</span></a></span><span class="local-media-inline-preview" data-media-path="${escapedPath}" data-media-type="${mediaType}" data-expanded="${defaultExpanded}"></span>`,
  };
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
  const normalizedHref = href.trim();
  let trimmed = normalizedHref;
  try {
    trimmed = decodeURIComponent(normalizedHref);
  } catch {
    // Preserve malformed percent sequences as literal path characters.
  }
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

const LINK_SUFFIXES: unique symbol = Symbol("safeMarkdownLinkSuffixes");

interface SafeMarkdownEnvironment extends Env {
  [LINK_SUFFIXES]?: string[];
}

// KaTeX output is generated inside the markdown renderer and stashed in
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

function storeKatexPlaceholder(html: string, _displayMode: boolean): string {
  const id = katexBuffer.length;
  katexBuffer.push(html);
  return `<span class="yepkatex-placeholder yepkatex-id-${id}"></span>`;
}

function renderLinkOpen(
  tokens: Token[],
  index: number,
  _options: Parameters<RendererRule>[2],
  environment: Env | undefined,
): string {
  const token = tokens[index];
  if (!token) return "";
  const href = String(token.attrGet("href") ?? "");
  const titleValue = token.attrGet("title");
  const title = titleValue === null ? undefined : String(titleValue);
  const localPath = resolveLocalMarkdownHref(href);
  let open = "";
  let close = "";

  if (localPath) {
    const ext = getExtension(localPath.filePath);
    if (MEDIA_EXTENSIONS.has(ext)) {
      const parts = renderLocalMediaLinkParts(localPath, ext);
      open = parts.open;
      close = parts.close;
    } else {
      const projectOptions = activeRenderOptions.projectFileLinks;
      const projectTarget = projectOptions
        ? resolveProjectFileCodeReference(
            formatLocalPathReference(localPath),
            projectOptions,
          )
        : null;
      open = projectOptions && projectTarget
        ? renderProjectFileLinkOpen(projectOptions, projectTarget, {
            title: title ?? formatLocalPathReference(localPath),
          })
        : renderLocalFileLinkOpen(localPath, {
            renderMarkdown: isMarkdownExtension(ext),
            title: title ?? formatLocalPathReference(localPath),
          });
      close = "</a>";
    }
  } else {
    const safeHref = sanitizeUrl(href);
    if (safeHref) {
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      open = `<a href="${escapeHtml(safeHref)}"${titleAttr}>`;
      close = "</a>";
    }
  }

  const safeEnvironment = environment as SafeMarkdownEnvironment | undefined;
  const suffixes = safeEnvironment?.[LINK_SUFFIXES] ?? [];
  suffixes.push(close);
  if (safeEnvironment) safeEnvironment[LINK_SUFFIXES] = suffixes;
  return open;
}

function renderLinkClose(
  _tokens: Token[],
  _index: number,
  _options: Parameters<RendererRule>[2],
  environment: Env | undefined,
): string {
  const suffixes = (environment as SafeMarkdownEnvironment | undefined)?.[
    LINK_SUFFIXES
  ];
  return suffixes?.pop() ?? "";
}

function renderCodeInline(tokens: Token[], index: number): string {
  const text = tokens[index]?.content ?? "";
  return renderProjectFileCodeLink(text) ?? `<code>${escapeHtml(text)}</code>`;
}

function renderImage(
  tokens: Token[],
  index: number,
  options: Parameters<RendererRule>[2],
  environment: Env | undefined,
  renderer: Renderer,
): string {
  const token = tokens[index];
  if (!token) return "";
  const href = String(token.attrGet("src") ?? "");
  const titleValue = token.attrGet("title");
  const title = titleValue === null ? undefined : String(titleValue);
  const text = renderer.renderInlineAsText(
    token.children ?? [],
    options,
    environment,
  );
  const localPath = resolveLocalMarkdownHref(href);
  if (localPath) {
    const ext = getExtension(localPath.filePath);
    if (MEDIA_EXTENSIONS.has(ext)) {
      if (activeRenderOptions.inlineLocalImages && IMAGE_EXTENSIONS.has(ext)) {
        return renderDirectLocalImage(localPath.filePath, text, title);
      }
      return renderLocalMediaLink(localPath, text, ext);
    }
    return escapeHtml(text || getFileName(localPath.filePath));
  }

  const safeSrc = sanitizeUrl(href, ALLOWED_IMAGE_PROTOCOLS);
  if (!safeSrc) return escapeHtml(text);
  const altAttr = text ? ` alt="${escapeHtml(text)}"` : ' alt=""';
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<img src="${escapeHtml(safeSrc)}"${altAttr}${titleAttr}>`;
}

function renderTableCellOpen(
  tokens: Token[],
  index: number,
  options: Parameters<RendererRule>[2],
  _environment: Env | undefined,
  renderer: Renderer,
): string {
  const token = tokens[index];
  if (!token) return "";
  const styleIndex = token.attrIndex("style");
  if (styleIndex >= 0 && token.attrs) {
    const style = String(token.attrs[styleIndex]?.[1] ?? "");
    const alignment = /^text-align:(left|center|right)$/.exec(style)?.[1];
    token.attrs.splice(styleIndex, 1);
    if (alignment) token.attrSet("align", alignment);
  }
  return renderer.renderToken(tokens, index, options);
}

function renderTaskListItems(state: StateCore): void {
  const pendingItems: boolean[] = [];
  for (const token of state.tokens) {
    if (token.type === "list_item_open") {
      pendingItems.push(true);
      continue;
    }
    if (token.type === "list_item_close") {
      pendingItems.pop();
      continue;
    }
    if (
      token.type !== "inline" ||
      pendingItems.length === 0 ||
      !pendingItems[pendingItems.length - 1]
    ) {
      continue;
    }

    pendingItems[pendingItems.length - 1] = false;
    const first = token.children?.[0];
    if (first?.type !== "text") continue;
    const match = /^\[([ xX])\]\s+/.exec(first.content);
    if (!match) continue;

    first.content = first.content.slice(match[0].length);
    const checkbox = new state.Token("html_inline", "", 0);
    checkbox.content = `<input${match[1]?.toLowerCase() === "x" ? ' checked=""' : ""} disabled="" type="checkbox"> `;
    token.children?.unshift(checkbox);
  }
}

const markdownRenderer = new MarkdownIt({
  breaks: false,
  html: false,
  linkify: true,
  typographer: false,
  xhtmlOut: false,
}).disable("strip_references");

markdownRenderer.use(markdownItKatex, {
  allowInlineWithSpace: false,
  delimiters: "all",
  logger: (): "ignore" => "ignore",
  mathFence: false,
  maxExpand: 1000,
  output: "html",
  throwOnError: false,
  transformer: storeKatexPlaceholder,
  trust: false,
});

function preserveEmptyMath(
  rendererRule: RendererRule,
  displayMode: boolean,
): RendererRule {
  return (tokens, index, options, environment, renderer) => {
    const token = tokens[index];
    if (!token) return "";
    const literalSource = token.meta?.[LITERAL_MATH_META];
    if (typeof literalSource === "string") {
      const literal = escapeHtml(literalSource);
      return displayMode ? `<p>${literal}</p>\n` : literal;
    }
    if (token.content.trim()) {
      return rendererRule(tokens, index, options, environment, renderer);
    }

    const opening = token.markup || (displayMode ? "$$" : "$");
    const closing =
      opening === "\\[" ? "\\]" : opening === "\\(" ? "\\)" : opening;
    const literal = escapeHtml(`${opening}${closing}`);
    return displayMode ? `<p>${literal}</p>\n` : literal;
  };
}

const pluginMathInlineRenderer = markdownRenderer.renderer.rules.math_inline;
const pluginMathBlockRenderer = markdownRenderer.renderer.rules.math_block;
if (!pluginMathInlineRenderer || !pluginMathBlockRenderer) {
  throw new Error("@mdit/plugin-katex did not register its renderer rules");
}
markdownRenderer.renderer.rules.math_inline = preserveEmptyMath(
  pluginMathInlineRenderer,
  false,
);
markdownRenderer.renderer.rules.math_block = preserveEmptyMath(
  pluginMathBlockRenderer,
  true,
);

// Parse every link, including unsafe schemes, so the renderer can keep its
// readable label while dropping the unsafe destination.
markdownRenderer.validateLink = () => true;
markdownRenderer.core.ruler.after(
  "block",
  "ya_windows_drive_paths",
  repairWindowsDriveMarkdownDestinations,
);
markdownRenderer.core.ruler.after(
  "block",
  "ya_unclosed_math_blocks",
  preserveUnclosedMathBlocks,
);
markdownRenderer.core.ruler.after(
  "text_join",
  "ya_task_list_items",
  renderTaskListItems,
);
markdownRenderer.renderer.rules.link_open = renderLinkOpen;
markdownRenderer.renderer.rules.link_close = renderLinkClose;
markdownRenderer.renderer.rules.code_inline = renderCodeInline;
markdownRenderer.renderer.rules.image = renderImage;
markdownRenderer.renderer.rules.th_open = renderTableCellOpen;
markdownRenderer.renderer.rules.td_open = renderTableCellOpen;

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

export interface MarkdownSourceSpan {
  endLine: number;
  level: number;
  nesting: -1 | 0 | 1;
  startLine: number;
  type: string;
}

/**
 * Parse Markdown into the block/source spans used by aligned projections.
 * Lines are one-based and inclusive; closing-only tokens have no source map
 * and are omitted.
 */
export function parseMarkdownSourceSpans(
  markdown: string,
): MarkdownSourceSpan[] {
  const tokens = markdownRenderer.parse(markdown, {});
  const spans: MarkdownSourceSpan[] = [];
  for (const token of tokens) {
    if (!token.map) continue;
    spans.push({
      endLine: token.map[1],
      level: token.level,
      nesting: token.nesting,
      startLine: token.map[0] + 1,
      type: token.type,
    });
  }
  return spans;
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
    const environment: SafeMarkdownEnvironment = {};
    const html = markdownRenderer.render(markdown, environment);
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
