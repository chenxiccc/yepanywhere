/**
 * Locate an edit's replacement in the current file so the edit-block viewer
 * can expand a hunk to full-file context without the SDK originalFile snapshot.
 */

export interface LineBlock {
  /** 0-based inclusive start line. */
  start: number;
  /** 0-based exclusive end line. */
  end: number;
}

export interface CharSpan {
  start: number;
  end: number;
}

export interface EditReplacement {
  oldString: string;
  newString: string;
}

export interface EditContextPatchHunk {
  lines: string[];
}

function splitLines(text: string): string[] {
  return text.split("\n");
}

function stripWhitespace(line: string): string {
  return line.replace(/\s/g, "");
}

function locateAllExact(haystack: string, needle: string): CharSpan[] {
  if (needle.length === 0) {
    return [];
  }
  const spans: CharSpan[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const start = haystack.indexOf(needle, from);
    if (start === -1) {
      break;
    }
    spans.push({ start, end: start + needle.length });
    from = start + 1;
  }
  return spans;
}

export function locateUniqueExact(
  haystack: string,
  needle: string,
): CharSpan | null {
  const spans = locateAllExact(haystack, needle);
  return spans.length === 1 ? (spans[0] ?? null) : null;
}

function locateAllWhitespaceInsensitive(
  haystack: string,
  needle: string,
): LineBlock[] {
  const hayLines = splitLines(haystack);
  const needleLines = splitLines(needle);
  if (needleLines.length === 0 || hayLines.length < needleLines.length) {
    return [];
  }
  if (!needleLines.some((line) => stripWhitespace(line).length > 0)) {
    return [];
  }
  const normHay = hayLines.map(stripWhitespace);
  const normNeedle = needleLines.map(stripWhitespace);
  const matches: LineBlock[] = [];
  const lastStart = normHay.length - normNeedle.length;
  for (let start = 0; start <= lastStart; start += 1) {
    let matched = true;
    for (let offset = 0; offset < normNeedle.length; offset += 1) {
      if (normHay[start + offset] !== normNeedle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      matches.push({ start, end: start + normNeedle.length });
    }
  }
  return matches;
}

export function locateUniqueWhitespaceInsensitive(
  haystack: string,
  needle: string,
): LineBlock | null {
  const matches = locateAllWhitespaceInsensitive(haystack, needle);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export function replaceCharSpan(
  haystack: string,
  span: CharSpan,
  replacement: string,
): string {
  return haystack.slice(0, span.start) + replacement + haystack.slice(span.end);
}

export function replaceLineBlock(
  haystack: string,
  block: LineBlock,
  replacement: string,
): string {
  const lines = splitLines(haystack);
  const next = [
    ...lines.slice(0, block.start),
    ...(replacement === "" ? [] : splitLines(replacement)),
    ...lines.slice(block.end),
  ];
  return next.join("\n");
}

export function deriveReplacementFromPatch(
  hunks?: EditContextPatchHunk[],
): EditReplacement | null {
  if (hunks?.length !== 1) {
    return null;
  }
  const lines = hunks[0]?.lines;
  if (!lines || lines.length === 0) {
    return null;
  }
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of lines) {
    const prefix = line[0];
    const body = line.slice(1);
    if (prefix === " " || prefix === "-") {
      oldLines.push(body);
    }
    if (prefix === " " || prefix === "+") {
      newLines.push(body);
    }
  }
  if (oldLines.length === 0 && newLines.length === 0) {
    return null;
  }
  return {
    oldString: oldLines.join("\n"),
    newString: newLines.join("\n"),
  };
}

export function resolveEditReplacement(
  oldString: string,
  newString: string,
  structuredPatch?: EditContextPatchHunk[],
): EditReplacement | null {
  if (oldString.length > 0 || newString.length > 0) {
    return { oldString, newString };
  }
  return deriveReplacementFromPatch(structuredPatch);
}

function locateNeedle(
  haystack: string,
  needle: string,
):
  | { kind: "exact"; span: CharSpan }
  | { kind: "lines"; block: LineBlock }
  | { kind: "ambiguous" }
  | null {
  if (needle.length === 0) {
    return null;
  }
  const exactMatches = locateAllExact(haystack, needle);
  if (exactMatches.length === 1 && exactMatches[0]) {
    return { kind: "exact", span: exactMatches[0] };
  }
  if (exactMatches.length > 1) {
    return { kind: "ambiguous" };
  }
  const lineMatch = locateUniqueWhitespaceInsensitive(haystack, needle);
  if (lineMatch) {
    return { kind: "lines", block: lineMatch };
  }
  return null;
}

function expandEmptyExactRemoval(haystack: string, span: CharSpan): CharSpan {
  const startsAtLine = span.start === 0 || haystack[span.start - 1] === "\n";
  const endsAtLineEnd =
    span.end === haystack.length || haystack[span.end] === "\n";
  if (
    startsAtLine &&
    endsAtLineEnd &&
    span.end < haystack.length &&
    haystack[span.end] === "\n"
  ) {
    return { start: span.start, end: span.end + 1 };
  }
  return span;
}

function applyNeedleReplacement(
  currentFile: string,
  located:
    | { kind: "exact"; span: CharSpan }
    | { kind: "lines"; block: LineBlock },
  replacement: string,
): string {
  if (located.kind === "exact") {
    const span =
      replacement === ""
        ? expandEmptyExactRemoval(currentFile, located.span)
        : located.span;
    return replaceCharSpan(currentFile, span, replacement);
  }
  return replaceLineBlock(currentFile, located.block, replacement);
}

/**
 * Build a pre-edit file the expand-diff endpoint can apply exactly.
 * Prefers a unique current-file match of newString (post-edit), then oldString
 * (still pre-edit). Multiple matches or a whitespace-only needle that cannot
 * be placed uniquely return null so the viewer can drop diff markers.
 */
export function reconstructOriginalFile(args: {
  currentFile: string;
  oldString: string;
  newString: string;
  structuredPatch?: EditContextPatchHunk[];
}): string | null {
  const replacement = resolveEditReplacement(
    args.oldString,
    args.newString,
    args.structuredPatch,
  );
  if (!replacement) {
    return null;
  }

  const newHit = locateNeedle(args.currentFile, replacement.newString);
  if (newHit?.kind === "ambiguous") {
    return null;
  }
  if (newHit) {
    return applyNeedleReplacement(
      args.currentFile,
      newHit,
      replacement.oldString,
    );
  }

  const oldHit = locateNeedle(args.currentFile, replacement.oldString);
  if (oldHit?.kind === "ambiguous") {
    return null;
  }
  if (oldHit) {
    return applyNeedleReplacement(
      args.currentFile,
      oldHit,
      replacement.oldString,
    );
  }
  return null;
}
