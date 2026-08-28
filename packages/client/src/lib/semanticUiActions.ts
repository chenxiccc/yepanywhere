import type { MessageSubmissionMetadata } from "../types/messageSubmission";
import type { ClientSummarySourceKey } from "./clientSummaryStore";

export const SEMANTIC_UI_ACTION_SCHEMA_VERSION = 1 as const;

const DEFAULT_ANCHOR_TIMEOUT_MS = 5_000;
const MAX_BENCHMARK_ITERATIONS = 1_000_000;

export type SemanticUiComposerOperation = "send" | "defer";

export interface SemanticUiActionAnchor {
  kind: "session-stream-event";
  eventId: string;
  messageId?: string;
  delayMs: number;
}

export interface SemanticUiComposerAction {
  schemaVersion: typeof SEMANTIC_UI_ACTION_SCHEMA_VERSION;
  actionId: string;
  kind: "composer.submit";
  sourceKey: string;
  sessionId: string;
  capturedAt: string;
  anchor: SemanticUiActionAnchor;
  payload: {
    operation: SemanticUiComposerOperation;
    text: string;
    metadata?: MessageSubmissionMetadata;
  };
}

export type SemanticUiAction = SemanticUiComposerAction;

export interface SemanticUiActionMeasurement {
  side: "client" | "server";
  name: string;
  valueMs: number;
  actionId?: string;
  recordedAt: string;
}

export interface SemanticUiObservedEvent {
  sourceKey: string;
  sessionId: string;
  eventId: string;
  messageId?: string;
  dataType?: string;
  deltaType?: string;
  observedAtMonotonicMs: number;
}

export interface SemanticUiActionDivergence {
  schemaVersion: typeof SEMANTIC_UI_ACTION_SCHEMA_VERSION;
  stage: "gather" | "anchor" | "executor" | "screen-condition";
  reason: string;
  actionId?: string;
  sourceKey?: string;
  sessionId?: string;
  recordedAt: string;
  timing: {
    elapsedMs: number;
    anchorWaitMs?: number;
  };
}

export interface SemanticUiActionHarnessSnapshot {
  schemaVersion: typeof SEMANTIC_UI_ACTION_SCHEMA_VERSION;
  actions: SemanticUiAction[];
  observedEvents: SemanticUiObservedEvent[];
  measurements: SemanticUiActionMeasurement[];
  divergences: SemanticUiActionDivergence[];
  firstDivergence: SemanticUiActionDivergence | null;
  observedAnchorCount: number;
}

export interface SemanticUiActionReplayResult {
  status: "executed" | "diverged";
  actionId?: string;
  anchorMatched: boolean;
  timing: {
    startedAtMonotonicMs: number;
    anchorWaitMs: number;
    recordedDelayWaitMs: number;
    executorMs: number;
    nextPaintMs: number;
    totalMs: number;
  };
  divergence?: SemanticUiActionDivergence;
}

export interface SemanticUiActionDispatchOverhead {
  iterations: number;
  gatherIterations: number;
  sampleCount: number;
  directNsPerCall: number;
  disabledNsPerCall: number;
  disabledMinusDirectNsPerCall: number;
  observedDisabledOverheadUpperBoundNsPerCall: number;
  gatherEnabledNsPerCall: number;
}

export interface SemanticUiActionHarnessBootstrap {
  schemaVersion: typeof SEMANTIC_UI_ACTION_SCHEMA_VERSION;
  gather: boolean;
  replay: boolean;
}

export interface SemanticUiActionHarnessApi {
  schemaVersion: typeof SEMANTIC_UI_ACTION_SCHEMA_VERSION;
  kind: "semantic-ui-action-harness";
  snapshot(): SemanticUiActionHarnessSnapshot;
  replay(
    action: unknown,
    options?: { anchorTimeoutMs?: number; applyRecordedDelay?: boolean },
  ): Promise<SemanticUiActionReplayResult>;
  recordMeasurement(
    measurement: Omit<SemanticUiActionMeasurement, "recordedAt">,
  ): void;
  recordDivergence(input: {
    stage: "screen-condition";
    reason: string;
    actionId?: string;
    sourceKey?: string;
    sessionId?: string;
    elapsedMs: number;
  }): SemanticUiActionDivergence;
  measureDispatchOverhead(input: {
    sourceKey: string;
    sessionId: string;
    iterations?: number;
    gatherIterations?: number;
  }): SemanticUiActionDispatchOverhead;
  dispose(): void;
}

declare global {
  interface Window {
    __YA_SEMANTIC_UI_ACTIONS__?:
      | SemanticUiActionHarnessBootstrap
      | SemanticUiActionHarnessApi;
  }
}

type SemanticUiComposerExecutor = (
  text: string,
  metadata?: MessageSubmissionMetadata,
) => unknown;

interface SemanticUiComposerExecutors {
  send: SemanticUiComposerExecutor;
  defer: SemanticUiComposerExecutor;
}

interface ObservedAnchor {
  eventId: string;
  messageId?: string;
  observedAtMonotonicMs: number;
}

interface ObservedSessionAnchors {
  latest: ObservedAnchor;
  byEventId: Map<string, ObservedAnchor>;
  byMessageId: Map<string, ObservedAnchor>;
}

interface AnchorWaiter {
  action: SemanticUiAction;
  resolve: (anchor: ObservedAnchor | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

function monotonicNow(): number {
  return performance.now();
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function scopeKey(sourceKey: string, sessionId: string): string {
  return JSON.stringify([sourceKey, sessionId]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isSubmissionMetadata(
  value: unknown,
): value is MessageSubmissionMetadata {
  if (!isRecord(value) || !isRecord(value.composition)) return false;
  if (
    !["direct", "steer", "deferred", "patient"].includes(
      String(value.deliveryIntent),
    )
  ) {
    return false;
  }
  if (
    value.patienceSeconds !== undefined &&
    (typeof value.patienceSeconds !== "number" ||
      !Number.isFinite(value.patienceSeconds))
  ) {
    return false;
  }
  if (value.steerNow !== undefined && typeof value.steerNow !== "boolean") {
    return false;
  }
  for (const field of [
    "typingStartedAt",
    "typingEndedAt",
    "lastEditedAt",
    "submittedAt",
  ]) {
    if (!optionalString(value.composition[field])) return false;
  }
  if (value.speech !== undefined) {
    if (!isRecord(value.speech)) return false;
    if (!optionalString(value.speech.clientTurnId)) return false;
    if (
      value.speech.transcriptionIds !== undefined &&
      (!Array.isArray(value.speech.transcriptionIds) ||
        !value.speech.transcriptionIds.every(
          (candidate) => typeof candidate === "string",
        ))
    ) {
      return false;
    }
  }
  return true;
}

function parseSemanticUiAction(value: unknown): SemanticUiAction | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SEMANTIC_UI_ACTION_SCHEMA_VERSION ||
    value.kind !== "composer.submit" ||
    typeof value.actionId !== "string" ||
    !value.actionId ||
    typeof value.sourceKey !== "string" ||
    !value.sourceKey ||
    typeof value.sessionId !== "string" ||
    !value.sessionId ||
    typeof value.capturedAt !== "string" ||
    !isRecord(value.anchor) ||
    value.anchor.kind !== "session-stream-event" ||
    typeof value.anchor.eventId !== "string" ||
    !value.anchor.eventId ||
    !optionalString(value.anchor.messageId) ||
    typeof value.anchor.delayMs !== "number" ||
    !Number.isFinite(value.anchor.delayMs) ||
    value.anchor.delayMs < 0 ||
    !isRecord(value.payload) ||
    (value.payload.operation !== "send" &&
      value.payload.operation !== "defer") ||
    typeof value.payload.text !== "string" ||
    (value.payload.metadata !== undefined &&
      !isSubmissionMetadata(value.payload.metadata))
  ) {
    return null;
  }
  return value as unknown as SemanticUiAction;
}

function extractMessageId(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  if (typeof data.uuid === "string") return data.uuid;
  if (typeof data.id === "string") return data.id;
  const event = isRecord(data.event) ? data.event : null;
  const message = event && isRecord(event.message) ? event.message : null;
  return typeof message?.id === "string" ? message.id : undefined;
}

function validatedIterationCount(
  value: number | undefined,
  fallback: number,
): number {
  const count = value ?? fallback;
  if (
    !Number.isInteger(count) ||
    count <= 0 ||
    count > MAX_BENCHMARK_ITERATIONS
  ) {
    throw new Error(
      `semantic action benchmark iterations must be in [1, ${MAX_BENCHMARK_ITERATIONS}]`,
    );
  }
  return count;
}

class SemanticUiActionHarnessRuntime {
  readonly actions: SemanticUiAction[] = [];
  readonly observedEvents: SemanticUiObservedEvent[] = [];
  readonly measurements: SemanticUiActionMeasurement[] = [];
  readonly divergences: SemanticUiActionDivergence[] = [];
  readonly anchors = new Map<string, ObservedSessionAnchors>();
  readonly executors = new Map<string, SemanticUiComposerExecutors>();
  readonly waiters = new Set<AnchorWaiter>();
  private nextActionSequence = 0;

  constructor(
    readonly gather: boolean,
    readonly replayEnabled: boolean,
  ) {}

  observe(
    sourceKey: string,
    sessionId: string,
    eventId: string,
    data: unknown,
  ): void {
    const dataRecord = isRecord(data) ? data : null;
    const eventRecord =
      dataRecord && isRecord(dataRecord.event) ? dataRecord.event : null;
    const deltaRecord =
      eventRecord && isRecord(eventRecord.delta) ? eventRecord.delta : null;
    const anchor: ObservedAnchor = {
      eventId,
      messageId: extractMessageId(data),
      observedAtMonotonicMs: monotonicNow(),
    };
    this.observedEvents.push({
      sourceKey,
      sessionId,
      eventId,
      ...(anchor.messageId ? { messageId: anchor.messageId } : {}),
      ...(typeof dataRecord?.type === "string"
        ? { dataType: dataRecord.type }
        : {}),
      ...(typeof deltaRecord?.type === "string"
        ? { deltaType: deltaRecord.type }
        : {}),
      observedAtMonotonicMs: anchor.observedAtMonotonicMs,
    });
    const key = scopeKey(sourceKey, sessionId);
    const observed = this.anchors.get(key) ?? {
      latest: anchor,
      byEventId: new Map(),
      byMessageId: new Map(),
    };
    observed.latest = anchor;
    observed.byEventId.set(anchor.eventId, anchor);
    if (anchor.messageId) observed.byMessageId.set(anchor.messageId, anchor);
    this.anchors.set(key, observed);

    for (const waiter of this.waiters) {
      const match = this.matchAnchor(waiter.action);
      if (!match) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(match);
    }
  }

  capture(
    sourceKey: string,
    sessionId: string,
    operation: SemanticUiComposerOperation,
    text: string,
    metadata?: MessageSubmissionMetadata,
  ): void {
    if (!this.gather) return;
    const capturedAtMonotonicMs = monotonicNow();
    const anchor = this.anchors.get(scopeKey(sourceKey, sessionId))?.latest;
    if (!anchor) {
      this.addDivergence({
        stage: "gather",
        reason: "no observed session-stream message anchor",
        sourceKey,
        sessionId,
        elapsedMs: 0,
      });
      return;
    }
    this.actions.push({
      schemaVersion: SEMANTIC_UI_ACTION_SCHEMA_VERSION,
      actionId: `semantic-action-${++this.nextActionSequence}`,
      kind: "composer.submit",
      sourceKey,
      sessionId,
      capturedAt: new Date().toISOString(),
      anchor: {
        kind: "session-stream-event",
        eventId: anchor.eventId,
        ...(anchor.messageId ? { messageId: anchor.messageId } : {}),
        delayMs: round(
          Math.max(0, capturedAtMonotonicMs - anchor.observedAtMonotonicMs),
        ),
      },
      payload: {
        operation,
        text,
        ...(metadata === undefined
          ? {}
          : { metadata: structuredClone(metadata) }),
      },
    });
  }

  register(
    sourceKey: string,
    sessionId: string,
    executors: SemanticUiComposerExecutors,
  ): () => void {
    const key = scopeKey(sourceKey, sessionId);
    this.executors.set(key, executors);
    return () => {
      if (this.executors.get(key) === executors) this.executors.delete(key);
    };
  }

  async replay(
    input: unknown,
    options: { anchorTimeoutMs?: number; applyRecordedDelay?: boolean } = {},
  ): Promise<SemanticUiActionReplayResult> {
    const startedAtMonotonicMs = monotonicNow();
    const emptyTiming = {
      startedAtMonotonicMs,
      anchorWaitMs: 0,
      recordedDelayWaitMs: 0,
      executorMs: 0,
      nextPaintMs: 0,
      totalMs: 0,
    };
    const action = parseSemanticUiAction(input);
    if (!action) {
      const divergence = this.addDivergence({
        stage: "anchor",
        reason: "invalid semantic UI action record",
        elapsedMs: monotonicNow() - startedAtMonotonicMs,
      });
      return {
        status: "diverged",
        anchorMatched: false,
        timing: {
          ...emptyTiming,
          totalMs: round(monotonicNow() - startedAtMonotonicMs),
        },
        divergence,
      };
    }
    if (!this.replayEnabled) {
      const divergence = this.addDivergence({
        stage: "executor",
        reason: "semantic UI action replay is disabled",
        action,
        elapsedMs: monotonicNow() - startedAtMonotonicMs,
      });
      return {
        status: "diverged",
        actionId: action.actionId,
        anchorMatched: false,
        timing: {
          ...emptyTiming,
          totalMs: round(monotonicNow() - startedAtMonotonicMs),
        },
        divergence,
      };
    }

    const anchorWaitStartedAtMs = monotonicNow();
    const matchedAnchor = await this.waitForAnchor(
      action,
      options.anchorTimeoutMs ?? DEFAULT_ANCHOR_TIMEOUT_MS,
    );
    const anchorWaitMs = monotonicNow() - anchorWaitStartedAtMs;
    if (!matchedAnchor) {
      const divergence = this.addDivergence({
        stage: "anchor",
        reason: "session-stream anchor timeout",
        action,
        elapsedMs: monotonicNow() - startedAtMonotonicMs,
        anchorWaitMs,
      });
      return {
        status: "diverged",
        actionId: action.actionId,
        anchorMatched: false,
        timing: {
          ...emptyTiming,
          anchorWaitMs: round(anchorWaitMs),
          totalMs: round(monotonicNow() - startedAtMonotonicMs),
        },
        divergence,
      };
    }

    let recordedDelayWaitMs = 0;
    if (options.applyRecordedDelay !== false) {
      const remainingDelayMs = Math.max(
        0,
        matchedAnchor.observedAtMonotonicMs +
          action.anchor.delayMs -
          monotonicNow(),
      );
      if (remainingDelayMs > 0) {
        const delayStartedAtMs = monotonicNow();
        await new Promise((resolve) => setTimeout(resolve, remainingDelayMs));
        recordedDelayWaitMs = monotonicNow() - delayStartedAtMs;
      }
    }

    const executors = this.executors.get(
      scopeKey(action.sourceKey, action.sessionId),
    );
    const executor = executors?.[action.payload.operation];
    if (!executor) {
      const divergence = this.addDivergence({
        stage: "executor",
        reason: "semantic composer executor is not mounted",
        action,
        elapsedMs: monotonicNow() - startedAtMonotonicMs,
        anchorWaitMs,
      });
      return {
        status: "diverged",
        actionId: action.actionId,
        anchorMatched: true,
        timing: {
          ...emptyTiming,
          anchorWaitMs: round(anchorWaitMs),
          recordedDelayWaitMs: round(recordedDelayWaitMs),
          totalMs: round(monotonicNow() - startedAtMonotonicMs),
        },
        divergence,
      };
    }

    const executorStartedAtMs = monotonicNow();
    try {
      await executor(action.payload.text, action.payload.metadata);
    } catch (error) {
      const executorMs = monotonicNow() - executorStartedAtMs;
      const divergence = this.addDivergence({
        stage: "executor",
        reason: error instanceof Error ? error.message : String(error),
        action,
        elapsedMs: monotonicNow() - startedAtMonotonicMs,
        anchorWaitMs,
      });
      return {
        status: "diverged",
        actionId: action.actionId,
        anchorMatched: true,
        timing: {
          ...emptyTiming,
          anchorWaitMs: round(anchorWaitMs),
          recordedDelayWaitMs: round(recordedDelayWaitMs),
          executorMs: round(executorMs),
          totalMs: round(monotonicNow() - startedAtMonotonicMs),
        },
        divergence,
      };
    }
    const executorMs = monotonicNow() - executorStartedAtMs;
    const paintStartedAtMs = monotonicNow();
    if (typeof requestAnimationFrame === "function") {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    }
    const nextPaintMs = monotonicNow() - paintStartedAtMs;
    const totalMs = monotonicNow() - startedAtMonotonicMs;
    for (const [name, valueMs] of [
      ["semantic-action.anchor-wait", anchorWaitMs],
      ["semantic-action.recorded-delay-wait", recordedDelayWaitMs],
      ["semantic-action.executor", executorMs],
      ["semantic-action.next-paint", nextPaintMs],
      ["semantic-action.total", totalMs],
    ] as const) {
      this.recordMeasurement({
        side: "client",
        name,
        valueMs,
        actionId: action.actionId,
      });
    }
    return {
      status: "executed",
      actionId: action.actionId,
      anchorMatched: true,
      timing: {
        startedAtMonotonicMs,
        anchorWaitMs: round(anchorWaitMs),
        recordedDelayWaitMs: round(recordedDelayWaitMs),
        executorMs: round(executorMs),
        nextPaintMs: round(nextPaintMs),
        totalMs: round(totalMs),
      },
    };
  }

  recordMeasurement(
    measurement: Omit<SemanticUiActionMeasurement, "recordedAt">,
  ): void {
    if (
      (measurement.side !== "client" && measurement.side !== "server") ||
      !measurement.name ||
      !Number.isFinite(measurement.valueMs) ||
      measurement.valueMs < 0
    ) {
      throw new Error("invalid semantic UI action measurement");
    }
    this.measurements.push({
      ...measurement,
      valueMs: round(measurement.valueMs),
      recordedAt: new Date().toISOString(),
    });
  }

  addDivergence(input: {
    stage: SemanticUiActionDivergence["stage"];
    reason: string;
    action?: SemanticUiAction;
    actionId?: string;
    sourceKey?: string;
    sessionId?: string;
    elapsedMs: number;
    anchorWaitMs?: number;
  }): SemanticUiActionDivergence {
    const divergence: SemanticUiActionDivergence = {
      schemaVersion: SEMANTIC_UI_ACTION_SCHEMA_VERSION,
      stage: input.stage,
      reason: input.reason,
      ...(input.action?.actionId || input.actionId
        ? { actionId: input.action?.actionId ?? input.actionId }
        : {}),
      ...(input.action?.sourceKey || input.sourceKey
        ? { sourceKey: input.action?.sourceKey ?? input.sourceKey }
        : {}),
      ...(input.action?.sessionId || input.sessionId
        ? { sessionId: input.action?.sessionId ?? input.sessionId }
        : {}),
      recordedAt: new Date().toISOString(),
      timing: {
        elapsedMs: round(Math.max(0, input.elapsedMs)),
        ...(input.anchorWaitMs === undefined
          ? {}
          : { anchorWaitMs: round(Math.max(0, input.anchorWaitMs)) }),
      },
    };
    this.divergences.push(divergence);
    return divergence;
  }

  snapshot(): SemanticUiActionHarnessSnapshot {
    return structuredClone({
      schemaVersion: SEMANTIC_UI_ACTION_SCHEMA_VERSION,
      actions: this.actions,
      observedEvents: this.observedEvents,
      measurements: this.measurements,
      divergences: this.divergences,
      firstDivergence: this.divergences[0] ?? null,
      observedAnchorCount: [...this.anchors.values()].reduce(
        (sum, anchors) => sum + anchors.byEventId.size,
        0,
      ),
    });
  }

  measureDispatchOverhead(input: {
    sourceKey: string;
    sessionId: string;
    iterations?: number;
    gatherIterations?: number;
  }): SemanticUiActionDispatchOverhead {
    const iterations = validatedIterationCount(input.iterations, 200_000);
    const gatherIterations = validatedIterationCount(
      input.gatherIterations,
      2_000,
    );
    let sink = 0;
    const executor: SemanticUiComposerExecutor = (text) => {
      sink += text.length;
    };
    const run = (count: number, invoke: () => void): number => {
      const startedAtMs = monotonicNow();
      for (let index = 0; index < count; index += 1) invoke();
      return ((monotonicNow() - startedAtMs) * 1_000_000) / count;
    };
    const median = (values: number[]): number => {
      const ordered = [...values].sort((left, right) => left - right);
      const middle = ordered[Math.floor(ordered.length / 2)];
      if (middle === undefined) {
        throw new Error("semantic action benchmark has no samples");
      }
      return middle;
    };

    run(1_000, () => executor("x"));
    const sampleCount = 7;
    const directSamples: number[] = [];
    const disabledSamples: number[] = [];
    const incumbentHarness = activeHarness;
    activeHarness = null;
    try {
      run(1_000, () =>
        executeSemanticUiComposerAction(
          input.sourceKey as ClientSummarySourceKey,
          input.sessionId,
          "send",
          "x",
          undefined,
          executor,
        ),
      );
      for (let sample = 0; sample < sampleCount; sample += 1) {
        const measureDirect = () => run(iterations, () => executor("x"));
        const measureDisabled = () =>
          run(iterations, () =>
            executeSemanticUiComposerAction(
              input.sourceKey as ClientSummarySourceKey,
              input.sessionId,
              "send",
              "x",
              undefined,
              executor,
            ),
          );
        if (sample % 2 === 0) {
          directSamples.push(measureDirect());
          disabledSamples.push(measureDisabled());
        } else {
          disabledSamples.push(measureDisabled());
          directSamples.push(measureDirect());
        }
      }
    } finally {
      activeHarness = incumbentHarness;
    }
    const directNsPerCall = median(directSamples);
    const disabledNsPerCall = median(disabledSamples);
    const disabledOverheadSamples = disabledSamples.map((value, index) => {
      const direct = directSamples[index];
      if (direct === undefined) {
        throw new Error("semantic action benchmark sample mismatch");
      }
      return value - direct;
    });

    const retainedActionCount = this.actions.length;
    const retainedDivergenceCount = this.divergences.length;
    const gatherEnabledNsPerCall = run(gatherIterations, () =>
      executeSemanticUiComposerAction(
        input.sourceKey as ClientSummarySourceKey,
        input.sessionId,
        "send",
        "x",
        undefined,
        executor,
      ),
    );
    this.actions.length = retainedActionCount;
    this.divergences.length = retainedDivergenceCount;
    if (sink <= 0) throw new Error("semantic action benchmark did no work");

    return {
      iterations,
      gatherIterations,
      sampleCount,
      directNsPerCall: round(directNsPerCall),
      disabledNsPerCall: round(disabledNsPerCall),
      disabledMinusDirectNsPerCall: round(median(disabledOverheadSamples)),
      observedDisabledOverheadUpperBoundNsPerCall: round(
        Math.max(0, ...disabledOverheadSamples),
      ),
      gatherEnabledNsPerCall: round(gatherEnabledNsPerCall),
    };
  }

  dispose(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.waiters.clear();
    this.executors.clear();
    this.anchors.clear();
  }

  private matchAnchor(action: SemanticUiAction): ObservedAnchor | null {
    const anchors = this.anchors.get(
      scopeKey(action.sourceKey, action.sessionId),
    );
    if (!anchors) return null;
    if (action.anchor.messageId) {
      return anchors.byMessageId.get(action.anchor.messageId) ?? null;
    }
    return anchors.byEventId.get(action.anchor.eventId) ?? null;
  }

  private waitForAnchor(
    action: SemanticUiAction,
    timeoutMs: number,
  ): Promise<ObservedAnchor | null> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error("semantic UI action anchor timeout must be nonnegative");
    }
    const current = this.matchAnchor(action);
    if (current) return Promise.resolve(current);
    if (timeoutMs === 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter: AnchorWaiter = {
        action,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve(null);
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }
}

let activeHarness: SemanticUiActionHarnessRuntime | null = null;

export function isSemanticUiActionHarnessEnabled(): boolean {
  return activeHarness !== null;
}

export function observeSemanticUiServerEvent(
  sourceKey: ClientSummarySourceKey,
  sessionId: string,
  eventId: string,
  eventType: string,
  data: unknown,
): void {
  const harness = activeHarness;
  if (!harness || eventType !== "message") return;
  harness.observe(sourceKey, sessionId, eventId, data);
}

export function executeSemanticUiComposerAction<TResult>(
  sourceKey: ClientSummarySourceKey,
  sessionId: string,
  operation: SemanticUiComposerOperation,
  text: string,
  metadata: MessageSubmissionMetadata | undefined,
  executor: (text: string, metadata?: MessageSubmissionMetadata) => TResult,
): TResult {
  const harness = activeHarness;
  if (!harness) return executor(text, metadata);
  harness.capture(sourceKey, sessionId, operation, text, metadata);
  return executor(text, metadata);
}

export function registerSemanticUiComposerExecutors(
  sourceKey: ClientSummarySourceKey,
  sessionId: string,
  executors: SemanticUiComposerExecutors,
): () => void {
  const harness = activeHarness;
  if (!harness) return () => {};
  return harness.register(sourceKey, sessionId, executors);
}

export function installSemanticUiActionHarness(
  bootstrap: SemanticUiActionHarnessBootstrap,
): SemanticUiActionHarnessApi {
  if (
    bootstrap.schemaVersion !== SEMANTIC_UI_ACTION_SCHEMA_VERSION ||
    (!bootstrap.gather && !bootstrap.replay)
  ) {
    throw new Error("invalid semantic UI action harness bootstrap");
  }
  if (activeHarness) {
    throw new Error("semantic UI action harness is already active");
  }
  const runtime = new SemanticUiActionHarnessRuntime(
    bootstrap.gather,
    bootstrap.replay,
  );
  activeHarness = runtime;
  const api: SemanticUiActionHarnessApi = {
    schemaVersion: SEMANTIC_UI_ACTION_SCHEMA_VERSION,
    kind: "semantic-ui-action-harness",
    snapshot: () => runtime.snapshot(),
    replay: (action, options) => runtime.replay(action, options),
    recordMeasurement: (measurement) => runtime.recordMeasurement(measurement),
    recordDivergence: (input) =>
      runtime.addDivergence({
        ...input,
        elapsedMs: input.elapsedMs,
      }),
    measureDispatchOverhead: (input) => runtime.measureDispatchOverhead(input),
    dispose: () => {
      if (activeHarness !== runtime) return;
      runtime.dispose();
      activeHarness = null;
      if (
        typeof window !== "undefined" &&
        window.__YA_SEMANTIC_UI_ACTIONS__ === api
      ) {
        delete window.__YA_SEMANTIC_UI_ACTIONS__;
      }
    },
  };
  if (typeof window !== "undefined") {
    window.__YA_SEMANTIC_UI_ACTIONS__ = api;
  }
  return api;
}

function installSemanticUiActionHarnessFromWindow(): void {
  if (typeof window === "undefined") return;
  const bootstrap = window.__YA_SEMANTIC_UI_ACTIONS__;
  if (!bootstrap || "kind" in bootstrap) return;
  if (
    bootstrap.schemaVersion !== SEMANTIC_UI_ACTION_SCHEMA_VERSION ||
    typeof bootstrap.gather !== "boolean" ||
    typeof bootstrap.replay !== "boolean" ||
    (!bootstrap.gather && !bootstrap.replay)
  ) {
    return;
  }
  installSemanticUiActionHarness(bootstrap);
}

installSemanticUiActionHarnessFromWindow();
