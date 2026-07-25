import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import {
  filterComposerTurnRecall,
  getComposerTurnRecallEntries,
} from "../composerTurnRecall";

function userTurn(content: Message["content"]): Message {
  return { type: "user", role: "user", content };
}

describe("getComposerTurnRecallEntries", () => {
  it("keeps user turns only, newest-first", () => {
    const entries = getComposerTurnRecallEntries([
      userTurn("first"),
      { type: "assistant", role: "assistant", content: "an answer" },
      userTurn("second"),
      { type: "system", role: "system", content: "a system note" },
      userTurn("third"),
    ]);
    expect(entries.map((entry) => entry.text)).toEqual([
      "third",
      "second",
      "first",
    ]);
  });

  it("drops empty and whitespace-only turns", () => {
    const entries = getComposerTurnRecallEntries([
      userTurn("kept"),
      userTurn("   "),
      userTurn(""),
    ]);
    expect(entries.map((entry) => entry.text)).toEqual(["kept"]);
  });

  it("deduplicates identical text, keeping the newest occurrence", () => {
    const entries = getComposerTurnRecallEntries([
      userTurn("repeat"),
      userTurn("unique"),
      userTurn("repeat"),
    ]);
    expect(entries.map((entry) => entry.text)).toEqual(["repeat", "unique"]);
  });

  it("excludes tool_use / tool_result turns that render under the user role", () => {
    const entries = getComposerTurnRecallEntries([
      userTurn("real prompt"),
      {
        type: "user",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "abc", content: "output" },
        ],
      },
    ]);
    expect(entries.map((entry) => entry.text)).toEqual(["real prompt"]);
  });

  it("extracts text from nested message.content and text blocks", () => {
    const entries = getComposerTurnRecallEntries([
      { type: "user", message: { role: "user", content: "nested prompt" } },
      userTurn([
        { type: "text", text: "block one" },
        { type: "text", text: "block two" },
      ]),
    ]);
    expect(entries.map((entry) => entry.text)).toEqual([
      "block one\nblock two",
      "nested prompt",
    ]);
  });

  it("collapses whitespace and clamps the preview to ~180 chars", () => {
    const longText = `${"x".repeat(300)}`;
    const entries = getComposerTurnRecallEntries([
      userTurn(`multi\n  line   prompt`),
      userTurn(longText),
    ]);
    // longText turn is newest.
    expect(entries[0]?.preview.length).toBeLessThanOrEqual(180);
    expect(entries[0]?.preview.endsWith("...")).toBe(true);
    expect(entries[1]?.preview).toBe("multi line prompt");
    // Full text is preserved even when the preview is clamped.
    expect(entries[0]?.text).toBe(longText);
  });
});

describe("filterComposerTurnRecall", () => {
  const entries = [
    { text: "hello world", preview: "hello world" },
    { text: "help me", preview: "help me" },
    { text: "goodbye", preview: "goodbye" },
  ];

  it("returns every entry for an empty or whitespace draft", () => {
    expect(filterComposerTurnRecall(entries, "")).toEqual(entries);
    expect(filterComposerTurnRecall(entries, "   ")).toEqual(entries);
  });

  it("prefix-matches case-insensitively and trims the draft", () => {
    expect(
      filterComposerTurnRecall(entries, "  HEL  ").map((entry) => entry.text),
    ).toEqual(["hello world", "help me"]);
  });

  it("preserves the newest-first order of the source entries", () => {
    expect(
      filterComposerTurnRecall(entries, "he").map((entry) => entry.text),
    ).toEqual(["hello world", "help me"]);
  });

  it("returns nothing when no entry prefix-matches", () => {
    expect(filterComposerTurnRecall(entries, "zzz")).toEqual([]);
  });
});
