import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupSubscriptions,
  createConnectionState,
  handleActivitySubscribe,
} from "../../src/routes/ws-relay-handlers.js";
import { ConnectedBrowsersService } from "../../src/services/ConnectedBrowsersService.js";
import { EventBus } from "../../src/watcher/EventBus.js";

describe("WebSocket activity browser-tab tracking", () => {
  let eventBus: EventBus;
  let connectedBrowsers: ConnectedBrowsersService;

  beforeEach(() => {
    eventBus = new EventBus();
    connectedBrowsers = new ConnectedBrowsersService(eventBus);
  });

  it("counts one socket once when it has overlapping activity streams", () => {
    const subscriptions = new Map<string, () => void>();
    const connState = createConnectionState();
    const send = vi.fn();

    for (const subscriptionId of ["activity-1", "activity-2"]) {
      handleActivitySubscribe(
        subscriptions,
        {
          type: "subscribe",
          subscriptionId,
          channel: "activity",
          browserProfileId: "profile-1",
        },
        send,
        eventBus,
        connState,
        connectedBrowsers,
      );
    }

    expect(connectedBrowsers.getTabCount("profile-1")).toBe(1);
    expect(connectedBrowsers.getTotalTabCount()).toBe(1);

    subscriptions.get("activity-1")?.();
    expect(connectedBrowsers.getTabCount("profile-1")).toBe(1);

    cleanupSubscriptions(subscriptions);
    expect(connectedBrowsers.getTabCount("profile-1")).toBe(0);
    expect(connectedBrowsers.getTotalTabCount()).toBe(0);
    expect(eventBus.subscriberCount).toBe(0);
  });

  it("holds global viewer presence for an open browser activity stream", () => {
    const subscriptions = new Map<string, () => void>();
    const releaseViewerPresence = vi.fn();
    const registerViewerPresence = vi.fn(() => releaseViewerPresence);

    handleActivitySubscribe(
      subscriptions,
      {
        type: "subscribe",
        subscriptionId: "activity-1",
        channel: "activity",
      },
      vi.fn(),
      eventBus,
      createConnectionState(),
      undefined,
      undefined,
      undefined,
      registerViewerPresence,
    );

    expect(registerViewerPresence).toHaveBeenCalledOnce();
    cleanupSubscriptions(subscriptions);
    expect(releaseViewerPresence).toHaveBeenCalledOnce();
  });
});
