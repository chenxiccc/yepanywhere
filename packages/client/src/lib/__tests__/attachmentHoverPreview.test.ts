import { describe, expect, it } from "vitest";
import { placeAttachmentHoverPreview } from "../attachmentHoverPreview";

describe("placeAttachmentHoverPreview", () => {
  it("keeps a small image at natural size below a top-of-viewport chip", () => {
    const box = placeAttachmentHoverPreview({
      anchor: { top: 20, left: 24, width: 160, height: 32 },
      imageWidth: 200,
      imageHeight: 150,
      viewportWidth: 1000,
      viewportHeight: 600,
    });

    expect(box.width).toBe(200);
    expect(box.height).toBe(150);
    expect(box.top).toBe(20 + 32 + 8);
    expect(box.left).toBe(12);
  });

  it("flips above a bottom composer chip and scales to the remaining viewport", () => {
    const box = placeAttachmentHoverPreview({
      anchor: { top: 500, left: 20, width: 180, height: 40 },
      imageWidth: 759,
      imageHeight: 668,
      viewportWidth: 1000,
      viewportHeight: 600,
    });

    expect(box.top).toBeLessThan(500);
    expect(box.top + box.height).toBeLessThanOrEqual(500 - 8);
    expect(box.left).toBeGreaterThanOrEqual(12);
    expect(box.left + box.width).toBeLessThanOrEqual(1000 - 12);
    expect(box.height / box.width).toBeCloseTo(668 / 759, 5);
    expect(box.width).toBeLessThan(759);
  });

  it("never overflows the viewport for a tall image beside a mid-screen chip", () => {
    const box = placeAttachmentHoverPreview({
      anchor: { top: 200, left: 40, width: 48, height: 48 },
      imageWidth: 400,
      imageHeight: 2000,
      viewportWidth: 375,
      viewportHeight: 812,
    });

    expect(box.top).toBeGreaterThanOrEqual(12);
    expect(box.left).toBeGreaterThanOrEqual(12);
    expect(box.top + box.height).toBeLessThanOrEqual(812 - 12);
    expect(box.left + box.width).toBeLessThanOrEqual(375 - 12);
  });
});
