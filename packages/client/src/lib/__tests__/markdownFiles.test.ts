import { describe, expect, it } from "vitest";
import { isMarkdownLikeFile } from "../markdownFiles";

describe("isMarkdownLikeFile", () => {
  it("recognizes Quarto Markdown paths", () => {
    expect(isMarkdownLikeFile("reports/analysis.qmd")).toBe(true);
    expect(isMarkdownLikeFile("reports/ANALYSIS.QMD?line=4")).toBe(true);
  });

  it("does not treat a qmd suffix without an extension as Markdown", () => {
    expect(isMarkdownLikeFile("reports/analysis-qmd.txt")).toBe(false);
  });
});
