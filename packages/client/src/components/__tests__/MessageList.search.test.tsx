// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  installMessageListTestEnvironment,
  assistantMessage,
  assistantToolUseMessage,
  systemMessage,
  userMessage,
} from "./MessageList.test-support";
import { MessageList } from "../MessageList";

installMessageListTestEnvironment();

function rect({
  top,
  height,
  right = 500,
  width = 400,
}: {
  top: number;
  height: number;
  right?: number;
  width?: number;
}): DOMRect {
  return {
    x: right - width,
    y: top,
    top,
    right,
    bottom: top + height,
    left: right - width,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function setReadonlyNumber(
  element: HTMLElement,
  key: "clientHeight" | "clientWidth" | "offsetWidth" | "scrollHeight",
  value: number,
) {
  Object.defineProperty(element, key, {
    configurable: true,
    value,
  });
}

function installSearchGeometry(rowOffsets: Record<string, number>) {
  const messageList = document.querySelector<HTMLElement>(".message-list");
  if (!messageList?.parentElement) {
    throw new Error("MessageList did not render a scroll container");
  }
  const scrollContainer = messageList.parentElement;
  let scrollTop = 0;
  const scrollTo = vi.fn(
    (optionsOrX?: ScrollToOptions | number, y?: number) => {
      scrollTop =
        typeof optionsOrX === "number"
          ? optionsOrX
          : Number(optionsOrX?.top ?? y ?? 0);
      scrollContainer.dispatchEvent(new Event("scroll"));
    },
  );

  Object.defineProperty(scrollContainer, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value) => {
      scrollTop = Number(value);
    },
  });
  setReadonlyNumber(scrollContainer, "scrollHeight", 1800);
  setReadonlyNumber(scrollContainer, "clientHeight", 200);
  setReadonlyNumber(scrollContainer, "clientWidth", 360);
  setReadonlyNumber(scrollContainer, "offsetWidth", 380);
  scrollContainer.getBoundingClientRect = () => rect({ top: 100, height: 200 });
  Object.defineProperty(scrollContainer, "scrollTo", {
    configurable: true,
    value: scrollTo,
  });

  for (const row of messageList.querySelectorAll<HTMLElement>(
    "[data-render-id]",
  )) {
    const renderId = row.dataset.renderId;
    const topOffset = renderId ? rowOffsets[renderId] : undefined;
    if (topOffset === undefined) {
      continue;
    }
    row.getBoundingClientRect = () =>
      rect({ top: 100 + topOffset - scrollTop, height: 24 });
  }

  return { scrollTo };
}

describe("MessageList reverse search", () => {
  it("opens reverse user-turn search with Ctrl+R and hides nonmatches", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    const composerTarget = document.createElement("div");
    composerTarget.className = "session-input-inner";
    document.body.append(composerTarget);

    render(
      <MessageList
        messages={[
          userMessage("user-1", "alpha setup request"),
          assistantMessage("assistant-1", "first response"),
          userMessage(
            "user-2",
            "please inspect the render latency regression in the client",
          ),
          assistantMessage("assistant-2", "second response"),
        ]}
      />,
    );

    const editableTarget = document.createElement("textarea");
    document.body.append(editableTarget);
    editableTarget.focus();
    fireEvent.keyDown(editableTarget, { key: "r", ctrlKey: true });

    const input = await screen.findByRole("textbox", {
      name: "Reverse search user turns",
    });
    expect(composerTarget.contains(input)).toBe(true);
    expect(screen.getByText("2+ chars")).toBeTruthy();

    fireEvent.change(input, { target: { value: "latency" } });

    expect(await screen.findByText("1/1")).toBeTruthy();
    expect(screen.queryByText("alpha setup request")).toBeNull();
    expect(screen.getByText(/render latency regression/)).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(document.activeElement).toBe(editableTarget);
    });
    editableTarget.remove();
    composerTarget.remove();
  });

  it("clears a selected search id when its trimmed turn disappears", async () => {
    const retained = userMessage("user-2", "retained searchable request");
    const rendered = render(
      <MessageList
        messages={[userMessage("user-1", "unique removed needle"), retained]}
        activeWindowTrimRevision={0}
      />,
    );

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    const input = await screen.findByRole("textbox", {
      name: "Reverse search user turns",
    });
    fireEvent.change(input, { target: { value: "needle" } });
    expect(await screen.findByText("1/1")).toBeTruthy();

    rendered.rerender(
      <MessageList messages={[retained]} activeWindowTrimRevision={1} />,
    );

    expect(await screen.findByText("0/0")).toBeTruthy();
    expect(screen.queryByText("unique removed needle")).toBeNull();
    expect(
      screen.getByRole("textbox", { name: "Reverse search user turns" }),
    ).toBe(input);
  });

  it("opens user-turn search with Ctrl+Alt+R fallback for one turn", async () => {
    render(
      <MessageList
        messages={[userMessage("user-1", "inspect Chrome shortcut handling")]}
      />,
    );

    fireEvent.keyDown(window, {
      key: "R",
      code: "KeyR",
      ctrlKey: true,
      altKey: true,
    });

    expect(
      await screen.findByRole("textbox", {
        name: "Reverse search user turns",
      }),
    ).toBeTruthy();
  });

  it("keeps reverse search active when focus moves outside its panel", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });

    render(
      <MessageList
        messages={[
          userMessage("user-1", "first searchable request"),
          userMessage("user-2", "second searchable request"),
        ]}
      />,
    );

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    const input = await screen.findByRole("textbox", {
      name: "Reverse search user turns",
    });
    const composer = document.createElement("textarea");
    document.body.append(composer);

    fireEvent.blur(input, { relatedTarget: composer });

    expect(
      screen.getByRole("textbox", { name: "Reverse search user turns" }),
    ).toBe(input);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: "Reverse search user turns" }),
      ).toBeNull();
    });
    composer.remove();
  });

  it("opens all-turn reverse search with Ctrl+S", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });

    render(
      <MessageList
        messages={[
          userMessage("user-1", "look at the first thing"),
          assistantMessage("assistant-1", "the assistant found needle text"),
          systemMessage("system-1", "system compacted needle context"),
        ]}
      />,
    );

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });

    const input = await screen.findByRole("textbox", {
      name: "Reverse search all turns",
    });
    expect(screen.getByText("All turns")).toBeTruthy();

    fireEvent.change(input, { target: { value: "needle" } });

    expect(await screen.findByText("2/2")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(await screen.findByText("1/2")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(await screen.findByText("2/2")).toBeTruthy();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(screen.queryByText("look at the first thing")).toBeNull();
    expect(screen.getByText("the assistant found needle text")).toBeTruthy();
    expect(screen.getByText("system compacted needle context")).toBeTruthy();

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("centers a clicked all-turn preview without a blur-time re-jump", async () => {
    const composerTarget = document.createElement("div");
    composerTarget.className = "session-input-inner";
    document.body.append(composerTarget);

    render(
      <MessageList
        messages={[
          userMessage("user-1", "unmatched setup request"),
          assistantMessage("assistant-1", "assistant needle answer"),
          userMessage("user-2", "later unmatched request"),
          assistantMessage("assistant-2", "later unmatched answer"),
        ]}
      />,
    );

    const { scrollTo } = installSearchGeometry({
      "user-1": 20,
      "assistant-1": 420,
      "user-2": 900,
      "assistant-2": 1320,
    });

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    const input = await screen.findByRole("textbox", {
      name: "Reverse search all turns",
    });
    fireEvent.change(input, { target: { value: "needle" } });

    const preview = await screen.findByRole("button", {
      name: "assistant needle answer",
    });
    fireEvent.click(preview);

    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalledWith({ top: 332, behavior: "auto" });
    });
    expect(
      screen.getByRole("textbox", { name: "Reverse search all turns" }),
    ).toBe(input);
    const scrollCallCount = scrollTo.mock.calls.length;
    const transcriptControl = document.createElement("button");
    document.body.append(transcriptControl);

    fireEvent.blur(input, { relatedTarget: transcriptControl });

    expect(
      screen.getByRole("textbox", { name: "Reverse search all turns" }),
    ).toBe(input);
    expect(scrollTo).toHaveBeenCalledTimes(scrollCallCount);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: "Reverse search all turns" }),
      ).toBeNull();
    });
    expect(scrollTo).toHaveBeenCalledTimes(scrollCallCount);
    expect(screen.getByText("unmatched setup request")).toBeTruthy();
    transcriptControl.remove();
  });

  it("repeats all-turn search arrow movement at a fast cadence", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });

    render(
      <MessageList
        messages={[
          userMessage("user-1", "needle in the first request"),
          assistantMessage("assistant-1", "needle in the first answer"),
          systemMessage("system-1", "needle in the compacted context"),
          assistantMessage("assistant-2", "needle in the final answer"),
        ]}
      />,
    );

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    const input = await screen.findByRole("textbox", {
      name: "Reverse search all turns",
    });
    fireEvent.change(input, { target: { value: "needle" } });
    expect(await screen.findByText("4/4")).toBeTruthy();

    vi.useFakeTimers();

    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(screen.getByText("3/4")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByText("2/4")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(42);
    });
    expect(screen.getByText("1/4")).toBeTruthy();

    fireEvent.keyUp(window, { key: "ArrowUp" });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByText("1/4")).toBeTruthy();
  });

  it("opens full-session reverse search with Ctrl+Alt+S for tool groups", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });

    render(
      <MessageList
        messages={[
          userMessage("user-1", "inspect recent changes"),
          assistantToolUseMessage("assistant-tools", [
            {
              type: "tool_use",
              id: "grep-1",
              name: "Grep",
              input: {
                pattern: "SearchNeedle",
                path: "packages/client/src/components/MessageList.tsx",
              },
            },
            {
              type: "tool_use",
              id: "read-1",
              name: "Read",
              input: {
                file_path:
                  "packages/client/src/components/UserTurnNavigator.tsx",
              },
            },
          ]),
        ]}
      />,
    );

    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });

    const allInput = await screen.findByRole("textbox", {
      name: "Reverse search all turns",
    });
    fireEvent.change(allInput, { target: { value: "Explored" } });

    expect(await screen.findByText("0/0")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: "Reverse search all turns" }),
      ).toBeNull();
    });

    fireEvent.keyDown(window, {
      key: "s",
      code: "KeyS",
      ctrlKey: true,
      altKey: true,
    });

    const fullInput = await screen.findByRole("textbox", {
      name: "Reverse search full session",
    });
    expect(screen.getByText("Full session")).toBeTruthy();
    expect(screen.getByText(/Ctrl\+Alt\+S prev/)).toBeTruthy();
    expect(screen.getByText(/click jumps/)).toBeTruthy();
    expect(screen.getByText(/Enter jump\+close/)).toBeTruthy();

    fireEvent.change(fullInput, { target: { value: "Explored" } });
    expect(await screen.findByText("1/1")).toBeTruthy();
    expect(screen.getByText("Exploring")).toBeTruthy();

    fireEvent.change(fullInput, {
      target: { value: "UserTurnNavigator.tsx" },
    });
    expect(await screen.findByText("1/1")).toBeTruthy();

    fireEvent.change(fullInput, { target: { value: "grep" } });
    expect(await screen.findByText("1/1")).toBeTruthy();
    expect(screen.getByText("Grep")).toBeTruthy();

    fireEvent.change(fullInput, { target: { value: "searchneedle" } });
    expect(await screen.findByText("1/1")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Case-sensitive search" }),
    );
    expect(await screen.findByText("0/0")).toBeTruthy();

    fireEvent.change(fullInput, { target: { value: "SearchNeedle" } });
    expect(await screen.findByText("1/1")).toBeTruthy();
  });
});
