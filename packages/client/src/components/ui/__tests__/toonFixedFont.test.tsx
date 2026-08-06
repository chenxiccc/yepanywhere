// @vitest-environment jsdom

/**
 * TOON flat tables in fixed-font command output (e.g. agent Bash results)
 * render as tables under the sigma toggle. Contract: topics/bang-commands.md.
 */

import { describe, expect, it } from "vitest";
import { renderFixedFontRichContent } from "../FixedFontMathToggle";

const TOON = [
  "harnesses[2]{harness,status}:",
  "claude,up-to-date",
  'codex,"needs, update"',
].join("\n");

describe("fixed-font TOON rendering", () => {
  it("renders a strict TOON block as a table", () => {
    const result = renderFixedFontRichContent(`before\n${TOON}\nafter`);
    expect(result.changed).toBe(true);
    expect(result.html).toContain('<table class="fixed-font-markdown-table">');
    expect(result.html).toContain("<th>harness</th>");
    expect(result.html).toContain("<td>needs, update</td>");
  });

  it("leaves malformed TOON alone", () => {
    const result = renderFixedFontRichContent("harnesses[3]{a,b}:\n1,2\n");
    expect(result.html).not.toContain("<table");
  });
});
