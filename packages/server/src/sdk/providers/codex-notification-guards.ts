import type {
  AgentMessageDeltaNotification,
  CommandExecutionOutputDeltaNotification,
  ErrorNotification as CodexErrorNotification,
  FileChangeOutputDeltaNotification,
  ItemCompletedNotification as CodexItemCompletedNotification,
  ItemStartedNotification as CodexItemStartedNotification,
  PlanDeltaNotification,
  RawResponseItemCompletedNotification,
  ReasoningSummaryTextDeltaNotification,
  ThreadTokenUsageUpdatedNotification,
  TurnCompletedNotification,
  TurnPlanUpdatedNotification,
} from "./codex-protocol/index.js";

const CODEX_DISABLE_LIVE_DELTAS_ENV = "YEP_CODEX_DISABLE_LIVE_DELTAS";
const CODEX_LIVE_DELTA_NOTIFICATION_METHODS = new Set<string>([
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
]);

export function isCodexLiveDeltaSuppressionEnabled(): boolean {
  return process.env[CODEX_DISABLE_LIVE_DELTAS_ENV] === "true";
}

export function isCodexLiveDeltaNotificationMethod(method: string): boolean {
  return CODEX_LIVE_DELTA_NOTIFICATION_METHODS.has(method);
}

export function asCodexTurnCompletedNotification(
  params: unknown,
): TurnCompletedNotification | null {
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  if (
    typeof record.threadId !== "string" ||
    !record.turn ||
    typeof record.turn !== "object" ||
    typeof (record.turn as { id?: unknown }).id !== "string"
  ) {
    return null;
  }
  return params as TurnCompletedNotification;
}

export function asCodexTurnPlanUpdatedNotification(
  params: unknown,
): TurnPlanUpdatedNotification | null {
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  if (
    typeof record.threadId !== "string" ||
    typeof record.turnId !== "string" ||
    (record.explanation !== null && typeof record.explanation !== "string") ||
    !Array.isArray(record.plan)
  ) {
    return null;
  }
  const validStatuses = new Set(["pending", "inProgress", "completed"]);
  if (
    !record.plan.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as Record<string, unknown>).step === "string" &&
        typeof (entry as Record<string, unknown>).status === "string" &&
        validStatuses.has((entry as Record<string, unknown>).status as string),
    )
  ) {
    return null;
  }
  return params as TurnPlanUpdatedNotification;
}

export function asCodexErrorNotification(
  params: unknown,
): CodexErrorNotification | null {
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  if (
    typeof record.threadId !== "string" ||
    typeof record.turnId !== "string" ||
    typeof record.willRetry !== "boolean" ||
    !record.error ||
    typeof record.error !== "object" ||
    typeof (record.error as { message?: unknown }).message !== "string"
  ) {
    return null;
  }
  return params as CodexErrorNotification;
}

/**
 * Read the explanatory detail string that belongs with a Codex turn error.
 *
 * App-server fills `additionalDetails` only on retryable stream errors; for a
 * terminal error it leaves that field null and, since Codex 0.151, carries the
 * substantive explanation of a misalignment block in `misalignment` instead.
 * The two therefore never arrive together, and preferring `additionalDetails`
 * keeps existing retry diagnostics unchanged while making the misalignment
 * explanation visible wherever YA already shows the detail string.
 *
 * `misalignment.steer` is deliberately not read here: submitting it is a
 * continuation affordance, not a detail string.
 */
export function readCodexTurnErrorDetail(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  const additionalDetails = record.additionalDetails;
  if (typeof additionalDetails === "string" && additionalDetails.trim()) {
    return additionalDetails;
  }
  const misalignment =
    record.misalignment && typeof record.misalignment === "object"
      ? (record.misalignment as Record<string, unknown>)
      : null;
  const explanation = misalignment?.detailedExplanation;
  if (typeof explanation === "string" && explanation.trim()) {
    return explanation;
  }
  return null;
}

export function asCodexThreadTokenUsageUpdatedNotification(
  params: unknown,
): ThreadTokenUsageUpdatedNotification | null {
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  const tokenUsage =
    record.tokenUsage && typeof record.tokenUsage === "object"
      ? (record.tokenUsage as Record<string, unknown>)
      : null;
  const last =
    tokenUsage?.last && typeof tokenUsage.last === "object"
      ? (tokenUsage.last as Record<string, unknown>)
      : null;
  if (
    typeof record.threadId !== "string" ||
    typeof record.turnId !== "string" ||
    !last ||
    typeof last.inputTokens !== "number" ||
    typeof last.outputTokens !== "number" ||
    typeof last.cachedInputTokens !== "number"
  ) {
    return null;
  }
  return params as ThreadTokenUsageUpdatedNotification;
}

export function asCodexItemStartedNotification(
  params: unknown,
): CodexItemStartedNotification | null {
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  if (
    typeof record.threadId !== "string" ||
    typeof record.turnId !== "string" ||
    !record.item ||
    typeof record.item !== "object"
  ) {
    return null;
  }
  return params as CodexItemStartedNotification;
}

export function asCodexItemCompletedNotification(
  params: unknown,
): CodexItemCompletedNotification | null {
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  if (
    typeof record.threadId !== "string" ||
    typeof record.turnId !== "string" ||
    !record.item ||
    typeof record.item !== "object"
  ) {
    return null;
  }
  return params as CodexItemCompletedNotification;
}

export function asCodexAgentMessageDeltaNotification(
  params: unknown,
): AgentMessageDeltaNotification | null {
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  if (
    typeof record.threadId !== "string" ||
    typeof record.turnId !== "string" ||
    typeof record.itemId !== "string" ||
    typeof record.delta !== "string"
  ) {
    return null;
  }
  return params as AgentMessageDeltaNotification;
}

export function asCodexPlanDeltaNotification(
  params: unknown,
): PlanDeltaNotification | null {
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  if (
    typeof record.threadId !== "string" ||
    typeof record.turnId !== "string" ||
    typeof record.itemId !== "string" ||
    typeof record.delta !== "string"
  ) {
    return null;
  }
  return params as PlanDeltaNotification;
}

export function asCodexReasoningSummaryTextDeltaNotification(
  params: unknown,
): ReasoningSummaryTextDeltaNotification | null {
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  if (
    typeof record.threadId !== "string" ||
    typeof record.turnId !== "string" ||
    typeof record.itemId !== "string" ||
    typeof record.delta !== "string" ||
    typeof record.summaryIndex !== "number"
  ) {
    return null;
  }
  return params as ReasoningSummaryTextDeltaNotification;
}

export function asCodexCommandExecutionOutputDeltaNotification(
  params: unknown,
): CommandExecutionOutputDeltaNotification | null {
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  if (
    typeof record.threadId !== "string" ||
    typeof record.turnId !== "string" ||
    typeof record.itemId !== "string" ||
    typeof record.delta !== "string"
  ) {
    return null;
  }
  return params as CommandExecutionOutputDeltaNotification;
}

export function asCodexFileChangeOutputDeltaNotification(
  params: unknown,
): FileChangeOutputDeltaNotification | null {
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  if (
    typeof record.threadId !== "string" ||
    typeof record.turnId !== "string" ||
    typeof record.itemId !== "string" ||
    typeof record.delta !== "string"
  ) {
    return null;
  }
  return params as FileChangeOutputDeltaNotification;
}

export function asCodexRawResponseItemCompletedNotification(
  params: unknown,
): RawResponseItemCompletedNotification | null {
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  if (
    typeof record.threadId !== "string" ||
    typeof record.turnId !== "string" ||
    !record.item ||
    typeof record.item !== "object" ||
    typeof (record.item as { type?: unknown }).type !== "string"
  ) {
    return null;
  }
  return params as RawResponseItemCompletedNotification;
}
