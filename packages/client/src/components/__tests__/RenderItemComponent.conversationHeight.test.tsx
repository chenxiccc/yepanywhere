// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { RenderItem } from "../../types/renderItems";
import { RenderItemComponent } from "../RenderItemComponent";

// jsdom has no ResizeObserver and reports offsetHeight 0, so drive the
// measurement by capturing the observer and its callback, then firing it after
// stubbing the observed element's rendered height.
class MockResizeObserver {
  readonly targets: Element[] = [];
  constructor(readonly cb: ResizeObserverCallback) {
    observers.push(this);
  }
  observe(element: Element) {
    this.targets.push(element);
  }
  unobserve() {}
  disconnect() {}
}
let observers: MockResizeObserver[] = [];

function conversationActivityItem(): RenderItem {
  return {
    type: "conversation_activity",
    id: "conversation-activity-1",
    activityCount: 5,
    active: true,
    expanded: false,
    startedAtMs: 1000,
    endedAtMs: 2000,
    sourceMessages: [],
    thinkingPreviews: [
      {
        id: "thinking-current",
        kind: "current",
        slot: "latest",
        thinking: "current reasoning tail",
        status: "streaming",
      },
      {
        id: "thinking-previous",
        kind: "previous",
        slot: "previous",
        thinking: "previous reasoning block",
        status: "complete",
      },
    ],
    recentActivities: [
      { label: "Run", detail: "Run: build", preview: "build" },
    ],
  };
}

describe("conversation thinking preview height publication", () => {
  afterEach(() => {
    observers = [];
    cleanup();
    vi.unstubAllGlobals();
  });

  it("publishes the latest preview's content height as a row CSS var for siblings to cap to", () => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);

    const { container } = render(
      <I18nProvider>
        <RenderItemComponent
          item={conversationActivityItem()}
          isStreaming
          thinkingExpanded={false}
          toggleThinkingExpanded={() => {}}
        />
      </I18nProvider>,
    );

    const row = container.querySelector<HTMLElement>(
      ".conversation-activity-row",
    );
    const latestContent = container.querySelector<HTMLElement>(
      '.conversation-thinking-preview[data-preview-slot="latest"] .conversation-thinking-preview-content',
    );
    expect(row).not.toBeNull();
    expect(latestContent).not.toBeNull();

    // The measurement watches exactly the current/latest preview's content box —
    // never the previous preview or the activity list, so no feedback loop.
    const watching = observers.find((observer) =>
      observer.targets.includes(latestContent as Element),
    );
    expect(
      watching,
      "an observer should watch the latest preview content",
    ).toBeDefined();

    Object.defineProperty(latestContent, "offsetHeight", {
      configurable: true,
      get: () => 240,
    });
    act(() => {
      watching?.cb([], watching as unknown as ResizeObserver);
    });

    expect(row?.style.getPropertyValue("--conversation-thinking-height")).toBe(
      "240px",
    );
  });

  it("publishes 0 when the current/latest card is collapsed so siblings never exceed it", () => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);

    const { container } = render(
      <I18nProvider>
        <RenderItemComponent
          item={conversationActivityItem()}
          isStreaming
          thinkingExpanded={false}
          toggleThinkingExpanded={() => {}}
          collapsedConversationThinkingPreviewSlots={new Set(["latest"])}
        />
      </I18nProvider>,
    );

    const row = container.querySelector<HTMLElement>(
      ".conversation-activity-row",
    );
    // Collapsed latest has no content box to measure; publishing 0 keeps the
    // previous preview and activity list from falling back to the viewport cap
    // and rendering taller than the header-only current card.
    expect(
      container.querySelector(
        '.conversation-thinking-preview[data-preview-slot="latest"] .conversation-thinking-preview-content',
      ),
      "collapsed latest should render no content box",
    ).toBeNull();
    expect(row?.style.getPropertyValue("--conversation-thinking-height")).toBe(
      "0px",
    );
  });

  it("marks the activity list clipped only while it overflows its cap", () => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);

    const { container } = render(
      <I18nProvider>
        <RenderItemComponent
          item={conversationActivityItem()}
          isStreaming
          thinkingExpanded={false}
          toggleThinkingExpanded={() => {}}
        />
      </I18nProvider>,
    );

    const list = container.querySelector<HTMLElement>(
      ".conversation-recent-activities",
    );
    const latestContent = container.querySelector<HTMLElement>(
      '.conversation-thinking-preview[data-preview-slot="latest"] .conversation-thinking-preview-content',
    );
    expect(list).not.toBeNull();
    const watching = observers.find((observer) =>
      observer.targets.includes(latestContent as Element),
    );

    Object.defineProperty(list, "scrollHeight", {
      configurable: true,
      get: () => 200,
    });
    let clientHeight = 100;
    Object.defineProperty(list, "clientHeight", {
      configurable: true,
      get: () => clientHeight,
    });

    // Older rows overflow the cap → the bottom edge fades.
    act(() => {
      watching?.cb([], watching as unknown as ResizeObserver);
    });
    expect(list?.classList.contains("is-clipped")).toBe(true);

    // The whole list fits → no fade, so it does not read as "more below".
    clientHeight = 200;
    act(() => {
      watching?.cb([], watching as unknown as ResizeObserver);
    });
    expect(list?.classList.contains("is-clipped")).toBe(false);
  });
});
