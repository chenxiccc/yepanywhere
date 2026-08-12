import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ClipboardEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownPreview } from "../MarkdownPreview";

describe("MarkdownPreview", () => {
  afterEach(() => {
    document.getSelection()?.removeAllRanges();
    cleanup();
  });

  it("leaves copy ownership to the containing document viewer", () => {
    const handleCopy = vi.fn((event: ClipboardEvent) => {
      expect(event.defaultPrevented).toBe(false);
    });
    render(
      <div onCopy={handleCopy}>
        <MarkdownPreview
          html={
            '<table class="source-table"><tbody><tr><th style="color: red">Header</th></tr></tbody></table>'
          }
        />
      </div>,
    );
    const preview = screen.getByRole("region", { name: "Markdown preview" });
    const rendered = preview.querySelector(".markdown-rendered");
    if (!rendered) {
      throw new Error("Expected rendered Markdown content");
    }
    const range = document.createRange();
    range.selectNodeContents(rendered);
    document.getSelection()?.addRange(range);
    const setData = vi.fn();

    fireEvent.copy(rendered, {
      clipboardData: { setData },
    });

    expect(handleCopy).toHaveBeenCalledOnce();
    expect(setData).not.toHaveBeenCalled();
  });
});
