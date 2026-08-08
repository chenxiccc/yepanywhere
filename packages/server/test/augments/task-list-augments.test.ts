import { describe, expect, it } from "vitest";
import {
  TASK_SNAPSHOT_FIELD,
  augmentTaskListSnapshots,
  createTaskListAugmenter,
  pruneTaskListSnapshotsToLatest,
  type TaskListSnapshot,
} from "../../src/augments/task-list-augments.js";
import type { Message } from "../../src/supervisor/types.js";

function assistantToolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): Message {
  return {
    type: "assistant",
    uuid: `assistant-${id}`,
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }],
    },
  };
}

function userToolResult(
  toolUseId: string,
  content: string,
  toolUseResult?: unknown,
): Message {
  return {
    type: "user",
    uuid: `user-${toolUseId}`,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
    ...(toolUseResult !== undefined ? { toolUseResult } : {}),
  };
}

function firstToolInput(message: Message): Record<string, unknown> {
  const content = message.message?.content;
  if (!Array.isArray(content)) {
    throw new Error("Expected content blocks");
  }
  const block = content[0];
  if (block?.type !== "tool_use" || !block.input) {
    throw new Error("Expected tool_use block");
  }
  return block.input as Record<string, unknown>;
}

function snapshotFromInput(message: Message): TaskListSnapshot | undefined {
  return firstToolInput(message)[TASK_SNAPSHOT_FIELD] as
    | TaskListSnapshot
    | undefined;
}

function snapshotFromResult(message: Message): TaskListSnapshot | undefined {
  const result = message.toolUseResult;
  return result && typeof result === "object"
    ? ((result as Record<string, unknown>)[
        TASK_SNAPSHOT_FIELD
      ] as TaskListSnapshot)
    : undefined;
}

describe("task-list augments", () => {
  it("folds TaskCreate and TaskUpdate ids into snapshots", () => {
    const create = assistantToolUse("tool-create-1", "TaskCreate", {
      subject: "Review the renderer",
      description: "Inspect the client output",
      activeForm: "Reviewing the renderer",
    });
    const createResult = userToolResult(
      "tool-create-1",
      "Task #1 created successfully: Review the renderer",
    );
    const update = assistantToolUse("tool-update-1", "TaskUpdate", {
      taskId: "1",
      status: "in_progress",
    });
    const updateResult = userToolResult("tool-update-1", "updated", {
      success: true,
      taskId: "1",
      updatedFields: ["status"],
      statusChange: { from: "pending", to: "in_progress" },
    });
    const messages = [create, createResult, update, updateResult];

    augmentTaskListSnapshots(messages);

    expect(snapshotFromInput(create)?.tasks).toMatchObject([
      { id: "1", subject: "Review the renderer", status: "pending" },
    ]);
    expect(snapshotFromResult(updateResult)?.tasks).toMatchObject([
      { id: "1", subject: "Review the renderer", status: "in_progress" },
    ]);
  });

  it("does not replay correlation when a prepared message reaches async enrichment", () => {
    const create = assistantToolUse("tool-create-1", "TaskCreate", {
      subject: "Keep one ordered snapshot",
    });
    const result = userToolResult(
      "tool-create-1",
      "Task #1 created successfully: Keep one ordered snapshot",
    );
    const augmenter = createTaskListAugmenter();

    augmenter.processMessage(create as Record<string, unknown>);
    augmenter.processMessage(result as Record<string, unknown>);
    const snapshot = snapshotFromResult(result);

    augmenter.processMessage(create as Record<string, unknown>);
    augmenter.processMessage(result as Record<string, unknown>);

    expect(snapshotFromResult(result)).toBe(snapshot);
  });

  it("preserves off-window TaskCreate subjects before pruning to the latest returned event", () => {
    const create = assistantToolUse("tool-create-1", "TaskCreate", {
      subject: "Trace compaction behavior",
    });
    const createResult = userToolResult(
      "tool-create-1",
      "Task #1 created successfully: Trace compaction behavior",
    );
    const updateOne = assistantToolUse("tool-update-1", "TaskUpdate", {
      taskId: "1",
      status: "in_progress",
    });
    const updateOneResult = userToolResult("tool-update-1", "updated", {
      success: true,
      taskId: "1",
      statusChange: { from: "pending", to: "in_progress" },
    });
    const updateTwo = assistantToolUse("tool-update-2", "TaskUpdate", {
      taskId: "1",
      status: "completed",
    });
    const updateTwoResult = userToolResult("tool-update-2", "updated", {
      success: true,
      taskId: "1",
      statusChange: { from: "in_progress", to: "completed" },
    });
    const fullHistory = [
      create,
      createResult,
      updateOne,
      updateOneResult,
      updateTwo,
      updateTwoResult,
    ];

    augmentTaskListSnapshots(fullHistory);
    const returnedSlice = [
      updateOne,
      updateOneResult,
      updateTwo,
      updateTwoResult,
    ];
    pruneTaskListSnapshotsToLatest(returnedSlice);

    expect(snapshotFromInput(updateTwo)?.tasks).toMatchObject([
      {
        id: "1",
        subject: "Trace compaction behavior",
        status: "completed",
      },
    ]);
    expect(snapshotFromInput(updateOne)).toBeUndefined();
  });
});
