import {
  getEarliestMessageTimestampMs,
  getLatestMessageTimestampMs,
} from "../messageAge";
import { getDisplayBashCommandFromInput } from "../bashCommand";
import { getPathBasename } from "../text";
import { toolRegistry } from "../../components/renderers/tools";
import { getToolSummary } from "../../components/tools/summaries";
import type {
  ConversationActivityItem,
  ConversationRecentActivity,
  ConversationThinkingPreview,
  ConversationThinkingPreviewSlot,
  RenderItem,
  ToolCallItem,
} from "../../types/renderItems";
import { groupRenderItemsIntoTurns } from "./renderItems";

const RECENT_ACTIVITY_LIMIT = 3;
const COMMAND_WRAPPERS = new Set(["command", "env", "exec", "sudo", "time"]);
const SETUP_COMMAND = /^(?:cd|export|popd|pushd)\b/;

export interface ConversationViewProjectionOptions {
  active: boolean;
  dismissedThinkingPreviewSlots?: ReadonlySet<ConversationThinkingPreviewSlot>;
  expandedActivityIds?: ReadonlySet<string>;
  nowMs: number;
}

export interface ConversationViewWindow {
  hiddenTurnCount: number;
  items: readonly RenderItem[];
  visibleTurnCount: number;
}

/**
 * Keep a suffix beginning at a user-turn boundary. This is a render projection:
 * the source transcript remains loaded and can be revealed without persistence
 * or a provider-history mutation.
 */
export function windowConversationViewItems(
  items: readonly RenderItem[],
  turnLimit: number,
): ConversationViewWindow {
  const userTurnIndexes: number[] = [];
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]?.type === "user_prompt") {
      userTurnIndexes.push(index);
    }
  }

  const normalizedLimit = Math.max(1, Math.floor(turnLimit));
  const hiddenTurnCount = Math.max(0, userTurnIndexes.length - normalizedLimit);
  if (hiddenTurnCount === 0) {
    return {
      hiddenTurnCount: 0,
      items,
      visibleTurnCount: userTurnIndexes.length,
    };
  }

  const firstVisibleIndex = userTurnIndexes[hiddenTurnCount] ?? 0;
  return {
    hiddenTurnCount,
    items: items.slice(firstVisibleIndex),
    visibleTurnCount: userTurnIndexes.length - hiddenTurnCount,
  };
}

function isMediaToolCall(item: ToolCallItem): boolean {
  return (item.toolResult?.media?.length ?? 0) > 0;
}

/**
 * Errors and incomplete calls retain their ordinary renderer: Conversation
 * view may compress routine work, but it must not erase actionable failure
 * state. Media calls also retain their media-only renderer so images stay
 * associated with the assistant turn.
 */
export function isConversationViewActivity(item: RenderItem): boolean {
  if (item.type === "thinking") {
    return true;
  }
  if (item.type === "task_notification") {
    const status = item.status?.toLowerCase();
    return status !== "failed" && status !== "error";
  }
  if (item.type === "system") {
    return item.subtype === "subagent_activity";
  }
  if (item.type !== "tool_call") {
    return false;
  }
  return (
    !isMediaToolCall(item) &&
    item.status !== "error" &&
    item.status !== "incomplete"
  );
}

export function getConversationViewActivityCount(item: RenderItem): number {
  if (item.type !== "tool_call") {
    return 1;
  }
  return Math.max(1, item.displayActions?.length ?? 0);
}

function compactPathToken(token: string): string {
  const quote =
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
      ? token[0]
      : "";
  const unquoted = quote ? token.slice(1, -1) : token;
  if (
    !unquoted.startsWith("/") &&
    !unquoted.startsWith("./") &&
    !unquoted.startsWith("../")
  ) {
    return token;
  }
  const basename = getPathBasename(unquoted);
  return quote ? `${quote}${basename}${quote}` : basename;
}

export function compactCommandActivityPreview(command: string): string {
  const segments = command
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .filter(Boolean);
  const segment =
    segments.find((candidate) => !SETUP_COMMAND.test(candidate)) ??
    segments[0] ??
    "";
  const tokens = segment.match(/(?:"[^"]*"|'[^']*'|\S+)/g) ?? [];
  let executableIndex = 0;
  while (executableIndex < tokens.length) {
    const token = tokens[executableIndex] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      executableIndex += 1;
      continue;
    }
    if (COMMAND_WRAPPERS.has(token)) {
      executableIndex += 1;
      continue;
    }
    break;
  }
  return tokens.slice(executableIndex).map(compactPathToken).join(" ");
}

function getToolActivityPreview(
  item: ToolCallItem,
  canonicalToolName: string,
  summary: string,
): string | undefined {
  if (["Read", "Write", "Edit"].includes(canonicalToolName)) {
    return summary && summary !== "..." ? summary : undefined;
  }
  if (canonicalToolName !== "Bash") return undefined;
  if (
    item.toolInput &&
    typeof item.toolInput === "object" &&
    !Array.isArray(item.toolInput)
  ) {
    const description = (item.toolInput as Record<string, unknown>).description;
    if (typeof description === "string" && description.trim()) {
      return description.trim();
    }
  }
  const compact = compactCommandActivityPreview(
    getDisplayBashCommandFromInput(item.toolInput),
  );
  return compact || (summary && summary !== "..." ? summary : undefined);
}

function getRecentActivity(
  item: RenderItem,
): ConversationRecentActivity | null {
  if (item.type === "tool_call") {
    const renderer = toolRegistry.get(item.toolName);
    const label = toolRegistry.getDisplayName(
      item.toolName,
      "pending",
      item.toolInput,
    );
    const summary = getToolSummary(
      item.toolName,
      item.toolInput,
      item.toolResult,
      item.status,
    );
    const preview = getToolActivityPreview(item, renderer.tool, summary);
    return {
      label,
      detail: summary && summary !== "..." ? `${label}: ${summary}` : label,
      ...(preview ? { preview } : {}),
    };
  }
  if (item.type === "task_notification") {
    return {
      label: "Task",
      detail:
        item.summary?.trim() ||
        item.event?.trim() ||
        item.status?.trim() ||
        "Task activity",
    };
  }
  if (item.type === "system" && item.subtype === "subagent_activity") {
    return {
      label: "Agent",
      detail: item.content.trim() || "Agent activity",
    };
  }
  return null;
}

function getRecentActivities(
  items: readonly RenderItem[],
): ConversationRecentActivity[] | undefined {
  const activities: ConversationRecentActivity[] = [];
  for (
    let index = items.length - 1;
    index >= 0 && activities.length < RECENT_ACTIVITY_LIMIT;
    index -= 1
  ) {
    const item = items[index];
    if (!item) continue;
    const activity = getRecentActivity(item);
    if (activity) activities.push(activity);
  }
  return activities.length > 0 ? activities : undefined;
}

/**
 * Keep the latest thinking block. While it is streaming, also keep the
 * immediately preceding completed block so a new turn starts with context;
 * once the latest block completes, the superseded preview disappears.
 * Ordering is by preview priority rather than transcript position.
 */
export function selectConversationThinkingPreviews(
  items: readonly RenderItem[],
): ConversationThinkingPreview[] {
  let latestIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.type === "thinking") {
      latestIndex = index;
      break;
    }
  }
  if (latestIndex < 0) return [];

  const latest = items[latestIndex];
  if (latest?.type !== "thinking") return [];
  const previews: ConversationThinkingPreview[] = [
    {
      id: latest.id,
      kind: latest.status === "streaming" ? "current" : "latest",
      slot: "latest",
      thinking: latest.thinking,
      status: latest.status,
    },
  ];
  if (latest.status !== "streaming") return previews;

  for (let index = latestIndex - 1; index >= 0; index -= 1) {
    const candidate = items[index];
    if (candidate?.type !== "thinking" || candidate.status !== "complete") {
      continue;
    }
    previews.push({
      id: candidate.id,
      kind: "previous",
      slot: "previous",
      thinking: candidate.thinking,
      status: candidate.status,
    });
    break;
  }
  return previews;
}

function getTurnTimestampBounds(items: readonly RenderItem[]): {
  startedAtMs: number | null;
  endedAtMs: number | null;
} {
  let startedAtMs: number | null = null;
  let endedAtMs: number | null = null;
  for (const item of items) {
    const itemStart = getEarliestMessageTimestampMs(item.sourceMessages);
    const itemEnd = getLatestMessageTimestampMs(item.sourceMessages);
    if (itemStart !== null) {
      startedAtMs =
        startedAtMs === null ? itemStart : Math.min(startedAtMs, itemStart);
    }
    if (itemEnd !== null) {
      endedAtMs = endedAtMs === null ? itemEnd : Math.max(endedAtMs, itemEnd);
    }
  }
  return { startedAtMs, endedAtMs };
}

/**
 * Project a transcript into Conversation view at the render-item boundary.
 * User turns and standalone transcript objects pass through unchanged.
 * Routine assistant activity is summarized once at the end of its turn.
 */
export function projectConversationView(
  items: readonly RenderItem[],
  {
    active,
    dismissedThinkingPreviewSlots = new Set<ConversationThinkingPreviewSlot>(),
    expandedActivityIds = new Set<string>(),
    nowMs,
  }: ConversationViewProjectionOptions,
): RenderItem[] {
  const groups = groupRenderItemsIntoTurns(items);
  let lastAssistantGroupIndex = -1;
  let lastActivityGroupIndex = -1;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group && !group.isUserPrompt && !group.isStandalone) {
      lastAssistantGroupIndex = index;
      break;
    }
  }

  const summaryIds = groups.map((group, groupIndex) => {
    const firstHiddenItem = group.items.find(isConversationViewActivity);
    if (!firstHiddenItem) return null;
    lastActivityGroupIndex = groupIndex;
    return `conversation-activity-${firstHiddenItem.id}`;
  });
  const expandedThinkingIds = new Set<string>();
  groups.forEach((group, groupIndex) => {
    const summaryId = summaryIds[groupIndex];
    if (!summaryId || !expandedActivityIds.has(summaryId)) return;
    for (const item of group.items) {
      if (item.type === "thinking") expandedThinkingIds.add(item.id);
    }
  });
  const thinkingPreviews = selectConversationThinkingPreviews(items).filter(
    (preview) =>
      !expandedThinkingIds.has(preview.id) &&
      !dismissedThinkingPreviewSlots.has(preview.slot),
  );

  return groups.flatMap((group, groupIndex) => {
    if (group.isUserPrompt || group.isStandalone) {
      return group.items;
    }

    const hiddenItems = group.items.filter(isConversationViewActivity);
    if (hiddenItems.length === 0) {
      return group.items;
    }

    const summaryId =
      summaryIds[groupIndex] ??
      `conversation-activity-${hiddenItems[0]?.id ?? groupIndex}`;
    const expanded = expandedActivityIds.has(summaryId);
    const isActive = active && groupIndex === lastAssistantGroupIndex;
    const { startedAtMs, endedAtMs } = getTurnTimestampBounds(group.items);
    const summary: ConversationActivityItem = {
      type: "conversation_activity",
      id: summaryId,
      activityCount: hiddenItems.reduce(
        (count, item) => count + getConversationViewActivityCount(item),
        0,
      ),
      active: isActive,
      expanded,
      thinkingPreviews:
        groupIndex === lastActivityGroupIndex && thinkingPreviews.length > 0
          ? thinkingPreviews
          : undefined,
      recentActivities:
        isActive &&
        groupIndex === lastActivityGroupIndex &&
        thinkingPreviews.length > 0
          ? getRecentActivities(hiddenItems)
          : undefined,
      startedAtMs,
      endedAtMs: isActive ? nowMs : endedAtMs,
      sourceMessages: hiddenItems.flatMap((item) => item.sourceMessages),
    };

    return [
      ...(expanded
        ? group.items
        : group.items.filter((item) => !isConversationViewActivity(item))),
      summary,
    ];
  });
}
