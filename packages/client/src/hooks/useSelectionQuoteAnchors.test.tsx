// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommentAnchor } from "../lib/commentAnchors";
import type {
  ComposerDraftChange,
  ComposerDraftSignal,
} from "../lib/composerDraftSignal";
import { useSelectionQuoteAnchors } from "./useSelectionQuoteAnchors";

afterEach(() => {
  document.body.replaceChildren();
});

describe("useSelectionQuoteAnchors", () => {
  it("subscribes only while a quote anchor is live", () => {
    const sourceElement = document.createElement("div");
    const textNode = document.createTextNode("Selected text");
    sourceElement.append(textNode);
    document.body.append(sourceElement);
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const anchor: CommentAnchor = {
      id: "anchor-1",
      lineSignatures: ["Selected text"],
      quotedText: "> Selected text",
      range,
      selectedText: "Selected text",
      sourceElement,
    };
    const container = document.createElement("div");
    document.body.append(container);
    const containerRef = { current: container };
    let draftListener: ((change: ComposerDraftChange) => void) | undefined;
    const unsubscribe = vi.fn();
    const subscribeDraftChanges = vi.fn(
      (listener: (change: ComposerDraftChange) => void) => {
        draftListener = listener;
        return unsubscribe;
      },
    );
    const composerDraftSignal: ComposerDraftSignal = {
      getDraft: () => "",
      publishDraftChange: () => {},
      subscribeDraftChanges,
    };
    const onQuoteSelection = vi.fn((text: string) => text);
    const { result } = renderHook(() =>
      useSelectionQuoteAnchors({
        composerDraftSignal,
        containerRef,
        onQuoteSelection,
        quoteClearSignal: 0,
      }),
    );

    expect(subscribeDraftChanges).not.toHaveBeenCalled();
    act(() => {
      expect(result.current.applyQuoteAnchors([anchor])).toBe(true);
    });
    expect(onQuoteSelection).toHaveBeenCalledWith("> Selected text\n");
    expect(subscribeDraftChanges).toHaveBeenCalledTimes(1);

    act(() => {
      draftListener?.({
        hasTextContent: false,
        metadata: { mayAffectQuoteAnchors: false },
        text: "",
      });
    });
    expect(unsubscribe).not.toHaveBeenCalled();

    act(() => {
      draftListener?.({
        hasTextContent: false,
        metadata: { mayAffectQuoteAnchors: true },
        text: "",
      });
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
