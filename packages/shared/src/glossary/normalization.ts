export interface NormalizedGlossarySource {
  chars: string[];
  ends: number[];
  starts: number[];
}

const graphemeSegmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("und", { granularity: "grapheme" })
    : null;
const ZERO_WIDTH_JOINER = String.fromCodePoint(0x200d);

interface SourceGrapheme {
  index: number;
  segment: string;
}

function isAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

function normalizeAsciiSource(
  text: string,
  foldCase: boolean,
): NormalizedGlossarySource {
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let whitespaceStart: number | null = null;

  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.charCodeAt(index);
    const isWhitespace =
      codePoint === 0x20 || (codePoint >= 0x09 && codePoint <= 0x0d);
    if (isWhitespace) {
      whitespaceStart ??= index;
      continue;
    }

    if (whitespaceStart !== null) {
      chars.push(" ");
      starts.push(whitespaceStart);
      ends.push(index);
      whitespaceStart = null;
    }

    chars.push(
      foldCase && codePoint >= 0x41 && codePoint <= 0x5a
        ? String.fromCharCode(codePoint + 0x20)
        : text[index]!,
    );
    starts.push(index);
    ends.push(index + 1);
  }

  if (whitespaceStart !== null) {
    chars.push(" ");
    starts.push(whitespaceStart);
    ends.push(text.length);
  }

  return { chars, ends, starts };
}

function hangulClass(codePoint: number): "L" | "V" | "T" | "LV" | "LVT" | null {
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97c)
  ) {
    return "L";
  }
  if (
    (codePoint >= 0x1160 && codePoint <= 0x11a7) ||
    (codePoint >= 0xd7b0 && codePoint <= 0xd7c6)
  ) {
    return "V";
  }
  if (
    (codePoint >= 0x11a8 && codePoint <= 0x11ff) ||
    (codePoint >= 0xd7cb && codePoint <= 0xd7fb)
  ) {
    return "T";
  }
  if (codePoint >= 0xac00 && codePoint <= 0xd7a3) {
    return (codePoint - 0xac00) % 28 === 0 ? "LV" : "LVT";
  }
  return null;
}

function fallbackGraphemes(text: string): SourceGrapheme[] {
  const graphemes: SourceGrapheme[] = [];
  let current = "";
  let currentIndex = 0;
  let previous: string | undefined;

  for (const char of text) {
    const charIndex = currentIndex + current.length;
    const previousClass = previous
      ? hangulClass(previous.codePointAt(0)!)
      : null;
    const currentClass = hangulClass(char.codePointAt(0)!);
    const joinsHangul =
      (previousClass === "L" &&
        (currentClass === "L" ||
          currentClass === "V" ||
          currentClass === "LV" ||
          currentClass === "LVT")) ||
      ((previousClass === "LV" || previousClass === "V") &&
        (currentClass === "V" || currentClass === "T")) ||
      ((previousClass === "LVT" || previousClass === "T") &&
        currentClass === "T");
    const joinsCurrent =
      current.length > 0 &&
      (/\p{Mark}/u.test(char) ||
        char === ZERO_WIDTH_JOINER ||
        previous === ZERO_WIDTH_JOINER ||
        joinsHangul);

    if (!joinsCurrent && current) {
      graphemes.push({ index: currentIndex, segment: current });
      currentIndex += current.length;
      current = "";
      previous = undefined;
    }
    if (!current) currentIndex = charIndex;
    current += char;
    previous = char;
  }
  if (current) graphemes.push({ index: currentIndex, segment: current });
  return graphemes;
}

function sourceGraphemes(text: string): Iterable<SourceGrapheme> {
  return graphemeSegmenter?.segment(text) ?? fallbackGraphemes(text);
}

function normalizeGrapheme(grapheme: string, foldCase: boolean): string {
  const normalized = grapheme.normalize("NFKC");
  return foldCase ? normalized.toLowerCase().replaceAll("ς", "σ") : normalized;
}

function normalizeGlossarySourceWithCase(
  text: string,
  foldCase: boolean,
): NormalizedGlossarySource {
  // Node 20's Intl.Segmenter has pathological scaling on long ASCII input.
  // ASCII code units are already individual graphemes, except CRLF; collapsing
  // adjacent whitespace gives CRLF the same normalized value and source span.
  if (isAscii(text)) return normalizeAsciiSource(text, foldCase);

  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let whitespaceStart: number | null = null;
  let whitespaceEnd = 0;

  const flushWhitespace = () => {
    if (whitespaceStart === null) return;
    chars.push(" ");
    starts.push(whitespaceStart);
    ends.push(whitespaceEnd);
    whitespaceStart = null;
  };

  for (const part of sourceGraphemes(text)) {
    const start = part.index;
    const end = start + part.segment.length;
    if (/^\s+$/u.test(part.segment)) {
      whitespaceStart ??= start;
      whitespaceEnd = end;
      continue;
    }

    flushWhitespace();
    for (const char of normalizeGrapheme(part.segment, foldCase)) {
      chars.push(char);
      starts.push(start);
      ends.push(end);
    }
  }
  flushWhitespace();
  return { chars, ends, starts };
}

/** Normalize glossary text with source offsets for every emitted code point. */
export function normalizeGlossarySource(
  text: string,
): NormalizedGlossarySource {
  return normalizeGlossarySourceWithCase(text, true);
}

export function normalizeGlossaryText(text: string): string {
  return normalizeGlossarySource(text).chars.join("").trim();
}

export function normalizeGlossaryCaseText(text: string): string {
  return normalizeGlossarySourceWithCase(text, false).chars.join("").trim();
}
