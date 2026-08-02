/**
 * Shiki-based syntax highlighting service.
 *
 * Uses CSS variables for theming so client can switch light/dark without
 * re-rendering. Pre-loads common languages for fast highlighting.
 */

import { createHash } from "node:crypto";
import {
  type BundledLanguage,
  type Highlighter,
  bundledLanguages,
  createHighlighter,
} from "shiki";
import { createCssVariablesTheme } from "shiki/core";

/** Maximum lines to highlight (avoid blocking on huge files) */
const MAX_LINES = 10000;

/**
 * Retained highlighted output, in bytes of generated HTML.
 *
 * Tokenizing is the dominant cost of a Source Control diff — roughly 90µs per
 * line — and the same two file versions are highlighted again on every diff
 * refetch, every whitespace/full-context toggle, and every reselection. A
 * version's content determines its highlighting exactly, so the result is
 * cacheable without any staleness window.
 */
const HIGHLIGHT_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/** Languages to pre-load on startup */
const PRELOADED_LANGUAGES: BundledLanguage[] = [
  "javascript",
  "typescript",
  "tsx",
  "jsx",
  "python",
  "bash",
  "shell",
  "json",
  "css",
  "html",
  "yaml",
  "sql",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "markdown",
  "diff",
];

/** CSS variables theme - outputs `style="color: var(--shiki-...)"` */
const cssVarsTheme = createCssVariablesTheme({
  name: "css-variables",
  variablePrefix: "--shiki-",
  fontStyle: true,
});

/** Extension to Shiki language mapping */
const EXTENSION_TO_LANG: Record<string, BundledLanguage> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  scala: "scala",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  cs: "csharp",
  swift: "swift",
  m: "objective-c",
  mm: "objective-c",
  php: "php",
  pl: "perl",
  pm: "perl",
  lua: "lua",
  r: "r",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  elm: "elm",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hrl: "erlang",
  hs: "haskell",
  clj: "clojure",
  cljs: "clojure",
  cljc: "clojure",
  ml: "ocaml",
  mli: "ocaml",
  fs: "fsharp",
  fsx: "fsharp",
  dart: "dart",
  nim: "nim",
  zig: "zig",
  sol: "solidity",
  proto: "protobuf",
  prisma: "prisma",
  dockerfile: "dockerfile",
  makefile: "makefile",
  cmake: "cmake",
  gradle: "groovy",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  ps1: "powershell",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  md: "markdown",
  markdown: "markdown",
  diff: "diff",
  patch: "diff",
};

let highlighterPromise: Promise<Highlighter> | null = null;
let loadedLanguages: Set<string> = new Set();

/** Insertion-ordered, so the oldest key is the first `keys()` entry. */
const highlightCache = new Map<string, HighlightResult>();
let highlightCacheBytes = 0;

function highlightCacheKey(code: string, lang: BundledLanguage): string {
  return `${lang}\0${createHash("sha1").update(code).digest("base64")}`;
}

function readHighlightCache(key: string): HighlightResult | null {
  const hit = highlightCache.get(key);
  if (!hit) return null;
  // Re-insert so eviction sees this as the most recently used entry.
  highlightCache.delete(key);
  highlightCache.set(key, hit);
  return hit;
}

function writeHighlightCache(key: string, result: HighlightResult): void {
  const bytes = result.html.length;
  if (bytes > HIGHLIGHT_CACHE_MAX_BYTES) return;

  // Two requests can miss on the same content and both write. Discount the
  // entry being replaced, or the running total drifts above the real retained
  // size and evicts entries that still fit.
  const replaced = highlightCache.get(key);
  if (replaced) highlightCacheBytes -= replaced.html.length;

  highlightCache.set(key, result);
  highlightCacheBytes += bytes;
  while (highlightCacheBytes > HIGHLIGHT_CACHE_MAX_BYTES) {
    const oldest = highlightCache.keys().next();
    if (oldest.done) break;
    const evicted = highlightCache.get(oldest.value);
    highlightCache.delete(oldest.value);
    highlightCacheBytes -= evicted?.html.length ?? 0;
  }
}

/**
 * Get or create the singleton highlighter instance.
 */
async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [cssVarsTheme],
      langs: PRELOADED_LANGUAGES,
    }).then((h) => {
      loadedLanguages = new Set(PRELOADED_LANGUAGES);
      return h;
    });
  }
  return highlighterPromise;
}

/**
 * Get the Shiki language for a file path based on extension.
 * Returns null if the extension is unknown.
 */
export function getLanguageForPath(filePath: string): BundledLanguage | null {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext) return null;

  const lang = EXTENSION_TO_LANG[ext];
  if (lang && lang in bundledLanguages) {
    return lang;
  }
  return null;
}

export interface HighlightResult {
  html: string;
  language: string;
  lineCount: number;
  truncated: boolean;
}

/**
 * Highlight code with syntax highlighting.
 *
 * @param code - The code to highlight
 * @param language - The language (Shiki language id or file extension)
 * @returns Highlighted HTML or null if language is unsupported
 */
export async function highlightCode(
  code: string,
  language: string,
): Promise<HighlightResult | null> {
  const highlighter = await getHighlighter();

  // Resolve language from extension if needed
  let lang: BundledLanguage | null = null;
  if (language in bundledLanguages) {
    lang = language as BundledLanguage;
  } else {
    lang = EXTENSION_TO_LANG[language.toLowerCase()] ?? null;
  }

  if (!lang) {
    return null;
  }

  // Load language if not already loaded
  if (!loadedLanguages.has(lang)) {
    try {
      await highlighter.loadLanguage(lang);
      loadedLanguages.add(lang);
    } catch {
      return null;
    }
  }

  const cacheKey = highlightCacheKey(code, lang);
  const cached = readHighlightCache(cacheKey);
  if (cached) {
    return cached;
  }

  // Check line count and truncate if needed
  const lines = code.split("\n");
  const truncated = lines.length > MAX_LINES;
  const codeToHighlight = truncated
    ? lines.slice(0, MAX_LINES).join("\n")
    : code;

  try {
    const html = highlighter.codeToHtml(codeToHighlight, {
      lang,
      theme: "css-variables",
    });

    const result: HighlightResult = {
      html,
      language: lang,
      lineCount: lines.length,
      truncated,
    };
    writeHighlightCache(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}

/**
 * Highlight a file's content.
 *
 * @param content - File content
 * @param filePath - File path (used to determine language)
 * @returns Highlighted HTML or null if language is unsupported
 */
export async function highlightFile(
  content: string,
  filePath: string,
): Promise<HighlightResult | null> {
  const lang = getLanguageForPath(filePath);
  if (!lang) {
    return null;
  }

  return highlightCode(content, lang);
}

/**
 * @internal
 * Exported for testing purposes only. Do not use in production code.
 */
export const __test__ = {
  MAX_LINES,
  EXTENSION_TO_LANG,
  cacheSize: () => highlightCache.size,
  cacheBytes: () => highlightCacheBytes,
  clearCache: () => {
    highlightCache.clear();
    highlightCacheBytes = 0;
  },
};
