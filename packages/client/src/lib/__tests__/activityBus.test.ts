import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toUrlProjectId } from "@yep-anywhere/shared";
import {
  activityBus,
  type SessionCreatedEvent,
  type SessionIdRemappedEvent,
} from "../activityBus";
import { FakeSourceTransport } from "../transport";

const SESSION_CREATED: SessionCreatedEvent = {
  type: "session-created",
  session: {
    id: "session-1",
    projectId: toUrlProjectId("project-1"),
    title: "Session",
    fullTitle: "Session",
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
    messageCount: 1,
    ownership: { owner: "none" },
    provider: "claude",
  },
  timestamp: "2026-07-05T00:00:00.000Z",
};

const SESSION_ID_REMAPPED: SessionIdRemappedEvent = {
  type: "session-id-remapped",
  oldSessionId: "temporary-session",
  newSessionId: "session-1",
  projectId: toUrlProjectId("project-1"),
  processId: "process-1",
  provider: "claude",
  timestamp: "2026-07-05T00:00:01.000Z",
};

function getOnlyActivitySubscription(transport: FakeSourceTransport) {
  const subscriptions = transport.getSubscriptions("activity");
  expect(subscriptions).toHaveLength(1);
  const subscription = subscriptions[0];
  if (!subscription) throw new Error("Expected activity subscription");
  return subscription;
}

beforeEach(() => {
  activityBus.resetForTests();
});

afterEach(() => {
  activityBus.resetForTests();
});

describe("activityBus source streams", () => {
  it("isolates source listeners while bridging only the current source", () => {
    const sourceATransport = new FakeSourceTransport();
    const sourceBTransport = new FakeSourceTransport();
    const sourceAEvent = vi.fn();
    const sourceBEvent = vi.fn();
    const globalEvent = vi.fn();

    activityBus.onSource("source-a", "session-created", sourceAEvent);
    activityBus.onSource("source-b", "session-created", sourceBEvent);
    activityBus.on("session-created", globalEvent);

    const releaseA = activityBus.retainCurrentSourceStream(
      "source-a",
      sourceATransport,
    );
    const releaseB = activityBus.retainSourceStream(
      "source-b",
      sourceBTransport,
    );
    const sourceASubscription = getOnlyActivitySubscription(sourceATransport);
    const sourceBSubscription = getOnlyActivitySubscription(sourceBTransport);

    sourceATransport.openSubscription(sourceASubscription.id);
    sourceBTransport.openSubscription(sourceBSubscription.id);

    sourceBTransport.emitSubscriptionEvent(
      sourceBSubscription.id,
      "session-created",
      SESSION_CREATED,
    );
    expect(sourceBEvent).toHaveBeenCalledWith(SESSION_CREATED);
    expect(sourceAEvent).not.toHaveBeenCalled();
    expect(globalEvent).not.toHaveBeenCalled();

    sourceATransport.emitSubscriptionEvent(
      sourceASubscription.id,
      "session-created",
      SESSION_CREATED,
    );
    expect(sourceAEvent).toHaveBeenCalledWith(SESSION_CREATED);
    expect(globalEvent).toHaveBeenCalledWith(SESSION_CREATED);

    releaseB();
    releaseA();
    expect(sourceATransport.getSubscriptions("activity")[0]).toMatchObject({
      closed: true,
      closeCalls: 1,
    });
    expect(sourceBTransport.getSubscriptions("activity")[0]).toMatchObject({
      closed: true,
      closeCalls: 1,
    });
  });

  it("resubscribes on ready recovery and emits reconnect after first open", () => {
    const transport = new FakeSourceTransport();
    const onReconnect = vi.fn();
    activityBus.on("reconnect", onReconnect);

    const release = activityBus.retainCurrentSourceStream(
      "source-a",
      transport,
    );
    const first = getOnlyActivitySubscription(transport);

    transport.openSubscription(first.id);
    expect(onReconnect).not.toHaveBeenCalled();
    expect(activityBus.connected).toBe(true);

    transport.setState("reconnecting");
    expect(transport.getSubscriptions("activity")[0]).toMatchObject({
      id: first.id,
      closed: true,
    });
    expect(activityBus.connected).toBe(false);

    transport.setState("ready");
    const second = transport.getSubscriptions("activity").at(-1);
    expect(transport.getSubscriptions("activity")).toHaveLength(2);
    expect(second).toMatchObject({ closed: false });

    if (!second) throw new Error("Expected recovered activity subscription");
    transport.openSubscription(second.id);
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(activityBus.connected).toBe(true);

    release();
  });

  it("forwards session ID remaps from the source stream", () => {
    const transport = new FakeSourceTransport();
    const onRemapped = vi.fn();
    activityBus.onSource("source-a", "session-id-remapped", onRemapped);

    const release = activityBus.retainSourceStream("source-a", transport);
    const subscription = getOnlyActivitySubscription(transport);
    transport.openSubscription(subscription.id);
    transport.emitSubscriptionEvent(
      subscription.id,
      "session-id-remapped",
      SESSION_ID_REMAPPED,
    );

    expect(onRemapped).toHaveBeenCalledWith(SESSION_ID_REMAPPED);
    release();
  });

  it("emits refresh on visibility restore while connected", () => {
    const transport = new FakeSourceTransport();
    const onRefresh = vi.fn();
    activityBus.on("refresh", onRefresh);

    const release = activityBus.retainCurrentSourceStream(
      "source-a",
      transport,
    );
    transport.emitVisibilityRestored();
    expect(onRefresh).not.toHaveBeenCalled();

    const subscription = getOnlyActivitySubscription(transport);
    transport.openSubscription(subscription.id);
    transport.emitVisibilityRestored();

    expect(onRefresh).toHaveBeenCalledTimes(1);
    release();
  });

  it("releases activity work on page exit and resumes a retained page", () => {
    const transport = new FakeSourceTransport();
    const release = activityBus.retainCurrentSourceStream(
      "source-a",
      transport,
    );
    const first = getOnlyActivitySubscription(transport);
    transport.openSubscription(first.id);

    window.dispatchEvent(new Event("pagehide"));

    expect(transport.getSubscriptions("activity")[0]).toMatchObject({
      id: first.id,
      closed: true,
      closeCalls: 1,
    });
    expect(activityBus.connected).toBe(false);

    window.dispatchEvent(new Event("pageshow"));

    const second = transport.getSubscriptions("activity").at(-1);
    expect(transport.getSubscriptions("activity")).toHaveLength(2);
    expect(second).toMatchObject({ closed: false, closeCalls: 0 });

    release();
    expect(transport.getSubscriptions("activity").at(-1)).toMatchObject({
      closed: true,
      closeCalls: 1,
    });
  });
});
