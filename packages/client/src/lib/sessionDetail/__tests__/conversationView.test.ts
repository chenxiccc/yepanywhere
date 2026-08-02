import { describe, expect, it } from "vitest";
import type { Message } from "../../../types";
import type {
  ConversationActivityItem,
  RenderItem,
  ToolCallItem,
} from "../../../types/renderItems";
import {
  compactCommandActivityPreview,
  projectConversationView,
  selectConversationThinkingPreviews,
  windowConversationViewItems,
} from "../conversationView";

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

  it("does not start elapsed activity at an older compact boundary", () => {
    const projected = projectConversationView(
      [
        {
          type: "system",
          id: "compact-boundary",
          subtype: "compact_boundary",
          content: "Earlier context compacted",
          sourceMessages: [source("compact-source", 100)],
        },
        tool("visible-tail-activity", 1_000),
        {
          type: "text",
          id: "answer",
          text: "Done.",
          sourceMessages: [source("answer-source", 3_000)],
        },
      ],
      {
        active: false,
        nowMs: 4_000,
      },
    );

    expect(summary(projected)).toMatchObject({
      startedAtMs: 1_000,
      endedAtMs: 3_000,
    });
  });
});

describe("compactCommandActivityPreview", () => {
  it("skips setup-only segments and reduces path-heavy commands to filenames", () => {
    expect(
      compactCommandActivityPreview(
        "cd /repo && FOO=1 /repo/node_modules/.bin/vitest run /repo/src/app.test.ts",
      ),
    ).toBe("vitest run app.test.ts");
  });
});

describe("windowConversationViewItems", () => {
  it("starts the visible suffix at the configured latest user turn", () => {
    const items: RenderItem[] = Array.from({ length: 120 }, (_, index) => [
      {
        type: "user_prompt" as const,
        id: `user-${index + 1}`,
        content: `Request ${index + 1}`,
        sourceMessages: [],
      },
      {
        type: "text" as const,
        id: `answer-${index + 1}`,
        text: `Answer ${index + 1}`,
        sourceMessages: [],
      },
    ]).flat();

    const windowed = windowConversationViewItems(items, 100);

    expect(windowed.hiddenTurnCount).toBe(20);
    expect(windowed.visibleTurnCount).toBe(100);
    expect(windowed.items[0]?.id).toBe("user-21");
    expect(windowed.items.at(-1)?.id).toBe("answer-120");
  });

  it("keeps standalone rows following the retained user-turn boundary", () => {
    const items: RenderItem[] = [
      {
        type: "system",
        id: "setup",
        subtype: "session_setup",
        content: "Setup",
        sourceMessages: [],
      },
      {
        type: "user_prompt",
        id: "user-1",
        content: "First",
        sourceMessages: [],
      },
      {
        type: "system",
        id: "between",
        subtype: "status",
        content: "Between",
        sourceMessages: [],
      },
      {
        type: "user_prompt",
        id: "user-2",
        content: "Second",
        sourceMessages: [],
      },
      {
        type: "system",
        id: "after",
        subtype: "status",
        content: "After",
        sourceMessages: [],
      },
    ];

    expect(
      windowConversationViewItems(items, 1).items.map((item) => item.id),
    ).toEqual(["user-2", "after"]);
  });

  it("does not discard a transcript without user-turn boundaries", () => {
    const items: RenderItem[] = [tool("standalone-tool", 1_000)];

    const windowed = windowConversationViewItems(items, 100);

    expect(windowed.items).toBe(items);
    expect(windowed.hiddenTurnCount).toBe(0);
    expect(windowed.visibleTurnCount).toBe(0);
  });
});

describe("selectConversationThinkingPreviews", () => {
  it("selects the current block and one preceding completed block", () => {
    const items: RenderItem[] = [
      {
        type: "thinking",
        id: "older",
        thinking: "Older",
        status: "complete",
        sourceMessages: [],
      },
      {
        type: "thinking",
        id: "previous",
        thinking: "Previous",
        status: "complete",
        sourceMessages: [],
      },
      {
        type: "thinking",
        id: "current",
        thinking: "Current",
        status: "streaming",
        sourceMessages: [],
      },
    ];

    expect(selectConversationThinkingPreviews(items)).toEqual([
      {
        id: "current",
        kind: "current",
        slot: "latest",
        thinking: "Current",
        status: "streaming",
      },
      {
        id: "previous",
        kind: "previous",
        slot: "previous",
        thinking: "Previous",
        status: "complete",
      },
    ]);
  });

  it("labels the latest completed block and omits restored originals", () => {
    const items: RenderItem[] = [
      {
        type: "thinking",
        id: "previous",
        thinking: "Previous",
        status: "complete",
        sourceMessages: [],
      },
      {
        type: "thinking",
        id: "latest",
        thinking: "Latest",
        status: "complete",
        sourceMessages: [],
      },
    ];

    expect(selectConversationThinkingPreviews(items)[0]?.kind).toBe("latest");

    const projected = projectConversationView(items, {
      active: false,
      expandedActivityIds: new Set(["conversation-activity-previous"]),
      nowMs: 1_000,
    });
    expect(summary(projected).thinkingPreviews).toBeUndefined();
  });

  it("attaches both previews only after the final activity summary", () => {
    const items: RenderItem[] = [
      {
        type: "thinking",
        id: "previous",
        thinking: "Previous",
        status: "complete",
        sourceMessages: [],
      },
      {
        type: "user_prompt",
        id: "user",
        content: "Continue",
        sourceMessages: [],
      },
      {
        type: "thinking",
        id: "current",
        thinking: "Current",
        status: "streaming",
        sourceMessages: [],
      },
    ];

    const summaries = projectConversationView(items, {
      active: true,
      nowMs: 1_000,
    }).filter(
      (item): item is ConversationActivityItem =>
        item.type === "conversation_activity",
    );

    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.thinkingPreviews).toBeUndefined();
    expect(
      summaries[1]?.thinkingPreviews?.map((preview) => preview.id),
    ).toEqual(["current", "previous"]);
  });

  it("keeps only the latest thinking preview after the turn completes", () => {
    const projected = projectConversationView(
      [
        {
          type: "thinking",
          id: "previous",
          thinking: "Previous",
          status: "complete",
          sourceMessages: [],
        },
        {
          type: "thinking",
          id: "latest",
          thinking: "Latest",
          status: "complete",
          sourceMessages: [],
        },
      ],
      {
        active: false,
        nowMs: 1_000,
      },
    );

    expect(
      summary(projected).thinkingPreviews?.map((preview) => preview.id),
    ).toEqual(["latest"]);
  });

  it("omits dismissed preview slots without changing the source transcript", () => {
    const items: RenderItem[] = [
      {
        type: "thinking",
        id: "previous",
        thinking: "Previous",
        status: "complete",
        sourceMessages: [],
      },
      {
        type: "thinking",
        id: "latest",
        thinking: "Latest",
        status: "complete",
        sourceMessages: [],
      },
    ];

    const projected = projectConversationView(items, {
      active: false,
      dismissedThinkingPreviewSlots: new Set(["previous"]),
      nowMs: 1_000,
    });

    expect(
      summary(projected).thinkingPreviews?.map((preview) => preview.slot),
    ).toEqual(["latest"]);
    expect(items.map((item) => item.id)).toEqual(["previous", "latest"]);
  });

  it("lists only the activities after the last complete thinking block", () => {
    const projected = projectConversationView(
      [
        tool("read", 1_000, {
          toolName: "Read",
          toolInput: { file_path: "/repo/README.md" },
        }),
        tool("edit", 2_000, {
          toolName: "Edit",
          toolInput: {
            file_path: "/repo/src/app.ts",
            old_string: "before",
            new_string: "after",
          },
        }),
        {
          type: "thinking",
          id: "thinking",
          thinking: "Plan",
          status: "complete",
          sourceMessages: [],
        },
        tool("run", 3_000, {
          toolName: "Bash",
          toolInput: { command: "pnpm test" },
        }),
        tool("write", 4_000, {
          toolName: "Write",
          toolInput: { file_path: "/repo/report.md", content: "done" },
        }),
      ],
      { active: true, nowMs: 5_000 },
    );

    // Read and Edit ran before the completed thought, so they are already
    // accounted for by it and stay folded into the count.
    expect(summary(projected).recentActivities).toEqual([
      { label: "Write", detail: "Write: report.md", preview: "report.md" },
      { label: "Run", detail: "Run: pnpm test", preview: "pnpm test" },
    ]);
  });

  it("keeps the activities after the last thought once the turn ends", () => {
    const projected = projectConversationView(
      [
        tool("early", 1_000, {
          toolName: "Read",
          toolInput: { file_path: "/repo/README.md" },
        }),
        {
          type: "thinking",
          id: "thinking",
          thinking: "Plan",
          status: "complete",
          sourceMessages: [],
        },
        tool("run", 2_000, {
          toolName: "Bash",
          toolInput: { command: "pnpm test" },
        }),
      ],
      { active: false, nowMs: 5_000 },
    );

    expect(summary(projected).recentActivities).toEqual([
      { label: "Run", detail: "Run: pnpm test", preview: "pnpm test" },
    ]);
  });

  it("reaches back only to the previous complete thought while streaming", () => {
    const projected = projectConversationView(
      [
        tool("stale", 1_000, {
          toolName: "Read",
          toolInput: { file_path: "/repo/old.md" },
        }),
        {
          type: "thinking",
          id: "previous",
          thinking: "Earlier",
          status: "complete",
          sourceMessages: [],
        },
        tool("run", 2_000, {
          toolName: "Bash",
          toolInput: { command: "pnpm test" },
        }),
        {
          type: "thinking",
          id: "current",
          thinking: "Now",
          status: "streaming",
          sourceMessages: [],
        },
        tool("write", 3_000, {
          toolName: "Write",
          toolInput: { file_path: "/repo/report.md", content: "done" },
        }),
      ],
      { active: true, nowMs: 5_000 },
    );

    // The streaming block is not the bound — the reader is still working out
    // of `previous`, so what that thought led to stays visible.
    expect(
      summary(projected).recentActivities?.map((activity) => activity.label),
    ).toEqual(["Write", "Run"]);
  });

  it("collapses every activity when the turn did no thinking", () => {
    const projected = projectConversationView(
      [
        tool("read", 1_000, {
          toolName: "Read",
          toolInput: { file_path: "/repo/README.md" },
        }),
        tool("run", 2_000, {
          toolName: "Bash",
          toolInput: { command: "pnpm test" },
        }),
      ],
      { active: false, nowMs: 5_000 },
    );

    expect(summary(projected).recentActivities).toBeUndefined();
    expect(summary(projected).activityCount).toBe(2);
  });

  it("hides recent activity names after completion without removing expansion", () => {
    const items: RenderItem[] = [
      tool("read", 1_000, {
        toolName: "Read",
        toolInput: { file_path: "/repo/README.md" },
      }),
      {
        type: "thinking",
        id: "latest",
        thinking: "Done",
        status: "complete",
        sourceMessages: [],
      },
    ];
    const compact = projectConversationView(items, {
      active: false,
      nowMs: 2_000,
    });
    const compactSummary = summary(compact);

    expect(compactSummary.recentActivities).toBeUndefined();
    expect(
      compactSummary.thinkingPreviews?.map((preview) => preview.id),
    ).toEqual(["latest"]);

    const expanded = projectConversationView(items, {
      active: false,
      expandedActivityIds: new Set([compactSummary.id]),
      nowMs: 2_000,
    });
    expect(expanded.map((item) => item.id)).toEqual([
      "read",
      "latest",
      compactSummary.id,
    ]);
    expect(summary(expanded).expanded).toBe(true);
  });
});
