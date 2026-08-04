import type { GlossaryArtifact, GlossaryMatch } from "./types.js";

interface NormalizedSource {
  chars: string[];
  ends: number[];
  starts: number[];
}

interface Candidate extends GlossaryMatch {
  alternativeOrder: number;
  glossaryOrder: number;
  requiredBoldCodePoints: number;
  rowOrder: number;
  visibleCodePoints: number;
}

function normalizeSource(text: string): NormalizedSource {
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  let cluster = "";
  let clusterStart = 0;
  let clusterEnd = 0;
  let whitespaceStart: number | null = null;

  const flushCluster = () => {
    if (!cluster) return;
    const normalized = cluster.normalize("NFKC").toLowerCase();
    for (const char of normalized) {
      chars.push(char);
      starts.push(clusterStart);
      ends.push(clusterEnd);
    }
    cluster = "";
  };

  const flushWhitespace = () => {
    if (whitespaceStart === null) return;
    chars.push(" ");
    starts.push(whitespaceStart);
    ends.push(offset);
    whitespaceStart = null;
  };

  for (const sourceChar of text) {
    const start = offset;
    if (/\s/u.test(sourceChar)) {
      flushCluster();
      offset += sourceChar.length;
      whitespaceStart ??= start;
      continue;
    }
    flushWhitespace();
    offset += sourceChar.length;
    if (/\p{Mark}/u.test(sourceChar) && cluster) {
      cluster += sourceChar;
      clusterEnd = offset;
    } else {
      flushCluster();
      cluster = sourceChar;
      clusterStart = start;
      clusterEnd = offset;
    }
  }
  flushCluster();
  flushWhitespace();
  return { chars, ends, starts };
}

function isBoundary(char: string | undefined): boolean {
  return char === undefined || /[\p{White_Space}\p{P}]/u.test(char);
}

function overlaps(left: Candidate, right: Candidate): boolean {
  return left.start < right.end && right.start < left.end;
}

function compareCandidatePrecedence(left: Candidate, right: Candidate): number {
  return (
    right.visibleCodePoints - left.visibleCodePoints ||
    right.requiredBoldCodePoints - left.requiredBoldCodePoints ||
    left.glossaryOrder - right.glossaryOrder ||
    left.rowOrder - right.rowOrder ||
    left.alternativeOrder - right.alternativeOrder ||
    left.start - right.start ||
    left.end - right.end
  );
}

/** Match non-overlapping glossary terms while retaining source UTF-16 offsets. */
export function matchGlossaryText(
  text: string,
  artifact: GlossaryArtifact,
): GlossaryMatch[] {
  if (!text || artifact.nodes.length === 0 || artifact.terminals.length === 0) {
    return [];
  }
  const normalized = normalizeSource(text);
  const candidates: Candidate[] = [];
  let state = 0;

  for (let index = 0; index < normalized.chars.length; index += 1) {
    const char = normalized.chars[index];
    if (char === undefined) continue;
    while (
      state !== 0 &&
      artifact.nodes[state]?.transitions[char] === undefined
    ) {
      state = artifact.nodes[state]?.failure ?? 0;
    }
    state =
      artifact.nodes[state]?.transitions[char] ??
      artifact.nodes[0]?.transitions[char] ??
      0;
    for (const terminalIndex of artifact.nodes[state]?.outputs ?? []) {
      const terminal = artifact.terminals[terminalIndex];
      if (!terminal) continue;
      const normalizedStart = index - terminal.codePointLength + 1;
      if (normalizedStart < 0) continue;
      if (
        !isBoundary(normalized.chars[normalizedStart - 1]) ||
        !isBoundary(normalized.chars[index + 1])
      ) {
        continue;
      }
      const start = normalized.starts[normalizedStart];
      const end = normalized.ends[index];
      if (start === undefined || end === undefined) continue;
      candidates.push({
        alternativeOrder: terminal.alternativeOrder,
        definitionText: terminal.definitionText,
        end,
        glossaryOrder: terminal.glossaryOrder,
        requiredBoldCodePoints: terminal.requiredBoldCodePoints,
        rowOrder: terminal.rowOrder,
        start,
        terminalIndex,
        visibleCodePoints: Array.from(text.slice(start, end)).length,
      });
    }
  }

  candidates.sort(compareCandidatePrecedence);
  const selected: Candidate[] = [];
  for (const candidate of candidates) {
    if (!selected.some((existing) => overlaps(existing, candidate))) {
      selected.push(candidate);
    }
  }
  selected.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  return selected.map(({ definitionText, end, start, terminalIndex }) => ({
    definitionText,
    end,
    start,
    terminalIndex,
  }));
}
