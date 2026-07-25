/**
 * Pure matching/highlight helpers for settings search.
 *
 * Matching is token-AND substring: the query splits on whitespace and every
 * token must appear (case-insensitive substring) somewhere in the row's
 * searchable texts. Highlighting marks every token occurrence within one
 * text, with overlapping token ranges merged.
 */

export function settingsSearchTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * True when every query token appears in at least one of `texts`.
 * An empty/whitespace query matches nothing (search is inactive).
 */
export function settingsTextMatches(
  query: string,
  texts: ReadonlyArray<string | undefined>,
): boolean {
  const tokens = settingsSearchTokens(query);
  if (tokens.length === 0) return false;
  const haystacks = texts
    .filter((text): text is string => !!text)
    .map((text) => text.toLowerCase());
  if (haystacks.length === 0) return false;
  return tokens.every((token) =>
    haystacks.some((haystack) => haystack.includes(token)),
  );
}

export interface SettingsMatchSegment {
  text: string;
  match: boolean;
}

/**
 * Split `text` into segments marking every occurrence of every query token,
 * merging overlapping/adjacent token ranges. Returns a single non-match
 * segment when nothing matches.
 */
export function splitSettingsMatchSegments(
  text: string,
  query: string,
): SettingsMatchSegment[] {
  const tokens = settingsSearchTokens(query);
  const lower = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const token of tokens) {
    let from = 0;
    while (from <= lower.length - token.length) {
      const at = lower.indexOf(token, from);
      if (at < 0) break;
      ranges.push([at, at + token.length]);
      from = at + 1;
    }
  }
  if (ranges.length === 0) return [{ text, match: false }];

  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }

  const segments: SettingsMatchSegment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) {
      segments.push({ text: text.slice(cursor, start), match: false });
    }
    segments.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), match: false });
  }
  return segments;
}

/** Stable-enough default jump id derived from a row's label. */
export function settingsItemSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}
