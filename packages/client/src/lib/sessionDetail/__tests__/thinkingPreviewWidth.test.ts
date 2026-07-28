import { describe, expect, it } from "vitest";
import {
  THINKING_PREVIEW_MIN_WIDTH_PX,
  THINKING_PREVIEW_MAX_WIDTH_PX,
  updateThinkingPreviewWidth,
} from "../thinkingPreviewWidth";

describe("thinking preview width", () => {
  it("grows but never shrinks while the same block streams", () => {
    const initial = updateThinkingPreviewWidth(null, "same", 300);
    const narrower = updateThinkingPreviewWidth(initial, "same", 240);
    const wider = updateThinkingPreviewWidth(narrower, "same", 420);

    expect(narrower).toBe(initial);
    expect(wider.targetWidthPx).toBeGreaterThan(initial.targetWidthPx);
  });

  it("may shrink when the slot receives a new block", () => {
    const wide = updateThinkingPreviewWidth(null, "wide", 480);
    const narrow = updateThinkingPreviewWidth(wide, "narrow", 120);

    expect(narrow.targetWidthPx).toBeLessThan(wide.targetWidthPx);
    expect(narrow.id).toBe("narrow");
  });

  it("clamps measured widths to the card bounds", () => {
    expect(updateThinkingPreviewWidth(null, "small", 0).targetWidthPx).toBe(
      THINKING_PREVIEW_MIN_WIDTH_PX,
    );
    expect(
      updateThinkingPreviewWidth(null, "large", 10_000).targetWidthPx,
    ).toBe(THINKING_PREVIEW_MAX_WIDTH_PX);
  });
});
