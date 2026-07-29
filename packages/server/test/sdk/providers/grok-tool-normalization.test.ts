import { describe, expect, it } from "vitest";
import {
  buildGrokStructuredToolResult,
  grokToolResultMediaCandidate,
  normalizeGrokToolUpdate,
} from "../../../src/sdk/providers/grok-tool-normalization.js";

function toolMeta(
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

describe("Grok 0.2.112 tool normalization", () => {
  it("uses canonical metadata instead of the generic ACP edit kind", () => {
    const initial = normalizeGrokToolUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "write-1",
      kind: "edit",
      title: "Updating file",
      rawInput: {
        variant: "Write",
        file_path: "/project/note.txt",
        content: "  exact content\n",
      },
      ...toolMeta("write", "file.write", "Write", {
        path: "/project/note.txt",
      }),
    });

    expect(initial).toMatchObject({
      name: "Write",
      nativeName: "write",
      input: {
        file_path: "/project/note.txt",
        content: "  exact content\n",
        grokTool: {
          version: 1,
          name: "write",
          kind: "file.write",
          namespace: "xai",
          label: "Write",
        },
      },
    });

    const terminalUpdate = {
      sessionUpdate: "tool_call_update",
      toolCallId: "write-1",
      status: "completed",
      rawOutput: {
        type: "SearchReplace",
        EditsApplied: {
          absolute_path: "/project/note.txt",
          new_string: "  exact content\n",
        },
      },
    };
    const terminal = normalizeGrokToolUpdate(terminalUpdate, initial);

    expect(terminal.name).toBe("Write");
    expect(buildGrokStructuredToolResult(terminalUpdate, terminal)).toEqual({
      type: "text",
      file: {
        filePath: "/project/note.txt",
        content: "  exact content\n",
        numLines: 2,
        startLine: 1,
        totalLines: 2,
      },
    });
  });

  it("preserves background command state across sparse lifecycle updates", () => {
    const initial = normalizeGrokToolUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "bash-1",
      rawInput: {
        variant: "Bash",
        command: "sleep 1",
        background: true,
      },
      ...toolMeta("run_terminal_command", "execute.background", "Run Command"),
    });
    const terminalUpdate = {
      sessionUpdate: "tool_call_update",
      toolCallId: "bash-1",
      status: "completed",
      rawOutput: {
        type: "BackgroundTaskStarted",
        task_id: "task-17",
      },
    };
    const terminal = normalizeGrokToolUpdate(terminalUpdate, initial);

    expect(terminal.input.run_in_background).toBe(true);
    expect(buildGrokStructuredToolResult(terminalUpdate, terminal)).toEqual({
      stdout: "",
      stderr: "",
      interrupted: false,
      isImage: false,
      backgroundTaskId: "task-17",
    });
  });

  it("normalizes Grok's metadata-free backend web search event", () => {
    const initial = normalizeGrokToolUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "web-1",
      kind: "search",
      title: "Web search:",
      rawInput: {
        variant: "WebSearch",
        backend: true,
        query: "current ACP specification",
      },
    });
    const terminalUpdate = {
      sessionUpdate: "tool_call_update",
      toolCallId: "web-1",
      status: "completed",
      rawOutput: {
        action: {
          type: "search",
          query: "current ACP specification",
          sources: [
            { type: "url", url: "https://example.com/acp" },
            { type: "url", url: "https://example.com/protocol" },
          ],
        },
      },
    };
    const terminal = normalizeGrokToolUpdate(terminalUpdate, initial);

    expect(terminal).toMatchObject({
      name: "WebSearch",
      nativeName: "web_search",
      input: { query: "current ACP specification" },
    });
    expect(buildGrokStructuredToolResult(terminalUpdate, terminal)).toEqual({
      query: "current ACP specification",
      results: [
        {
          content: [
            {
              title: "https://example.com/acp",
              url: "https://example.com/acp",
            },
            {
              title: "https://example.com/protocol",
              url: "https://example.com/protocol",
            },
          ],
        },
      ],
      durationSeconds: 0,
    });
  });

  it("keeps image actions generic while exposing relay-safe media input", () => {
    const initial = normalizeGrokToolUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "image-1",
      rawInput: {
        variant: "ImageGen",
        prompt: "A violet circuit board",
      },
      ...toolMeta("image_gen", "image.generate", "Generate Image"),
    });
    const terminalUpdate = {
      sessionUpdate: "tool_call_update",
      toolCallId: "image-1",
      status: "completed",
      rawOutput: {
        type: "ImageGen",
        path: "/home/test/.grok/sessions/project/images/1.jpg",
        filename: "1.jpg",
        session_folder: "/home/test/.grok/sessions/project",
      },
    };
    const terminal = normalizeGrokToolUpdate(terminalUpdate, initial);

    expect(terminal.name).toBe("ImageGen");
    expect(buildGrokStructuredToolResult(terminalUpdate, terminal)).toEqual({
      type: "image",
      path: "/home/test/.grok/sessions/project/images/1.jpg",
      filename: "1.jpg",
      sessionFolder: "/home/test/.grok/sessions/project",
    });
    expect(grokToolResultMediaCandidate(terminalUpdate)).toEqual({
      originalPath: "/home/test/.grok/sessions/project/images/1.jpg",
      filename: "1.jpg",
    });
  });

  it("routes subagent spawn to the existing compatible renderer", () => {
    const state = normalizeGrokToolUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "agent-1",
      rawInput: {
        variant: "Task",
        description: "Inspect the fixture",
        prompt: "Read only.\n",
        subagent_type: "explore",
      },
      ...toolMeta("spawn_subagent", "task", "Subagent"),
    });

    expect(state).toMatchObject({
      name: "spawn_agent",
      nativeName: "spawn_subagent",
      input: {
        description: "Inspect the fixture",
        prompt: "Read only.\n",
        subagent_type: "explore",
      },
    });
  });

  it("preserves unknown canonical tool identity and input for future kinds", () => {
    const state = normalizeGrokToolUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "future-1",
      rawInput: { variant: "UnreleasedAction", extra: "diagnostic" },
      ...toolMeta("future_native_tool", "workflow.future", "Future Action", {
        stable: true,
      }),
    });

    expect(state).toMatchObject({
      name: "future_native_tool",
      nativeName: "future_native_tool",
      input: {
        stable: true,
        rawInput: { variant: "UnreleasedAction", extra: "diagnostic" },
        grokTool: {
          name: "future_native_tool",
          kind: "workflow.future",
          label: "Future Action",
        },
      },
    });
  });
});
