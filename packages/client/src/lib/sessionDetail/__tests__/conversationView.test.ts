import { describe, expect, it } from "vitest";
import type { Message } from "../../../types";
import type {
  ConversationActivityItem,
  RenderItem,
  ToolCallItem,
} from "../../../types/renderItems";
import { projectConversationView } from "../conversationView";

function source(id: string, timestampMs: number): Message {
  return {
    id,
    timestamp: new Date(timestampMs).toISOString(),
  } as Message;
}

function tool(
  id: string,
  timestampMs: number,
  overrides: Partial<ToolCallItem> = {},
): ToolCallItem {
  return {
    type: "tool_call",
    id,
    toolName: "Read",
    toolInput: {},
    status: "complete",
    sourceMessages: [source(`${id}-source`, timestampMs)],
    ...overrides,
  };
}

function summary(items: readonly RenderItem[]): ConversationActivityItem {
  const item = items.find(
    (candidate): candidate is ConversationActivityItem =>
      candidate.type === "conversation_activity",
  );
  expect(item).toBeDefined();
  return item as ConversationActivityItem;
}

describe("projectConversationView", () => {
  it("preserves authored text, media, and failures while summarizing routine activity", () => {
    const items: RenderItem[] = [
      {
        type: "user_prompt",
        id: "user",
        content: "Please inspect this.",
        sourceMessages: [source("user-source", 500)],
      },
      {
        type: "thinking",
        id: "thinking",
        thinking: "Planning",
        status: "complete",
        sourceMessages: [source("thinking-source", 1_000)],
      },
      tool("routine-tool", 2_000, {
        displayActions: [
          { kind: "read", name: "one.md", path: "one.md" },
          { kind: "read", name: "two.md", path: "two.md" },
        ],
      }),
      {
        type: "text",
        id: "answer",
        text: "Here is the result.",
        sourceMessages: [source("answer-source", 3_000)],
      },
      tool("image-tool", 4_000, {
        toolResult: {
          content: "",
          isError: false,
          media: [
            {
              state: "rejected",
              reason: "unsupported-media",
              filename: "result.png",
              toolCallId: "image-tool",
            },
          ],
        },
      }),
      tool("failed-tool", 5_000, { status: "error" }),
      {
        type: "task_notification",
        id: "failed-task",
        raw: "<task-notification><status>failed</status></task-notification>",
        status: "failed",
        summary: "Background task failed",
        sourceMessages: [source("failed-task-source", 5_500)],
      },
      {
        type: "task_notification",
        id: "completed-task",
        raw: "<task-notification><status>completed</status></task-notification>",
        status: "completed",
        summary: "Background task completed",
        sourceMessages: [source("completed-task-source", 6_000)],
      },
    ];

    const projected = projectConversationView(items, {
      active: false,
      nowMs: 9_000,
    });

    expect(projected.map((item) => item.id)).toEqual([
      "user",
      "answer",
      "image-tool",
      "failed-tool",
      "failed-task",
      "conversation-activity-thinking",
    ]);
    expect(summary(projected)).toMatchObject({
      activityCount: 4,
      active: false,
      expanded: false,
      startedAtMs: 1_000,
      endedAtMs: 6_000,
    });
  });

  it("restores hidden rows in their original positions when expanded", () => {
    const items: RenderItem[] = [
      tool("read-before", 1_000),
      {
        type: "text",
        id: "answer",
        text: "Done.",
        sourceMessages: [source("answer-source", 2_000)],
      },
      tool("read-after", 3_000),
    ];
    const compact = projectConversationView(items, {
      active: false,
      nowMs: 4_000,
    });
    const summaryId = summary(compact).id;

    const expanded = projectConversationView(items, {
      active: false,
      expandedActivityIds: new Set([summaryId]),
      nowMs: 4_000,
    });

    expect(expanded.map((item) => item.id)).toEqual([
      "read-before",
      "answer",
      "read-after",
      summaryId,
    ]);
    expect(summary(expanded).expanded).toBe(true);
  });

  it("uses the live clock only for the active final assistant turn", () => {
    const items: RenderItem[] = [
      tool("first-turn", 1_000),
      {
        type: "user_prompt",
        id: "next-user",
        content: "Continue.",
        sourceMessages: [source("next-user-source", 2_000)],
      },
      tool("active-turn", 3_000, { status: "pending" }),
    ];

    const projected = projectConversationView(items, {
      active: true,
      nowMs: 8_000,
    });
    const summaries = projected.filter(
      (item): item is ConversationActivityItem =>
        item.type === "conversation_activity",
    );

    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({
      active: false,
      endedAtMs: 1_000,
    });
    expect(summaries[1]).toMatchObject({
      active: true,
      startedAtMs: 3_000,
      endedAtMs: 8_000,
    });
  });
});
