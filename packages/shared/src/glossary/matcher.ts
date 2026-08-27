import {
  normalizeGlossaryCaseText,
  normalizeGlossarySource,
} from "./normalization.js";
import type { GlossaryArtifact, GlossaryMatch } from "./types.js";

interface Candidate extends GlossaryMatch {
  alternativeOrder: number;
  glossaryOrder: number;
  requiredBoldCodePoints: number;
  rowOrder: number;
  visibleCodePoints: number;
}

function isBoundary(char: string | undefined): boolean {
  return (
    char === undefined ||
    (!/[-\u2010\u2011]/u.test(char) && /[\p{White_Space}\p{P}]/u.test(char))
  );
}

class SelectedSpanIndex {
  private readonly boundaryIndexes: Map<number, number>;
  private readonly occupiedSegments: Uint32Array;

  constructor(candidates: readonly Candidate[]) {
    const boundaries = Array.from(
      new Set(
        candidates.flatMap((candidate) => [candidate.start, candidate.end]),
      ),
    ).sort((left, right) => left - right);
    this.boundaryIndexes = new Map(
      boundaries.map((boundary, index) => [boundary, index]),
    );
    this.occupiedSegments = new Uint32Array(boundaries.length + 1);
  }

  overlaps(start: number, end: number): boolean {
    const startIndex = this.boundaryIndexes.get(start)!;
    const endIndex = this.boundaryIndexes.get(end)!;
    return this.prefixSum(endIndex) > this.prefixSum(startIndex);
  }

  add(start: number, end: number): void {
    const startIndex = this.boundaryIndexes.get(start)!;
    const endIndex = this.boundaryIndexes.get(end)!;
    for (let index = startIndex; index < endIndex; index += 1) {
      this.addSegment(index);
    }
  }

  private addSegment(index: number): void {
    for (
      let treeIndex = index + 1;
      treeIndex < this.occupiedSegments.length;
      treeIndex += treeIndex & -treeIndex
    ) {
      this.occupiedSegments[treeIndex]! += 1;
    }
  }

  private prefixSum(endIndex: number): number {
    let sum = 0;
    for (
      let treeIndex = endIndex;
      treeIndex > 0;
      treeIndex -= treeIndex & -treeIndex
    ) {
      sum += this.occupiedSegments[treeIndex] ?? 0;
    }
    return sum;
  }
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
  const normalized = normalizeGlossarySource(text);
  const candidates: Candidate[] = [];
  const caseFormSets = new Map<number, Set<string>>();
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
      const matchedText = text.slice(start, end);
      if (terminal.caseSensitiveForms?.length) {
        let caseForms = caseFormSets.get(terminalIndex);
        if (!caseForms) {
          caseForms = new Set(terminal.caseSensitiveForms);
          caseFormSets.set(terminalIndex, caseForms);
        }
        if (!caseForms.has(normalizeGlossaryCaseText(matchedText))) continue;
      }
      candidates.push({
        alternativeOrder: terminal.alternativeOrder,
        definitionText: terminal.definitionText,
        end,
        glossaryOrder: terminal.glossaryOrder,
        requiredBoldCodePoints: terminal.requiredBoldCodePoints,
        rowOrder: terminal.rowOrder,
        start,
        terminalIndex,
        visibleCodePoints: Array.from(matchedText).length,
      });
    }
  }

  candidates.sort(compareCandidatePrecedence);
  const selected: Candidate[] = [];
  const selectedSpans = new SelectedSpanIndex(candidates);
  for (const candidate of candidates) {
    if (selectedSpans.overlaps(candidate.start, candidate.end)) continue;
    selectedSpans.add(candidate.start, candidate.end);
    selected.push(candidate);
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
