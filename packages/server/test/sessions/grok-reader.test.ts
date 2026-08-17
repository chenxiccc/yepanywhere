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

describe("GrokSessionReader interject replay", () => {
  it("strips Grok's outer steer envelope from user_message_chunk text", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-reader-interject-"));
    tempRoots.push(root);
    const sessionsDir = join(root, "sessions");
    const projectPath = join(root, "project");
    const sessionId = "grok-session-interject";
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
        created_at: "2026-08-17T00:00:00.000Z",
        updated_at: "2026-08-17T00:01:00.000Z",
        generated_title: "Interject",
        num_messages: 1,
        current_model_id: "grok-4.6",
      }),
    );
    const inner = [
      "keep this quoted example",
      "<user_query>",
      "quoted inner",
      "</user_query>",
    ].join("\n");
    writeFileSync(
      join(sessionDir, "updates.jsonl"),
      `${JSON.stringify({
        timestamp: 1_775_000_000,
        params: {
          update: {
            sessionUpdate: "user_message_chunk",
            content: {
              type: "text",
              text: [
                "The user sent a message while you were working:",
                "<user_query>",
                inner,
                "</user_query>",
                "Make sure to complete any unfinished tasks from previous turns.",
              ].join("\n"),
            },
          },
        },
      })}\n`,
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
    expect(loaded.data.session.messages).toMatchObject([
      {
        type: "user",
        message: { role: "user", content: inner },
      },
    ]);
  });
});

describe("GrokSessionReader provider children", () => {
  it("lists parent/subagents metas and hides child dirs from top-level lists", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-reader-children-"));
    tempRoots.push(root);
    const sessionsDir = join(root, "sessions");
    const projectPath = join(root, "project");
    const encoded = encodeURIComponent(projectPath);
    const parentId = "grok-parent-1";
    const childId = "grok-child-1";
    const parentDir = join(sessionsDir, encoded, parentId);
    const childDir = join(sessionsDir, encoded, childId);
    mkdirSync(projectPath, { recursive: true });
    mkdirSync(join(parentDir, "subagents", childId), { recursive: true });
    mkdirSync(childDir, { recursive: true });
    writeFileSync(
      join(parentDir, "summary.json"),
      JSON.stringify({
        info: { id: parentId, cwd: projectPath },
        created_at: "2026-08-16T00:00:00.000Z",
        updated_at: "2026-08-16T00:02:00.000Z",
        generated_title: "Parent turn",
        num_messages: 2,
        current_model_id: "grok-4.6",
      }),
    );
    writeFileSync(join(parentDir, "updates.jsonl"), "");
    writeFileSync(
      join(parentDir, "subagents", childId, "meta.json"),
      JSON.stringify({
        subagent_id: childId,
        parent_session_id: parentId,
        child_session_id: childId,
        subagent_type: "explore",
        description: "Search the repo",
        status: "completed",
        started_at: "2026-08-16T00:00:10.000Z",
        completed_at: "2026-08-16T00:01:40.000Z",
      }),
    );
    writeFileSync(
      join(childDir, "summary.json"),
      JSON.stringify({
        info: { id: childId, cwd: projectPath },
        created_at: "2026-08-16T00:00:10.000Z",
        updated_at: "2026-08-16T00:01:40.000Z",
        generated_title: "Search the repo",
        num_messages: 1,
        current_model_id: "grok-4.6",
      }),
    );
    writeFileSync(
      join(childDir, "updates.jsonl"),
      `${JSON.stringify({
        timestamp: 1_775_000_100,
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Found two matches." },
          },
        },
      })}\n`,
    );

    const reader = new GrokSessionReader({ sessionsDir, projectPath });
    const projectId = toUrlProjectId(projectPath);

    await expect(reader.listSessions(projectId)).resolves.toEqual([
      expect.objectContaining({ id: parentId, title: "Parent turn" }),
    ]);
    await expect(reader.listSessionFiles(sessionsDir)).resolves.toEqual([
      expect.objectContaining({ sessionId: parentId }),
    ]);
    await expect(reader.listProviderChildSessions(parentId)).resolves.toEqual([
      {
        id: childId,
        parentSessionId: parentId,
        title: "Search the repo",
        agentType: "explore",
        updatedAt: "2026-08-16T00:01:40.000Z",
      },
    ]);

    const agent = await reader.getAgentSession(childId, parentId);
    expect(agent?.status).toBe("completed");
    expect(agent?.agentType).toBe("explore");
    expect(agent?.description).toBe("Search the repo");
    expect(agent?.messages.length).toBeGreaterThan(0);
  });
});
