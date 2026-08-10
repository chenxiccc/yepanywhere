// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assistantMessage,
  installMessageListTestEnvironment,
  userMessage,
} from "./MessageList.test-support";
import { MessageList } from "../MessageList";

installMessageListTestEnvironment();

const originalIntersectionObserver = window.IntersectionObserver;

interface ObservedIntersection {
  callback: IntersectionObserverCallback;
  options?: IntersectionObserverInit;
  target: Element | null;
}

function installIntersectionObserverMock(): ObservedIntersection {
  const observed: ObservedIntersection = {
    callback: () => {},
    target: null,
  };

  class IntersectionObserverMock {
    constructor(
      callback: IntersectionObserverCallback,
      options?: IntersectionObserverInit,
    ) {
      observed.callback = callback;
      observed.options = options;
    }

    observe(target: Element) {
      observed.target = target;
    }

    disconnect() {}
  }

  Object.defineProperty(window, "IntersectionObserver", {
    configurable: true,
    value: IntersectionObserverMock,
  });
  return observed;
}

function reportIntersection(
  observed: ObservedIntersection,
  isIntersecting: boolean,
) {
  if (!observed.target) throw new Error("No pagination boundary observed");
  observed.callback(
    [
      {
        target: observed.target,
        isIntersecting,
        intersectionRatio: isIntersecting ? 1 : 0,
      } as IntersectionObserverEntry,
    ],
    {} as IntersectionObserver,
  );
}

afterEach(() => {
  Object.defineProperty(window, "IntersectionObserver", {
    configurable: true,
    value: originalIntersectionObserver,
  });
});

describe("MessageList older-page pagination", () => {
  it("loads each visible older-page cursor once", () => {
    const observed = installIntersectionObserverMock();
    const onLoadOlderMessages = vi.fn();
    const messages = [
      userMessage("user-2", "Current request"),
      assistantMessage("assistant-2", "Current answer"),
    ];
    const { container, rerender } = render(
      <MessageList
        messages={messages}
        hasOlderMessages={true}
        olderMessagesCursor="user-2"
        onLoadOlderMessages={onLoadOlderMessages}
      />,
    );

    expect(observed.target?.classList.contains("load-older-messages")).toBe(
      true,
    );
    expect(observed.options?.root).toBe(container);

    act(() => reportIntersection(observed, true));
    act(() => reportIntersection(observed, true));
    expect(onLoadOlderMessages).toHaveBeenCalledTimes(1);

    rerender(
      <MessageList
        messages={[
          userMessage("user-1", "Older request"),
          assistantMessage("assistant-1", "Older answer"),
          ...messages,
        ]}
        hasOlderMessages={true}
        olderMessagesCursor="user-1"
        onLoadOlderMessages={onLoadOlderMessages}
      />,
    );
    act(() => reportIntersection(observed, true));
    expect(onLoadOlderMessages).toHaveBeenCalledTimes(1);
    act(() => reportIntersection(observed, false));
    act(() => reportIntersection(observed, true));
    expect(onLoadOlderMessages).toHaveBeenCalledTimes(2);
  });

  it("allows a visible-boundary retry after the reader leaves and returns", () => {
    const observed = installIntersectionObserverMock();
    const onLoadOlderMessages = vi.fn();
    render(
      <MessageList
        messages={[userMessage("user-1", "Current request")]}
        hasOlderMessages={true}
        olderMessagesCursor="user-1"
        onLoadOlderMessages={onLoadOlderMessages}
      />,
    );

    act(() => reportIntersection(observed, true));
    act(() => reportIntersection(observed, false));
    act(() => reportIntersection(observed, true));
    expect(onLoadOlderMessages).toHaveBeenCalledTimes(2);
  });

  it("waits for the current page to settle before loading a new cursor", async () => {
    const observed = installIntersectionObserverMock();
    let resolveFirstLoad: (() => void) | undefined;
    const firstLoad = new Promise<void>((resolve) => {
      resolveFirstLoad = resolve;
    });
    const onLoadOlderMessages = vi
      .fn<() => void | Promise<void>>()
      .mockReturnValueOnce(firstLoad)
      .mockReturnValue(undefined);
    const messages = [userMessage("user-2", "Current request")];
    const { rerender } = render(
      <MessageList
        messages={messages}
        hasOlderMessages={true}
        olderMessagesCursor="user-2"
        onLoadOlderMessages={onLoadOlderMessages}
      />,
    );

    act(() => reportIntersection(observed, true));
    rerender(
      <MessageList
        messages={[userMessage("user-1", "Older request"), ...messages]}
        hasOlderMessages={true}
        olderMessagesCursor="user-1"
        onLoadOlderMessages={onLoadOlderMessages}
      />,
    );
    act(() => reportIntersection(observed, true));
    expect(onLoadOlderMessages).toHaveBeenCalledTimes(1);

    await act(async () => resolveFirstLoad?.());
    act(() => reportIntersection(observed, true));
    expect(onLoadOlderMessages).toHaveBeenCalledTimes(1);
    act(() => reportIntersection(observed, false));
    act(() => reportIntersection(observed, true));
    expect(onLoadOlderMessages).toHaveBeenCalledTimes(2);
  });

  it("keeps the manual button when visibility observation is unavailable", () => {
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: undefined,
    });
    const onLoadOlderMessages = vi.fn();
    render(
      <MessageList
        messages={[userMessage("user-1", "Current request")]}
        hasOlderMessages={true}
        olderMessagesCursor="user-1"
        onLoadOlderMessages={onLoadOlderMessages}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Load older messages" }),
    );
    expect(onLoadOlderMessages).toHaveBeenCalledTimes(1);
  });

  it("keeps explicit continuation available after the history safety boundary", () => {
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: undefined,
    });
    const onLoadOlderMessages = vi.fn();
    render(
      <MessageList
        messages={[userMessage("user-1", "Current request")]}
        hasOlderMessages={true}
        olderLoadContinuationRequired={true}
        onLoadOlderMessages={onLoadOlderMessages}
      />,
    );

    expect(
      screen.getByText(
        "Loaded a large history span without reaching an earlier user turn. Load older messages again to continue.",
      ),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Load older messages" }),
    );
    expect(onLoadOlderMessages).toHaveBeenCalledTimes(1);
  });
});
