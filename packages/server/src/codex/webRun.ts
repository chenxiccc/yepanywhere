/**
 * Parser for Codex `web.run` (rollout `web__run`) tool output.
 *
 * The provider prints one text blob per call. Observed grammar
 * (corpus: GPT-5.6 rollouts, 2026-07):
 *
 *   Script completed
 *   Wall time 1.2 seconds
 *   Output:
 *   <page block>…
 *
 * Each page block is a title line `Title (URL)` followed by a marker line
 *
 *   \uE200cite\uE202<ref>\uE201 [wordlim: N] <Key: value; >… <body…>
 *
 * where `<ref>` is a follow-up reference like `turn0search4`, the `Key:`
 * prefix carries page metadata (Published, Crawled, Content type, Source,
 * Redirected to URL, Total lines), and the body is either windowed page
 * lines (`L0: …`, several may share one physical line) or a prose search
 * snippet. Inline links are wrapped as
 * `\uE200cite\uE202<id>†<label>[†<domain>]\uE201`; only the label is
 * user-visible content. The U+E200–E202 wrappers are private-use characters,
 * so they are format-significant markup, never renderable text.
 *
 * Parsing fails closed: input that does not present the envelope or at
 * least one page block keeps its raw-text presentation.
 */

import type {
  CodexWebRunLine,
  CodexWebRunPage,
  CodexWebRunResult,
} from "@yep-anywhere/shared";

const MARK_OPEN = "\uE200";
const MARK_CLOSE = "\uE201";
const MARK_SEP = "\uE202";

const ENVELOPE_RE =
  /^Script completed\nWall time ([\d.]+) seconds?\n(?:Output:\n)?/;
const PAGE_MARKER_RE = new RegExp(
  `^${MARK_OPEN}cite${MARK_SEP}([^${MARK_CLOSE}†]+)${MARK_CLOSE}` +
    `(?:\\s*\\[wordlim: (\\d+)\\])?\\s?`,
);
const TITLE_URL_RE = /^(.*?)\s*\((https?:\/\/\S+)\)$/;
const INLINE_MARK_RE = new RegExp(
  `${MARK_OPEN}cite${MARK_SEP}([^${MARK_CLOSE}]*)${MARK_CLOSE}`,
  "g",
);
const META_KEY_RE =
  /^(Published|Crawled|Content type|Source|Redirected to URL|Total lines): ([^;\n]*)(?:;\s*|(?=\n)|$)/;
const LINE_MARKER_SPLIT_RE = /(?:^|(?<=\s))L(\d+): ?/;

export interface ParsedCodexWebRunOutput {
  result: CodexWebRunResult;
  /** Marker-cleaned plain text (envelope dropped) for content fallback. */
  contentText: string;
}

/** Reduce citation markup to its visible text. */
export function cleanWebRunMarkers(text: string): string {
  return text
    .replace(INLINE_MARK_RE, (_match, inner: string) => {
      const parts = inner.split("†");
      if (parts.length >= 2) {
        // <id>†<label>[†<domain>] — the label is the visible link text.
        return parts[1]?.trim() ?? "";
      }
      // Bare page reference (e.g. `turn0search4`): pure markup.
      return inner.startsWith("turn") ? "" : inner;
    })
    .replace(new RegExp(`[${MARK_OPEN}${MARK_CLOSE}${MARK_SEP}]`, "g"), "");
}

function parseMetaFields(text: string): {
  meta: Partial<CodexWebRunPage>;
  rest: string;
} {
  const meta: Partial<CodexWebRunPage> = {};
  let rest = text;
  for (;;) {
    const match = META_KEY_RE.exec(rest);
    if (!match) break;
    const value = (match[2] ?? "").trim();
    switch (match[1]) {
      case "Published":
        meta.published = value;
        break;
      case "Crawled":
        meta.crawled = value;
        break;
      case "Content type":
        meta.contentType = value;
        break;
      case "Source":
        meta.source = value;
        break;
      case "Redirected to URL":
        meta.redirectedUrl = value;
        break;
      case "Total lines": {
        const totalLines = Number.parseInt(value, 10);
        if (Number.isFinite(totalLines)) meta.totalLines = totalLines;
        break;
      }
    }
    rest = rest.slice(match[0].length);
  }
  return { meta, rest: rest.replace(/^\n/, "") };
}

/**
 * Split a body of `Ln:`-marked page lines. Several logical lines may share
 * one physical line (`L37: # Heading L38: `), so split on the markers, not
 * on newlines. Whitespace after the single marker space is indentation and
 * is preserved.
 */
function parseNumberedLines(body: string): CodexWebRunLine[] | undefined {
  if (!/^L\d+: ?/.test(body.trimStart())) return undefined;
  const parts = body.split(LINE_MARKER_SPLIT_RE);
  // split with one capture group yields [prefix, n, text, n, text, …]
  if ((parts[0] ?? "").trim() !== "") return undefined;
  const lines: CodexWebRunLine[] = [];
  for (let i = 1; i < parts.length - 1; i += 2) {
    const n = Number.parseInt(parts[i] ?? "", 10);
    if (!Number.isFinite(n)) return undefined;
    const text = stripTrailingDivider(cleanWebRunMarkers(parts[i + 1] ?? ""));
    lines.push({ n, text });
  }
  return lines.length > 0 ? lines : undefined;
}

interface RawPageBlock {
  titleLine: string;
  markerLine: string;
  bodyLines: string[];
}

/** The exact 80-dash rule the provider prints between page blocks. Shorter
 * dash runs are page content (e.g. markdown rules) and stay. Usually on its
 * own line, but occasionally glued to the end of the preceding content line. */
const PAGE_DIVIDER_RE = /^-{80}$/;
const TRAILING_PAGE_DIVIDER_RE = /(?:^|[ \n])-{80}$/;

function stripTrailingDivider(text: string): string {
  const trimmed = text.replace(/[ \n]+$/, "");
  return trimmed.replace(TRAILING_PAGE_DIVIDER_RE, "").replace(/[ \n]+$/, "");
}

function splitPageBlocks(lines: string[]): RawPageBlock[] {
  const blocks: RawPageBlock[] = [];
  let current: RawPageBlock | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (PAGE_DIVIDER_RE.test(line)) continue;
    const next = lines[i + 1] ?? "";
    if (PAGE_MARKER_RE.test(next)) {
      current = { titleLine: line, markerLine: next, bodyLines: [] };
      blocks.push(current);
      i++;
      continue;
    }
    current?.bodyLines.push(line);
  }
  return blocks;
}

function parsePageBlock(block: RawPageBlock): CodexWebRunPage {
  const page: CodexWebRunPage = { title: "" };

  const titleMatch = TITLE_URL_RE.exec(block.titleLine.trim());
  if (titleMatch) {
    page.title = cleanWebRunMarkers(titleMatch[1] ?? "").trim();
    page.url = titleMatch[2];
  } else {
    page.title = cleanWebRunMarkers(block.titleLine).trim();
  }

  const marker = PAGE_MARKER_RE.exec(block.markerLine);
  if (marker) {
    page.ref = marker[1];
    if (marker[2]) {
      const wordLimit = Number.parseInt(marker[2], 10);
      if (Number.isFinite(wordLimit)) page.wordLimit = wordLimit;
    }
  }

  const markerTail = marker
    ? block.markerLine.slice(marker[0].length)
    : block.markerLine;
  const { meta, rest } = parseMetaFields(
    [markerTail, ...block.bodyLines].join("\n"),
  );
  Object.assign(page, meta);

  const body = rest.replace(/^\s*\n/, "").replace(/\s+$/, "");
  if (body) {
    const numbered = parseNumberedLines(body);
    if (numbered) {
      page.lines = numbered;
    } else {
      page.text = stripTrailingDivider(cleanWebRunMarkers(body)).trim();
    }
  }
  return page;
}

/**
 * Parse one web.run output blob. Returns undefined when the text carries
 * neither the script envelope nor a page block, so callers keep the raw
 * presentation for unrecognized shapes.
 */
export function parseCodexWebRunOutput(
  output: string,
): ParsedCodexWebRunOutput | undefined {
  const normalized = output.replace(/\r\n/g, "\n");
  const envelope = ENVELOPE_RE.exec(normalized);
  const body = envelope ? normalized.slice(envelope[0].length) : normalized;
  const durationSeconds = envelope?.[1]
    ? Number.parseFloat(envelope[1])
    : undefined;

  const pages = splitPageBlocks(body.split("\n")).map(parsePageBlock);
  if (!envelope && pages.length === 0) return undefined;

  const result: CodexWebRunResult = {
    ...(durationSeconds !== undefined && Number.isFinite(durationSeconds)
      ? { durationSeconds }
      : {}),
    pages,
    ...(pages.length === 0 ? { text: cleanWebRunMarkers(body).trim() } : {}),
  };
  return { result, contentText: cleanWebRunMarkers(body).trim() };
}
