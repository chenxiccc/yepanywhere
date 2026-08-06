import { describe, expect, it, vi } from "vitest";
import { FakeSourceTransport, SourceTransportNotReadyError } from "../index";

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("FakeSourceTransport", () => {
  it("publishes scripted status snapshots", () => {
    const transport = new FakeSourceTransport({
      initialSnapshot: {
        kind: "localhost",
        state: "ready",
        channels: [{ name: "same-origin-http", state: "stateless" }],
      },
    });
    const listener = vi.fn();
    const unsubscribe = transport.status.subscribe(listener);

    transport.setState("reconnecting");
    transport.upsertChannel({
      name: "stream-websocket",
      state: "reconnecting",
      activeSubscriptions: 2,
    });
    unsubscribe();
    transport.setState("ready");

    expect(listener).toHaveBeenCalledTimes(2);
    expect(transport.status.getSnapshot()).toEqual({
      kind: "localhost",
      state: "ready",
      channels: [
        { name: "same-origin-http", state: "stateless" },
        {
          name: "stream-websocket",
          state: "reconnecting",
          activeSubscriptions: 2,
        },
      ],
    });
  });

  it("records and drives subscriptions", () => {
    const transport = new FakeSourceTransport();
    const handlers = {
      onEvent: vi.fn(),
      onOpen: vi.fn(),
      onClose: vi.fn(),
    };

    const subscription = transport.subscribeSession(
      "session-1",
      handlers,
      "event-2",
      { wantsLiveDeltas: false },
    );
    const records = transport.getSubscriptions("session");
    const record = records[0];
    expect(record).toBeDefined();
    if (!record) throw new Error("Expected fake subscription record.");
    expect(record).toMatchObject({
      kind: "session",
      sessionId: "session-1",
      lastEventId: "event-2",
      options: { wantsLiveDeltas: false },
      closed: false,
      closeCalls: 0,
    });

    transport.openSubscription(record.id);
    transport.emitSubscriptionEvent(
      record.id,
      "message",
      { ok: true },
      "event-3",
    );
    subscription.close();
    transport.emitSubscriptionEvent(
      record.id,
      "message",
      { ok: false },
      "event-4",
    );

    expect(handlers.onOpen).toHaveBeenCalledTimes(1);
    expect(handlers.onEvent).toHaveBeenCalledTimes(1);
    expect(handlers.onEvent).toHaveBeenCalledWith("message", "event-3", {
      ok: true,
    });
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(transport.getSubscriptions("session")[0]).toMatchObject({
      closed: true,
      closeCalls: 1,
    });
  });

  it("reports not-ready raw subscriptions as retryable typed errors", async () => {
    const transport = new FakeSourceTransport({
      initialSnapshot: {
        kind: "secure",
        state: "disconnected",
        channels: [{ name: "secure-websocket", state: "disconnected" }],
      },
    });
    const onError = vi.fn();

    transport.subscribeActivity({ onEvent: vi.fn(), onError });
    await flushPromises();

    expect(onError).toHaveBeenCalledTimes(1);
    const error = onError.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(SourceTransportNotReadyError);
    expect(error).toMatchObject({
      code: "SOURCE_TRANSPORT_NOT_READY",
      retryable: true,
      transportKind: "secure",
      state: "disconnected",
    });
  });
});
