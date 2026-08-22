// @vitest-environment jsdom

import type { FileContentResponse } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { getRenderedFileClipboardPayload } from "../renderedFileClipboard";

function fileResponse(
  overrides: Partial<FileContentResponse> = {},
): FileContentResponse {
  return {
    metadata: {
      path: "docs/guide.md",
      size: 8,
      mimeType: "text/markdown",
      isText: true,
    },
    rawUrl: "",
    content: "# Guide",
    ...overrides,
  };
}

describe("getRenderedFileClipboardPayload", () => {
  it("copies Markdown's rendered representation instead of source", () => {
    expect(
      getRenderedFileClipboardPayload(
        "docs/guide.md",
        fileResponse({ renderedMarkdownHtml: "<h1>Guide</h1>" }),
      ),
    ).toEqual({ html: "<h1>Guide</h1>", text: "Guide" });
  });

  it("copies an HTML document body without active content", () => {
    const payload = getRenderedFileClipboardPayload(
      "report.html",
      fileResponse({
        metadata: {
          path: "report.html",
          size: 45,
          mimeType: "text/html",
          isText: true,
        },
        content:
          "<!doctype html><html><body><h1>Report</h1><script>bad()</script></body></html>",
      }),
    );

    expect(payload).toEqual({ html: "<h1>Report</h1>", text: "Report" });
  });

  it("does not offer a rendered payload for source-only files", () => {
    expect(
      getRenderedFileClipboardPayload(
        "src/app.ts",
        fileResponse({
          metadata: {
            path: "src/app.ts",
            size: 8,
            mimeType: "text/typescript",
            isText: true,
          },
        }),
      ),
    ).toBeNull();
  });
});
