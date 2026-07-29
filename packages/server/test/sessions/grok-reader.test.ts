import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  TOOL_RESULT_MEDIA_CANDIDATES,
  type ToolResultMediaCandidateCarrier,
} from "../../src/media/inlineImageData.js";
import { GrokSessionReader } from "../../src/sessions/grok-reader.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true });
  }
});

function canonicalMeta(
  name: string,
  kind: string,
  label: string,
  input: Record<string, unknown> = {},
) {
  return {
    _meta: {
      "x.ai/tool": {
        version: 1,
        name,
        kind,
        namespace: "xai",
        label,
        read_only: kind.includes("read"),
        input,
      },
    },
  };
}

describe("GrokSessionReader tool replay", () => {
  it("joins lifecycle updates once and preserves image media candidates", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-reader-tools-"));
    tempRoots.push(root);
    const sessionsDir = join(root, "sessions");
    const projectPath = join(root, "project");
    const sessionId = "grok-session-1";
    const sessionDir = join(
      sessionsDir,
      encodeURIComponent(projectPath),
      sessionId,
    );
    mkdirSync(projectPath, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "summary.json"),
      JSON.stringify({
        info: { id: sessionId, cwd: projectPath },
        created_at: "2026-07-29T00:00:00.000Z",
        updated_at: "2026-07-29T00:01:00.000Z",
        generated_title: "Grok vocabulary",
        num_messages: 4,
        current_model_id: "grok-4.5",
      }),
    );

    const updates = [
      {
        sessionUpdate: "tool_call",
        toolCallId: "edit-1",
        kind: "edit",
        title: "Starting edit",
        rawInput: {
          variant: "SearchReplace",
          file_path: join(projectPath, "note.txt"),
          old_string: "old\n",
          new_string: "new\n",
        },
        ...canonicalMeta("search_replace", "file.edit", "Edit"),
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "edit-1",
        status: "in_progress",
        title: "Replacing text in note.txt",
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "edit-1",
        status: "completed",
        rawOutput: {
          type: "SearchReplace",
          EditsApplied: {
            absolute_path: join(projectPath, "note.txt"),
            old_string: "old\n",
            new_string: "new\n",
          },
        },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "edit-1",
        status: "completed",
        rawOutput: {
          type: "SearchReplace",
          EditsApplied: {
            absolute_path: join(projectPath, "note.txt"),
            old_string: "old\n",
            new_string: "new\n",
          },
        },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "image-1",
        rawInput: { variant: "ImageGen", prompt: "violet circuit" },
        ...canonicalMeta("image_gen", "image.generate", "Generate Image"),
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "image-1",
        status: "completed",
        rawOutput: {
          type: "ImageGen",
          path: join(sessionDir, "images", "1.jpg"),
          filename: "1.jpg",
          session_folder: sessionDir,
        },
      },
    ];
    writeFileSync(
      join(sessionDir, "updates.jsonl"),
      updates
        .map((update, index) =>
          JSON.stringify({
            timestamp: 1_775_000_000 + index,
            params: { update },
          }),
        )
        .join("\n"),
    );

    const reader = new GrokSessionReader({ sessionsDir, projectPath });
    const loaded = await reader.getSession(
      sessionId,
      toUrlProjectId(projectPath),
    );

    expect(loaded?.data.provider).toBe("grok");
    if (loaded?.data.provider !== "grok") {
      throw new Error("Expected a Grok session");
    }
    const messages = loaded.data.session.messages;
    expect(messages).toHaveLength(4);
    expect(messages[0]).toMatchObject({
      uuid: "edit-1",
      toolUse: {
        id: "edit-1",
        name: "Edit",
        input: {
          old_string: "old\n",
          new_string: "new\n",
          title: "Replacing text in note.txt",
          status: "completed",
        },
      },
    });
    expect(messages[1]).toMatchObject({
      uuid: "edit-1:result",
      toolUseResult: {
        filePath: join(projectPath, "note.txt"),
        oldString: "old\n",
        newString: "new\n",
      },
    });
    expect(messages[2]).toMatchObject({
      uuid: "image-1",
      toolUse: { id: "image-1", name: "ImageGen" },
    });
    expect(
      (messages[3] as ToolResultMediaCandidateCarrier)[
        TOOL_RESULT_MEDIA_CANDIDATES
      ],
    ).toEqual([
      {
        originalPath: join(sessionDir, "images", "1.jpg"),
        filename: "1.jpg",
      },
    ]);
  });
});
