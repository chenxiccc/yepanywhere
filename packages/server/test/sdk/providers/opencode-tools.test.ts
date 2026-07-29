import { describe, expect, it } from "vitest";
import {
  mapOpenCodeQuestionAnswers,
  normalizeOpenCodeTool,
  normalizeOpenCodeToolResult,
} from "../../../src/sdk/providers/opencode-tools.js";

describe("normalizeOpenCodeTool", () => {
  it("maps lower-case tool names to YA canonical renderer names", () => {
    expect(normalizeOpenCodeTool("bash", {}).name).toBe("Bash");
    expect(normalizeOpenCodeTool("read", {}).name).toBe("Read");
    expect(normalizeOpenCodeTool("edit", {}).name).toBe("Edit");
    expect(normalizeOpenCodeTool("write", {}).name).toBe("Write");
    expect(normalizeOpenCodeTool("glob", {}).name).toBe("Glob");
    expect(normalizeOpenCodeTool("grep", {}).name).toBe("Grep");
    expect(normalizeOpenCodeTool("todowrite", {}).name).toBe("TodoWrite");
    expect(normalizeOpenCodeTool("task", {}).name).toBe("Task");
    expect(normalizeOpenCodeTool("webfetch", {}).name).toBe("WebFetch");
    expect(normalizeOpenCodeTool("websearch", {}).name).toBe("WebSearch");
    expect(normalizeOpenCodeTool("apply_patch", {}).name).toBe("Edit");
    expect(normalizeOpenCodeTool("question", {}).name).toBe("AskUserQuestion");
  });

  it("renames read/write file fields to Claude shape", () => {
    expect(
      normalizeOpenCodeTool("read", { filePath: "/a", offset: 1, limit: 2 })
        .input,
    ).toEqual({ file_path: "/a", offset: 1, limit: 2 });
    expect(
      normalizeOpenCodeTool("write", { filePath: "/a", content: "x" }).input,
    ).toEqual({ file_path: "/a", content: "x" });
  });

  it("renames edit fields including oldString/newString/replaceAll", () => {
    expect(
      normalizeOpenCodeTool("edit", {
        filePath: "/a",
        oldString: "o",
        newString: "n",
        replaceAll: true,
      }).input,
    ).toEqual({
      file_path: "/a",
      old_string: "o",
      new_string: "n",
      replace_all: true,
    });
  });

  it("maps grep include -> glob and passes other fields through", () => {
    expect(
      normalizeOpenCodeTool("grep", { pattern: "x", include: "*.py" }).input,
    ).toEqual({ pattern: "x", glob: "*.py" });
  });

  it("maps apply_patch input to canonical Edit raw-patch fields", () => {
    const patch =
      "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch";
    expect(normalizeOpenCodeTool("apply_patch", { patchText: patch })).toEqual({
      name: "Edit",
      input: {
        patch,
        rawPatch: patch,
        _rawPatch: patch,
      },
    });
  });

  it("passes through tools with matching field shapes (bash, todowrite)", () => {
    expect(
      normalizeOpenCodeTool("bash", { command: "ls", description: "d" }).input,
    ).toEqual({ command: "ls", description: "d" });
    const todos = [{ content: "c", id: "1", priority: "high", status: "x" }];
    expect(normalizeOpenCodeTool("todowrite", { todos }).input).toEqual({
      todos,
    });
  });

  it("keeps unknown tools explicit (no alias, untouched input)", () => {
    const r = normalizeOpenCodeTool("todoread", { foo: 1 });
    expect(r.name).toBe("todoread");
    expect(r.input).toEqual({ foo: 1 });
  });

  it("tolerates missing/non-object input", () => {
    expect(normalizeOpenCodeTool("read", undefined).input).toEqual({});
    expect(normalizeOpenCodeTool(undefined, null).name).toBe("unknown");
  });
});

describe("normalizeOpenCodeToolResult", () => {
  it("preserves completed image-read attachments for tool-result media", () => {
    expect(
      normalizeOpenCodeToolResult("read", [
        {
          type: "file",
          mime: "image/png",
          url: "data:image/png;base64,aGVsbG8=",
        },
      ]),
    ).toEqual({
      type: "image",
      file: {
        base64: "aGVsbG8=",
        type: "image/png",
        originalSize: 5,
      },
    });
  });

  it("ignores non-read and non-image attachments", () => {
    expect(
      normalizeOpenCodeToolResult("write", [
        {
          type: "file",
          mime: "image/png",
          url: "data:image/png;base64,aGVsbG8=",
        },
      ]),
    ).toBeUndefined();
    expect(
      normalizeOpenCodeToolResult("read", [
        {
          type: "file",
          mime: "text/plain",
          url: "data:text/plain;base64,aGVsbG8=",
        },
      ]),
    ).toBeUndefined();
  });
});

describe("mapOpenCodeQuestionAnswers", () => {
  const questions = [
    { question: "Pick a color?" },
    { question: "Pick fruits?" },
    { question: "Unanswered?" },
  ];

  it("maps YA answers (keyed by question text) to ordered label arrays", () => {
    const answers = {
      "Pick a color?": "blue",
      "Pick fruits?": ["apple", "pear"],
    };
    expect(mapOpenCodeQuestionAnswers(questions, answers)).toEqual([
      ["blue"],
      ["apple", "pear"],
      [],
    ]);
  });

  it("returns empty arrays when no answers are present", () => {
    expect(mapOpenCodeQuestionAnswers(questions, undefined)).toEqual([
      [],
      [],
      [],
    ]);
  });
});
