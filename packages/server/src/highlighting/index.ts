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
 * Whole-file tokenizations waiting to run, held oldest-first and taken from
 * the newest end.
 *
 * Each one blocks the loop while it runs, so a fast walk through a changeset
 * must not queue an unbounded stall behind itself. Both ends of the queue
 * favour the newest entry, because that is the file being looked at now: it
 * runs first, and when the queue is full it is the *oldest* that gets dropped.
 * Dropping is always safe — the request that asked still has its excerpt, and
 * any later read of that version queues it again.
 */
const pendingWarms: { key: string; code: string; lang: BundledLanguage }[] = [];
const MAX_PENDING_WARM_HIGHLIGHTS = 4;
let warmRunning = false;

function drainWarms(): void {
  const next = pendingWarms.pop();
  if (!next) {
    warmRunning = false;
    return;
  }
  highlightCode(next.code, next.lang)
    .catch(() => undefined)
    // One at a time, and never in the same tick as the response it follows.
    .finally(() => setImmediate(drainWarms));
}

function resolveLanguage(language: string): BundledLanguage | null {
  if (language in bundledLanguages) return language as BundledLanguage;
  return EXTENSION_TO_LANG[language.toLowerCase()] ?? null;
}

/**
 * The retained highlighting for this exact content, or null if it has not been
 * tokenized yet. Lets a latency-sensitive caller take the exact result when it
 * is already paid for and choose a cheaper approximation when it is not,
 * without blocking on tokenization.
 */
export function getCachedHighlight(
  code: string,
  language: string,
): HighlightResult | null {
  const lang = resolveLanguage(language);
  if (!lang) return null;
  return readHighlightCache(highlightCacheKey(code, lang));
}

/**
 * Tokenize this content off the critical path so a later request finds it in
 * the cache. Returns immediately; failures are dropped, since every caller has
 * a working fallback and this only ever improves the next response.
 */
export function warmHighlight(code: string, language: string): void {
  const lang = resolveLanguage(language);
  if (!lang) return;
  const key = highlightCacheKey(code, lang);
  if (highlightCache.has(key)) return;
  if (pendingWarms.some((entry) => entry.key === key)) return;

  pendingWarms.push({ key, code, lang });
  if (pendingWarms.length > MAX_PENDING_WARM_HIGHLIGHTS) pendingWarms.shift();
  if (warmRunning) return;

  warmRunning = true;
  // After the in-flight response flushes, not ahead of it.
  setImmediate(drainWarms);
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

  const lang = resolveLanguage(language);
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
    pendingWarms.length = 0;
  },
  pendingWarmCount: () => pendingWarms.length,
};
