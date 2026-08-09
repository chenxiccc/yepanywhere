// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadBlob, writeClipboardImageLater } from "../imageActions";

describe("image actions", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "ClipboardItem");
    Reflect.deleteProperty(navigator, "clipboard");
    Reflect.deleteProperty(URL, "createObjectURL");
    Reflect.deleteProperty(URL, "revokeObjectURL");
  });

  it("starts a clipboard write before relay-delivered bytes resolve", async () => {
    let resolveBlob: ((blob: Blob) => void) | undefined;
    const pendingBlob = new Promise<Blob>((resolve) => {
      resolveBlob = resolve;
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

    const result = writeClipboardImageLater(pendingBlob);

    expect(write).toHaveBeenCalledTimes(1);
    expect(clipboardItems).toHaveLength(1);
    expect(clipboardItems[0]?.["image/png"]).toBeInstanceOf(Promise);
    resolveBlob?.(new Blob(["png"], { type: "image/png" }));
    await expect(result).resolves.toBe(true);
  });

  it("downloads with a short-lived object URL", () => {
    vi.useFakeTimers();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:download"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    downloadBlob(new Blob(["png"]), "capture.png");

    expect(click).toHaveBeenCalledTimes(1);
    expect(document.querySelector('a[download="capture.png"]')).toBeNull();
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:download");
  });
});
