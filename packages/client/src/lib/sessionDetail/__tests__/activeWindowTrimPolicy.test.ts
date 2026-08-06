import { describe, expect, it, vi } from "vitest";
import type { Message } from "../../../types";
import {
  ACTIVE_WINDOW_MIN_BOUNDARY_AGE_MS,
  evaluateActiveWindowTrim,
  getActiveWindowStructuralKind,
  getActiveWindowTurnTrigger,
  isActiveWindowRealUserTurn,
  planActiveWindowTrim,
  shouldConsiderActiveWindowTrim,
  type ActiveWindowTrimCheckInput,
} from "../activeWindowTrimPolicy";

const NOW_MS = Date.parse("2026-07-10T12:00:00.000Z");
const OLD_TIMESTAMP = new Date(NOW_MS - 5 * 60_000).toISOString();

function user(id: string, timestamp = OLD_TIMESTAMP): Message {
  return {
    type: "user",
    uuid: id,
    timestamp,
    message: { role: "user", content: id },
  };
}

function assistant(id: string, timestamp = OLD_TIMESTAMP): Message {
  return {
    type: "assistant",
    uuid: id,
    timestamp,
    message: { role: "assistant", content: id },
  };
}

function compact(id: string, timestamp = OLD_TIMESTAMP): Message {
  return {
    type: "system",
    subtype: "compact_boundary",
    uuid: id,
    timestamp,
  };
}

function baseCheck(
  overrides: Partial<ActiveWindowTrimCheckInput> = {},
): ActiveWindowTrimCheckInput {
  return {
    enabled: true,
    followingBottom: true,
    historyExpanded: false,
    structuralRevision: 2,
    lastEvaluatedStructuralRevision: 1,
    completedTranscriptGrowth: false,
    nowMs: NOW_MS,
    ...overrides,
  };
}

describe("active window structural classification", () => {
  it("matches session pagination's real user-turn exclusions", () => {
    const syntheticMessages: Message[] = [
      {
        ...user("summary"),
        isCompactSummary: true,
      },
      {
        ...user("tool-result"),
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1" }],
        },
      },
      {
        ...user("skill-body"),
        isMeta: true,
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "Base directory for this skill: /tmp/skill\n\n# Skill",
            },
          ],
        },
      },
      {
        ...user("command"),
        message: {
          role: "user",
          content:
            "<command-name>/compact</command-name>\n" +
            "<command-message>compact</command-message>\n" +
            "<command-args></command-args>",
        },
      },
      {
        ...user("stdout"),
        message: {
          role: "user",
          content: "<local-command-stdout>Compacted</local-command-stdout>",
        },
      },
    ];

    expect(syntheticMessages.map(isActiveWindowRealUserTurn)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(isActiveWindowRealUserTurn(user("real"))).toBe(true);
    expect(
      isActiveWindowRealUserTurn({
        ...assistant("role-user"),
        message: { role: "user", content: "role-shaped user" },
      }),
    ).toBe(true);
    expect(getActiveWindowStructuralKind(compact("cb"))).toBe(
      "compact_boundary",
    );
    expect(getActiveWindowStructuralKind(assistant("a"))).toBeNull();
  });
});

describe("shouldConsiderActiveWindowTrim", () => {
  it.each([
    ["disabled", { enabled: false }],
    ["history expanded", { historyExpanded: true }],
    ["not following bottom", { followingBottom: false }],
    ["explicit tailFrom", { tailFrom: "user-1" }],
  ])("rejects %s before planning", (_label, overrides) => {
    expect(shouldConsiderActiveWindowTrim(baseCheck(overrides))).toBe(false);
  });

  it("admits a new structural revision", () => {
    expect(shouldConsiderActiveWindowTrim(baseCheck())).toBe(true);
  });

  it("reconsiders an old pending candidate only on completed growth", () => {
    const pendingCandidateEligibleAfterMs = NOW_MS - 1;
    expect(
      shouldConsiderActiveWindowTrim(
        baseCheck({
          structuralRevision: 2,
          lastEvaluatedStructuralRevision: 2,
          completedTranscriptGrowth: true,
          pendingCandidateEligibleAfterMs,
        }),
      ),
    ).toBe(true);
    expect(
      shouldConsiderActiveWindowTrim(
        baseCheck({
          structuralRevision: 2,
          lastEvaluatedStructuralRevision: 2,
          completedTranscriptGrowth: false,
          pendingCandidateEligibleAfterMs,
        }),
      ),
    ).toBe(false);
    expect(
      shouldConsiderActiveWindowTrim(
        baseCheck({
          structuralRevision: 2,
          lastEvaluatedStructuralRevision: 2,
          completedTranscriptGrowth: true,
          pendingCandidateEligibleAfterMs: NOW_MS,
        }),
      ),
    ).toBe(false);
  });

  it("does not invoke the planner for frequent irrelevant actions", () => {
    const planner = vi.fn();
    const check = baseCheck({
      structuralRevision: 2,
      lastEvaluatedStructuralRevision: 2,
      completedTranscriptGrowth: false,
    });

    for (let index = 0; index < 10_000; index += 1) {
      expect(
        evaluateActiveWindowTrim(
          { check, plan: { messages: [], nowMs: NOW_MS } },
          planner,
        ),
      ).toEqual({ kind: "not_considered" });
    }

    expect(planner).not.toHaveBeenCalled();
  });
});

describe("planActiveWindowTrim", () => {
  it("keeps the newest two compact boundaries after a third", () => {
    const messages = [
      user("opening"),
      compact("cb-1"),
      assistant("a-1"),
      compact("cb-2"),
      assistant("a-2"),
      compact("cb-3"),
      assistant("a-3"),
    ];

    expect(planActiveWindowTrim({ messages, nowMs: NOW_MS })).toMatchObject({
      kind: "ready",
      candidate: {
        startIndex: 3,
        startMessageId: "cb-2",
        reason: "compact_boundary",
      },
    });
  });

  it("does not trim with only two compact boundaries", () => {
    const messages = [
      user("opening"),
      compact("cb-1"),
      assistant("a-1"),
      compact("cb-2"),
    ];

    expect(planActiveWindowTrim({ messages, nowMs: NOW_MS })).toEqual({
      kind: "none",
      reason: "below_threshold",
    });
  });

  it("uses 30-to-20 turn hysteresis", () => {
    const thirtyTurns = Array.from({ length: 30 }, (_, index) =>
      user(`u-${index + 1}`),
    );
    const thirtyOneTurns = [
      assistant("prefix"),
      ...Array.from({ length: 31 }, (_, index) => user(`u-${index + 1}`)),
    ];

    expect(
      planActiveWindowTrim({ messages: thirtyTurns, nowMs: NOW_MS }),
    ).toEqual({ kind: "none", reason: "below_threshold" });
    expect(
      planActiveWindowTrim({ messages: thirtyOneTurns, nowMs: NOW_MS }),
    ).toMatchObject({
      kind: "ready",
      candidate: {
        startMessageId: "u-12",
        reason: "user_turn",
        turnTarget: 20,
        turnTrigger: 30,
      },
    });
  });

  it("selects the later compact or user-turn start", () => {
    const messages: Message[] = [assistant("prefix")];
    for (let turn = 1; turn <= 31; turn += 1) {
      messages.push(user(`u-${turn}`));
      if (turn === 5) messages.push(compact("cb-1"));
      if (turn === 15) messages.push(compact("cb-2"));
      if (turn === 25) messages.push(compact("cb-3"));
    }

    expect(planActiveWindowTrim({ messages, nowMs: NOW_MS })).toMatchObject({
      kind: "ready",
      candidate: {
        startMessageId: "cb-2",
        reason: "compact_boundary",
      },
    });

    const earlierCompactMessages: Message[] = [assistant("prefix")];
    for (let turn = 1; turn <= 31; turn += 1) {
      earlierCompactMessages.push(user(`u-${turn}`));
      if (turn === 3) earlierCompactMessages.push(compact("early-cb-1"));
      if (turn === 7) earlierCompactMessages.push(compact("early-cb-2"));
      if (turn === 25) earlierCompactMessages.push(compact("early-cb-3"));
    }
    expect(
      planActiveWindowTrim({
        messages: earlierCompactMessages,
        nowMs: NOW_MS,
      }),
    ).toMatchObject({
      kind: "ready",
      candidate: {
        startMessageId: "u-12",
        reason: "user_turn",
      },
    });
  });

  it("requires the selected boundary to be strictly older than 60 seconds", () => {
    const exactBoundaryTimestamp = new Date(
      NOW_MS - ACTIVE_WINDOW_MIN_BOUNDARY_AGE_MS,
    ).toISOString();
    const messages = [
      user("opening"),
      compact("cb-1"),
      compact("cb-2", exactBoundaryTimestamp),
      compact("cb-3"),
    ];

    expect(planActiveWindowTrim({ messages, nowMs: NOW_MS })).toMatchObject({
      kind: "deferred",
      candidate: {
        startMessageId: "cb-2",
        eligibleAfterMs: NOW_MS,
      },
    });
    expect(planActiveWindowTrim({ messages, nowMs: NOW_MS + 1 })).toMatchObject(
      { kind: "ready" },
    );
  });

  it("refuses a missing or invalid boundary timestamp", () => {
    const missingTimestamp = [
      user("opening"),
      compact("cb-1"),
      { ...compact("cb-2"), timestamp: undefined },
      compact("cb-3"),
    ];
    const invalidTimestamp = [
      user("opening"),
      compact("cb-1"),
      compact("cb-2", "not-a-time"),
      compact("cb-3"),
    ];

    expect(
      planActiveWindowTrim({ messages: missingTimestamp, nowMs: NOW_MS }),
    ).toEqual({ kind: "none", reason: "invalid_timestamp" });
    expect(
      planActiveWindowTrim({ messages: invalidTimestamp, nowMs: NOW_MS }),
    ).toEqual({ kind: "none", reason: "invalid_timestamp" });
  });

  it("derives conservative hysteresis for a custom turn target", () => {
    expect(getActiveWindowTurnTrigger(4)).toBe(6);
    const messages = [
      assistant("prefix"),
      ...Array.from({ length: 7 }, (_, index) => user(`u-${index + 1}`)),
    ];

    expect(
      planActiveWindowTrim({ messages, nowMs: NOW_MS, tailTurns: 4 }),
    ).toMatchObject({
      kind: "ready",
      candidate: {
        startMessageId: "u-4",
        turnTarget: 4,
        turnTrigger: 6,
      },
    });
  });
});
