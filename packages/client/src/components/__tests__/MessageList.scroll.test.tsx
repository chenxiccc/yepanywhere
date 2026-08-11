// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { setConversationViewPreference } from "../../hooks/useConversationView";
import {
  installMessageListTestEnvironment,
  assistantMessage,
  codexThinkingMessage,
  userMessage,
} from "./MessageList.test-support";
import { MessageList } from "../MessageList";

installMessageListTestEnvironment();

describe("MessageList scroll and follow", () => {
  it("focuses the transcript after a native scrollbar gesture", () => {
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "inspect this"),
          assistantMessage("assistant-1", "Visible answer"),
        ]}
      />,
    );
    container.tabIndex = -1;
    Object.defineProperty(container, "clientWidth", {
      configurable: true,
      value: 380,
    });
    Object.defineProperty(container, "offsetWidth", {
      configurable: true,
      value: 400,
    });
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      bottom: 500,
      height: 500,
      left: 0,
      right: 400,
      top: 0,
      width: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const composer = document.createElement("textarea");
    document.body.append(composer);
    composer.focus();

    fireEvent(
      container,
      new MouseEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 395,
      }),
    );

    expect(document.activeElement).toBe(container);
  });

  it("keeps a clicked activity summary fixed while scrolled up", async () => {
    setConversationViewPreference(true);
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "inspect this"),
          codexThinkingMessage("thinking-1", "private planning"),
          assistantMessage("assistant-1", "Visible answer"),
          userMessage("user-2", "next question"),
          assistantMessage("assistant-2", "Later answer"),
        ]}
      />,
    );
    const summary = screen.getByRole("button", {
      name: /activity hidden/,
    });
    const summaryRow = summary.closest<HTMLElement>("[data-render-id]");
    expect(summaryRow?.dataset.renderId).toBeTruthy();
    const summaryId = summaryRow?.dataset.renderId;

    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 200,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () =>
        container
          .querySelector(".conversation-activity-summary")
          ?.getAttribute("aria-expanded") === "true"
          ? 1500
          : 1200,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 400,
    });
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 400,
        width: 400,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function getRect(this: HTMLElement) {
        if (this === container) {
          return rectFor(0, 400);
        }
        if (this.dataset.renderId === "user-1") {
          return rectFor(220 - container.scrollTop, 40);
        }
        if (this.dataset.renderId === summaryId) {
          const expanded =
            this.querySelector(".conversation-activity-summary")?.getAttribute(
              "aria-expanded",
            ) === "true";
          return rectFor((expanded ? 750 : 450) - container.scrollTop, 40);
        }
        return rectFor(900 - container.scrollTop, 40);
      });

    try {
      const topBefore = summaryRow?.getBoundingClientRect().top;
      expect(summary.getAttribute("aria-expanded")).toBe("false");
      expect(topBefore).toBe(250);
      fireEvent.click(summary);

      await waitFor(() => {
        const expandedSummary = screen.getByRole("button", {
          name: /activity hidden/,
        });
        expect(expandedSummary.getAttribute("aria-expanded")).toBe("true");
        expect(
          expandedSummary
            .closest<HTMLElement>("[data-render-id]")
            ?.getBoundingClientRect().top,
        ).toBe(topBefore);
      });

      fireEvent.click(
        screen.getByRole("button", {
          name: /activity hidden/,
        }),
      );
      await waitFor(() => {
        const collapsedSummary = screen.getByRole("button", {
          name: /activity hidden/,
        });
        expect(collapsedSummary.getAttribute("aria-expanded")).toBe("false");
        expect(
          collapsedSummary
            .closest<HTMLElement>("[data-render-id]")
            ?.getBoundingClientRect().top,
        ).toBe(topBefore);
      });
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("preserves live-tail follow across an active-window prefix trim", () => {
    const onFollowingBottomChange = vi.fn();
    const onScrollSnapshotChange = vi.fn();
    const initialMessages = [
      userMessage("user-1", "old request"),
      assistantMessage("assistant-1", "old response"),
      userMessage("user-2", "retained request"),
      assistantMessage("assistant-2", "retained response"),
    ];
    const { container, rerender } = render(
      <MessageList
        messages={initialMessages}
        activeWindowTrimRevision={0}
        onFollowingBottomChange={onFollowingBottomChange}
        onScrollSnapshotChange={onScrollSnapshotChange}
      />,
    );
    let scrollHeight = 1000;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 500,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });

    fireEvent.scroll(container);
    expect(onFollowingBottomChange).toHaveBeenLastCalledWith(true);

    scrollHeight = 600;
    rerender(
      <MessageList
        messages={initialMessages.slice(2)}
        activeWindowTrimRevision={1}
        onFollowingBottomChange={onFollowingBottomChange}
        onScrollSnapshotChange={onScrollSnapshotChange}
      />,
    );

    expect(container.scrollTop).toBe(100);
    expect(onFollowingBottomChange).toHaveBeenLastCalledWith(true);
    expect(onScrollSnapshotChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ atBottom: true, scrollTop: 100 }),
    );
  });

  it("does not force a trim revision back to bottom after reader intent changes", () => {
    const onFollowingBottomChange = vi.fn();
    const initialMessages = [
      userMessage("user-1", "old request"),
      assistantMessage("assistant-1", "old response"),
      userMessage("user-2", "retained request"),
    ];
    const { container, rerender } = render(
      <MessageList
        messages={initialMessages}
        activeWindowTrimRevision={0}
        onFollowingBottomChange={onFollowingBottomChange}
      />,
    );
    let scrollHeight = 1000;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 100,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });

    fireEvent.wheel(container, { deltaY: -120 });
    expect(onFollowingBottomChange).toHaveBeenLastCalledWith(false);

    scrollHeight = 600;
    rerender(
      <MessageList
        messages={initialMessages.slice(2)}
        activeWindowTrimRevision={1}
        onFollowingBottomChange={onFollowingBottomChange}
      />,
    );

    expect(container.scrollTop).toBe(100);
    expect(onFollowingBottomChange).toHaveBeenLastCalledWith(false);
  });

  it("disables off-screen transcript rendering by default and allows opt-in", () => {
    const messages = [userMessage("user-1", "completed request")];
    const { container, rerender } = render(<MessageList messages={messages} />);

    expect(
      container
        .querySelector(".message-list")
        ?.classList.contains("message-list-offscreen-rendering"),
    ).toBe(false);

    rerender(
      <MessageList
        messages={messages}
        offscreenTranscriptRenderingEnabled={true}
      />,
    );

    expect(
      container
        .querySelector(".message-list")
        ?.classList.contains("message-list-offscreen-rendering"),
    ).toBe(true);
  });

  it("scrolls to current from a focused composer with Ctrl+End", () => {
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request"),
          assistantMessage("assistant-1", "current response"),
        ]}
      />,
    );
    const scrollTo = vi.fn();

    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 300,
    });
    container.scrollTo = scrollTo as typeof container.scrollTo;

    const editableTarget = document.createElement("textarea");
    document.body.append(editableTarget);
    editableTarget.focus();
    fireEvent.keyDown(editableTarget, {
      key: "End",
      code: "End",
      ctrlKey: true,
    });

    expect(scrollTo).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(900);
    editableTarget.remove();
  });

  it("navigates to hidden user turns and skips prompts already fully visible", () => {
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "first"),
          assistantMessage("assistant-1", "answer one"),
          userMessage("user-2", "second"),
          assistantMessage("assistant-2", "answer two"),
          userMessage("user-3", "third"),
          assistantMessage("assistant-3", "answer three"),
          userMessage("user-4", "fourth"),
          userMessage("user-5", "fifth"),
        ]}
      />,
    );
    const absoluteTops: Record<string, number> = {
      "user-1": 0,
      "user-2": 220,
      "user-3": 400,
      "user-4": 720,
      "user-5": 800,
    };
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 650,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 1100,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 300,
    });
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 400,
        width: 400,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function getRect(this: HTMLElement) {
        if (this === container) return rectFor(0, 300);
        const absoluteTop = this.dataset.renderId
          ? absoluteTops[this.dataset.renderId]
          : undefined;
        return rectFor(
          absoluteTop === undefined ? 1000 : absoluteTop - container.scrollTop,
          40,
        );
      });
    container.scrollTo = vi.fn((options: ScrollToOptions) => {
      if (typeof options.top === "number") container.scrollTop = options.top;
    }) as typeof container.scrollTo;

    try {
      fireEvent.keyDown(window, { key: "Home", code: "Home" });
      expect(container.scrollTop).toBe(388);
      fireEvent.keyDown(window, {
        key: "Home",
        code: "Home",
        repeat: true,
      });
      expect(container.scrollTop).toBe(208);

      container.scrollTop = 100;
      fireEvent.keyDown(window, { key: "End", code: "End" });
      expect(container.scrollTop).toBe(388);
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("preserves editor Home/End and offers Alt+Arrow turn accelerators", () => {
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "first"),
          assistantMessage("assistant-1", "answer one"),
          userMessage("user-2", "second"),
        ]}
      />,
    );
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 500,
      writable: true,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 300,
    });
    const rectFor = (top: number): DOMRect =>
      ({
        top,
        bottom: top + 40,
        height: 40,
        left: 0,
        right: 400,
        width: 400,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function getRect(this: HTMLElement) {
        if (this === container) return rectFor(0);
        if (this.dataset.renderId === "user-1") {
          return rectFor(100 - container.scrollTop);
        }
        if (this.dataset.renderId === "user-2") {
          return rectFor(700 - container.scrollTop);
        }
        return rectFor(1000 - container.scrollTop);
      });
    container.scrollTo = vi.fn((options: ScrollToOptions) => {
      if (typeof options.top === "number") container.scrollTop = options.top;
    }) as typeof container.scrollTo;
    const editableTarget = document.createElement("textarea");
    document.body.append(editableTarget);
    editableTarget.focus();

    try {
      fireEvent.keyDown(editableTarget, { key: "Home", code: "Home" });
      expect(container.scrollTop).toBe(500);
      fireEvent.keyDown(editableTarget, {
        key: "ArrowUp",
        code: "ArrowUp",
        altKey: true,
      });
      expect(container.scrollTop).toBe(88);

      container.scrollTop = 300;
      fireEvent.keyDown(editableTarget, { key: "End", code: "End" });
      expect(container.scrollTop).toBe(300);
      fireEvent.keyDown(editableTarget, {
        key: "ArrowDown",
        code: "ArrowDown",
        altKey: true,
      });
      expect(container.scrollTop).toBe(688);
    } finally {
      editableTarget.remove();
      rectSpy.mockRestore();
    }
  });

  it("shows a composer follow control when scrolled away from latest", async () => {
    const composerTarget = document.createElement("div");
    composerTarget.className = "session-input-inner";
    document.body.append(composerTarget);
    const onFollowCurrent = vi.fn();

    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request"),
          assistantMessage("assistant-1", "current response"),
        ]}
        onFollowCurrent={onFollowCurrent}
      />,
    );
    const scrollTo = vi.fn();

    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 200,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });
    container.scrollTo = scrollTo as typeof container.scrollTo;

    fireEvent.wheel(container, { deltaY: -120 });

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Follow latest session output",
      }),
    );

    expect(scrollTo).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(500);
    expect(onFollowCurrent).toHaveBeenCalledTimes(1);
    composerTarget.remove();
  });

  it("retargets the position timestamp to a hovered row's start time", async () => {
    const onTranscriptPositionTimestampChange = vi.fn();
    const assistantStart = "2026-04-26T12:04:00.000Z";
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request", "2026-04-26T12:00:00.000Z"),
          assistantMessage("assistant-1", "earlier response", assistantStart),
        ]}
        onTranscriptPositionTimestampChange={
          onTranscriptPositionTimestampChange
        }
      />,
    );

    const row = container.querySelector<HTMLElement>(
      '[data-render-id="assistant-1"]',
    );
    expect(row).toBeTruthy();
    fireEvent.pointerOver(row as HTMLElement);

    // Hover overrides even in follow mode, where scroll position reports null.
    await waitFor(() => {
      expect(onTranscriptPositionTimestampChange).toHaveBeenLastCalledWith(
        new Date(assistantStart).getTime(),
      );
    });

    // Leaving the transcript (composer / dead area) restores the status quo.
    const messageList = container.querySelector<HTMLElement>(".message-list");
    fireEvent.pointerLeave(messageList as HTMLElement);
    await waitFor(() => {
      expect(onTranscriptPositionTimestampChange).toHaveBeenLastCalledWith(
        null,
      );
    });
  });

  it("reports the most recent visible turn end while scrolled back", async () => {
    const onTranscriptPositionTimestampChange = vi.fn();
    const assistantEnd = "2026-04-26T12:04:00.000Z";
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request", "2026-04-26T12:00:00.000Z"),
          assistantMessage("assistant-1", "earlier response", assistantEnd),
          userMessage("user-2", "current request", "2026-04-26T12:05:00.000Z"),
          assistantMessage(
            "assistant-2",
            "current response",
            "2026-04-26T12:06:00.000Z",
          ),
        ]}
        onTranscriptPositionTimestampChange={
          onTranscriptPositionTimestampChange
        }
      />,
    );

    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 240,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 300,
    });
    container.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 300,
        height: 300,
        left: 0,
        right: 400,
        width: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 400,
        width: 400,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;

    const user1 = container.querySelector<HTMLElement>(
      '[data-render-id="user-1"]',
    );
    const assistant1 = container.querySelector<HTMLElement>(
      '[data-render-id="assistant-1"]',
    );
    const user2 = container.querySelector<HTMLElement>(
      '[data-render-id="user-2"]',
    );
    const assistant2 = container.querySelector<HTMLElement>(
      '[data-render-id="assistant-2"]',
    );
    const assistantTurns =
      container.querySelectorAll<HTMLElement>(".assistant-turn");
    const firstAssistantTurn = assistantTurns.item(0);
    const lastAssistantTurn = assistantTurns.item(1);
    expect(user1).toBeTruthy();
    expect(assistant1).toBeTruthy();
    expect(user2).toBeTruthy();
    expect(assistant2).toBeTruthy();
    expect(assistantTurns).toHaveLength(2);
    expect(firstAssistantTurn).toBeTruthy();
    expect(lastAssistantTurn).toBeTruthy();
    (user1 as HTMLElement).getBoundingClientRect = () => rectFor(-220, 40);
    (assistant1 as HTMLElement).getBoundingClientRect = () => rectFor(80, 70);
    (user2 as HTMLElement).getBoundingClientRect = () => rectFor(220, 40);
    (assistant2 as HTMLElement).getBoundingClientRect = () => rectFor(380, 80);
    (firstAssistantTurn as HTMLElement).getBoundingClientRect = () =>
      rectFor(80, 70);
    (lastAssistantTurn as HTMLElement).getBoundingClientRect = () =>
      rectFor(380, 80);

    fireEvent.wheel(container, { deltaY: -120 });
    fireEvent.scroll(container);

    await waitFor(() => {
      expect(onTranscriptPositionTimestampChange).toHaveBeenLastCalledWith(
        new Date(assistantEnd).getTime(),
      );
    });
  });

  it("uses the middle visible row when no turn end is visible", async () => {
    const onTranscriptPositionTimestampChange = vi.fn();
    const assistantMiddle = "2026-04-26T12:05:00.000Z";
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "long request", "2026-04-26T12:00:00.000Z"),
          assistantMessage("assistant-1", "long response", assistantMiddle),
        ]}
        onTranscriptPositionTimestampChange={
          onTranscriptPositionTimestampChange
        }
      />,
    );

    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 240,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 300,
    });
    container.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 300,
        height: 300,
        left: 0,
        right: 400,
        width: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 400,
        width: 400,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;

    const user1 = container.querySelector<HTMLElement>(
      '[data-render-id="user-1"]',
    );
    const assistant1 = container.querySelector<HTMLElement>(
      '[data-render-id="assistant-1"]',
    );
    const assistantTurn =
      container.querySelector<HTMLElement>(".assistant-turn");
    expect(user1).toBeTruthy();
    expect(assistant1).toBeTruthy();
    expect(assistantTurn).toBeTruthy();
    (user1 as HTMLElement).getBoundingClientRect = () => rectFor(-120, 40);
    (assistant1 as HTMLElement).getBoundingClientRect = () => rectFor(-80, 520);
    (assistantTurn as HTMLElement).getBoundingClientRect = () =>
      rectFor(-80, 520);

    fireEvent.wheel(container, { deltaY: -120 });
    fireEvent.scroll(container);

    await waitFor(() => {
      expect(onTranscriptPositionTimestampChange).toHaveBeenLastCalledWith(
        new Date(assistantMiddle).getTime(),
      );
    });
  });

  it("captures neighbor and timestamp context with scroll anchors", async () => {
    const onScrollSnapshotChange = vi.fn();
    const assistantTimestamp = "2026-04-26T12:01:00.000Z";
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "previous request", "2026-04-26T12:00:00.000Z"),
          assistantMessage(
            "assistant-1",
            "visible response",
            assistantTimestamp,
          ),
          userMessage("user-2", "next request", "2026-04-26T12:02:00.000Z"),
        ]}
        onScrollSnapshotChange={onScrollSnapshotChange}
      />,
    );

    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 120,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 300,
    });
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 400,
        width: 400,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    container.getBoundingClientRect = () => rectFor(0, 300);

    const user1 = container.querySelector<HTMLElement>(
      '[data-render-id="user-1"]',
    );
    const assistant1 = container.querySelector<HTMLElement>(
      '[data-render-id="assistant-1"]',
    );
    const user2 = container.querySelector<HTMLElement>(
      '[data-render-id="user-2"]',
    );
    expect(user1).toBeTruthy();
    expect(assistant1).toBeTruthy();
    expect(user2).toBeTruthy();
    (user1 as HTMLElement).getBoundingClientRect = () => rectFor(-120, 40);
    (assistant1 as HTMLElement).getBoundingClientRect = () => rectFor(40, 80);
    (user2 as HTMLElement).getBoundingClientRect = () => rectFor(360, 40);

    fireEvent.wheel(container, { deltaY: -120 });
    fireEvent.scroll(container);

    await waitFor(() => {
      expect(onScrollSnapshotChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          atBottom: false,
          scrollTop: 120,
          anchor: {
            id: "assistant-1",
            topOffset: 40,
            previousId: "user-1",
            nextId: "user-2",
            timestampMs: new Date(assistantTimestamp).getTime(),
          },
        }),
      );
    });
  });

  it("keeps catching up after Follow while output grows", async () => {
    const composerTarget = document.createElement("div");
    composerTarget.className = "session-input-inner";
    document.body.append(composerTarget);

    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request"),
          assistantMessage("assistant-1", "current response"),
        ]}
      />,
    );
    let scrollHeight = 1000;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 200,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      container.scrollTop = Number(options.top ?? 0);
    });
    container.scrollTo = scrollTo as typeof container.scrollTo;

    fireEvent.wheel(container, { deltaY: -120 });
    const followButton = await screen.findByRole("button", {
      name: "Follow latest session output",
    });
    vi.useFakeTimers();
    fireEvent.click(followButton);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(500);

    scrollHeight = 1400;
    act(() => {
      vi.advanceTimersByTime(120);
    });

    expect(scrollTo).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(900);
    composerTarget.remove();
  });

  it("keeps following visible thinking after a user send", () => {
    let resizeCallback: ResizeObserverCallback | null = null;
    class CapturingResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      disconnect() {}
    }
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: CapturingResizeObserver,
    });

    const firstThought = codexThinkingMessage(
      "thinking-1",
      "Initial visible thought",
      "2026-08-10T03:04:40.000Z",
      true,
    );
    const confirmedSteer = userMessage("steer-1", "Clarify the diff scope");
    const { container, rerender } = render(
      <MessageList provider="codex" isProcessing={true} messages={[]} />,
    );
    let scrollHeight = 1000;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 500,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });
    container.scrollTo = vi.fn((options: ScrollToOptions) => {
      container.scrollTop = Number(options.top ?? 0);
    }) as typeof container.scrollTo;

    rerender(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[firstThought]}
      />,
    );
    fireEvent.wheel(container, { deltaY: -120 });
    rerender(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[firstThought, confirmedSteer]}
        scrollTrigger={1}
      />,
    );
    expect(container.scrollTop).toBe(500);

    scrollHeight = 1400;
    rerender(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "Initial visible thought\nReasoning after the accepted steer",
            "2026-08-10T03:04:40.000Z",
            true,
          ),
          confirmedSteer,
        ]}
        scrollTrigger={1}
      />,
    );
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });

    expect(container.scrollTop).toBe(900);
  });

  it("does not follow visible thinking deltas until Follow is clicked", async () => {
    const composerTarget = document.createElement("div");
    composerTarget.className = "session-input-inner";
    document.body.append(composerTarget);

    let resizeCallback: ResizeObserverCallback | null = null;
    class CapturingResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      disconnect() {}
    }
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: CapturingResizeObserver,
    });

    const { container, rerender } = render(
      <MessageList provider="codex" isProcessing={true} messages={[]} />,
    );
    let scrollHeight = 1000;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 500,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });
    container.scrollTo = vi.fn((options: ScrollToOptions) => {
      container.scrollTop = Number(options.top ?? 0);
    }) as typeof container.scrollTo;

    rerender(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "Initial visible thought",
            "2026-04-25T00:00:00.000Z",
            true,
          ),
        ]}
      />,
    );

    scrollHeight = 1400;
    rerender(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "Initial visible thought\nA longer visible thinking delta",
            "2026-04-25T00:00:00.000Z",
            true,
          ),
        ]}
      />,
    );
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });

    expect(container.scrollTop).toBe(500);
    const followButton = await screen.findByRole("button", {
      name: "Follow latest session output",
    });

    fireEvent.click(followButton);
    expect(container.scrollTop).toBe(900);

    scrollHeight = 1600;
    rerender(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[
          codexThinkingMessage(
            "thinking-1",
            [
              "Initial visible thought",
              "A longer visible thinking delta",
              "Another visible thinking delta after Follow",
            ].join("\n"),
            "2026-04-25T00:00:00.000Z",
            true,
          ),
        ]}
      />,
    );
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });

    expect(container.scrollTop).toBe(1100);
    composerTarget.remove();
  });

  it("re-pins an active follower to the new bottom when content shrinks", async () => {
    const composerTarget = document.createElement("div");
    composerTarget.className = "session-input-inner";
    document.body.append(composerTarget);

    let resizeCallback: ResizeObserverCallback | null = null;
    class CapturingResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      disconnect() {}
    }
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: CapturingResizeObserver,
    });

    const { container, rerender } = render(
      <MessageList provider="codex" isProcessing={true} messages={[]} />,
    );
    let scrollHeight = 1000;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 500,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });
    container.scrollTo = vi.fn((options: ScrollToOptions) => {
      container.scrollTop = Number(options.top ?? 0);
    }) as typeof container.scrollTo;

    rerender(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "Initial visible thought",
            "2026-04-25T00:00:00.000Z",
            true,
          ),
        ]}
      />,
    );

    // Grow while not following, which surfaces the Follow control.
    scrollHeight = 1400;
    rerender(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "Initial visible thought\nA longer visible thinking delta",
            "2026-04-25T00:00:00.000Z",
            true,
          ),
        ]}
      />,
    );
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });
    expect(container.scrollTop).toBe(500);

    // Opt into follow, setting shouldAutoScroll.
    const followButton = await screen.findByRole("button", {
      name: "Follow latest session output",
    });
    fireEvent.click(followButton);
    expect(container.scrollTop).toBe(900); // 1400 - 500

    // Turn completes: the bounded thinking preview and recent-activity rows
    // collapse out of the flow, so total content height shrinks. An active
    // follower must ride down to the new bottom, not be stranded above it.
    scrollHeight = 1100;
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });

    expect(container.scrollTop).toBe(600); // 1100 - 500
    composerTarget.remove();
  });

  it("re-pins to the new bottom on turn completion while following", () => {
    const { container, rerender } = render(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[
          userMessage("user-1", "go"),
          assistantMessage("assistant-1", "working"),
        ]}
      />,
    );
    let scrollHeight = 1000;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 500,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });

    // Establish an active follow at the bottom.
    fireEvent.scroll(container);

    // Turn completes: the thinking preview and activity rows collapse out of
    // the flow, shrinking total height. The completion-boundary layout effect
    // must re-pin an active follower to the new bottom before a clamp-fired
    // scroll event can read the shrink as a scroll-away.
    scrollHeight = 700;
    rerender(
      <MessageList
        provider="codex"
        isProcessing={false}
        messages={[
          userMessage("user-1", "go"),
          assistantMessage("assistant-1", "done"),
        ]}
      />,
    );

    expect(container.scrollTop).toBe(200); // 700 - 500
  });

  it("lets a user wheel away cancel live follow before resize catch-up", () => {
    let resizeCallback: ResizeObserverCallback | null = null;
    class CapturingResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      disconnect() {}
    }
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: CapturingResizeObserver,
    });

    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request"),
          assistantMessage("assistant-1", "current response"),
        ]}
      />,
    );
    let scrollHeight = 1000;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 200,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });
    container.scrollTo = vi.fn() as typeof container.scrollTo;

    fireEvent.wheel(container, { deltaY: -120 });
    container.scrollTop = 320;
    scrollHeight = 1400;
    expect(resizeCallback).not.toBeNull();
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });

    expect(container.scrollTop).toBe(320);
  });

  it("ignores unanchored top snapshots on initial restore", () => {
    const scrollContainer = document.createElement("div");
    document.body.append(scrollContainer);
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 500,
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request"),
          assistantMessage("assistant-1", "current response"),
        ]}
        initialScrollSnapshot={{
          atBottom: false,
          scrollTop: 0,
          scrollHeight: 48,
          clientHeight: 500,
          updatedAtMs: Date.now(),
        }}
      />,
      { container: scrollContainer },
    );

    expect(scrollContainer.scrollTop).toBe(500);
  });

  it("ignores anchored top snapshots on initial restore", () => {
    const scrollContainer = document.createElement("div");
    document.body.append(scrollContainer);
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 500,
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request"),
          assistantMessage("assistant-1", "current response"),
        ]}
        initialScrollSnapshot={{
          atBottom: false,
          scrollTop: 0,
          scrollHeight: 1000,
          clientHeight: 500,
          anchor: { id: "user-1", topOffset: 0 },
          updatedAtMs: Date.now(),
        }}
      />,
      { container: scrollContainer },
    );

    expect(scrollContainer.scrollTop).toBe(500);
  });

  it("keeps live-tail bottom restore even when the snapshot has an anchor", () => {
    const scrollContainer = document.createElement("div");
    document.body.append(scrollContainer);
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 100,
      writable: true,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 500,
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request"),
          assistantMessage("assistant-1", "current response"),
        ]}
        initialScrollSnapshot={{
          atBottom: true,
          scrollTop: 100,
          scrollHeight: 1000,
          clientHeight: 500,
          anchor: { id: "user-1", topOffset: 20 },
          updatedAtMs: Date.now(),
        }}
      />,
      { container: scrollContainer },
    );

    expect(scrollContainer.scrollTop).toBe(500);
  });

  it("restores an at-bottom anchor in remember-place mode", () => {
    const scrollContainer = document.createElement("div");
    document.body.append(scrollContainer);
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 100,
      writable: true,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 500,
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        left: 0,
        right: 360,
        width: 360,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function getRect(this: HTMLElement) {
        if (this === scrollContainer) {
          return rectFor(0, 500);
        }
        if (this.dataset.renderId === "user-1") {
          return rectFor(120, 40);
        }
        return rectFor(0, 40);
      });

    try {
      render(
        <MessageList
          messages={[
            userMessage("user-1", "earlier request"),
            assistantMessage("assistant-1", "current response"),
          ]}
          initialScrollSnapshot={{
            atBottom: true,
            scrollTop: 100,
            scrollHeight: 1000,
            clientHeight: 500,
            anchor: { id: "user-1", topOffset: 20 },
            updatedAtMs: Date.now(),
          }}
          scrollBehaviorMode="remember-place"
        />,
        { container: scrollContainer },
      );
    } finally {
      rectSpy.mockRestore();
    }

    expect(scrollContainer.scrollTop).toBe(200);
  });

  it("falls back to a neighboring row when a remembered anchor is gone", () => {
    const scrollContainer = document.createElement("div");
    document.body.append(scrollContainer);
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 100,
      writable: true,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 500,
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        left: 0,
        right: 360,
        width: 360,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function getRect(this: HTMLElement) {
        if (this === scrollContainer) {
          return rectFor(0, 500);
        }
        if (this.dataset.renderId === "user-1") {
          return rectFor(160, 40);
        }
        return rectFor(0, 40);
      });

    try {
      render(
        <MessageList
          messages={[
            userMessage("user-1", "surviving request"),
            assistantMessage("assistant-1", "surviving response"),
          ]}
          initialScrollSnapshot={{
            atBottom: false,
            scrollTop: 100,
            scrollHeight: 1000,
            clientHeight: 500,
            anchor: {
              id: "deleted-row",
              topOffset: 20,
              previousId: "user-1",
            },
            updatedAtMs: Date.now(),
          }}
          scrollBehaviorMode="remember-place"
        />,
        { container: scrollContainer },
      );
    } finally {
      rectSpy.mockRestore();
    }

    expect(scrollContainer.scrollTop).toBe(240);
  });

  it("falls back to the nearest timestamped row when an anchor is gone", () => {
    const scrollContainer = document.createElement("div");
    document.body.append(scrollContainer);
    const assistantTimestamp = "2026-04-26T12:01:00.000Z";
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 100,
      writable: true,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 500,
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        left: 0,
        right: 360,
        width: 360,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function getRect(this: HTMLElement) {
        if (this === scrollContainer) {
          return rectFor(0, 500);
        }
        if (this.dataset.renderId === "assistant-1") {
          return rectFor(260, 80);
        }
        return rectFor(0, 40);
      });

    try {
      render(
        <MessageList
          messages={[
            userMessage(
              "user-1",
              "surviving request",
              "2026-04-26T12:00:00.000Z",
            ),
            assistantMessage(
              "assistant-1",
              "surviving response",
              assistantTimestamp,
            ),
          ]}
          initialScrollSnapshot={{
            atBottom: false,
            scrollTop: 100,
            scrollHeight: 1000,
            clientHeight: 500,
            anchor: {
              id: "deleted-row",
              topOffset: 30,
              timestampMs: new Date(assistantTimestamp).getTime(),
            },
            updatedAtMs: Date.now(),
          }}
          scrollBehaviorMode="remember-place"
        />,
        { container: scrollContainer },
      );
    } finally {
      rectSpy.mockRestore();
    }

    expect(scrollContainer.scrollTop).toBe(330);
  });

  it("waits for a remember-place anchor to mount during progressive restore", () => {
    vi.useFakeTimers();
    const scrollContainer = document.createElement("div");
    document.body.append(scrollContainer);
    const messages = Array.from({ length: 150 }, (_, index) => {
      const turn = index + 1;
      return [
        userMessage(`user-${turn}`, `request ${turn}`),
        assistantMessage(`assistant-${turn}`, `response ${turn}`),
      ];
    }).flat();
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 1600,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 500,
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        left: 0,
        right: 360,
        width: 360,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function getRect(this: HTMLElement) {
        if (this === scrollContainer) {
          return rectFor(0, 500);
        }
        if (this.dataset.renderId === "user-1") {
          return rectFor(240, 40);
        }
        return rectFor(900, 80);
      });

    try {
      render(
        <MessageList
          messages={messages}
          progressiveRenderEnabled
          progressiveRenderKey="remember-place-progressive"
          initialScrollSnapshot={{
            atBottom: true,
            scrollTop: 100,
            scrollHeight: 1000,
            clientHeight: 500,
            anchor: { id: "user-1", topOffset: 20 },
            updatedAtMs: Date.now(),
          }}
          scrollBehaviorMode="remember-place"
        />,
        { container: scrollContainer },
      );

      expect(
        scrollContainer.querySelector('[data-render-id="user-1"]'),
      ).toBeNull();
      expect(scrollContainer.scrollTop).toBe(0);

      for (let index = 0; index < 6; index += 1) {
        act(() => {
          vi.advanceTimersByTime(40);
        });
      }
      act(() => {
        vi.advanceTimersByTime(220);
      });

      expect(
        scrollContainer.querySelector('[data-render-id="user-1"]'),
      ).toBeTruthy();
      expect(scrollContainer.scrollTop).toBe(220);
      expect(screen.getByText("New output below")).toBeTruthy();

      fireEvent.click(
        screen.getByRole("button", {
          name: "Jump to latest session output",
        }),
      );

      expect(scrollContainer.scrollTop).toBe(1100);
      expect(screen.queryByText("New output below")).toBeNull();
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("keeps following the tail when progressive restore reveals rows", () => {
    vi.useFakeTimers();
    const scrollContainer = document.createElement("div");
    document.body.append(scrollContainer);
    let scrollHeight = 500;
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 500,
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    render(
      <MessageList
        messages={[
          userMessage("user-1", "cached request"),
          assistantMessage("assistant-1", "cached response"),
        ]}
        progressiveRenderEnabled
        progressiveRenderKey="cached-session"
      />,
      { container: scrollContainer },
    );

    expect(
      scrollContainer.querySelector(".message-list-progressive-hydrating"),
    ).toBeTruthy();

    scrollHeight = 1400;
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(scrollContainer.scrollTop).toBe(900);
  });

  it("catches up a parked transcript on reveal while following latest", () => {
    const scrollContainer = document.createElement("div");
    document.body.append(scrollContainer);
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 500,
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    const { rerender } = render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request"),
          assistantMessage("assistant-1", "current response"),
        ]}
        inert
      />,
      { container: scrollContainer },
    );
    scrollContainer.scrollTop = 0;

    rerender(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request"),
          assistantMessage("assistant-1", "current response"),
        ]}
      />,
    );

    expect(scrollContainer.scrollTop).toBe(500);
  });

  it("ignores parked scroll events before tail-follow reveal", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    const scrollContainer = document.createElement("div");
    document.body.append(scrollContainer);
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 500,
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    const messages = [
      userMessage("user-1", "earlier request"),
      assistantMessage("assistant-1", "current response"),
    ];
    const { rerender } = render(<MessageList messages={messages} />, {
      container: scrollContainer,
    });
    expect(scrollContainer.scrollTop).toBe(500);

    rerender(<MessageList messages={messages} inert />);
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        left: 0,
        right: 360,
        width: 360,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    scrollContainer.getBoundingClientRect = () => rectFor(0, 500);
    const content = scrollContainer.querySelector(".message-list");
    const lastLine = content?.lastElementChild;
    expect(lastLine).toBeInstanceOf(HTMLElement);
    (lastLine as HTMLElement).getBoundingClientRect = () => rectFor(900, 100);
    scrollContainer.scrollTop = 0;
    fireEvent.scroll(scrollContainer);

    rerender(<MessageList messages={messages} />);

    expect(scrollContainer.scrollTop).toBe(500);
  });

  it("preserves a parked transcript read position on reveal", () => {
    const scrollContainer = document.createElement("div");
    document.body.append(scrollContainer);
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 500,
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    const messages = [
      userMessage("user-1", "earlier request"),
      assistantMessage("assistant-1", "current response"),
    ];
    const { rerender } = render(<MessageList messages={messages} />, {
      container: scrollContainer,
    });

    scrollContainer.scrollTop = 200;
    fireEvent.wheel(scrollContainer, { deltaY: -120 });

    rerender(<MessageList messages={messages} inert />);
    expect(scrollContainer.scrollTop).toBe(200);

    rerender(<MessageList messages={messages} />);
    expect(scrollContainer.scrollTop).toBe(200);
  });
});
