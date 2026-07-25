import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import {
  createComposerTurnRecallCache,
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

describe("createComposerTurnRecallCache", () => {
  const assistant = (text: string): Message => ({
    type: "assistant",
    role: "assistant",
    content: text,
  });

  it("derives the first scan as an increment from the empty previous state", () => {
    const messages = [userTurn("first"), assistant("a"), userTurn("second")];
    expect(createComposerTurnRecallCache().derive(messages)).toEqual(
      getComposerTurnRecallEntries(messages),
    );
  });

  it("returns the cached array for the same messages reference", () => {
    const cache = createComposerTurnRecallCache();
    const messages = [userTurn("only")];
    const first = cache.derive(messages);
    expect(cache.derive(messages)).toBe(first);
  });

  it("keeps entry identity across streaming ticks that replace the assistant tail", () => {
    const cache = createComposerTurnRecallCache();
    const prompt = userTurn("deploy the app");
    const first = cache.derive([prompt, assistant("th")]);
    const second = cache.derive([prompt, assistant("thinking...")]);
    expect(second).toBe(first);
    expect(second.map((entry) => entry.text)).toEqual(["deploy the app"]);
  });

  it("prepends an appended user turn and displaces an older duplicate", () => {
    const cache = createComposerTurnRecallCache();
    const older = [userTurn("repeat"), userTurn("unique")];
    expect(cache.derive(older).map((entry) => entry.text)).toEqual([
      "unique",
      "repeat",
    ]);
    const withDuplicate = [...older, userTurn("repeat")];
    expect(cache.derive(withDuplicate).map((entry) => entry.text)).toEqual([
      "repeat",
      "unique",
    ]);
  });

  it("resurrects the older occurrence when a replaced tail removes the newest duplicate", () => {
    const cache = createComposerTurnRecallCache();
    const oldRepeat: Message = {
      uuid: "old-repeat",
      type: "user",
      message: { role: "user", content: "repeat" },
    };
    const newRepeat: Message = {
      uuid: "new-repeat",
      type: "user",
      message: { role: "user", content: "repeat" },
    };
    const withBoth = [oldRepeat, userTurn("unique"), newRepeat];
    expect(
      cache.derive(withBoth).map((entry) => [entry.id, entry.text]),
    ).toEqual([
      ["new-repeat", "repeat"],
      [expect.anything(), "unique"],
    ]);
    // Tail replaced without the newest "repeat": the older one wins again.
    const tailReplaced = [oldRepeat, userTurn("unique"), assistant("done")];
    expect(
      cache.derive(tailReplaced).map((entry) => [entry.id, entry.text]),
    ).toEqual([
      [expect.anything(), "unique"],
      ["old-repeat", "repeat"],
    ]);
  });

  it("adopts the confirmed id when a pending user turn is replaced in place", () => {
    const cache = createComposerTurnRecallCache();
    const pending: Message = {
      id: "pending-1",
      type: "user",
      message: { role: "user", content: "run the tests" },
    };
    const confirmed: Message = {
      uuid: "durable-1",
      type: "user",
      message: { role: "user", content: "run the tests" },
    };
    const before = [userTurn("earlier"), pending];
    expect(cache.derive(before).map((entry) => entry.id)).toEqual([
      "pending-1",
      expect.anything(),
    ]);
    const after = [userTurn("earlier"), confirmed, assistant("running")];
    expect(cache.derive(after).map((entry) => entry.id)).toEqual([
      "durable-1",
      expect.anything(),
    ]);
  });

  it("stays correct when older history is prepended (divergence at the front)", () => {
    const cache = createComposerTurnRecallCache();
    const tail = [userTurn("recent")];
    cache.derive(tail);
    const withHistory = [userTurn("ancient"), assistant("old reply"), ...tail];
    expect(cache.derive(withHistory)).toEqual(
      getComposerTurnRecallEntries(withHistory),
    );
  });

  it("matches the one-shot derivation across randomized mutation sequences", () => {
    // Deterministic PRNG (mulberry32) — no Math.random, reproducible runs.
    const mulberry32 = (seed: number) => () => {
      seed += 0x6d2b79f5;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // A small text alphabet forces duplicate-text collisions constantly.
    const texts = ["alpha", "beta", "gamma", "", "  "];
    for (let seed = 1; seed <= 5; seed += 1) {
      const random = mulberry32(seed);
      const pick = <T>(options: readonly T[]): T =>
        options[Math.floor(random() * options.length)] as T;
      let messageCounter = 0;
      const someMessage = (): Message =>
        pick([
          () => ({
            uuid: `u${messageCounter++}`,
            type: "user" as const,
            message: { role: "user" as const, content: pick(texts) },
          }),
          () => assistant(`reply ${messageCounter++}`),
          () => ({
            type: "user" as const,
            role: "user" as const,
            content: [
              { type: "tool_result", tool_use_id: "t", content: "out" },
            ],
          }),
        ])();

      const cache = createComposerTurnRecallCache();
      let messages: Message[] = [];
      for (let step = 0; step < 60; step += 1) {
        const mutation = pick(["append", "appendMany", "replaceTail", "truncate", "prepend"]);
        if (mutation === "append") {
          messages = [...messages, someMessage()];
        } else if (mutation === "appendMany") {
          messages = [...messages, someMessage(), someMessage(), someMessage()];
        } else if (mutation === "replaceTail" && messages.length > 0) {
          const cut = Math.floor(random() * Math.min(3, messages.length));
          messages = [
            ...messages.slice(0, messages.length - cut - 1),
            someMessage(),
          ];
        } else if (mutation === "truncate" && messages.length > 0) {
          messages = messages.slice(
            0,
            Math.floor(random() * messages.length),
          );
        } else if (mutation === "prepend") {
          messages = [someMessage(), ...messages];
        }
        expect(cache.derive(messages)).toEqual(
          getComposerTurnRecallEntries(messages),
        );
      }
    }
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
