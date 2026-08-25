import {
  findProjectPathTokens,
  type ProjectPathLinkTarget,
} from "@yep-anywhere/shared";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { ProjectPathIndex } from "../projects/projectPathIndex.js";
import {
  renderLocalFileLink,
  renderProjectFileViewerLink,
} from "./safe-markdown.js";

/**
 * Turn bare project-relative paths inside highlighted file content into the
 * same local-file links the Markdown viewer produces.
 *
 * Membership in the project's path set is the entire test — a string links
 * because it *is* a file here, not because it looks like one. That is what
 * makes this safe to run over arbitrary content: a JSON value like
 * `"runs/eval-v2.jsonl"` links, and prose about `application/json` or a
 * version like `1.2.3` cannot, without either needing a rule of its own.
 */

/**
 * Characters a path token may contain. Deliberately excludes quotes, brackets,
 * commas and colons so a JSON string, a YAML value, or a bare word in prose
 * yields the path and nothing around it. `&` is excluded because the
 * surrounding HTML is escaped and a decoded entity would not round-trip.
 */
const PATH_TOKEN = /[^\s"'`<>&,:;()[\]{}=|]+/g;

/** One absolute token runs from a whitespace boundary to the next whitespace. */
const ABSOLUTE_PATH_TOKEN = /(?:^|\s)((?:\/(?!\/)|[A-Za-z]:[\\/])\S+)/g;

/** Trailing punctuation a writer adds that is not part of the path. */
const TRAILING_NOISE = /[.!?]+$/;

/** Longest trailing run still read as an extension: `.jsonl`, not a hash. */
const MAX_EXTENSION_LENGTH = 8;
const MIN_ABSOLUTE_PATH_LENGTH = 4;
const MAX_ABSOLUTE_PATH_PROBES = 64;
const VIEWED_FILE_ROOT_PREFIX = /^\$ROOT[\\/](.+)$/;

function mayCostAbsoluteLookup(token: string): boolean {
  return (
    token.length >= MIN_ABSOLUTE_PATH_LENGTH &&
    ((token.startsWith("/") && !token.startsWith("//")) ||
      /^[A-Za-z]:[\\/]/.test(token))
  );
}

function decodeHtmlText(text: string): string {
  return text.replace(
    /&(amp|lt|gt|quot|apos|#39|#\d+|#x[\da-f]+);/gi,
    (entity, name: string) => {
      switch (name.toLowerCase()) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
        case "#39":
          return "'";
        default: {
          const radix = name[1]?.toLowerCase() === "x" ? 16 : 10;
          const digits = name.slice(radix === 16 ? 2 : 1);
          const codePoint = Number.parseInt(digits, radix);
          return Number.isFinite(codePoint) && codePoint <= 0x10ffff
            ? String.fromCodePoint(codePoint)
            : entity;
        }
      }
    },
  );
}

/**
 * Whether a token may cost a filesystem call.
 *
 * A separator, a leading dot, or a trailing extension is what distinguishes a
 * path from an ordinary word. The extension must contain a letter, so a version
 * like `1.2.3` stays a word.
 *
 * This gates *I/O*, not linking. A token failing it is still linked when the
 * cache already proves it, so a bare `Makefile` in a directory that has been
 * listed links for free and only an unlisted one goes unlinked.
 */
function mayCostLookup(token: string): boolean {
  // Only project-relative paths are ever linked, so a leading separator rules
  // the token out outright — which is also what a URL's `//host/path` becomes
  // once the tokenizer drops the scheme at its colon.
  if (token.startsWith("/")) return false;
  if (token.includes("/") || token.startsWith(".")) return true;
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return false;
  const extension = token.slice(dot + 1);
  return (
    extension.length <= MAX_EXTENSION_LENGTH &&
    /^[A-Za-z0-9]+$/.test(extension) &&
    /[A-Za-z]/.test(extension)
  );
}

/** Whether this markup opens or closes an element, and which. */
function tagName(tag: string): { closing: boolean; name: string } | null {
  const match = /^<(\/?)([A-Za-z][A-Za-z0-9]*)/.exec(tag);
  if (!match) return null;
  return { closing: match[1] === "/", name: match[2]!.toLowerCase() };
}

/**
 * Rewrite the text between tags, leaving markup untouched.
 *
 * Highlighted HTML nests spans per token, so a match is only looked for inside
 * one text run: a path split across two spans stays unlinked rather than
 * risking a rewrite that crosses a tag boundary.
 *
 * Text inside an existing `<a>` is left alone. Highlighted source contains no
 * anchors, but rendered turn text does — from Markdown links and from the
 * inline-code file linker — and an anchor nested inside an anchor is not
 * markup any browser can be asked to render.
 */
function mapHtmlTextRuns(
  html: string,
  mapText: (text: string) => string,
): string {
  let out = "";
  let index = 0;
  let anchorDepth = 0;
  while (index < html.length) {
    const tagStart = html.indexOf("<", index);
    if (tagStart < 0) {
      out += anchorDepth > 0 ? html.slice(index) : mapText(html.slice(index));
      break;
    }
    const text = html.slice(index, tagStart);
    out += anchorDepth > 0 ? text : mapText(text);
    const tagEnd = html.indexOf(">", tagStart);
    if (tagEnd < 0) {
      out += html.slice(tagStart);
      break;
    }
    const tag = html.slice(tagStart, tagEnd + 1);
    out += tag;
    const parsed = tagName(tag);
    if (parsed?.name === "a") {
      if (parsed.closing) anchorDepth = Math.max(0, anchorDepth - 1);
      else anchorDepth += 1;
    }
    index = tagEnd + 1;
  }
  return out;
}

export interface ProjectPathLinkOptions {
  /** Project whose authenticated FileViewer route owns generated links. */
  projectId?: string;
  /** Absolute path of the project the content belongs to. */
  projectPath: string;
  index: ProjectPathIndex;
  /** Project-relative viewed-file path; owns sibling resolution and self-suppression. */
  selfRelativePath?: string;
  /**
   * Spend filesystem I/O only on path-shaped tokens.
   *
   * Set for prose, where most words are words. The file viewer leaves it off:
   * every token there came out of a file the reader is already looking at, and
   * one batch groups them by directory anyway.
   */
  gateLookupsByShape?: boolean;
  /** Marks direct filesystem answers that no live watcher versions. */
  onUnversionedLookup?: () => void;
  /** Authenticated, allow-set-aware exact probes. Omit for public shares. */
  resolveAbsoluteFilePaths?: (
    paths: readonly string[],
  ) => Promise<ReadonlySet<string>>;
}

interface ResolvedProjectPathCandidates {
  absolute: ReadonlySet<string>;
  relative: ReadonlyMap<string, string>;
}

function viewedFileDirectory(selfRelativePath: string | undefined): {
  directory: string;
  self: string;
} | null {
  if (
    !selfRelativePath ||
    isAbsolute(selfRelativePath) ||
    /^[A-Za-z]:[\\/]/.test(selfRelativePath) ||
    /^[/\\]{2}/.test(selfRelativePath)
  ) {
    return null;
  }
  const self = normalize(selfRelativePath);
  if (self === ".." || self.startsWith(`..${sep}`)) return null;
  return { directory: dirname(self), self };
}

function relativeCandidateTargets(
  candidates: readonly string[],
  selfRelativePath: string | undefined,
): ReadonlyMap<string, readonly string[]> {
  const viewedFile = viewedFileDirectory(selfRelativePath);
  const targets = new Map<string, readonly string[]>();
  for (const candidate of candidates) {
    const rootRelative = viewedFile
      ? VIEWED_FILE_ROOT_PREFIX.exec(candidate)?.[1]
      : undefined;
    const projectTarget = viewedFile
      ? normalize(rootRelative ?? candidate)
      : candidate;
    if (viewedFile && projectTarget === viewedFile.self) continue;

    const ordered = [projectTarget];
    if (viewedFile) {
      const fileTarget = join(viewedFile.directory, projectTarget);
      if (fileTarget !== projectTarget && fileTarget !== viewedFile.self) {
        ordered.push(fileTarget);
      }
    }
    targets.set(candidate, ordered);
  }
  return targets;
}

async function resolveProjectPathCandidates(
  relativeCandidates: readonly string[],
  absoluteCandidates: readonly string[],
  {
    index,
    selfRelativePath,
    gateLookupsByShape,
    onUnversionedLookup,
    resolveAbsoluteFilePaths,
  }: ProjectPathLinkOptions,
): Promise<ResolvedProjectPathCandidates | null> {
  const candidateTargets = relativeCandidateTargets(
    relativeCandidates,
    selfRelativePath,
  );
  const worthLookup = Array.from(
    new Set(
      relativeCandidates
        .filter((candidate) =>
          gateLookupsByShape ? mayCostLookup(candidate) : true,
        )
        .flatMap((candidate) => candidateTargets.get(candidate) ?? []),
    ),
  );

  const relative = new Map<string, string>();
  let absolute = new Set<string>();
  try {
    const [existingRelative, existingAbsolute] = await Promise.all([
      index.findExisting(worthLookup),
      absoluteCandidates.length > 0
        ? resolveAbsoluteFilePaths?.(absoluteCandidates)
        : undefined,
    ]);
    for (const candidate of relativeCandidates) {
      const target = candidateTargets
        .get(candidate)
        ?.find((path) => existingRelative.has(path));
      if (target) relative.set(candidate, target);
    }
    absolute = new Set(existingAbsolute);
  } catch {
    // Link discovery is advisory. An unavailable index must not fail the view
    // that owns the source text.
    onUnversionedLookup?.();
    return null;
  }

  if (worthLookup.some((path) => index.knownFile(path) === undefined)) {
    onUnversionedLookup?.();
  }
  if (absoluteCandidates.length > 0) {
    onUnversionedLookup?.();
  }
  if (gateLookupsByShape) {
    // A token not worth a lookup is still worth an answer the cache already
    // holds, which is what keeps `Makefile` and `LICENSE` linking.
    for (const candidate of relativeCandidates) {
      if (mayCostLookup(candidate)) continue;
      const target = candidateTargets
        .get(candidate)
        ?.find((path) => index.knownFile(path) === true);
      if (target) {
        relative.set(candidate, target);
      }
    }
  }

  return { absolute, relative };
}

/** Resolve raw command/result text to a small exact-link annotation. */
export async function resolveProjectPathTextLinks(
  text: string,
  options: ProjectPathLinkOptions,
): Promise<ProjectPathLinkTarget[]> {
  if (!text) return [];

  const tokens = findProjectPathTokens(text);
  const relativeCandidates = Array.from(
    new Set(
      tokens
        .filter((token) => token.kind === "relative")
        .map((token) => token.text)
        .filter((token) => token !== options.selfRelativePath),
    ),
  );
  const absoluteCandidates =
    options.projectId && options.resolveAbsoluteFilePaths
      ? Array.from(
          new Set(
            tokens
              .filter(
                (token) =>
                  token.kind === "absolute" &&
                  mayCostAbsoluteLookup(token.text),
              )
              .map((token) => token.text),
          ),
        ).slice(0, MAX_ABSOLUTE_PATH_PROBES)
      : [];
  if (relativeCandidates.length === 0 && absoluteCandidates.length === 0) {
    return [];
  }

  const resolved = await resolveProjectPathCandidates(
    relativeCandidates,
    absoluteCandidates,
    options,
  );
  if (!resolved) return [];

  const targets = new Map<string, ProjectPathLinkTarget>();
  for (const token of tokens) {
    const filePath =
      token.kind === "absolute"
        ? resolved.absolute.has(token.text)
          ? token.text
          : undefined
        : resolved.relative.get(token.text);
    if (!filePath || targets.has(token.text)) continue;
    targets.set(token.text, {
      filePath,
      text: token.text,
    });
  }
  return Array.from(targets.values());
}

/**
 * Hydrate the index for every path-shaped token in raw source text.
 *
 * Rendering asks about membership synchronously — the inline-code file linker
 * has no place to await — so one batched asynchronous pass over the source runs
 * first and turns those later questions into cache hits. Batching is also what
 * lets the index list a directory once instead of probing each name in it.
 */
export async function resolveShapedPaths(
  text: string,
  index: ProjectPathIndex,
): Promise<boolean> {
  const shaped = new Set<string>();
  PATH_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null = PATH_TOKEN.exec(text);
  while (match !== null) {
    const trimmed = match[0].replace(TRAILING_NOISE, "");
    if (trimmed && mayCostLookup(trimmed)) shaped.add(trimmed);
    match = PATH_TOKEN.exec(text);
  }
  if (shaped.size === 0) return true;
  const paths = Array.from(shaped);
  await index.findExisting(paths);
  return paths.every((path) => index.knownFile(path) !== undefined);
}

function collectCandidatePaths(
  html: string,
  selfRelativePath: string | undefined,
): string[] {
  const candidates = new Set<string>();
  mapHtmlTextRuns(html, (text) => {
    PATH_TOKEN.lastIndex = 0;
    let match: RegExpExecArray | null = PATH_TOKEN.exec(text);
    while (match !== null) {
      const trimmed = match[0].replace(TRAILING_NOISE, "");
      if (trimmed && !trimmed.startsWith("/") && trimmed !== selfRelativePath) {
        candidates.add(trimmed);
      }
      match = PATH_TOKEN.exec(text);
    }
    return text;
  });
  return Array.from(candidates);
}

function collectAbsoluteCandidatePaths(html: string): string[] {
  const candidates = new Set<string>();
  mapHtmlTextRuns(html, (text) => {
    ABSOLUTE_PATH_TOKEN.lastIndex = 0;
    let match: RegExpExecArray | null = ABSOLUTE_PATH_TOKEN.exec(text);
    while (match !== null) {
      const token = match[1];
      if (token) candidates.add(decodeHtmlText(token));
      match = ABSOLUTE_PATH_TOKEN.exec(text);
    }
    return text;
  });
  return Array.from(candidates);
}

function linkAbsolutePaths(
  html: string,
  projectId: string,
  existing: ReadonlySet<string>,
): string {
  return mapHtmlTextRuns(html, (text) => {
    ABSOLUTE_PATH_TOKEN.lastIndex = 0;
    let out = "";
    let cursor = 0;
    let match: RegExpExecArray | null = ABSOLUTE_PATH_TOKEN.exec(text);
    while (match !== null) {
      const encodedToken = match[1];
      if (encodedToken) {
        const token = decodeHtmlText(encodedToken);
        if (existing.has(token)) {
          const start = match.index + match[0].length - encodedToken.length;
          out += text.slice(cursor, start);
          out += renderProjectFileViewerLink(projectId, token, token);
          cursor = start + encodedToken.length;
        }
      }
      match = ABSOLUTE_PATH_TOKEN.exec(text);
    }
    return cursor === 0 ? text : out + text.slice(cursor);
  });
}

/**
 * Link every project-relative path occurring in already-highlighted HTML.
 * Returns the input unchanged when the project has no indexed paths, so an
 * unavailable index degrades to today's plain content rather than an error.
 */
export async function linkifyProjectPaths(
  html: string,
  {
    projectPath,
    projectId,
    index,
    selfRelativePath,
    gateLookupsByShape,
    onUnversionedLookup,
    resolveAbsoluteFilePaths,
  }: ProjectPathLinkOptions,
): Promise<string> {
  if (!html) return html;

  const relativeCandidates = collectCandidatePaths(html, selfRelativePath);
  const absoluteCandidates =
    projectId && resolveAbsoluteFilePaths
      ? collectAbsoluteCandidatePaths(html)
          .filter(mayCostAbsoluteLookup)
          .slice(0, MAX_ABSOLUTE_PATH_PROBES)
      : [];
  if (relativeCandidates.length === 0 && absoluteCandidates.length === 0) {
    return html;
  }

  const resolved = await resolveProjectPathCandidates(
    relativeCandidates,
    absoluteCandidates,
    {
      projectPath,
      projectId,
      index,
      selfRelativePath,
      gateLookupsByShape,
      onUnversionedLookup,
      resolveAbsoluteFilePaths,
    },
  );
  if (!resolved) return html;

  const existing = resolved.relative;
  const existingAbsolute = resolved.absolute;
  let linkedHtml =
    projectId && existingAbsolute.size > 0
      ? linkAbsolutePaths(html, projectId, existingAbsolute)
      : html;
  if (existing.size === 0) return linkedHtml;

  linkedHtml = mapHtmlTextRuns(linkedHtml, (text) => {
    if (!text) return text;
    PATH_TOKEN.lastIndex = 0;
    let out = "";
    let cursor = 0;
    let match: RegExpExecArray | null = PATH_TOKEN.exec(text);
    while (match !== null) {
      const token = match[0];
      const trimmed = token.replace(TRAILING_NOISE, "");
      const target = trimmed ? existing.get(trimmed) : undefined;
      if (trimmed && target) {
        const start = match.index;
        out += text.slice(cursor, start);
        out += renderLocalFileLink(
          { filePath: resolve(projectPath, target) },
          trimmed,
          { title: trimmed },
        );
        out += token.slice(trimmed.length);
        cursor = start + token.length;
      }
      match = PATH_TOKEN.exec(text);
    }
    return cursor === 0 ? text : out + text.slice(cursor);
  });
  return linkedHtml;
}
