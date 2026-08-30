// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMarkdownCopySource } from "../lib/markdownSelectionCopy";
import {
  placeSelectionActions,
  type SelectionActionSnapshot,
  useSelectionActionCapture,
} from "./useSelectionActionCapture";

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useSelectionActionCapture", () => {
  it("rate-limits geometry without letting viewport events dismiss actions", () => {
    vi.useFakeTimers();
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: false,
    } as MediaQueryList);
    const root = document.createElement("div");
    const sourceElement = document.createElement("p");
    const textNode = document.createTextNode("Selectable text");
    sourceElement.append(textNode);
    root.append(sourceElement);
    document.body.append(root);
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 400 },
      clientWidth: { configurable: true, value: 600 },
    });
    root.getBoundingClientRect = () =>
      ({
        bottom: 400,
        height: 400,
        left: 0,
        right: 600,
        top: 0,
        width: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const rangeRect = {
      bottom: 120,
      height: 20,
      left: 100,
      right: 220,
      top: 100,
      width: 120,
      x: 100,
      y: 100,
      toJSON: () => ({}),
    } as DOMRect;
    range.getBoundingClientRect = vi.fn(() => rangeRect);
    range.getClientRects = () => {
      const rects = [rangeRect];
      return Object.assign(rects, {
        item: (index: number) => rects[index] ?? null,
      });
    };
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const unregister = registerMarkdownCopySource(
      sourceElement,
      "Selectable text",
    );
    const containerRef = { current: root } as RefObject<HTMLDivElement>;
    const { result, unmount } = renderHook(() =>
      useSelectionActionCapture({
        actionCount: 1,
        containerRef,
        inert: false,
        isInteractiveTarget: () => false,
      }),
    );

    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
      document.dispatchEvent(new Event("selectionchange"));
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.state?.snapshot.snippets).toMatchObject([
      { markdown: "Selectable text" },
    ]);
    expect(range.getBoundingClientRect).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(50));

    expect(range.getBoundingClientRect).toHaveBeenCalledTimes(2);

    act(() => vi.advanceTimersByTime(50));

    act(() => {
      window.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("scroll"));
    });

    expect(range.getBoundingClientRect).toHaveBeenCalledTimes(3);

    act(() => vi.advanceTimersByTime(50));

    expect(range.getBoundingClientRect).toHaveBeenCalledTimes(4);

    const capturedState = result.current.state;
    selection?.removeAllRanges();
    act(() => window.dispatchEvent(new Event("scroll")));

    expect(result.current.state).toBe(capturedState);

    act(() => document.dispatchEvent(new Event("selectionchange")));

    expect(result.current.state).toBeNull();
    unmount();
    unregister();
  });

  it("restarts read-only selections without clearing editable controls", () => {
    const root = document.createElement("div");
    const sourceElement = document.createElement("p");
    const textNode = document.createTextNode("Selectable text");
    const input = document.createElement("textarea");
    sourceElement.append(textNode);
    root.append(sourceElement, input);
    document.body.append(root);
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const unregister = registerMarkdownCopySource(
      sourceElement,
      "Selectable text",
    );
    const containerRef = { current: root } as RefObject<HTMLDivElement>;
    const { unmount } = renderHook(() =>
      useSelectionActionCapture({
        actionCount: 1,
        containerRef,
        inert: false,
        isInteractiveTarget: (target) => target === input,
      }),
    );

    sourceElement.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
    expect(selection?.rangeCount).toBe(0);

    selection?.addRange(range);
    input.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
    expect(selection?.toString()).toBe("Selectable text");

    unmount();
    unregister();
  });
});

describe("placeSelectionActions", () => {
  it("uses the clear side when the preferred side has no room", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: false,
    } as MediaQueryList);
    const root = document.createElement("div");
    const sourceElement = document.createElement("p");
    const textNode = document.createTextNode("Right edge selection");
    sourceElement.append(textNode);
    root.append(sourceElement);
    document.body.append(root);
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 400 },
      clientWidth: { configurable: true, value: 600 },
    });
    root.getBoundingClientRect = () =>
      ({
        bottom: 400,
        height: 400,
        left: 0,
        right: 600,
        top: 0,
        width: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    const range = document.createRange();
    range.selectNodeContents(textNode);
    range.getBoundingClientRect = () =>
      ({
        bottom: 120,
        height: 20,
        left: 500,
        right: 590,
        top: 100,
        width: 90,
        x: 500,
        y: 100,
        toJSON: () => ({}),
      }) as DOMRect;
    range.getClientRects = () => {
      const rects = [range.getBoundingClientRect()];
      return Object.assign(rects, {
        item: (index: number) => rects[index] ?? null,
      });
    };
    const snapshot: SelectionActionSnapshot = {
      anchors: [],
      ranges: [range],
      root,
      snippets: [
        {
          markdown: "Right edge selection",
          range,
          selectedText: "Right edge selection",
          sourceElement,
        },
      ],
    };
    const selection = {
      getRangeAt: () => range,
      rangeCount: 1,
    } as unknown as Selection;

    expect(placeSelectionActions(root, selection, snapshot, 3)?.side).toBe(
      "before",
    );
  });
});
