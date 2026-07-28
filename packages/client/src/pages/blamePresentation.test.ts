import type { GitBlameLine } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  assignBlameAuthorColorSlots,
  circularSlotDistance,
  getBlameAuthorKey,
  groupConsecutiveBlameRows,
} from "./blamePresentation";

function line(
  number: number,
  sha: string,
  author: string,
  authorColorSeed: number,
): GitBlameLine {
  return {
    line: number,
    sha,
    shortSha: sha.slice(0, 7),
    author,
    authorColorSeed,
    authorTime: "2026-07-28T00:00:00Z",
    summary: "subject",
    content: `line ${number}`,
    uncommitted: false,
  };
}

describe("blame presentation", () => {
  it("groups only consecutive rows with the same populated blame", () => {
    const first = line(1, "a".repeat(40), "A", 1);
    const second = line(2, "a".repeat(40), "A", 1);
    const third = line(3, "b".repeat(40), "B", 2);
    const fourth = line(4, "a".repeat(40), "A", 1);

    const grouped = groupConsecutiveBlameRows(
      ["one", "two", "three", "four", "pending"],
      [first, second, third, fourth],
    );

    expect(grouped.map((run) => run.rows.map((row) => row.index))).toEqual([
      [0, 1],
      [2],
      [3],
      [4],
    ]);
    expect(new Set(grouped.map((run) => run.key)).size).toBe(grouped.length);
  });

  it("leaves a one-author file gray", () => {
    const only = line(1, "a".repeat(40), "Only", 4);
    expect(assignBlameAuthorColorSlots([only]).size).toBe(0);
  });

  it("maximizes color distance for the usual four-author set", () => {
    const lines = [
      line(1, "a".repeat(40), "A", 0),
      line(2, "b".repeat(40), "B", 0),
      line(3, "c".repeat(40), "C", 0),
      line(4, "d".repeat(40), "D", 0),
    ];
    const slots = lines.map(
      (item) =>
        assignBlameAuthorColorSlots(lines).get(getBlameAuthorKey(item))!,
    );

    expect(new Set(slots).size).toBe(4);
    for (let left = 0; left < slots.length; left += 1) {
      for (let right = left + 1; right < slots.length; right += 1) {
        expect(
          circularSlotDistance(slots[left]!, slots[right]!),
        ).toBeGreaterThanOrEqual(90);
      }
    }
  });

  it("uses the author hash when an older server has no color seed", () => {
    const left = { ...line(1, "a".repeat(40), "A", 1) };
    const right = { ...line(2, "b".repeat(40), "B", 2) };
    delete left.authorColorSeed;
    delete right.authorColorSeed;

    const first = assignBlameAuthorColorSlots([left, right]);
    const second = assignBlameAuthorColorSlots([left, right]);
    expect([...first]).toEqual([...second]);
    expect(first.size).toBe(2);
  });

  it("reuses stable preferences after all hue slots are occupied", () => {
    const lines = Array.from({ length: 361 }, (_, index) =>
      line(index + 1, index.toString(16).padStart(40, "0"), `A${index}`, index),
    );
    const slots = assignBlameAuthorColorSlots(lines);

    expect(new Set(slots.values()).size).toBe(360);
    expect(slots.get(getBlameAuthorKey(lines[360]!))).toBe(0);
  });
});
