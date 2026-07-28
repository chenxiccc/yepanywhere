import { describe, expect, it, vi } from "vitest";
import {
  createComposerDraftSignal,
  createComposerEditAvailabilityStore,
} from "../composerDraftSignal";

describe("composerDraftSignal", () => {
  it("publishes draft changes without requiring a React owner", () => {
    const signal = createComposerDraftSignal();
    const listener = vi.fn();
    const unsubscribe = signal.subscribeDraftChanges(listener);

    signal.publishDraftChange("hello", {
      mayAffectQuoteAnchors: false,
    });

    expect(signal.getDraft()).toBe("hello");
    expect(listener).toHaveBeenCalledWith({
      text: "hello",
      metadata: { mayAffectQuoteAnchors: false },
      hasTextContent: true,
    });

    unsubscribe();
    signal.publishDraftChange("", { mayAffectQuoteAnchors: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("composerEditAvailabilityStore", () => {
  it("notifies only when the editability boolean changes", () => {
    const store = createComposerEditAvailabilityStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.setDraftText("a");
    store.setDraftText("ab");
    store.setDraftText(" ");
    store.setDraftText("");

    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toBe(true);
  });

  it("combines draft, attachment, and upload blockers", () => {
    const store = createComposerEditAvailabilityStore();

    store.setExternalBlockers(true, false);
    expect(store.getCurrent()).toBe(false);

    store.setDraftText("draft");
    store.setExternalBlockers(false, true);
    expect(store.getCurrent()).toBe(false);

    store.setDraftText("");
    expect(store.getCurrent()).toBe(false);

    store.setExternalBlockers(false, false);
    expect(store.getCurrent()).toBe(true);
  });
});
