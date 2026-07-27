// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { useQuoteableTextSource } from "../../hooks/useQuoteableTextSource";
import {
  installMessageListTestEnvironment,
  SessionTranscriptHarness,
  assistantMessage,
  dispatchCopyEvent,
  mockPointerCoarse,
  recapMessage,
  userMessage,
} from "./MessageList.test-support";
import { MessageList } from "../MessageList";
import { Modal } from "../ui/Modal";

installMessageListTestEnvironment();

function QuoteableModal() {
  const textRef = useQuoteableTextSource<HTMLParagraphElement>(
    "Modal selected text",
  );
  return (
    <Modal title="Expanded edit" onClose={() => {}}>
      <p ref={textRef}>Modal selected text</p>
    </Modal>
  );
}

describe("MessageList selection and copy", () => {
  it("copies rendered assistant selections as source markdown", () => {
    render(
      <MessageList
        messages={[
          assistantMessage("assistant-1", "1. First item\n1. Second item"),
        ]}
        markdownAugments={{
          "assistant-1": {
            html: "<ol><li>First item</li><li>Second item</li></ol>",
          },
        }}
      />,
    );

    const secondItem = screen.getByText("Second item");
    const textNode = secondItem.firstChild;
    expect(textNode).toBeTruthy();
    const range = document.createRange();
    range.setStart(textNode as Node, 0);
    range.setEnd(textNode as Node, secondItem.textContent?.length ?? 0);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const { event, setData } = dispatchCopyEvent();

    expect(event.defaultPrevented).toBe(true);
    expect(setData).toHaveBeenCalledWith("text/plain", "1. Second item");
  });

  it("preserves old rendered assistant DOM when later messages append", () => {
    const first = assistantMessage(
      "assistant-1",
      "1. First item\n1. Second item",
      "2026-04-25T00:00:00.000Z",
    );
    const { rerender } = render(
      <SessionTranscriptHarness messages={[first]} />,
    );

    const selectedElement = screen.getByText("Second item");
    const selectedTextNode = selectedElement.firstChild;
    expect(selectedTextNode).toBeTruthy();
    const codeBlock = document.querySelector(
      ".code-block",
    ) as HTMLElement | null;
    expect(codeBlock).toBeTruthy();
    if (codeBlock) {
      codeBlock.scrollLeft = 73;
    }

    const range = document.createRange();
    range.setStart(selectedTextNode as Node, 0);
    range.setEnd(selectedTextNode as Node, "Second item".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    rerender(
      <SessionTranscriptHarness
        messages={[
          first,
          assistantMessage(
            "assistant-2",
            "new complete response",
            "2026-04-25T00:01:00.000Z",
          ),
        ]}
      />,
    );

    const nextSelectedElement = screen.getByText("Second item");
    const nextCodeBlock = document.querySelector(
      ".code-block",
    ) as HTMLElement | null;

    expect(nextSelectedElement).toBe(selectedElement);
    expect(selectedTextNode?.isConnected).toBe(true);
    expect(window.getSelection()?.toString()).toBe("Second item");
    expect(nextCodeBlock).toBe(codeBlock);
    expect(codeBlock?.isConnected).toBe(true);
    expect(nextCodeBlock?.scrollLeft).toBe(73);
  });

  it("copies mixed turn selections as separate source snippets", () => {
    render(
      <MessageList
        messages={[
          userMessage("user-1", "user selected text"),
          assistantMessage("assistant-1", "assistant selected text"),
        ]}
      />,
    );

    const userText = screen.getByText("user selected text").firstChild;
    const assistantText = screen.getByText(
      "assistant selected text",
    ).firstChild;
    expect(userText).toBeTruthy();
    expect(assistantText).toBeTruthy();

    const range = document.createRange();
    range.setStart(userText as Node, 0);
    range.setEnd(assistantText as Node, "assistant selected text".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const { event, setData } = dispatchCopyEvent();

    expect(event.defaultPrevented).toBe(true);
    expect(setData).toHaveBeenCalledWith(
      "text/plain",
      "user selected text\n\nassistant selected text",
    );
  });

  it("shields session chrome while transcript text is selected", () => {
    mockPointerCoarse(true);

    const activeClass = "session-transcript-selection-active";
    const { container, unmount } = render(
      <div className="session-page">
        <MessageList
          messages={[assistantMessage("assistant-1", "selected assistant text")]}
        />
      </div>,
    );
    const shell = container.querySelector(".session-page");
    const selectedText = screen.getByText("selected assistant text").firstChild;
    expect(shell).toBeInstanceOf(HTMLElement);
    expect(selectedText).toBeTruthy();

    const range = document.createRange();
    range.setStart(selectedText as Node, 0);
    range.setEnd(selectedText as Node, "selected assistant text".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect((shell as HTMLElement).classList.contains(activeClass)).toBe(true);
    expect(document.body.classList.contains(activeClass)).toBe(true);

    selection?.removeAllRanges();
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect((shell as HTMLElement).classList.contains(activeClass)).toBe(false);
    expect(document.body.classList.contains(activeClass)).toBe(false);

    selection?.addRange(range);
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect((shell as HTMLElement).classList.contains(activeClass)).toBe(true);

    unmount();

    expect((shell as HTMLElement).classList.contains(activeClass)).toBe(false);
    expect(document.body.classList.contains(activeClass)).toBe(false);
  });

  it("does not shield session chrome for desktop pointer selection", () => {
    mockPointerCoarse(false);

    const activeClass = "session-transcript-selection-active";
    const { container } = render(
      <div className="session-page">
        <MessageList
          messages={[assistantMessage("assistant-1", "desktop selected text")]}
        />
      </div>,
    );
    const shell = container.querySelector(".session-page");
    const selectedText = screen.getByText("desktop selected text").firstChild;
    expect(shell).toBeInstanceOf(HTMLElement);
    expect(selectedText).toBeTruthy();

    const range = document.createRange();
    range.setStart(selectedText as Node, 0);
    range.setEnd(selectedText as Node, "desktop selected text".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect((shell as HTMLElement).classList.contains(activeClass)).toBe(false);
    expect(document.body.classList.contains(activeClass)).toBe(false);
  });

  it("quotes recap selections through the reply pipeline", () => {
    const onQuoteSelection = vi.fn(() => "> Recap selected text\nx");

    render(
      <MessageList
        messages={[recapMessage("recap-1", "Recap selected text")]}
        onQuoteSelection={onQuoteSelection}
      />,
    );

    const recapText = screen.getByText("Recap selected text").firstChild;
    expect(recapText).toBeTruthy();
    const range = document.createRange();
    range.setStart(recapText as Node, 0);
    range.setEnd(recapText as Node, "Recap selected text".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.keyDown(window, { key: "x" });

    expect(onQuoteSelection).toHaveBeenCalledWith("> Recap selected text\nx");
  });

  it("keeps the selected-text quote button inside the transcript on desktop", async () => {
    mockPointerCoarse(false);
    const onQuoteSelection = vi.fn(() => "> Desktop selected text\n");

    render(
      <MessageList
        messages={[assistantMessage("assistant-1", "Desktop selected text")]}
        onQuoteSelection={onQuoteSelection}
      />,
    );

    const selectedElement = screen.getByText("Desktop selected text");
    const selectedText = selectedElement.firstChild;
    expect(selectedText).toBeTruthy();

    const range = document.createRange();
    range.setStart(selectedText as Node, 0);
    range.setEnd(selectedText as Node, "Desktop selected text".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.pointerDown(selectedElement, { clientY: 120 });
    fireEvent.pointerUp(selectedElement, { clientX: 180, clientY: 120 });

    const quoteButton = await screen.findByRole("button", {
      name: "Quote selection",
    });
    expect(quoteButton.closest(".message-list")).toBeTruthy();
    expect(
      quoteButton.classList.contains("selection-quote-button--mobile"),
    ).toBe(false);

    fireEvent.click(quoteButton);

    expect(onQuoteSelection).toHaveBeenCalledWith("> Desktop selected text\n");
  });

  it("quotes registered text from a portaled modal into the active session", async () => {
    mockPointerCoarse(false);
    const onQuoteSelection = vi.fn(() => "> Modal selected text\n");

    render(
      <>
        <MessageList
          messages={[assistantMessage("assistant-1", "Transcript text")]}
          onQuoteSelection={onQuoteSelection}
        />
        <QuoteableModal />
      </>,
    );

    const selectedElement = screen.getByText("Modal selected text");
    const selectedText = selectedElement.firstChild;
    expect(selectedText).toBeTruthy();

    const range = document.createRange();
    range.setStart(selectedText as Node, 0);
    range.setEnd(selectedText as Node, "Modal selected text".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.pointerDown(selectedElement, { clientY: 120 });
    fireEvent.pointerUp(selectedElement, { clientX: 180, clientY: 120 });

    const quoteButton = await screen.findByRole("button", {
      name: "Quote selection",
    });
    expect(quoteButton.closest(".modal")).toBeTruthy();
    expect(quoteButton.closest(".message-list")).toBeNull();

    fireEvent.click(quoteButton);

    expect(onQuoteSelection).toHaveBeenCalledWith("> Modal selected text\n");
  });

  it("moves the selected-text quote button to the composer edge on mobile", async () => {
    mockPointerCoarse(true);
    const onQuoteSelection = vi.fn(() => "> Mobile selected text\n");
    const inputTarget = document.createElement("div");
    inputTarget.className = "session-input-inner";
    document.body.appendChild(inputTarget);

    render(
      <MessageList
        messages={[assistantMessage("assistant-1", "Mobile selected text")]}
        onQuoteSelection={onQuoteSelection}
      />,
    );

    const selectedElement = screen.getByText("Mobile selected text");
    const selectedText = selectedElement.firstChild;
    expect(selectedText).toBeTruthy();

    const range = document.createRange();
    range.setStart(selectedText as Node, 0);
    range.setEnd(selectedText as Node, "Mobile selected text".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });

    const quoteButton = await screen.findByRole("button", {
      name: "Quote selection",
    });
    expect(inputTarget.contains(quoteButton)).toBe(true);
    expect(
      quoteButton.classList.contains("selection-quote-button--mobile"),
    ).toBe(true);
    expect(quoteButton.textContent).toContain("Quote");

    selection?.removeAllRanges();
    fireEvent.click(quoteButton);

    expect(onQuoteSelection).toHaveBeenCalledWith("> Mobile selected text\n");
  });
});
