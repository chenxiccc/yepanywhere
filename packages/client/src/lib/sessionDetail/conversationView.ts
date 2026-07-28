import {
  getEarliestMessageTimestampMs,
  getLatestMessageTimestampMs,
} from "../messageAge";
import type {
  ConversationActivityItem,
  RenderItem,
  ToolCallItem,
} from "../../types/renderItems";
import { groupRenderItemsIntoTurns } from "./renderItems";

export interface ConversationViewProjectionOptions {
  active: boolean;
  expandedActivityIds?: ReadonlySet<string>;
  nowMs: number;
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
      endedAtMs =
        endedAtMs === null ? itemEnd : Math.max(endedAtMs, itemEnd);
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
    expandedActivityIds = new Set<string>(),
    nowMs,
  }: ConversationViewProjectionOptions,
): RenderItem[] {
  const groups = groupRenderItemsIntoTurns(items);
  let lastAssistantGroupIndex = -1;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group && !group.isUserPrompt && !group.isStandalone) {
      lastAssistantGroupIndex = index;
      break;
    }
  }

  return groups.flatMap((group, groupIndex) => {
    if (group.isUserPrompt || group.isStandalone) {
      return group.items;
    }

    const hiddenItems = group.items.filter(isConversationViewActivity);
    if (hiddenItems.length === 0) {
      return group.items;
    }

    const summaryId = `conversation-activity-${hiddenItems[0]?.id ?? groupIndex}`;
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
