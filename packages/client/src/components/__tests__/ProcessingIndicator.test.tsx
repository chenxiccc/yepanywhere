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
        processingAnimationPause: "Pause processing text animation",
        processingAnimationResume: "Resume processing text animation",
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

  it("renders the activity dot without a text cursor", () => {
    render(<ProcessingIndicator isProcessing={true} />);

    expect(document.querySelector(".processing-cursor")).toBeNull();
    expect(document.querySelector(".processing-text")?.textContent).toBe("");

    const dotContainer = document.querySelector(".processing-dot-container");
    expect(dotContainer?.firstElementChild?.firstElementChild).not.toBeNull();
  });

  it("types text progressively over time", async () => {
    render(<ProcessingIndicator isProcessing={true} />);

    const textElement = document.querySelector(".processing-text");

    expect(textElement?.textContent).toBe("");

    // Each state update schedules the next typewriter tick.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });
    expect(textElement?.textContent).toBe("T");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });
    expect(textElement?.textContent).toBe("Th");
  });

  it("pauses and resumes the typewriter when clicked", async () => {
    render(<ProcessingIndicator isProcessing={true} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    const toggle = screen.getByRole("button", {
      name: "Pause processing text animation",
    });
    const pausedText = toggle.textContent;
    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe(
      "Resume processing text animation",
    );
    expect(document.querySelector(".processing-cursor")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(toggle.textContent).toBe(pausedText);

    fireEvent.click(toggle);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });

    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.textContent).not.toBe(pausedText);
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

    // Should be visible again without reintroducing a cursor.
    expect(document.querySelector(".processing-indicator")).not.toBeNull();
    expect(document.querySelector(".processing-cursor")).toBeNull();
  });
});
