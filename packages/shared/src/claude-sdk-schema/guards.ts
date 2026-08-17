import type { AssistantEntry } from "./entry/AssistantEntrySchema.js";
import type { SystemEntry } from "./entry/SystemEntrySchema.js";
import type { UserEntry } from "./entry/UserEntrySchema.js";
import type { ClaudeSessionEntry } from "./index.js";

function getObjectField(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const field = value[key];
  return field && typeof field === "object" && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : undefined;
}

function getStringField(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (!value) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function getLastStringField(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (!value) return undefined;
  const field = value[key];
  if (!Array.isArray(field)) return undefined;

  for (let index = field.length - 1; index >= 0; index -= 1) {
    const item = field[index];
    if (typeof item === "string") {
      return item;
    }
  }

  return undefined;
}

/** Check if entry is a compact_boundary system entry */
export function isCompactBoundary(
  entry: ClaudeSessionEntry,
): entry is SystemEntry & { subtype: "compact_boundary" } {
  return (
    entry.type === "system" &&
    "subtype" in entry &&
    entry.subtype === "compact_boundary"
  );
}

/** Get logicalParentUuid if compact_boundary, otherwise undefined */
export function getLogicalParentUuid(
  entry: ClaudeSessionEntry,
): string | undefined {
  if (isCompactBoundary(entry)) {
    const logicalParentUuid = (entry as { logicalParentUuid?: string })
      .logicalParentUuid;
    if (logicalParentUuid) {
      return logicalParentUuid;
    }

    const compactMetadata = (entry as { compactMetadata?: unknown })
      .compactMetadata;
    if (!compactMetadata || typeof compactMetadata !== "object") {
      return undefined;
    }

    const metadata = compactMetadata as Record<string, unknown>;
    const preservedSegment = getObjectField(metadata, "preservedSegment");
    const segmentTailUuid = getStringField(preservedSegment, "tailUuid");
    if (segmentTailUuid) {
      return segmentTailUuid;
    }

    const preservedMessages = getObjectField(metadata, "preservedMessages");
    return (
      getLastStringField(preservedMessages, "uuids") ??
      getLastStringField(preservedMessages, "allUuids")
    );
  }
  return undefined;
}

/**
 * Model id Claude Code stamps on assistant entries that no model produced.
 * Such an entry reports zero input and output tokens: no request was made.
 */
const SYNTHETIC_MODEL = "<synthetic>";

/**
 * The prompt Claude Code injects, as a meta user turn, when a message is
 * delivered to a session whose previous process is gone.
 */
const INJECTED_CONTINUATION_TEXT = "Continue from where you left off.";

/** The placeholder Claude Code records in place of a turn it never ran. */
const NO_RESPONSE_PLACEHOLDER_TEXT = "No response requested.";

/**
 * Loosest shape both predicates below need. They run against raw session
 * entries *and* normalized `Message`s, whose declared types differ but whose
 * carrier fields do not, so the parameter is structural rather than either
 * package's nominal type.
 */
type ContinuationEntryLike = {
  type?: unknown;
  isMeta?: unknown;
  content?: unknown;
  message?: { role?: unknown; model?: unknown; content?: unknown } | unknown;
};

function entryTextContent(entry: ContinuationEntryLike): string | undefined {
  const message =
    entry.message && typeof entry.message === "object"
      ? (entry.message as { content?: unknown })
      : undefined;
  const content = message?.content ?? entry.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(
      (block): block is { type: "text"; text: string } =>
        !!block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("")
    .trim();
  return text || undefined;
}

/**
 * The meta user turn Claude Code injects to restart a dead session, which the
 * user never typed. It is always answered by the synthetic placeholder below.
 */
export function isInjectedContinuationPrompt(
  entry: ContinuationEntryLike | null | undefined,
): boolean {
  if (!entry || typeof entry !== "object") return false;
  const role = (entry.message as { role?: unknown } | undefined)?.role;
  if (entry.type !== "user" && role !== "user") return false;
  if (entry.isMeta !== true) return false;
  return entryTextContent(entry) === INJECTED_CONTINUATION_TEXT;
}

/**
 * The assistant-shaped placeholder Claude Code records when it declined to run
 * a turn. No model produced it, so it is neither agent prose nor a real reply:
 * surfaces that quote the agent must skip it, and the transcript must not
 * render it as an assistant message.
 */
export function isSyntheticNoResponseTurn(
  entry: ContinuationEntryLike | null | undefined,
): boolean {
  if (!entry || typeof entry !== "object") return false;
  const message =
    entry.message && typeof entry.message === "object"
      ? (entry.message as { role?: unknown; model?: unknown })
      : undefined;
  if (entry.type !== "assistant" && message?.role !== "assistant") return false;
  if (message?.model !== SYNTHETIC_MODEL) return false;
  return entryTextContent(entry) === NO_RESPONSE_PLACEHOLDER_TEXT;
}

/** Check if entry is a conversation entry (has message field) */
export function isConversationEntry(
  entry: ClaudeSessionEntry,
): entry is UserEntry | AssistantEntry {
  return entry.type === "user" || entry.type === "assistant";
}

/** Get message content from user/assistant entry */
export function getMessageContent(entry: ClaudeSessionEntry) {
  if (isConversationEntry(entry)) {
    // Use optional chaining for defensive access (handles incomplete mock data in tests)
    return (entry as { message?: { content?: unknown } }).message?.content;
  }
  return undefined;
}
