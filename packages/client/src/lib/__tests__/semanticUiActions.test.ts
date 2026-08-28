import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageSubmissionMetadata } from "../../types/messageSubmission";
import {
  executeSemanticUiComposerAction,
  installSemanticUiActionHarness,
  isSemanticUiActionHarnessEnabled,
  observeSemanticUiServerEvent,
  registerSemanticUiComposerExecutors,
  type SemanticUiAction,
  type SemanticUiActionHarnessApi,
} from "../semanticUiActions";
import {
  LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
  type ClientSummarySourceKey,
} from "../clientSummaryStore";

const sourceKey = LOCAL_CLIENT_SUMMARY_SOURCE_KEY;
const sessionId = "session-1";
const metadata: MessageSubmissionMetadata = {
  deliveryIntent: "direct",
  composition: { submittedAt: "2026-08-28T00:00:00.000Z" },
};

let api: SemanticUiActionHarnessApi | null = null;

afterEach(() => {
  api?.dispose();
  api = null;
  vi.restoreAllMocks();
});

function install(): SemanticUiActionHarnessApi {
  api = installSemanticUiActionHarness({
    schemaVersion: 1,
    gather: true,
    replay: true,
  });
  return api;
}

function observe(
  selectedSourceKey: ClientSummarySourceKey = sourceKey,
  selectedSessionId = sessionId,
): void {
  observeSemanticUiServerEvent(
    selectedSourceKey,
    selectedSessionId,
    "event-7",
    "message",
    { type: "assistant", uuid: "message-7" },
  );
}

function capture(executor = vi.fn()): SemanticUiAction {
  executeSemanticUiComposerAction(
    sourceKey,
    sessionId,
    "send",
    "continue",
    metadata,
    executor,
  );
  return api?.snapshot().actions[0] as SemanticUiAction;
}

describe("semantic UI actions", () => {
  it("adds only the inactive check before the direct executor", () => {
    const nowSpy = vi.spyOn(performance, "now");
    const dateSpy = vi.spyOn(Date, "now");
    const cloneSpy = vi.spyOn(globalThis, "structuredClone");
    const executor = vi.fn(() => "sent");

    expect(
      executeSemanticUiComposerAction(
        sourceKey,
        sessionId,
        "send",
        "continue",
        metadata,
        executor,
      ),
    ).toBe("sent");
    expect(isSemanticUiActionHarnessEnabled()).toBe(false);
    expect(executor).toHaveBeenCalledWith("continue", metadata);
    expect(nowSpy).not.toHaveBeenCalled();
    expect(dateSpy).not.toHaveBeenCalled();
    expect(cloneSpy).not.toHaveBeenCalled();
  });

  it("gathers a versioned composer action against an observed message", () => {
    install();
    observe();
    const executor = vi.fn();
    const action = capture(executor);

    expect(executor).toHaveBeenCalledWith("continue", metadata);
    expect(action).toMatchObject({
      schemaVersion: 1,
      actionId: "semantic-action-1",
      kind: "composer.submit",
      sourceKey,
      sessionId,
      anchor: {
        kind: "session-stream-event",
        eventId: "event-7",
        messageId: "message-7",
      },
      payload: {
        operation: "send",
        text: "continue",
        metadata,
      },
    });
    expect(action.anchor.delayMs).toBeGreaterThanOrEqual(0);
  });

  it("replays through the same registered composer executor", async () => {
    const harness = install();
    observe();
    const executor = vi.fn();
    const unregister = registerSemanticUiComposerExecutors(
      sourceKey,
      sessionId,
      { send: executor, defer: executor },
    );
    const action = capture(executor);
    executor.mockClear();

    const result = await harness.replay(action, {
      applyRecordedDelay: false,
    });

    expect(result.status).toBe("executed");
    expect(result.anchorMatched).toBe(true);
    expect(executor).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledWith("continue", metadata);
    expect(harness.snapshot().measurements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          side: "client",
          name: "semantic-action.executor",
          actionId: action.actionId,
        }),
      ]),
    );
    unregister();
  });

  it("records anchor divergence without discarding prior measurements", async () => {
    const harness = install();
    observe();
    const action = capture();
    harness.recordMeasurement({
      side: "server",
      name: "provider-first-text-delta",
      valueMs: 12.5,
      actionId: action.actionId,
    });
    const unmatched = structuredClone(action);
    unmatched.anchor.eventId = "event-missing";
    unmatched.anchor.messageId = "message-missing";

    const result = await harness.replay(unmatched, {
      anchorTimeoutMs: 0,
    });
    const snapshot = harness.snapshot();

    expect(result).toMatchObject({
      status: "diverged",
      anchorMatched: false,
      divergence: {
        stage: "anchor",
        reason: "session-stream anchor timeout",
      },
    });
    expect(snapshot.firstDivergence).toEqual(result.divergence);
    expect(snapshot.measurements).toContainEqual(
      expect.objectContaining({
        side: "server",
        name: "provider-first-text-delta",
        valueMs: 12.5,
      }),
    );
  });

  it("does not accept a reused stream event id for another message", async () => {
    const harness = install();
    observe();
    const executor = vi.fn();
    registerSemanticUiComposerExecutors(sourceKey, sessionId, {
      send: executor,
      defer: executor,
    });
    const action = capture(executor);
    observeSemanticUiServerEvent(
      sourceKey,
      sessionId,
      action.anchor.eventId,
      "message",
      { type: "assistant", uuid: "message-from-new-connection" },
    );
    const mismatched = structuredClone(action);
    mismatched.anchor.messageId = "message-missing";
    executor.mockClear();

    const result = await harness.replay(mismatched, { anchorTimeoutMs: 0 });

    expect(result.status).toBe("diverged");
    expect(result.divergence?.stage).toBe("anchor");
    expect(executor).not.toHaveBeenCalled();
  });

  it("does not retain synthetic actions from the overhead measurement", () => {
    const harness = install();
    observe();
    capture();
    const before = harness.snapshot();

    const result = harness.measureDispatchOverhead({
      sourceKey,
      sessionId,
      iterations: 1_000,
      gatherIterations: 100,
    });

    expect(result.iterations).toBe(1_000);
    expect(result.gatherIterations).toBe(100);
    expect(result.sampleCount).toBe(7);
    expect(result.directNsPerCall).toBeGreaterThanOrEqual(0);
    expect(result.disabledNsPerCall).toBeGreaterThanOrEqual(0);
    expect(
      result.observedDisabledOverheadUpperBoundNsPerCall,
    ).toBeGreaterThanOrEqual(0);
    expect(result.gatherEnabledNsPerCall).toBeGreaterThanOrEqual(0);
    expect(harness.snapshot().actions).toEqual(before.actions);
  });
});
