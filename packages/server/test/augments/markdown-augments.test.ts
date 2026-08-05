import { describe, expect, it } from "vitest";
import { augmentTextBlocks } from "../../src/augments/markdown-augments.js";
import type { ProjectPathIndex } from "../../src/projects/projectPathIndex.js";

describe("assistant markdown augments", () => {
  it("renders bracket-delimited inline and display math through katex", async () => {
    const text = String.raw`
For each token \(t\), it formed only a local emission score:

\[
e_t(y)=(Wh_t+b)_y
\]
`;
    const block: { _html?: string; text: string; type: "text" } = {
      text,
      type: "text",
    };
    const messages = [
      {
        type: "assistant",
        message: { content: [block] },
      },
    ];

    await augmentTextBlocks(messages);

    expect(block._html?.match(/class="katex"/g)).toHaveLength(2);
    expect(block._html).toContain('class="katex-display"');
    expect(block._html).toContain('class="msupsub"');
  });

  it("links bare project paths in turn prose and skips ordinary words", async () => {
    const batches: string[][] = [];
    const files = new Set(["src/server.ts", "Makefile"]);
    const index: ProjectPathIndex = {
      findExisting: async (paths: readonly string[]) => {
        batches.push([...paths]);
        return new Set(paths.filter((path) => files.has(path)));
      },
      has: async (path: string) => files.has(path),
      // Stands in for a listed root, which is what lets an extensionless name
      // be answered without spending a lookup on it.
      knownFile: (path: string) => files.has(path),
      release: () => undefined,
    };
    const block: { _html?: string; text: string; type: "text" } = {
      text: "Edited src/server.ts and the Makefile; runs/absent.json is gone. See [src/server.ts](https://example.com/x) upstream.",
      type: "text",
    };

    await augmentTextBlocks(
      [{ type: "assistant", message: { content: [block] } }],
      {
        projectFileLinks: {
          projectId: "project-1",
          projectPath: "/workspace/project",
          index,
        },
      },
    );

    const html = block._html ?? "";
    expect(html).toContain('data-ya-resource="local-file"');
    expect(html).toContain("/workspace/project/src/server.ts");
    expect(html).toContain("/workspace/project/Makefile");
    expect(html).not.toContain("runs/absent.json</a>");
    // The markdown link's anchor text is a real path; rewriting it would nest
    // an anchor inside an anchor.
    expect(html).toContain('href="https://example.com/x"');
    expect(html).not.toMatch(/<a[^>]*>[^<]*<a /);
    // One batched pre-resolve pass, and `Makefile` never entered it.
    expect(batches[0]).toEqual(["src/server.ts", "runs/absent.json"]);
  });
});
