// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  assistantMessage,
  installMessageListTestEnvironment,
  userMessage,
} from "./MessageList.test-support";
import { MessageList } from "../MessageList";

installMessageListTestEnvironment();

describe("MessageList transcript render window", () => {
  it("keeps the original DOM path for a short transcript", () => {
    const messages = Array.from({ length: 20 }, (_, index) => [
      userMessage(`user-${index}`, `Request ${index}`),
      assistantMessage(`assistant-${index}`, `Answer ${index}`),
    ]).flat();
    const { container } = render(<MessageList messages={messages} />);

    expect(container.querySelectorAll("[data-render-id]")).toHaveLength(40);
    expect(
      container.querySelector("[data-transcript-render-boundary]"),
    ).toBeNull();
    expect(
      container.querySelector("[data-transcript-render-spacer]"),
    ).toBeNull();
  });

  it("bounds mounted history and wakes an offscreen requested turn", async () => {
    const messages = Array.from({ length: 130 }, (_, index) => [
      userMessage(`user-${index}`, `Request ${index}`),
      assistantMessage(`assistant-${index}`, `Answer ${index}`),
    ]).flat();
    const { container, rerender } = render(<MessageList messages={messages} />);

    expect(
      container.querySelector('[data-transcript-render-spacer="before"]'),
    ).not.toBeNull();
    expect(
      container.querySelectorAll("[data-render-id]").length,
    ).toBeLessThanOrEqual(48);
    expect(container.querySelector('[data-render-id="user-0"]')).toBeNull();

    rerender(
      <MessageList
        messages={messages}
        scrollToTurnRequest={{ id: "user-0", token: 1 }}
      />,
    );

    await waitFor(() => {
      expect(
        container.querySelector('[data-render-id="user-0"]'),
      ).not.toBeNull();
    });
    expect(
      container.querySelectorAll("[data-render-id]").length,
    ).toBeLessThanOrEqual(48);
    expect(
      container.querySelector('[data-transcript-render-spacer="after"]'),
    ).not.toBeNull();
  });

  it("retains a live quote anchor while waking a distant turn", async () => {
    const messages = Array.from({ length: 130 }, (_, index) => [
      userMessage(`user-${index}`, `Request ${index}`),
      assistantMessage(`assistant-${index}`, `Answer ${index}`),
    ]).flat();
    const onQuoteSelection = vi.fn((text: string) => text);
    const { container, rerender } = render(
      <MessageList messages={messages} onQuoteSelection={onQuoteSelection} />,
    );

    const quoteButtons = screen.getAllByRole("button", {
      name: "Quote this block",
    });
    fireEvent.click(quoteButtons[quoteButtons.length - 1] as HTMLElement);
    expect(onQuoteSelection).toHaveBeenCalled();

    rerender(
      <MessageList
        messages={messages}
        onQuoteSelection={onQuoteSelection}
        scrollToTurnRequest={{ id: "user-0", token: 1 }}
      />,
    );

    await waitFor(() => {
      expect(
        container.querySelector('[data-render-id="user-0"]'),
      ).not.toBeNull();
    });
    expect(
      container.querySelector('[data-render-id="assistant-129"]'),
    ).not.toBeNull();
    expect(
      container.querySelectorAll("[data-render-id]").length,
    ).toBeLessThanOrEqual(49);
  });
});
