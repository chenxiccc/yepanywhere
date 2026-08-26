/**
 * Ephemeral correlation metadata for Codex tool messages whose live
 * app-server event and durable rollout item use different provider identities.
 *
 * This metadata travels with YA's in-memory/API message representation only.
 * The rollout remains the sole durable transcript source of truth.
 */

export const CODEX_TOOL_CORRELATION_FIELD = "_codexToolCorrelation";

export type CodexToolCorrelationOrigin =
  | "command_execution"
  | "custom_tool_call"
  | "function_call"
  | "image_view"
  | "plan_update";

export interface CodexToolCorrelationMetadata {
  origin: CodexToolCorrelationOrigin;
  turnId: string;
  itemId: string;
  /** Live command start time, retained when completion replaces its start. */
  startedAt?: string;
  /** Added client-side after an exact live-to-durable match. */
  durableCallId?: string;
  /** Added client-side to the durable-shaped copy after an exact match. */
  liveItemId?: string;
}

export function createCodexToolCorrelation(
  origin: CodexToolCorrelationOrigin,
  turnId: string,
  itemId: string,
  startedAt?: string,
): CodexToolCorrelationMetadata {
  return { origin, turnId, itemId, ...(startedAt ? { startedAt } : {}) };
}

export function getCodexToolCorrelation(
  value: unknown,
): CodexToolCorrelationMetadata | null {
  if (!value || typeof value !== "object") return null;
  const metadata = (value as Record<string, unknown>)[
    CODEX_TOOL_CORRELATION_FIELD
  ];
  if (!metadata || typeof metadata !== "object") return null;

  const record = metadata as Record<string, unknown>;
  const origin = record.origin;
  if (
    origin !== "command_execution" &&
    origin !== "custom_tool_call" &&
    origin !== "function_call" &&
    origin !== "image_view" &&
    origin !== "plan_update"
  ) {
    return null;
  }
  if (typeof record.turnId !== "string" || typeof record.itemId !== "string") {
    return null;
  }

  return {
    origin,
    turnId: record.turnId,
    itemId: record.itemId,
    ...(typeof record.startedAt === "string"
      ? { startedAt: record.startedAt }
      : {}),
    ...(typeof record.durableCallId === "string"
      ? { durableCallId: record.durableCallId }
      : {}),
    ...(typeof record.liveItemId === "string"
      ? { liveItemId: record.liveItemId }
      : {}),
  };
}

/** Read Codex's rollout-recoverable turn id without depending on raw schemas. */
export function getCodexResponseItemTurnId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const metadata = (payload as Record<string, unknown>)
    .internal_chat_message_metadata_passthrough;
  if (!metadata || typeof metadata !== "object") return null;
  const turnId = (metadata as Record<string, unknown>).turn_id;
  return typeof turnId === "string" ? turnId : null;
}
