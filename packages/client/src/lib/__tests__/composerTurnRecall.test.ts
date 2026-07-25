import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import {
  filterComposerTurnRecall,
  getComposerTurnRecallEntries,
} from "../composerTurnRecall";
import { buildSessionDetailRenderItems } from "../sessionDetail/renderItems";
import { getUserTurnNavAnchors } from "../sessionDetail/search";

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

  it("carries the message id, preferring uuid over id", () => {
    const entries = getComposerTurnRecallEntries([
      { uuid: "uuid-1", id: "id-1", type: "user", message: { role: "user", content: "with uuid" } },
      { id: "id-2", type: "user", message: { role: "user", content: "id only" } },
    ]);
    expect(entries.map((entry) => ({ id: entry.id, text: entry.text }))).toEqual(
      [
        { id: "id-2", text: "id only" },
        { id: "uuid-1", text: "with uuid" },
      ],
    );
  });

  // The go-to-turn control scrolls via scrollToRenderId/findRenderRow, which
  // match on the row's data-render-id. That attribute is set to the render
  // item's id (RenderItemComponent: data-render-id={item.id}), the same id
  // getUserTurnNavAnchors exposes. This proves the id we store on each recall
  // entry is exactly the id the scroll path resolves.
  it("stores an id equal to the transcript render row id (getUserTurnNavAnchors)", () => {
    const messages: Message[] = [
      { uuid: "u1", type: "user", message: { role: "user", content: "deploy the app" } },
      { uuid: "a1", type: "assistant", message: { role: "assistant", content: "on it" } },
      { uuid: "u2", type: "user", message: { role: "user", content: "run the tests" } },
    ];

    const entryIds = getComposerTurnRecallEntries(messages).map(
      (entry) => entry.id,
    );
    const renderItems = buildSessionDetailRenderItems({ messages });
    const anchorIds = getUserTurnNavAnchors(renderItems).map(
      (anchor) => anchor.id,
    );
    const renderRowIds = renderItems
      .filter((item) => item.type === "user_prompt")
      .map((item) => item.id);

    // Anchors and data-render-id rows are in render order; recall is newest
    // first, so reverse to compare.
    expect(anchorIds).toEqual(["u1", "u2"]);
    expect(renderRowIds).toEqual(["u1", "u2"]);
    expect([...entryIds].reverse()).toEqual(anchorIds);
  });
});

describe("filterComposerTurnRecall", () => {
  const entries = [
    { id: "a", text: "hello world", preview: "hello world" },
    { id: "b", text: "help me", preview: "help me" },
    { id: "c", text: "goodbye", preview: "goodbye" },
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
