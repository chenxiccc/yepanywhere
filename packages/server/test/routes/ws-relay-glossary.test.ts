import { toUrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import type { ProjectGlossarySubscriptionManager } from "../../src/projects/projectGlossarySubscriptionManager.js";
import {
  cleanupSubscriptions,
  handleGlossarySubscribe,
} from "../../src/routes/ws-relay-handlers.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("WebSocket glossary subscriptions", () => {
  it("cancels a pending subscription as soon as its socket closes", async () => {
    const pending = deferred<void>();
    const release = vi.fn();
    const manager = {
      subscribe: vi.fn(() => ({ ready: pending.promise, release })),
    } as unknown as ProjectGlossarySubscriptionManager;
    const subscriptions = new Map<string, () => void>();
    const send = vi.fn();

    const subscribing = handleGlossarySubscribe(
      subscriptions,
      {
        type: "subscribe",
        subscriptionId: "glossary-1",
        channel: "glossary",
        projectId: toUrlProjectId("/project"),
      },
      send,
      manager,
    );
    expect(subscriptions.has("glossary-1")).toBe(true);

    cleanupSubscriptions(subscriptions);
    expect(release).toHaveBeenCalledOnce();
    pending.resolve(undefined);
    await subscribing;

    expect(release).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });
});
