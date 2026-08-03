import { describe, expect, it } from "vitest";
import { MessageQueue, concatUserMessages } from "../src/sdk/messageQueue.js";
import type { UserMessage } from "../src/sdk/types.js";

const msg = (text: string, tempId?: string): UserMessage => ({
  text,
  ...(tempId ? { tempId } : {}),
});

describe("concatUserMessages", () => {
  it("records every chunk's tempId so the echo can clear chips by identity", () => {
    const combined = concatUserMessages([
      msg("first", "temp-1"),
      msg("second", "temp-2"),
      msg("third", "temp-3"),
    ]);

    expect(combined.tempIds).toEqual(["temp-1", "temp-2", "temp-3"]);
    // first.tempId is still the single-id field for backward compatibility.
    expect(combined.tempId).toBe("temp-1");
    expect(combined.text).toBe(
      "first\n\n--------\n\nsecond\n\n--------\n\nthird",
    );
  });

  it("omits tempIds entirely when no chunk carried one", () => {
    const combined = concatUserMessages([msg("a"), msg("b")]);
    expect(combined.tempIds).toBeUndefined();
  });

  it("keeps only the ids that were present", () => {
    const combined = concatUserMessages([
      msg("first", "temp-1"),
      msg("second"),
      msg("third", "temp-3"),
    ]);
    expect(combined.tempIds).toEqual(["temp-1", "temp-3"]);
  });

  it("keeps the most urgent Claude SDK priority across chunks", () => {
    const combined = concatUserMessages([
      { ...msg("later"), priority: "later" },
      { ...msg("now"), priority: "now" },
      { ...msg("next"), priority: "next" },
    ]);

    expect(combined.priority).toBe("now");
  });

  it("keeps the permission mode selected for the provider turn", () => {
    const combined = concatUserMessages([
      { ...msg("first"), mode: "bypassPermissions" },
      { ...msg("second"), mode: "bypassPermissions" },
    ]);

    expect(combined.mode).toBe("bypassPermissions");
  });
});

describe("MessageQueue", () => {
  it("reports authoritative removals to remote queue mirrors", () => {
    const queue = new MessageQueue();
    const removed: string[][] = [];
    const unsubscribe = queue.subscribeRemoved((messages) => {
      removed.push(messages.map((message) => message.uuid ?? ""));
    });
    queue.push({ ...msg("first", "temp-1"), uuid: "uuid-1" });
    queue.push({ ...msg("second", "temp-2"), uuid: "uuid-2" });

    queue.removeByTempId("temp-1");
    queue.drain();
    unsubscribe();

    expect(removed).toEqual([["uuid-1"], ["uuid-2"]]);
  });

  it("removes queued messages by temp id before they are yielded", () => {
    const queue = new MessageQueue();
    queue.push(msg("first", "temp-1"));
    queue.push({ ...msg("bundled", "temp-bundle-head"), tempIds: ["temp-2"] });
    queue.push(msg("third", "temp-3"));

    expect(
      queue.removeByTempId("temp-2").map((message) => message.text),
    ).toEqual(["bundled"]);
    expect(queue.depth).toBe(2);
    expect(queue.drain().map((message) => message.tempId)).toEqual([
      "temp-1",
      "temp-3",
    ]);
  });

  it("emits different permission modes as separate provider turns", async () => {
    const queue = new MessageQueue();
    queue.push({ ...msg("ask"), mode: "default" });
    queue.push({ ...msg("bypass"), mode: "bypassPermissions" });
    const iterator = queue[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        mode: "default",
        message: { content: "ask" },
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        mode: "bypassPermissions",
        message: { content: "bypass" },
      },
    });
    await iterator.return?.();
  });
});
