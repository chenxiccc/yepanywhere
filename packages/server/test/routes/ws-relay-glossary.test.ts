import { toUrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import type { ProjectGlossarySubscriptionManager } from "../../src/projects/projectGlossarySubscriptionManager.js";
import {
  cleanupSubscriptions,
  handleGlossarySubscribe,
  handleUnsubscribe,
} from "../../src/routes/ws-relay-handlers.js";
import { routeClientMessageSafely } from "../../src/routes/ws-message-router.js";

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

    handleGlossarySubscribe(
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
    await pending.promise;
    await Promise.resolve();

    expect(release).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("admits ping and unsubscribe frames while readiness is pending", async () => {
    const pending = deferred<void>();
    const release = vi.fn();
    const manager = {
      subscribe: vi.fn(() => ({ ready: pending.promise, release })),
    } as unknown as ProjectGlossarySubscriptionManager;
    const subscriptions = new Map<string, () => void>();
    const send = vi.fn();
    const handlers = {
      onRequest: vi.fn(async () => {}),
      onSubscribe: vi.fn((message) =>
        handleGlossarySubscribe(subscriptions, message, send, manager),
      ),
      onUnsubscribe: vi.fn((message) =>
        handleUnsubscribe(subscriptions, message),
      ),
      onUploadStart: vi.fn(async () => {}),
      onStagedUploadStart: vi.fn(async () => {}),
      onUploadChunk: vi.fn(async () => {}),
      onUploadEnd: vi.fn(async () => {}),
      onPing: vi.fn((message) => send({ type: "pong", id: message.id })),
    };
    let frameQueue = Promise.resolve();
    frameQueue = frameQueue.then(() =>
      routeClientMessageSafely(
        {
          type: "subscribe",
          subscriptionId: "glossary-1",
          channel: "glossary",
          projectId: toUrlProjectId("/project"),
        },
        send,
        handlers,
      ),
    );
    frameQueue = frameQueue.then(() =>
      routeClientMessageSafely({ type: "ping", id: "ping-1" }, send, handlers),
    );
    frameQueue = frameQueue.then(() =>
      routeClientMessageSafely(
        { type: "unsubscribe", subscriptionId: "glossary-1" },
        send,
        handlers,
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handlers.onPing).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(subscriptions.has("glossary-1")).toBe(false);
    expect(send).toHaveBeenCalledWith({ type: "pong", id: "ping-1" });

    pending.resolve(undefined);
    await frameQueue;
    await Promise.resolve();
    expect(release).toHaveBeenCalledOnce();
  });

  it("owns an initial event send failure after readiness", async () => {
    const pending = deferred<void>();
    const release = vi.fn();
    const manager = {
      subscribe: vi.fn(() => ({ ready: pending.promise, release })),
    } as unknown as ProjectGlossarySubscriptionManager;
    const subscriptions = new Map<string, () => void>();
    const send = vi.fn(() => {
      throw new Error("socket closed");
    });

    handleGlossarySubscribe(
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
    pending.resolve(undefined);
    await pending.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(release).toHaveBeenCalledOnce();
    expect(subscriptions.has("glossary-1")).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
