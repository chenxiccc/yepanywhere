// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { asClientSummarySourceKey } from "../clientSummaryStore";
import type { SessionRouteScrollSnapshot } from "../sessionRouteSnapshots";
import {
  clearSessionScrollMemory,
  createSessionScrollMemoryStorageKey,
  readSessionScrollMemory,
  selectFurthestSessionScrollMemory,
  writeSessionScrollMemory,
} from "../sessionScrollMemoryStorage";

const reference = {
  sourceKey: asClientSummarySourceKey("host:desktop"),
  projectId: "project-a",
  sessionId: "session-a",
};

function snapshot({
  id,
  timestampMs,
  following = false,
  updatedAtMs = timestampMs,
}: {
  id: string;
  timestampMs: number;
  following?: boolean;
  updatedAtMs?: number;
}): SessionRouteScrollSnapshot {
  return {
    atBottom: following,
    scrollTop: timestampMs,
    scrollHeight: 1000,
    clientHeight: 500,
    anchor: { id: `answer-${id}`, topOffset: 12, timestampMs },
    completedTurn: { id, timestampMs },
    following,
    updatedAtMs,
  };
}

describe("sessionScrollMemoryStorage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("keeps split-screen sessions in independent storage entries", () => {
    const first = snapshot({ id: "turn-1", timestampMs: 100 });
    const secondReference = { ...reference, sessionId: "session-b" };
    const second = snapshot({ id: "turn-2", timestampMs: 200 });

    writeSessionScrollMemory(reference, first);
    writeSessionScrollMemory(secondReference, second);

    expect(readSessionScrollMemory(reference)).toEqual(first);
    expect(readSessionScrollMemory(secondReference)).toEqual(second);
    expect(createSessionScrollMemoryStorageKey(reference)).not.toBe(
      createSessionScrollMemoryStorageKey(secondReference),
    );
  });

  it("writes only for a later turn or a same-turn follow upgrade", () => {
    const first = snapshot({ id: "turn-1", timestampMs: 100 });
    const sameTurn = snapshot({
      id: "turn-1",
      timestampMs: 100,
      following: true,
      updatedAtMs: 150,
    });
    const older = snapshot({ id: "turn-0", timestampMs: 50 });
    const newer = snapshot({ id: "turn-2", timestampMs: 200 });

    expect(writeSessionScrollMemory(reference, first)?.written).toBe(true);
    expect(writeSessionScrollMemory(reference, sameTurn)?.written).toBe(true);
    expect(writeSessionScrollMemory(reference, older)?.written).toBe(false);
    expect(writeSessionScrollMemory(reference, sameTurn)?.written).toBe(false);
    expect(readSessionScrollMemory(reference)).toEqual(sameTurn);
    expect(writeSessionScrollMemory(reference, newer)?.written).toBe(true);
    expect(readSessionScrollMemory(reference)).toEqual(newer);
  });

  it("prefers a following observation when two tabs reached one turn", () => {
    const parked = snapshot({ id: "turn-1", timestampMs: 100 });
    const following = snapshot({
      id: "turn-1",
      timestampMs: 100,
      following: true,
      updatedAtMs: 90,
    });

    expect(selectFurthestSessionScrollMemory(parked, following)).toBe(
      following,
    );
    expect(selectFurthestSessionScrollMemory(following, parked)).toBe(
      following,
    );
  });

  it("ignores malformed entries and clears only session scroll memory", () => {
    const key = createSessionScrollMemoryStorageKey(reference);
    localStorage.setItem(key, '{"following":"yes"}');
    localStorage.setItem("unrelated", "keep");

    expect(readSessionScrollMemory(reference)).toBeNull();
    writeSessionScrollMemory(
      reference,
      snapshot({ id: "turn-1", timestampMs: 100 }),
    );
    clearSessionScrollMemory();

    expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("keep");
  });
});
