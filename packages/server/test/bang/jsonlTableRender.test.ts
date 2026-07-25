/**
 * Uniform JSONL bang output (the acli default for list-shaped tools such
 * as almanac) renders as a real table through the standard markdown path.
 * Contract: topics/bang-commands.md § Output rendering.
 */

import { describe, expect, it } from "vitest";
import { buildBangOutputMarkdown } from "../../src/routes/bang-commands.js";
import { renderMarkdownToHtml } from "../../src/augments/markdown-augments.js";

const ALMANAC_JSONL = [
  '{"card":"Echo Form","section":"defect","tier":"S"}',
  '{"card":"Shatter","section":"defect","tier":"S"}',
  '{"card":"Glacier","section":"defect","tier":"S"}',
].join("\n");

describe("JSONL bang output → table", () => {
  it("classifies a uniform JSONL run as markdown-table output", () => {
    const { markdown, mode } = buildBangOutputMarkdown(ALMANAC_JSONL);
    expect(mode).toBe("markdown");
    expect(markdown).toContain("| card | section | tier |");
    expect(markdown).not.toContain("```json");
  });

  it("renders it as an HTML table", async () => {
    const { markdown } = buildBangOutputMarkdown(ALMANAC_JSONL);
    const html = await renderMarkdownToHtml(markdown);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>card</th>");
    expect(html).toContain("Echo Form");
  });

  it("leaves a single JSON document as a fenced json blob", () => {
    const { markdown, mode } = buildBangOutputMarkdown('{"count":0,"of":"records"}');
    expect(mode).toBe("json");
    expect(markdown).toContain("```json");
  });

  it("leaves non-uniform JSONL as a fenced json blob", () => {
    const { mode } = buildBangOutputMarkdown('{"a":1}\n{"b":2}');
    expect(mode).toBe("json");
  });
});
