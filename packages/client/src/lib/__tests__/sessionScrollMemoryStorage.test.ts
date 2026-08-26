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
    seenTurn: { id, timestampMs, activityIndex: 0 },
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

  it("keeps the furthest seen turn across captures", () => {
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

  it("does not move the resume point backward when the reader scrolls up", () => {
    const following = snapshot({
      id: "turn-2",
      timestampMs: 200,
      following: true,
    });
    const rememberedPlace = {
      ...snapshot({ id: "turn-1", timestampMs: 100, updatedAtMs: 300 }),
      scrollTop: 240,
      anchor: { id: "answer-mid-turn-1", topOffset: 12, timestampMs: 150 },
    };

    writeSessionScrollMemory(reference, following);
    expect(writeSessionScrollMemory(reference, rememberedPlace)?.written).toBe(
      false,
    );

    expect(readSessionScrollMemory(reference)).toEqual(following);
  });

  it("does not replace the high-water mark with an unclassified viewport", () => {
    const following = snapshot({
      id: "turn-2",
      timestampMs: 200,
      following: true,
    });
    const rememberedPlace = {
      ...snapshot({ id: "turn-1", timestampMs: 100, updatedAtMs: 300 }),
      scrollTop: 240,
      anchor: { id: "answer-mid-turn-1", topOffset: 12, timestampMs: 150 },
      completedTurn: undefined,
      seenTurn: undefined,
    };

    writeSessionScrollMemory(reference, following);
    expect(writeSessionScrollMemory(reference, rememberedPlace)).toBeNull();

    expect(readSessionScrollMemory(reference)).toEqual(following);
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

  it("advances within one turn but rejects an earlier activity", () => {
    const firstActivity = snapshot({
      id: "turn-1",
      timestampMs: 100,
      updatedAtMs: 100,
    });
    const laterActivity = {
      ...firstActivity,
      anchor: { id: "activity-2", topOffset: -20, timestampMs: 200 },
      seenTurn: { id: "turn-1", timestampMs: 100, activityIndex: 2 },
      updatedAtMs: 200,
    };
    const earlierActivity = {
      ...firstActivity,
      anchor: { id: "activity-1", topOffset: -10, timestampMs: 150 },
      seenTurn: { id: "turn-1", timestampMs: 100, activityIndex: 1 },
      updatedAtMs: 300,
    };

    expect(writeSessionScrollMemory(reference, firstActivity)?.written).toBe(
      true,
    );
    expect(writeSessionScrollMemory(reference, laterActivity)?.written).toBe(
      true,
    );
    expect(writeSessionScrollMemory(reference, earlierActivity)?.written).toBe(
      false,
    );
    expect(readSessionScrollMemory(reference)).toEqual(laterActivity);
  });

  it("keeps the furthest offset reached inside one expanded activity", () => {
    const firstOffset = snapshot({ id: "turn-1", timestampMs: 100 });
    const laterOffset = {
      ...firstOffset,
      anchor: { ...firstOffset.anchor!, topOffset: -120 },
      updatedAtMs: 200,
    };
    const scrolledUpOffset = {
      ...firstOffset,
      anchor: { ...firstOffset.anchor!, topOffset: -40 },
      updatedAtMs: 300,
    };

    writeSessionScrollMemory(reference, firstOffset);
    expect(writeSessionScrollMemory(reference, laterOffset)?.written).toBe(
      true,
    );
    expect(writeSessionScrollMemory(reference, scrolledUpOffset)?.written).toBe(
      false,
    );
    expect(readSessionScrollMemory(reference)).toEqual(laterOffset);
  });

  it("advances to an active turn before that turn completes", () => {
    const activeTurn = {
      ...snapshot({ id: "turn-2", timestampMs: 200 }),
      completedTurn: undefined,
      seenTurn: { id: "turn-2", timestampMs: 200, activityIndex: 1 },
    };

    expect(writeSessionScrollMemory(reference, activeTurn)?.written).toBe(true);
    expect(readSessionScrollMemory(reference)).toEqual(activeTurn);
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
