import { describe, expect, it } from "vitest";
import { createCoalescingSaver } from "../../src/lib/coalescingSaver.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const tick = () => new Promise((res) => setTimeout(res, 0));

describe("createCoalescingSaver", () => {
  it("coalesces saves issued during a write into one follow-up", async () => {
    const gates = [deferred(), deferred()];
    let writes = 0;
    const { save } = createCoalescingSaver(() => {
      const gate = gates[writes++];
      if (!gate) throw new Error("unexpected extra write");
      return gate.promise;
    });

    const first = save();
    await save();
    await save();
    await save();
    expect(writes).toBe(1);

    gates[0]?.resolve();
    await tick();
    expect(writes).toBe(2);
    gates[1]?.resolve();
    await first;
    expect(writes).toBe(2);
  });

  it("recovers after a rejected write instead of wedging", async () => {
    let writes = 0;
    let fail = true;
    const { save } = createCoalescingSaver(async () => {
      writes++;
      if (fail) throw new Error("disk full");
    });

    await expect(save()).rejects.toThrow("disk full");
    fail = false;
    // The regression this guards: a rejected write must not leave in-flight
    // state set, or this save would return "success" without writing.
    await save();
    expect(writes).toBe(2);
  });

  it("still runs the pending follow-up when the write rejects", async () => {
    const gate = deferred();
    let writes = 0;
    const { save } = createCoalescingSaver(async () => {
      writes++;
      if (writes === 1) {
        await gate.promise;
        throw new Error("first write failed");
      }
    });

    const first = save();
    await save();
    gate.resolve();
    await expect(first).rejects.toThrow("first write failed");
    expect(writes).toBe(2);
  });

  it("idle resolves after the drain (follow-ups included), swallowing failures", async () => {
    const gate = deferred();
    let writes = 0;
    const saver = createCoalescingSaver(async () => {
      writes++;
      if (writes === 1) {
        await gate.promise;
        throw new Error("first write failed");
      }
    });

    const first = saver.save();
    await saver.save(); // marks a follow-up
    const idle = saver.idle();
    gate.resolve();
    await idle; // must not reject even though the first write did
    expect(writes).toBe(2);
    await expect(first).rejects.toThrow("first write failed");
  });

  it("idle returns immediately when nothing is running", async () => {
    const saver = createCoalescingSaver(async () => {});
    await saver.idle();
    await saver.save();
    await saver.idle();
  });
});
