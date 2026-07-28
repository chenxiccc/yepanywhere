// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const indexStylesheetUrl = new URL("../index.css", import.meta.url);
const rendererStylesheetUrl = new URL("../renderers.css", import.meta.url);

describe("shared source-code typography", () => {
  it("drives source views from the fixed-font Appearance metrics", async () => {
    const [indexCss, rendererCss] = await Promise.all([
      readFile(indexStylesheetUrl, "utf8"),
      readFile(rendererStylesheetUrl, "utf8"),
    ]);

    expect(indexCss).toMatch(
      /--source-code-font-size:\s*max\([\s\S]*?var\(--fixed-font-size-base-raw\)[\s\S]*?var\(--source-font-size-offset,\s*0px\)[\s\S]*?\);/,
    );
    expect(indexCss).toMatch(
      /--source-code-line-height:\s*calc\([\s\S]*?var\(--output-prose-line-height-offset\)[\s\S]*?var\(--source-vspace-offset,\s*0px\)[\s\S]*?\);/,
    );
    expect(rendererCss).toMatch(
      /\.diff-view,\s*\.highlighted-diff,\s*\.diff-content,\s*\.file-viewer-code,\s*\.blame-view\s*\{[\s\S]*?font-family:\s*var\(--font-mono\);[\s\S]*?font-size:\s*var\(--source-code-font-size\);[\s\S]*?line-height:\s*var\(--source-code-line-height\);[\s\S]*?\}/,
    );
  });

  it("restores shared metrics inside zero-sized highlighted wrappers", async () => {
    const [indexCss, rendererCss] = await Promise.all([
      readFile(indexStylesheetUrl, "utf8"),
      readFile(rendererStylesheetUrl, "utf8"),
    ]);

    expect(rendererCss).toMatch(
      /\.highlighted-diff code\s*\{[\s\S]*?font-size:\s*0;[\s\S]*?\}/,
    );
    expect(rendererCss).toMatch(
      /\.highlighted-diff \.line\s*\{[\s\S]*?font-size:\s*var\(--source-code-font-size\);[\s\S]*?line-height:\s*var\(--source-code-line-height\);[\s\S]*?\}/,
    );
    expect(rendererCss).toMatch(
      /\.diff-content > div\s*\{[\s\S]*?line-height:\s*inherit;[\s\S]*?\}/,
    );
    expect(rendererCss).toMatch(
      /--file-viewer-code-line-box:\s*var\(--source-code-line-height\);/,
    );
    expect(indexCss).toMatch(
      /\.output-preview-fixed\s*\{[\s\S]*?font-size:\s*var\(--source-code-font-size\);[\s\S]*?line-height:\s*var\(--source-code-line-height\);[\s\S]*?\}/,
    );
    expect(rendererCss).not.toMatch(
      /\.source-diff-pane[\s\S]{0,160}font-size:/,
    );
  });
});
