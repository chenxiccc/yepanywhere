import { describe, expect, it, vi } from "vitest";
import {
  captureScrollPositionAnchor,
  restoreScrollPositionAnchor,
} from "../scrollAnchor";

function rect(top: number): DOMRect {
  return {
    bottom: top + 10,
    height: 10,
    left: 0,
    right: 10,
    top,
    width: 10,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

describe("scroll position anchors", () => {
  it("keeps an element at its original scroll-root offset", () => {
    const scrollRoot = document.createElement("div");
    const initialElement = document.createElement("div");
    const replacementElement = document.createElement("div");
    scrollRoot.scrollTop = 40;
    vi.spyOn(scrollRoot, "getBoundingClientRect").mockReturnValue(rect(20));
    vi.spyOn(initialElement, "getBoundingClientRect").mockReturnValue(rect(80));
    vi.spyOn(replacementElement, "getBoundingClientRect").mockReturnValue(
      rect(140),
    );

    const anchor = captureScrollPositionAnchor(scrollRoot, initialElement);
    restoreScrollPositionAnchor(anchor, replacementElement);

    expect(scrollRoot.scrollTop).toBe(100);
  });
});
