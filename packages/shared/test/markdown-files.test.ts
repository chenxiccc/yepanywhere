import { describe, expect, it } from "vitest";
import {
  isMarkdownLikeFile,
  isQuartoMarkdownFile,
  MARKDOWN_LIKE_FILE_EXTENSIONS,
} from "../src/markdown-files.js";

describe("rendered Markdown file eligibility", () => {
  it("recognizes every supported extension case-insensitively", () => {
    for (const extension of MARKDOWN_LIKE_FILE_EXTENSIONS) {
      expect(isMarkdownLikeFile(`reports/analysis.${extension}`)).toBe(true);
      expect(
        isMarkdownLikeFile(`reports/ANALYSIS.${extension.toUpperCase()}`),
      ).toBe(true);
    }
  });

  it("handles URL suffixes and rejects lookalike suffixes", () => {
    expect(isMarkdownLikeFile("reports/analysis.qmd?line=4#results")).toBe(
      true,
    );
    expect(isMarkdownLikeFile("reports/analysis-qmd.txt")).toBe(false);
    expect(isMarkdownLikeFile(undefined)).toBe(false);
  });

  it("identifies Quarto Markdown as the one Quarto-aware variant", () => {
    expect(isQuartoMarkdownFile("reports/ANALYSIS.QMD?line=4")).toBe(true);
    expect(isQuartoMarkdownFile("reports/analysis.md")).toBe(false);
  });
});
