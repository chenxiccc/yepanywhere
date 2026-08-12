// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { writeClipboardRichText } from "../clipboard";

describe("writeClipboardRichText", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "ClipboardItem");
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("writes HTML and plain-text clipboard representations", async () => {
    const clipboardItems: Array<Record<string, Blob>> = [];
    class FakeClipboardItem {
      constructor(data: Record<string, Blob>) {
        clipboardItems.push(data);
      }
    }
    const write = vi.fn(async () => {});
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: FakeClipboardItem,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write },
    });

    await expect(
      writeClipboardRichText("<strong>Rich</strong>", "Rich"),
    ).resolves.toBe(true);

    expect(write).toHaveBeenCalledTimes(1);
    expect(clipboardItems[0]?.["text/html"]?.type).toBe("text/html");
    expect(clipboardItems[0]?.["text/plain"]?.type).toBe("text/plain");
  });

  it("falls back to plain text when rich clipboard writes fail", async () => {
    class FakeClipboardItem {}
    const write = vi.fn(async () => {
      throw new Error("permission denied");
    });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: FakeClipboardItem,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write, writeText },
    });

    await expect(
      writeClipboardRichText("<strong>Rich</strong>", "Rich"),
    ).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("Rich");
  });
});
