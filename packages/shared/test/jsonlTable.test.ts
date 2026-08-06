import { describe, expect, it } from "vitest";
import { jsonlTablesToMarkdown } from "../src/jsonlTable.js";

const JSONL = [
  '{"card":"Bash","tier":"B","cost":2}',
  '{"card":"Strike","tier":"C","cost":1}',
  '{"card":"Whirlwind","tier":"S","cost":0}',
].join("\n");

describe("jsonlTablesToMarkdown", () => {
  it("renders a uniform JSONL run as one GFM table (no caption)", () => {
    const { markdown, tableCount } = jsonlTablesToMarkdown(JSONL);
    expect(tableCount).toBe(1);
    expect(markdown).toBe(
      [
        "| card | tier | cost |",
        "| --- | --- | --- |",
        "| Bash | B | 2 |",
        "| Strike | C | 1 |",
        "| Whirlwind | S | 0 |",
      ].join("\n"),
    );
  });

  it("groups by identical key set regardless of key order, and escapes pipes", () => {
    const text = ['{"a":"x|y","b":1}', '{"b":2,"a":"z"}'].join("\n");
    const { markdown, tableCount } = jsonlTablesToMarkdown(text);
    expect(tableCount).toBe(1);
    // Columns follow the first row's order; second row's values map by key.
    expect(markdown).toContain("| a | b |");
    expect(markdown).toContain("| x\\|y | 1 |");
    expect(markdown).toContain("| z | 2 |");
  });

  it("does not tabulate a single object, a non-object, or a JSON array", () => {
    expect(jsonlTablesToMarkdown('{"a":1}').tableCount).toBe(0);
    expect(jsonlTablesToMarkdown('{"a":1}\n{"b":2}').tableCount).toBe(0);
    expect(jsonlTablesToMarkdown("[1,2,3]").tableCount).toBe(0);
    expect(jsonlTablesToMarkdown('"plain"\n"lines"').tableCount).toBe(0);
  });

  it("tabulates each consecutive run, passing other lines through verbatim", () => {
    const text = [
      "before",
      '{"a":1}',
      '{"a":2}',
      "middle",
      '{"x":1,"y":2}',
      '{"x":3,"y":4}',
    ].join("\n");
    const { markdown, tableCount } = jsonlTablesToMarkdown(text);
    expect(tableCount).toBe(2);
    expect(markdown.startsWith("before")).toBe(true);
    expect(markdown).toContain("middle");
    expect(markdown).toContain("| a |");
    expect(markdown).toContain("| x | y |");
  });

  it("renders nested cell values as compact JSON and null as empty", () => {
    const text = ['{"k":"a","v":{"n":1}}', '{"k":"b","v":null}'].join("\n");
    const { markdown } = jsonlTablesToMarkdown(text);
    expect(markdown).toContain('| a | {"n":1} |');
    expect(markdown).toContain("| b |  |");
  });
});
