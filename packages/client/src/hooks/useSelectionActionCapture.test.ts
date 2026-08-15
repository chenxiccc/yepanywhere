// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  placeSelectionActions,
  type SelectionActionSnapshot,
} from "./useSelectionActionCapture";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
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
