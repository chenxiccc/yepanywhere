// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBlameLineWidthCacheKey,
  getBlameLineWidthCacheSizeForTests,
  getCachedBlameMaxLineWidth,
  measureBlameDetailWidth,
  MIN_BLAME_DETAIL_WIDTH,
  resetBlameLineWidthCacheForTests,
} from "./blameContentWidth";

describe("Files blame content-width measurement", () => {
  afterEach(() => {
    resetBlameLineWidthCacheForTests();
  });

  it("reuses a measurement for the same content and typography", () => {
    const measure = vi.fn(() => 480);
    const key = createBlameLineWidthCacheKey({
      projectId: "project",
      path: "src/x.ts",
      lines: ["const x = 1;"],
      typography: "mono|12px|tab:2",
    });

    expect(getCachedBlameMaxLineWidth(key, measure)).toBe(480);
    expect(getCachedBlameMaxLineWidth(key, measure)).toBe(480);
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it("invalidates for changed content or typography", () => {
    const base = {
      projectId: "project",
      path: "src/x.ts",
      lines: ["\twide 界"],
    };
    const first = createBlameLineWidthCacheKey({
      ...base,
      typography: "mono|12px|tab:2",
    });
    const changedContent = createBlameLineWidthCacheKey({
      ...base,
      lines: ["\twide 界界"],
      typography: "mono|12px|tab:2",
    });
    const changedTypography = createBlameLineWidthCacheKey({
      ...base,
      typography: "mono|14px|tab:4",
    });

    expect(new Set([first, changedContent, changedTypography]).size).toBe(3);
    getCachedBlameMaxLineWidth(first, () => 100);
    getCachedBlameMaxLineWidth(changedContent, () => 120);
    getCachedBlameMaxLineWidth(changedTypography, () => 140);
    expect(getBlameLineWidthCacheSizeForTests()).toBe(3);
  });

  it("uses rendered scroll widths for tabs and wide characters", () => {
    const container = document.createElement("section");
    container.innerHTML = `
      <div data-blame-row="">
        <span data-blame-gutter="commit">abcdef0</span>
        <span data-blame-lineno="">1</span>
        <span data-blame-code="">\twide 界</span>
      </div>
      <div data-blame-row="">
        <span data-blame-gutter="commit">abcdef0</span>
        <span data-blame-lineno="">2</span>
        <span data-blame-code="">short</span>
      </div>
    `;
    const codeCells =
      container.querySelectorAll<HTMLElement>("[data-blame-code]");
    Object.defineProperty(codeCells[0], "scrollWidth", { value: 510 });
    Object.defineProperty(codeCells[1], "scrollWidth", { value: 80 });

    expect(measureBlameDetailWidth(container, "tab-wide")).toBe(624);
  });

  it("keeps an empty file pane usable", () => {
    const container = document.createElement("section");

    expect(measureBlameDetailWidth(container, "empty")).toBe(
      MIN_BLAME_DETAIL_WIDTH,
    );
  });
});
