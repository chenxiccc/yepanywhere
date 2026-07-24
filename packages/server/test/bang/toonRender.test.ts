/**
 * TOON flat tables render as real tables through the standard fence
 * pipeline (augment generator), for bang output and any other fenced
 * command output. Spec: ~/agents topics/agent-cli.md; contract:
 * topics/bang-commands.md.
 */

import { parseToonDocument } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { renderMarkdownToHtml } from "../../src/augments/markdown-augments.js";

const TOON = [
  "harnesses[2]{harness,installed,status}:",
  'claude,1.0.0,"up,to,date"',
  "codex,,not-installed",
].join("\n");

describe("TOON rendering", () => {
  it("parses quoted cells", () => {
    const tables = parseToonDocument(TOON);
    expect(tables?.[0]?.rows[0]).toEqual(["claude", "1.0.0", "up,to,date"]);
    expect(tables?.[0]?.rows[1]).toEqual(["codex", "", "not-installed"]);
  });

  it("renders a toon fence as an HTML table", async () => {
    const html = await renderMarkdownToHtml(`\`\`\`toon\n${TOON}\n\`\`\``);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>harness</th>");
    expect(html).toContain("up,to,date");
  });

  it("renders an untagged fence containing TOON as a table too", async () => {
    const html = await renderMarkdownToHtml(`\`\`\`\n${TOON}\n\`\`\``);
    expect(html).toContain("<table>");
  });

  it("leaves malformed TOON as a plain code block", async () => {
    const html = await renderMarkdownToHtml(
      "```toon\nitems[3]{a,b}:\n1,2\n```",
    );
    expect(html).not.toContain("<table>");
    expect(html).toContain("items[3]{a,b}:");
  });

  it("rejects unterminated and trailing quoted-cell syntax", () => {
    expect(parseToonDocument('items[1]{a}:\n"unterminated')).toBeNull();
    expect(parseToonDocument('items[1]{a}:\n"value"trailing')).toBeNull();
  });
});
