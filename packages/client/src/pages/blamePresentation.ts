import type { GitBlameLine } from "@yep-anywhere/shared";

export const BLAME_AUTHOR_COLOR_SLOT_COUNT = 360;

export interface BlameRenderRow {
  content: string;
  index: number;
  line: GitBlameLine | undefined;
}

export interface BlameRenderRun {
  identity: string;
  key: string;
  rows: BlameRenderRow[];
}

export function groupConsecutiveBlameRows(
  contentLines: readonly string[],
  blameLines: readonly GitBlameLine[] | undefined,
): BlameRenderRun[] {
  const runs: BlameRenderRun[] = [];
  contentLines.forEach((content, index) => {
    const line =
      blameLines?.[index]?.line === index + 1 ? blameLines[index] : undefined;
    const key = line
      ? `${line.uncommitted ? "uncommitted" : "sha"}:${line.sha}`
      : `unknown:${index}`;
    const row = { content, index, line };
    const current = runs.at(-1);
    if (current?.identity === key) {
      current.rows.push(row);
    } else {
      // A commit can own several nonconsecutive runs. Include the first line
      // in the render key so A/B/A history never creates duplicate siblings.
      runs.push({ identity: key, key: `${key}:${index}`, rows: [row] });
    }
  });
  return runs;
}

export function getBlameAuthorKey(line: GitBlameLine): string {
  return `${line.author}\0${line.authorColorSeed ?? ""}`;
}

/**
 * Assign the visible author set to a fixed hue wheel by maximin distance.
 * Server-provided seeds preserve project-wide preference; older servers fall
 * back to an author hash. A one-author file deliberately remains uncolored.
 */
export function assignBlameAuthorColorSlots(
  lines: readonly GitBlameLine[],
): ReadonlyMap<string, number> {
  const authors = new Map<string, number>();
  for (const line of lines) {
    if (line.uncommitted) continue;
    const key = getBlameAuthorKey(line);
    if (!authors.has(key)) {
      authors.set(key, line.authorColorSeed ?? stableHash(line.author));
    }
  }
  if (authors.size <= 1) return new Map();

  const ordered = [...authors].sort(
    ([leftKey, leftSeed], [rightKey, rightSeed]) =>
      leftSeed - rightSeed || leftKey.localeCompare(rightKey),
  );
  const assigned = new Map<string, number>();
  const used: number[] = [];
  const usedSet = new Set<number>();
  for (const [key, seed] of ordered) {
    const preferred = positiveModulo(seed, BLAME_AUTHOR_COLOR_SLOT_COUNT);
    if (usedSet.size === BLAME_AUTHOR_COLOR_SLOT_COUNT) {
      assigned.set(key, preferred);
      continue;
    }
    const candidates = Array.from(
      { length: BLAME_AUTHOR_COLOR_SLOT_COUNT },
      (_, slot) => slot,
    ).filter((slot) => !usedSet.has(slot));
    let best = candidates[0] ?? preferred;
    let bestDistance = -1;
    let bestPreferenceDistance = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const distance =
        used.length === 0
          ? BLAME_AUTHOR_COLOR_SLOT_COUNT
          : Math.min(
              ...used.map((slot) => circularSlotDistance(candidate, slot)),
            );
      const preferenceDistance = circularSlotDistance(candidate, preferred);
      if (
        distance > bestDistance ||
        (distance === bestDistance &&
          preferenceDistance < bestPreferenceDistance)
      ) {
        best = candidate;
        bestDistance = distance;
        bestPreferenceDistance = preferenceDistance;
      }
    }
    assigned.set(key, best);
    used.push(best);
    usedSet.add(best);
  }
  return assigned;
}

export function circularSlotDistance(left: number, right: number): number {
  const distance = Math.abs(left - right);
  return Math.min(distance, BLAME_AUTHOR_COLOR_SLOT_COUNT - distance);
}

export function blameAuthorHue(slot: number): number {
  return (360 / BLAME_AUTHOR_COLOR_SLOT_COUNT) * slot;
}

function positiveModulo(value: number, modulus: number): number {
  return ((Math.round(value) % modulus) + modulus) % modulus;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
