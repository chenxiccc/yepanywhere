import { describe, expect, it } from "vitest";
import {
  SessionCollectionGeneration,
  busEventChangesSessionCollection,
} from "../../src/sessions/sessionCollectionGeneration.js";
import { EventBus } from "../../src/watcher/EventBus.js";
import type { BusEvent } from "../../src/watcher/EventBus.js";

function event(type: string): BusEvent {
  return { type, timestamp: new Date().toISOString() } as unknown as BusEvent;
}

describe("busEventChangesSessionCollection", () => {
  it("invalidates on anything that can change a rendered row", () => {
    for (const type of [
      "file-change",
      "session-created",
      "session-updated",
      "session-seen",
      "session-metadata-changed",
      "session-status-changed",
      "session-id-remapped",
      "session-aborted",
      "process-state-changed",
      "process-terminated",
      "workstreams-changed",
    ]) {
      expect(busEventChangesSessionCollection(event(type))).toBe(true);
    }
  });

  it("leaves connection, host, and aggregate-only events alone", () => {
    for (const type of [
      "source-change",
      "backend-reloaded",
      "safe-restart-changed",
      "network-binding-changed",
      "browser-tab-connected",
      "browser-tab-disconnected",
      "worker-activity-changed",
      "cache-miss-billing",
    ]) {
      expect(busEventChangesSessionCollection(event(type))).toBe(false);
    }
  });

  it("invalidates on an event type it has never heard of", () => {
    // The deny-list is the whole point: a `BusEvent` variant added later must
    // default to a stale-safe full response, not to a silent `no-change`.
    expect(busEventChangesSessionCollection(event("some-future-event"))).toBe(
      true,
    );
  });
});

describe("SessionCollectionGeneration", () => {
  it("starts past zero so a default-initialized token never matches", () => {
    const generation = new SessionCollectionGeneration();
    expect(generation.current).toBeGreaterThan(0);
    expect(generation.matches(0)).toBe(false);
    expect(generation.matches(undefined)).toBe(false);
  });

  it("advances on bus events and only matches the current value", () => {
    const bus = new EventBus();
    const generation = new SessionCollectionGeneration(bus);
    const before = generation.current;
    expect(generation.matches(before)).toBe(true);

    bus.emit(event("session-created"));
    expect(generation.matches(before)).toBe(false);
    expect(generation.matches(generation.current)).toBe(true);
  });

  it("refuses a token from the future", () => {
    // A restarted server rewinds the counter, so a token above the current
    // value names a generation this process never produced.
    const generation = new SessionCollectionGeneration();
    expect(generation.matches(generation.current + 1)).toBe(false);
  });

  it("stops advancing once disposed", () => {
    const bus = new EventBus();
    const generation = new SessionCollectionGeneration(bus);
    generation.dispose();
    const before = generation.current;

    bus.emit(event("session-created"));
    expect(generation.current).toBe(before);
  });
});
