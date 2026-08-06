import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asCodexAgentMessageDeltaNotification,
  asCodexCommandExecutionOutputDeltaNotification,
  asCodexErrorNotification,
  asCodexFileChangeOutputDeltaNotification,
  asCodexItemCompletedNotification,
  asCodexItemStartedNotification,
  asCodexPlanDeltaNotification,
  asCodexRawResponseItemCompletedNotification,
  asCodexReasoningSummaryTextDeltaNotification,
  asCodexThreadTokenUsageUpdatedNotification,
  asCodexTurnCompletedNotification,
  isCodexLiveDeltaNotificationMethod,
  isCodexLiveDeltaSuppressionEnabled,
} from "../../../src/sdk/providers/codex-notification-guards.js";

describe("Codex notification guards", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("classifies the live delta methods that YA can suppress", () => {
    const liveDeltaMethods = [
      "item/agentMessage/delta",
      "item/plan/delta",
      "item/reasoning/summaryTextDelta",
      "item/commandExecution/outputDelta",
      "item/fileChange/outputDelta",
    ];

    for (const method of liveDeltaMethods) {
      expect(isCodexLiveDeltaNotificationMethod(method)).toBe(true);
    }

    expect(isCodexLiveDeltaNotificationMethod("item/completed")).toBe(false);
    expect(isCodexLiveDeltaNotificationMethod("command/exec/outputDelta")).toBe(
      false,
    );
  });

  it("requires the live delta suppression env flag to be exactly true", () => {
    vi.stubEnv("YEP_CODEX_DISABLE_LIVE_DELTAS", "true");
    expect(isCodexLiveDeltaSuppressionEnabled()).toBe(true);

    vi.stubEnv("YEP_CODEX_DISABLE_LIVE_DELTAS", "false");
    expect(isCodexLiveDeltaSuppressionEnabled()).toBe(false);

    vi.stubEnv("YEP_CODEX_DISABLE_LIVE_DELTAS", "1");
    expect(isCodexLiveDeltaSuppressionEnabled()).toBe(false);
  });

  it("guards terminal turn notifications", () => {
    const completed = {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    };
    const error = {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: false,
      error: { message: "quota reached" },
    };

    expect(asCodexTurnCompletedNotification(completed)).toBe(completed);
    expect(asCodexTurnCompletedNotification({ ...completed, turn: {} })).toBe(
      null,
    );
    expect(asCodexErrorNotification(error)).toBe(error);
    expect(asCodexErrorNotification({ ...error, willRetry: "false" })).toBe(
      null,
    );
  });

  it("guards token usage updates", () => {
    const usage = {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        last: {
          inputTokens: 10,
          outputTokens: 4,
          cachedInputTokens: 2,
        },
      },
    };

    expect(asCodexThreadTokenUsageUpdatedNotification(usage)).toBe(usage);
    expect(
      asCodexThreadTokenUsageUpdatedNotification({
        ...usage,
        tokenUsage: { last: { inputTokens: 10, outputTokens: 4 } },
      }),
    ).toBe(null);
  });

  it("guards item lifecycle and delta notifications", () => {
    const itemStarted = {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "item-1", type: "message" },
    };
    const itemCompleted = {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "item-1", type: "message" },
    };
    const delta = {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      delta: "hello",
    };
    const reasoningDelta = {
      ...delta,
      summaryIndex: 0,
    };

    expect(asCodexItemStartedNotification(itemStarted)).toBe(itemStarted);
    expect(asCodexItemStartedNotification({ ...itemStarted, item: null })).toBe(
      null,
    );
    expect(asCodexItemCompletedNotification(itemCompleted)).toBe(itemCompleted);
    expect(
      asCodexItemCompletedNotification({ ...itemCompleted, item: "" }),
    ).toBe(null);
    expect(asCodexAgentMessageDeltaNotification(delta)).toBe(delta);
    expect(asCodexPlanDeltaNotification(delta)).toBe(delta);
    expect(asCodexCommandExecutionOutputDeltaNotification(delta)).toBe(delta);
    expect(asCodexFileChangeOutputDeltaNotification(delta)).toBe(delta);
    expect(
      asCodexAgentMessageDeltaNotification({ ...delta, delta: null }),
    ).toBe(null);
    expect(asCodexReasoningSummaryTextDeltaNotification(reasoningDelta)).toBe(
      reasoningDelta,
    );
    expect(
      asCodexReasoningSummaryTextDeltaNotification({
        ...reasoningDelta,
        summaryIndex: "0",
      }),
    ).toBe(null);
  });

  it("guards raw response item completed notifications", () => {
    const rawItemCompleted = {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "function_call",
        call_id: "call-1",
      },
    };

    expect(asCodexRawResponseItemCompletedNotification(rawItemCompleted)).toBe(
      rawItemCompleted,
    );
    expect(
      asCodexRawResponseItemCompletedNotification({
        ...rawItemCompleted,
        item: { call_id: "call-1" },
      }),
    ).toBe(null);
  });
});
