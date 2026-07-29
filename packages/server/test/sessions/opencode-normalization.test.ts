import type { OpenCodeStoredPart } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  convertOpenCodeParts,
  normalizeSession,
} from "../../src/sessions/normalization.js";
import type { LoadedSession } from "../../src/sessions/types.js";

function part(p: Partial<OpenCodeStoredPart>): OpenCodeStoredPart {
  return {
    id: "prt",
    sessionID: "ses",
    messageID: "msg",
    type: "text",
    ...p,
  } as OpenCodeStoredPart;
}

describe("convertOpenCodeParts (durable)", () => {
  it("maps reasoning parts to thinking blocks (skipping empty text)", () => {
    const blocks = convertOpenCodeParts([
      part({ type: "reasoning", text: "pondering" }),
      part({ type: "reasoning", text: "" }),
    ]);
    expect(blocks).toEqual([{ type: "thinking", thinking: "pondering" }]);
  });

  it("normalizes tool name + fields to YA rich-renderer shape", () => {
    const blocks = convertOpenCodeParts([
      part({
        type: "tool",
        tool: "edit",
        callID: "c1",
        state: {
          status: "completed",
          input: { filePath: "/a", oldString: "o", newString: "n" },
          output: "ok",
        },
      }),
    ]);
    expect(blocks[0]).toMatchObject({
      type: "tool_use",
      id: "c1",
      name: "Edit",
      input: { file_path: "/a", old_string: "o", new_string: "n" },
    });
    expect(blocks[1]).toMatchObject({
      type: "tool_result",
      tool_use_id: "c1",
      content: "ok",
      is_error: false,
    });
  });

  it("emits a tool_result with is_error for failed tools", () => {
    const blocks = convertOpenCodeParts([
      part({
        type: "tool",
        tool: "grep",
        callID: "c2",
        state: { status: "error", input: { pattern: "x" }, error: "boom" },
      }),
    ]);
    expect(blocks[1]).toMatchObject({
      type: "tool_result",
      tool_use_id: "c2",
      content: "boom",
      is_error: true,
    });
  });

  it("skips metadata/marker parts (step-*, patch, compaction)", () => {
    const blocks = convertOpenCodeParts([
      part({ type: "step-start" }),
      part({ type: "step-finish" }),
      part({ type: "patch" }),
      part({ type: "compaction" }),
    ]);
    expect(blocks).toEqual([]);
  });

  it("emits durable image tool results as separate user messages", () => {
    const imagePart = part({
      type: "tool",
      tool: "read",
      callID: "c-image",
      state: {
        status: "completed",
        input: { filePath: "fixture.png" },
        output: "Image read successfully",
        attachments: [
          {
            type: "file",
            mime: "image/png",
            url: "data:image/png;base64,aGVsbG8=",
          },
        ],
      },
    });
    const loaded = {
      summary: { id: "ses" },
      data: {
        provider: "opencode",
        session: {
          messages: [
            {
              message: {
                id: "msg",
                sessionID: "ses",
                role: "assistant",
                modelID: "claude-haiku-4.5",
              },
              parts: [imagePart],
            },
          ],
        },
      },
    } as LoadedSession;

    const normalized = normalizeSession(loaded);
    expect(normalized.messages).toHaveLength(2);
    expect(normalized.messages[0]).toMatchObject({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "c-image",
            name: "Read",
            input: { file_path: "fixture.png" },
          },
        ],
      },
    });
    expect(normalized.messages[1]).toMatchObject({
      uuid: "msg:c-image:result",
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "c-image",
            content: "Image read successfully",
          },
        ],
      },
      toolUseResult: {
        type: "image",
        file: {
          base64: "aGVsbG8=",
          type: "image/png",
          originalSize: 5,
        },
      },
    });
  });
});
