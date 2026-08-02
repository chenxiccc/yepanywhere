/**
 * Split plain text into text/url segments so plain-text surfaces (user
 * prompts, queued chips, system messages, thinking text) can render bare
 * URLs as anchors. Assistant markdown already autolinks via markdown-it
 * mode; this mirrors that behavior closely enough that the same URL reads
 * the same in both surfaces: `https?://` and `www.` matches, trailing
 * punctuation excluded, close-parens kept only while balanced.
 */

export interface LinkifySegment {
  type: "text" | "url";
  text: string;
  /** Present on url segments: the navigable target. */
  href?: string;
}

const URL_CANDIDATE = /(?:https?:\/\/|www\.)[^\s<>]+/gi;

// Characters that end a sentence around a URL rather than belonging to it.
const TRAILING_PUNCTUATION = new Set([
  ".",
  ",",
  ":",
  ";",
  "!",
  "?",
  "'",
  '"',
  "`",
  "*",
  "_",
  "~",
]);

const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function countChar(text: string, char: string): number {
  let count = 0;
  for (const c of text) {
    if (c === char) count += 1;
  }
  return count;
}

/** Trim sentence punctuation and unbalanced closing brackets off a match. */
function trimUrlMatch(match: string): string {
  let url = match;
  for (;;) {
    const last = url[url.length - 1];
    if (last === undefined) break;
    if (TRAILING_PUNCTUATION.has(last)) {
      url = url.slice(0, -1);
      continue;
    }
    const opener = CLOSERS[last];
    if (opener) {
      const body = url.slice(0, -1);
      if (countChar(body, opener) > countChar(body, last)) {
        // Balanced pair like en.wikipedia.org/wiki/X_(Y) — keep the closer.
        break;
      }
      url = url.slice(0, -1);
      continue;
    }
    break;
  }
  return url;
}

function hrefForUrl(url: string): string | null {
  const href = url.startsWith("www.") ? `https://${url}` : url;
  try {
    const parsed = new URL(href);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (!parsed.hostname.includes(".")) {
      return null;
    }
    return href;
  } catch {
    return null;
  }
}

export interface SplitUrlSegmentsOptions {
  /**
   * The text was cut mid-stream (e.g. char truncation), so a URL touching the
   * end of the string may continue past it; render it as plain text rather
   * than linking to a truncated target.
   */
  suppressTrailingUrl?: boolean;
}

export function splitUrlSegments(
  text: string,
  options?: SplitUrlSegmentsOptions,
): LinkifySegment[] {
  const segments: LinkifySegment[] = [];
  let lastIndex = 0;

  URL_CANDIDATE.lastIndex = 0;
  for (
    let match = URL_CANDIDATE.exec(text);
    match !== null;
    match = URL_CANDIDATE.exec(text)
  ) {
    const url = trimUrlMatch(match[0]);
    const href = hrefForUrl(url);
    const end = match.index + url.length;
    const suppressed =
      options?.suppressTrailingUrl === true && end >= text.length;
    if (!href || suppressed) {
      continue;
    }
    if (match.index > lastIndex) {
      segments.push({ type: "text", text: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: "url", text: url, href });
    lastIndex = end;
    URL_CANDIDATE.lastIndex = end;
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", text: text.slice(lastIndex) });
  }
  return segments;
}

/** Fast pre-check so render paths can skip segment work for most text. */
export function containsLinkifiableUrl(text: string): boolean {
  return /https?:\/\/|www\./i.test(text);
}
