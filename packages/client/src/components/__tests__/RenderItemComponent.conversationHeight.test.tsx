// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { CONVERSATION_ACTIVITY_RESERVE_HOLD_MS } from "../../lib/sessionDetail/activityHeightReserve";
import type {
  ConversationActivityItem,
  ConversationThinkingPreviewSlot,
  RenderItem,
} from "../../types/renderItems";
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
        endedAtMs: 2000,
      },
      {
        id: "thinking-previous",
        kind: "previous",
        slot: "previous",
        thinking: "previous reasoning block",
        status: "complete",
        endedAtMs: 1400,
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

  it("enables the wide activity layout only when requested", () => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);

    const { container, rerender } = render(
      <I18nProvider>
        <RenderItemComponent
          item={conversationActivityItem()}
          isStreaming
          thinkingExpanded={false}
          toggleThinkingExpanded={() => {}}
        />
      </I18nProvider>,
    );

    expect(
      container
        .querySelector(".conversation-activity-row")
        ?.classList.contains("is-wide-activity-previews"),
    ).toBe(false);

    rerender(
      <I18nProvider>
        <RenderItemComponent
          item={conversationActivityItem()}
          isStreaming
          thinkingExpanded={false}
          toggleThinkingExpanded={() => {}}
          widerConversationActivityPreviews
        />
      </I18nProvider>,
    );

    expect(
      container
        .querySelector(".conversation-activity-row")
        ?.classList.contains("is-wide-activity-previews"),
    ).toBe(true);
  });
});

describe("conversation thinking preview age", () => {
  afterEach(() => {
    observers = [];
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderPreviews(item: RenderItem) {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    return render(
      <I18nProvider>
        <RenderItemComponent
          item={item}
          isStreaming
          thinkingExpanded={false}
          toggleThinkingExpanded={() => {}}
        />
      </I18nProvider>,
    );
  }

  function headerText(container: HTMLElement, slot: string): string {
    return (
      container.querySelector(
        `.conversation-thinking-preview[data-preview-slot="${slot}"] .conversation-thinking-preview-header`,
      )?.textContent ?? ""
    );
  }

  it("places a completed block by how far it sits before the turn's end", () => {
    const base = conversationActivityItem() as Extract<
      RenderItem,
      { type: "conversation_activity" }
    >;
    // The turn runs to 4000; the previous block last spoke at 1400.
    const { container } = renderPreviews({ ...base, endedAtMs: 4_000 });

    expect(headerText(container as HTMLElement, "previous")).toContain(
      "2.6s ago",
    );
  });

  it("gives the streaming block no age, since it is happening now", () => {
    const { container } = renderPreviews(conversationActivityItem());

    expect(headerText(container as HTMLElement, "latest")).not.toContain("ago");
  });

  it("shows no age when the provider supplied no timestamps", () => {
    const base = conversationActivityItem() as Extract<
      RenderItem,
      { type: "conversation_activity" }
    >;
    const item = {
      ...base,
      thinkingPreviews: base.thinkingPreviews?.map((preview) => ({
        ...preview,
        endedAtMs: null,
      })),
    };
    const { container } = renderPreviews(item);

    expect(headerText(container as HTMLElement, "previous")).not.toContain(
      "ago",
    );
  });
});

describe("conversation activity height reserve", () => {
  afterEach(() => {
    observers = [];
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const RESERVE_VAR = "--conversation-activity-reserved-height";

  /**
   * jsdom lays nothing out, so give the row a top of 0 and every child the
   * natural height under test. The row's own rect is deliberately left flat:
   * the measurement must read the children, or the applied reserve would feed
   * back into itself.
   */
  function stubRowMetrics(row: HTMLElement, naturalHeightPx: () => number) {
    row.getBoundingClientRect = () =>
      ({ top: 0, bottom: 0 }) as unknown as DOMRect;
    for (const child of Array.from(row.children)) {
      (child as HTMLElement).getBoundingClientRect = () =>
        ({ top: 0, bottom: naturalHeightPx() }) as unknown as DOMRect;
    }
  }

  function fireRowObservers(row: HTMLElement) {
    act(() => {
      for (const observer of observers.filter((candidate) =>
        candidate.targets.includes(row),
      )) {
        observer.cb([], observer as unknown as ResizeObserver);
      }
    });
  }

  function reservedHeight(row: HTMLElement): string {
    return row.style.getPropertyValue(RESERVE_VAR);
  }

  function renderActivity(
    item = conversationActivityItem(),
    collapsed?: Set<ConversationThinkingPreviewSlot>,
  ) {
    return (
      <I18nProvider>
        <RenderItemComponent
          item={item}
          isStreaming
          thinkingExpanded={false}
          toggleThinkingExpanded={() => {}}
          collapsedConversationThinkingPreviewSlots={collapsed}
        />
      </I18nProvider>
    );
  }

  it("holds the row's height across the cooling-off period, then releases it", () => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    vi.useFakeTimers();

    const { container } = render(renderActivity());
    const row = container.querySelector<HTMLElement>(
      ".conversation-activity-row",
    ) as HTMLElement;
    let naturalHeightPx = 400;
    stubRowMetrics(row, () => naturalHeightPx);

    fireRowObservers(row);
    expect(reservedHeight(row)).toBe("400px");

    // A shorter block replaces the long one: the space stays, so the transcript
    // above it does not slide down under follow mode.
    naturalHeightPx = 90;
    fireRowObservers(row);
    expect(reservedHeight(row)).toBe("400px");

    act(() => {
      vi.advanceTimersByTime(CONVERSATION_ACTIVITY_RESERVE_HOLD_MS - 1);
    });
    expect(reservedHeight(row)).toBe("400px");

    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(reservedHeight(row)).toBe("90px");
  });

  it("gives the space back at once when the reader collapses a card", () => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    vi.useFakeTimers();

    const { container, rerender } = render(renderActivity());
    const row = container.querySelector<HTMLElement>(
      ".conversation-activity-row",
    ) as HTMLElement;
    let naturalHeightPx = 400;
    stubRowMetrics(row, () => naturalHeightPx);
    fireRowObservers(row);
    expect(reservedHeight(row)).toBe("400px");

    // The chevron asks for a shorter row and keeps the card collapsed as later
    // blocks stream into the slot, so there is nothing to hold the space for.
    naturalHeightPx = 90;
    rerender(renderActivity(conversationActivityItem(), new Set(["latest"])));
    stubRowMetrics(row, () => naturalHeightPx);
    expect(reservedHeight(row)).toBe("90px");
  });

  it("holds through a dismissal, but not the one that hides thinking", () => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    vi.useFakeTimers();

    const base = conversationActivityItem() as Extract<
      RenderItem,
      { type: "conversation_activity" }
    >;
    const { container, rerender } = render(renderActivity(base));
    const row = container.querySelector<HTMLElement>(
      ".conversation-activity-row",
    ) as HTMLElement;
    let naturalHeightPx = 400;
    stubRowMetrics(row, () => naturalHeightPx);
    fireRowObservers(row);
    expect(reservedHeight(row)).toBe("400px");

    // ✕ on one of two cards: thinking stays visible and the freed space is
    // about to be used by the next block, so the hold still applies.
    naturalHeightPx = 90;
    rerender(
      renderActivity({
        ...base,
        thinkingPreviews: base.thinkingPreviews?.slice(0, 1),
      }),
    );
    stubRowMetrics(row, () => naturalHeightPx);
    fireRowObservers(row);
    expect(reservedHeight(row)).toBe("400px");

    // ✕ on the last card hides thinking entirely — that space is not coming
    // back, so holding it would just leave a gap.
    rerender(renderActivity({ ...base, thinkingPreviews: [] }));
    stubRowMetrics(row, () => naturalHeightPx);
    expect(reservedHeight(row)).toBe("90px");
  });
});

describe("conversation thinking auto-hide", () => {
  beforeEach(() => {
    observers = [];
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function renderCompleted(overrides: Partial<ConversationActivityItem> = {}) {
    const base = conversationActivityItem() as ConversationActivityItem;
    const item: ConversationActivityItem = {
      ...base,
      active: false,
      hasFollowingConversationText: true,
      endedAtMs: Date.now(),
      thinkingPreviews: base.thinkingPreviews?.map((preview) => ({
        ...preview,
        status: "complete",
      })),
      ...overrides,
    };
    return render(
      <I18nProvider>
        <RenderItemComponent
          item={item}
          isStreaming={false}
          thinkingExpanded={false}
          toggleThinkingExpanded={() => {}}
        />
      </I18nProvider>,
    );
  }

  it("keeps thinking visible for 5s after a completed turn with following text", () => {
    const { container } = renderCompleted();
    expect(
      container.querySelector(".conversation-thinking-preview"),
    ).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(
      container.querySelector(".conversation-thinking-preview"),
    ).not.toBeNull();
  });

  it("hides thinking after the delay when conversation text followed it", () => {
    const { container } = renderCompleted();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(
      container.querySelector(".conversation-thinking-preview"),
    ).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(
      container.querySelector(".conversation-thinking-preview"),
    ).toBeNull();
    expect(
      container.querySelector(".conversation-activity-summary"),
    ).not.toBeNull();
  });

  it("starts compact for a turn that completed more than 5s ago", () => {
    const { container } = renderCompleted({
      endedAtMs: Date.now() - 60_000,
    });
    expect(
      container.querySelector(".conversation-thinking-preview"),
    ).toBeNull();
  });

  it("does not hide thinking when no conversation text followed it", () => {
    const { container } = renderCompleted({
      hasFollowingConversationText: false,
      endedAtMs: Date.now() - 60_000,
    });
    expect(
      container.querySelector(".conversation-thinking-preview"),
    ).not.toBeNull();
  });
});
