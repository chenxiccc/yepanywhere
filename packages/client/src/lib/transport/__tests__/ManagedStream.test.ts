import { describe, expect, it, vi } from "vitest";
import { MockTimers } from "../../connection/__tests__/ConnectionSimulator";
import { SubscriptionError } from "../../connection/types";
import {
  createManagedStream,
  FakeSourceTransport,
  type FakeSourceTransportSubscriptionKind,
  type FakeSourceTransportSubscriptionRecord,
  type ManagedStreamScheduler,
  type ManagedStreamSpec,
} from "../index";

function schedulerFromTimers(timers: MockTimers): ManagedStreamScheduler {
  return {
    setTimeout: (fn, delayMs) => timers.setTimeout(fn, delayMs),
    clearTimeout: (handle) => timers.clearTimeout(handle as number),
  };
}

function getOnlySubscription(
  transport: FakeSourceTransport,
  kind: FakeSourceTransportSubscriptionKind,
): FakeSourceTransportSubscriptionRecord {
  const subscriptions = transport.getSubscriptions(kind);
  expect(subscriptions).toHaveLength(1);
  const subscription = subscriptions[0];
  if (!subscription) throw new Error(`Expected ${kind} subscription.`);
  return subscription;
}

function getLastSubscription(
  transport: FakeSourceTransport,
  kind: FakeSourceTransportSubscriptionKind,
): FakeSourceTransportSubscriptionRecord {
  const subscriptions = transport.getSubscriptions(kind);
  const subscription = subscriptions.at(-1);
  if (!subscription) throw new Error(`Expected ${kind} subscription.`);
  return subscription;
}

function createSessionSpec(
  onEvent = vi.fn(),
  onError = vi.fn(),
): ManagedStreamSpec {
  return {
    subscribe: ({ transport, handlers, lastEventId }) =>
      transport.subscribeSession("session-1", handlers, lastEventId, {
        wantsLiveDeltas: false,
      }),
    onEvent,
    onError,
  };
}

function createWatchSpec(onEvent = vi.fn()): ManagedStreamSpec {
  return {
    subscribe: ({ transport, handlers }) =>
      transport.subscribeSessionWatch("session-1", handlers, {
        projectId: "project-1",
        provider: "claude",
      }),
    onEvent,
  };
}

function createActivitySpec(onEvent = vi.fn()): ManagedStreamSpec {
  return {
    subscribe: ({ transport, handlers }) =>
      transport.subscribeActivity(handlers),
    onEvent,
  };
}

describe("createManagedStream", () => {
  it("waits for transport readiness before subscribing", () => {
    const transport = new FakeSourceTransport({
      initialSnapshot: {
        kind: "secure",
        state: "disconnected",
        channels: [{ name: "secure-websocket", state: "disconnected" }],
      },
    });
    const stream = createManagedStream(transport, createSessionSpec());

    expect(stream.getSnapshot()).toMatchObject({
      state: "waiting",
      connected: false,
    });
    expect(transport.getSubscriptions("session")).toHaveLength(0);

    transport.setState("ready");
    const subscription = getOnlySubscription(transport, "session");
    transport.openSubscription(subscription.id);

    expect(stream.getSnapshot()).toMatchObject({
      state: "open",
      connected: true,
    });
  });

  it("resubscribes session streams with the captured lastEventId", () => {
    const transport = new FakeSourceTransport();
    const onEvent = vi.fn();
    const stream = createManagedStream(transport, createSessionSpec(onEvent));

    const first = getOnlySubscription(transport, "session");
    transport.openSubscription(first.id);
    transport.emitSubscriptionEvent(
      first.id,
      "message",
      { ok: true },
      "event-1",
    );

    expect(stream.getSnapshot().lastEventId).toBe("event-1");
    expect(onEvent).toHaveBeenCalledWith({
      eventType: "message",
      eventId: "event-1",
      data: { ok: true },
    });

    transport.setState("reconnecting");
    expect(transport.getSubscriptions("session")[0]).toMatchObject({
      closed: true,
      closeCalls: 1,
    });

    transport.setState("ready");
    const second = getLastSubscription(transport, "session");

    expect(transport.getSubscriptions("session")).toHaveLength(2);
    expect(second).toMatchObject({
      kind: "session",
      sessionId: "session-1",
      lastEventId: "event-1",
      options: { wantsLiveDeltas: false },
      closed: false,
    });
  });

  it("resubscribes watch streams after ready transitions", () => {
    const transport = new FakeSourceTransport();
    createManagedStream(transport, createWatchSpec());

    const first = getOnlySubscription(transport, "session-watch");
    transport.openSubscription(first.id);

    transport.setState("reconnecting");
    transport.setState("ready");
    const second = getLastSubscription(transport, "session-watch");

    expect(transport.getSubscriptions("session-watch")).toHaveLength(2);
    expect(second).toMatchObject({
      kind: "session-watch",
      sessionId: "session-1",
      options: { projectId: "project-1", provider: "claude" },
      closed: false,
    });
  });

  it("ignores stale callbacks and closes the active subscription once", () => {
    const transport = new FakeSourceTransport();
    const stream = createManagedStream(transport, createSessionSpec());

    const first = getOnlySubscription(transport, "session");
    transport.openSubscription(first.id);
    transport.setState("reconnecting");
    transport.setState("ready");

    const second = getLastSubscription(transport, "session");
    transport.openSubscription(second.id);
    transport.closeSubscription(first.id, undefined, { allowClosed: true });
    transport.failSubscription(first.id, new Error("late failure"), {
      allowClosed: true,
    });

    expect(stream.getSnapshot()).toMatchObject({
      state: "open",
      connected: true,
    });
    expect(transport.getSubscriptions("session")[1]).toMatchObject({
      id: second.id,
      closed: false,
      closeCalls: 0,
    });

    stream.close();
    stream.close();

    expect(transport.getSubscriptions("session")[1]).toMatchObject({
      id: second.id,
      closed: true,
      closeCalls: 1,
    });
  });

  it("is safe across StrictMode-style close and remount", () => {
    const transport = new FakeSourceTransport();
    const firstStream = createManagedStream(transport, createSessionSpec());
    const first = getOnlySubscription(transport, "session");
    firstStream.close();

    const secondStream = createManagedStream(transport, createSessionSpec());
    const second = getLastSubscription(transport, "session");
    transport.openSubscription(second.id);
    transport.closeSubscription(first.id, undefined, { allowClosed: true });
    transport.failSubscription(first.id, new Error("late failure"), {
      allowClosed: true,
    });

    expect(secondStream.getSnapshot()).toMatchObject({
      state: "open",
      connected: true,
    });
    expect(transport.getSubscriptions("session")[1]).toMatchObject({
      id: second.id,
      closed: false,
    });
  });

  it("keeps activity connect idempotent and resubscribes on ready", () => {
    const transport = new FakeSourceTransport({
      initialSnapshot: {
        kind: "secure",
        state: "disconnected",
        channels: [{ name: "secure-websocket", state: "disconnected" }],
      },
    });
    const stream = createManagedStream(transport, createActivitySpec(), {
      autoStart: false,
    });

    stream.start();
    stream.start();
    expect(transport.getSubscriptions("activity")).toHaveLength(0);

    transport.setState("ready");
    const first = getOnlySubscription(transport, "activity");
    transport.openSubscription(first.id);
    stream.start();
    expect(transport.getSubscriptions("activity")).toHaveLength(1);

    transport.setState("reconnecting");
    transport.setState("ready");
    const second = getLastSubscription(transport, "activity");

    expect(transport.getSubscriptions("activity")).toHaveLength(2);
    expect(second.closed).toBe(false);
  });

  it("leaves subscription 4xx terminal without reconnecting transport", () => {
    const timers = new MockTimers();
    const reconnect = vi.fn();
    const onError = vi.fn();
    const transport = new FakeSourceTransport({ reconnect });
    const stream = createManagedStream(
      transport,
      createSessionSpec(vi.fn(), onError),
      {
        scheduler: schedulerFromTimers(timers),
        retry: { initialDelayMs: 10, maxDelayMs: 10 },
      },
    );

    const first = getOnlySubscription(transport, "session");
    transport.failSubscription(
      first.id,
      new SubscriptionError(404, "No active process"),
    );
    timers.advance(1_000);

    expect(stream.getSnapshot()).toMatchObject({
      state: "terminal",
      connected: false,
      terminal: true,
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(reconnect).not.toHaveBeenCalled();
    expect(transport.getSubscriptions("session")).toHaveLength(1);
  });

  it("retries transient subscription failures without transport reconnect", () => {
    const timers = new MockTimers();
    const reconnect = vi.fn();
    const transport = new FakeSourceTransport({ reconnect });
    const stream = createManagedStream(transport, createSessionSpec(), {
      scheduler: schedulerFromTimers(timers),
      retry: { initialDelayMs: 25, maxDelayMs: 25 },
    });

    const first = getOnlySubscription(transport, "session");
    transport.openSubscription(first.id);
    transport.emitSubscriptionEvent(
      first.id,
      "message",
      { ok: true },
      "event-7",
    );
    transport.failSubscription(first.id, new Error("transient"));

    expect(stream.getSnapshot()).toMatchObject({
      state: "retrying",
      connected: false,
      retryAttempt: 1,
      lastEventId: "event-7",
    });
    expect(transport.getSubscriptions("session")).toHaveLength(1);
    expect(reconnect).not.toHaveBeenCalled();

    timers.advance(24);
    expect(transport.getSubscriptions("session")).toHaveLength(1);

    timers.advance(1);
    const second = getLastSubscription(transport, "session");

    expect(transport.getSubscriptions("session")).toHaveLength(2);
    expect(second).toMatchObject({
      lastEventId: "event-7",
      closed: false,
    });
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("isolates status churn between independent runtimes", () => {
    const firstTransport = new FakeSourceTransport();
    const secondTransport = new FakeSourceTransport();
    const firstStream = createManagedStream(
      firstTransport,
      createSessionSpec(),
    );
    const secondStream = createManagedStream(
      secondTransport,
      createSessionSpec(),
    );

    const firstSub = getOnlySubscription(firstTransport, "session");
    const secondSub = getOnlySubscription(secondTransport, "session");
    firstTransport.openSubscription(firstSub.id);
    secondTransport.openSubscription(secondSub.id);

    firstTransport.setState("reconnecting");

    expect(firstStream.getSnapshot()).toMatchObject({
      state: "waiting",
      connected: false,
    });
    expect(secondStream.getSnapshot()).toMatchObject({
      state: "open",
      connected: true,
    });
    expect(secondTransport.getSubscriptions("session")).toHaveLength(1);
    expect(secondTransport.getSubscriptions("session")[0]).toMatchObject({
      id: secondSub.id,
      closed: false,
    });

    firstTransport.setState("ready");

    expect(firstTransport.getSubscriptions("session")).toHaveLength(2);
    expect(secondTransport.getSubscriptions("session")).toHaveLength(1);
  });
});
