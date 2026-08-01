import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessingIndicator } from "../ProcessingIndicator";

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        processingThinkingTranscriptHide:
          "Hide thinking transcript rows (display only; the agent keeps working)",
        processingThinkingTranscriptShowHidden:
          "Show hidden thinking transcript rows",
        processingThinkingTranscriptShowWhenAvailable:
          "Show thinking transcript rows when available",
        processingThinkingRightClickShowExpandAll:
          "Right-click: show thinking and expand all blocks",
        processingThinkingRightClickExpandAll:
          "Right-click: expand all thinking blocks, including earlier ones",
        processingThinkingRightClickLatestOnly:
          "Right-click: auto-expand only the latest thinking block",
      })[key] ?? key,
  }),
}));

describe("ProcessingIndicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Mock localStorage for useFunPhrases hook - disable fun phrases for predictable tests
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue("false"),
      setItem: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders nothing when not processing", () => {
    const { container } = render(<ProcessingIndicator isProcessing={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders dot and cursor when processing", () => {
    render(<ProcessingIndicator isProcessing={true} />);

    const cursor = document.querySelector(".processing-cursor");
    expect(cursor).not.toBeNull();
    expect(cursor?.textContent).toBe("|");

    const dotContainer = document.querySelector(".processing-dot-container");
    expect(dotContainer?.firstElementChild?.firstElementChild).not.toBeNull();
  });

  it("types text progressively over time", async () => {
    render(<ProcessingIndicator isProcessing={true} />);

    const textElement = document.querySelector(".processing-text");

    // Initially just cursor
    expect(textElement?.textContent).toBe("|");

    // Advance enough time to type several characters (500ms = 20 chars worth)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    // Should have typed some text (starts with T from "Thinking...")
    const content = textElement?.textContent ?? "";
    expect(content).toMatch(/^T/); // Starts with T
    expect(content.length).toBeGreaterThan(1); // Has typed something
  });

  it("has processing indicator container", () => {
    render(<ProcessingIndicator isProcessing={true} />);

    const container = document.querySelector(".processing-indicator");
    expect(container).not.toBeNull();

    const dotContainer = document.querySelector(".processing-dot-container");
    expect(dotContainer).not.toBeNull();
  });

  it("can expose a compact thinking transcript visibility toggle", () => {
    const onToggle = vi.fn();
    render(
      <ProcessingIndicator
        isProcessing={false}
        hasThinkingItems={true}
        thinkingItemsVisible={false}
        onToggleThinkingItemsVisible={onToggle}
      />,
    );

    const button = screen.getByRole("button", {
      name: "Show hidden thinking transcript rows",
    });
    expect(button.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(button);

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("right-clicking the toggle flips the auto-expand policy, not visibility", () => {
    const onToggleVisible = vi.fn();
    const onToggleLatestOnly = vi.fn();
    render(
      <ProcessingIndicator
        isProcessing={false}
        hasThinkingItems={true}
        thinkingItemsVisible={true}
        onToggleThinkingItemsVisible={onToggleVisible}
        onToggleThinkingLatestOnly={onToggleLatestOnly}
      />,
    );

    const button = screen.getByRole("button");
    fireEvent.contextMenu(button);

    expect(onToggleLatestOnly).toHaveBeenCalledTimes(1);
    expect(onToggleVisible).not.toHaveBeenCalled();
  });

  it("marks the toggle and hints that right-click expands history in latest-only mode", () => {
    render(
      <ProcessingIndicator
        isProcessing={false}
        hasThinkingItems={true}
        thinkingItemsVisible={true}
        thinkingLatestOnly={true}
        onToggleThinkingItemsVisible={vi.fn()}
        onToggleThinkingLatestOnly={vi.fn()}
      />,
    );

    const button = screen.getByRole("button");
    expect(button.classList.contains("is-latest-only")).toBe(true);
    expect(button.getAttribute("title")).toContain(
      "expand all thinking blocks, including earlier ones",
    );
    // The accessible name stays the clean click action.
    expect(button.getAttribute("aria-label")).toBe(
      "Hide thinking transcript rows (display only; the agent keeps working)",
    );
  });

  it("hints that right-click drops back to latest-only when everything expands", () => {
    render(
      <ProcessingIndicator
        isProcessing={false}
        hasThinkingItems={true}
        thinkingItemsVisible={true}
        thinkingLatestOnly={false}
        onToggleThinkingItemsVisible={vi.fn()}
        onToggleThinkingLatestOnly={vi.fn()}
      />,
    );

    expect(screen.getByRole("button").getAttribute("title")).toContain(
      "auto-expand only the latest thinking block",
    );
  });

  it("right-click works from the hidden state and the hint says it reveals", () => {
    const onToggleLatestOnly = vi.fn();
    render(
      <ProcessingIndicator
        isProcessing={false}
        hasThinkingItems={true}
        thinkingItemsVisible={false}
        onToggleThinkingItemsVisible={vi.fn()}
        onToggleThinkingLatestOnly={onToggleLatestOnly}
      />,
    );

    const button = screen.getByRole("button");
    expect(button.getAttribute("title")).toContain(
      "show thinking and expand all blocks",
    );

    fireEvent.contextMenu(button);
    expect(onToggleLatestOnly).toHaveBeenCalledTimes(1);
  });

  it("long-press toggles policy and suppresses the follow-up click", () => {
    const onToggleVisible = vi.fn();
    const onToggleLatestOnly = vi.fn();
    render(
      <ProcessingIndicator
        isProcessing={false}
        hasThinkingItems={true}
        thinkingItemsVisible={true}
        onToggleThinkingItemsVisible={onToggleVisible}
        onToggleThinkingLatestOnly={onToggleLatestOnly}
      />,
    );

    const button = screen.getByRole("button");
    fireEvent.touchStart(button);
    act(() => {
      vi.advanceTimersByTime(450);
    });
    fireEvent.touchEnd(button);
    fireEvent.click(button);

    expect(onToggleLatestOnly).toHaveBeenCalledTimes(1);
    expect(onToggleVisible).not.toHaveBeenCalled();
  });

  it("hides when processing stops", async () => {
    const { rerender } = render(<ProcessingIndicator isProcessing={true} />);

    // Verify it's visible
    expect(document.querySelector(".processing-indicator")).not.toBeNull();

    // Stop processing
    rerender(<ProcessingIndicator isProcessing={false} />);

    // Should render nothing
    expect(document.querySelector(".processing-indicator")).toBeNull();
  });

  it("restarts when re-enabled after stopping", async () => {
    const { rerender } = render(<ProcessingIndicator isProcessing={true} />);

    // Advance some time
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    // Stop processing
    rerender(<ProcessingIndicator isProcessing={false} />);
    expect(document.querySelector(".processing-indicator")).toBeNull();

    // Start processing again
    rerender(<ProcessingIndicator isProcessing={true} />);

    // Should be visible again with cursor
    expect(document.querySelector(".processing-indicator")).not.toBeNull();
    expect(document.querySelector(".processing-cursor")).not.toBeNull();
  });
});
