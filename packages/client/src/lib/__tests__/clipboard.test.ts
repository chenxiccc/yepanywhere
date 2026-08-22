// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  writeClipboardRichText,
  writeClipboardRichTextLater,
} from "../clipboard";

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

  it("starts a deferred rich write during the selecting gesture", async () => {
    let resolvePayload!: (value: { html: string; text: string }) => void;
    const payload = new Promise<{ html: string; text: string }>((resolve) => {
      resolvePayload = resolve;
    });
    const clipboardItems: Array<Record<string, Promise<Blob>>> = [];
    class FakeClipboardItem {
      constructor(data: Record<string, Promise<Blob>>) {
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

    const result = writeClipboardRichTextLater(payload);
    expect(write).toHaveBeenCalledTimes(1);

    resolvePayload({ html: "<strong>Rich</strong>", text: "Rich" });
    await expect(result).resolves.toBe(true);
    await expect(clipboardItems[0]?.["text/html"]).resolves.toMatchObject({
      type: "text/html",
    });
    await expect(clipboardItems[0]?.["text/plain"]).resolves.toMatchObject({
      type: "text/plain",
    });
  });
});
