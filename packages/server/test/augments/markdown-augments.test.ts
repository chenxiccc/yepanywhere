import { afterEach, describe, expect, it } from "vitest";
import {
  __test__,
  augmentTextBlocks,
  markdownAugmentCacheDiagnostics,
  renderMarkdownToHtml,
} from "../../src/augments/markdown-augments.js";
import type { ProjectPathIndex } from "../../src/projects/projectPathIndex.js";

afterEach(() => {
  __test__.resetMarkdownHtmlCache();
});

describe("assistant markdown augments", () => {
  it("retains immutable HTML and joins concurrent duplicate renders", async () => {
    const first = renderMarkdownToHtml("Shared **body**.");
    const second = renderMarkdownToHtml("Shared **body**.");

    expect(await first).toBe(await second);
    expect(markdownAugmentCacheDiagnostics()).toMatchObject({
      joinedCalls: 1,
      retainedEntries: 1,
      staleCompletions: 0,
      unretainedCompletions: 0,
      workStarts: 1,
    });

    await renderMarkdownToHtml("Shared **body**.");
    expect(markdownAugmentCacheDiagnostics()).toMatchObject({
      cacheHits: 1,
      retainedEntries: 1,
      workStarts: 1,
    });
  });

  it("keeps Quarto-aware renders separate in the Markdown cache", async () => {
    const markdown = "{{< include sections/_methods.qmd >}}";
    const ordinary = await renderMarkdownToHtml(markdown, {
      localFileBasePath: "/workspace/project",
    });
    const quarto = await renderMarkdownToHtml(markdown, {
      localFileBasePath: "/workspace/project",
      quartoMarkdown: true,
    });

    expect(ordinary).not.toContain("data-ya-resource");
    expect(quarto).toContain(
      'href="/api/local-file?path=%2Fworkspace%2Fproject%2Fsections%2F_methods.qmd&amp;render=1"',
    );
    expect(markdownAugmentCacheDiagnostics()).toMatchObject({
      retainedEntries: 2,
      workStarts: 2,
    });
  });

  it("joins but does not retain unversioned filesystem answers", async () => {
    const index: ProjectPathIndex = {
      findExisting: async (paths) => new Set(paths),
      has: async () => true,
      knownFile: () => undefined,
      release: () => undefined,
      sourceRevision: () => 1,
    };
    const options = {
      projectFileLinks: {
        projectId: "project-1",
        projectPath: "/workspace/project",
        index,
      },
    };

    const first = renderMarkdownToHtml("See `src/server.ts`.", options);
    const second = renderMarkdownToHtml("See `src/server.ts`.", options);
    await Promise.all([first, second]);
    expect(markdownAugmentCacheDiagnostics()).toMatchObject({
      joinedCalls: 1,
      retainedEntries: 0,
      unretainedCompletions: 1,
      workStarts: 1,
    });

    await renderMarkdownToHtml("See `src/server.ts`.", options);
    expect(markdownAugmentCacheDiagnostics()).toMatchObject({
      retainedEntries: 0,
      unretainedCompletions: 2,
      workStarts: 2,
    });
  });

  it("coalesces but does not retain inline local-image output", async () => {
    const options = {
      inlineLocalImages: true,
      localFileBasePath: "/workspace/project",
    };

    const first = renderMarkdownToHtml("Shared **body**.", options);
    const second = renderMarkdownToHtml("Shared **body**.", options);
    await Promise.all([first, second]);
    expect(markdownAugmentCacheDiagnostics()).toMatchObject({
      joinedCalls: 1,
      retainedEntries: 0,
      unretainedCompletions: 1,
      workStarts: 1,
    });

    await renderMarkdownToHtml("Shared **body**.", options);
    expect(markdownAugmentCacheDiagnostics()).toMatchObject({
      retainedEntries: 0,
      unretainedCompletions: 2,
      workStarts: 2,
    });
  });

  it("recomputes retained HTML after the path membership revision changes", async () => {
    let revision = 1;
    let exists = true;
    const index: ProjectPathIndex = {
      findExisting: async (paths) => new Set(exists ? paths : []),
      has: async () => exists,
      knownFile: () => exists,
      release: () => undefined,
      sourceRevision: () => revision,
    };
    const options = {
      projectFileLinks: {
        projectId: "project-1",
        projectPath: "/workspace/project",
        index,
      },
    };

    expect(
      await renderMarkdownToHtml("See `src/server.ts`.", options),
    ).toContain('data-ya-resource="local-file"');
    revision += 1;
    exists = false;
    expect(
      await renderMarkdownToHtml("See `src/server.ts`.", options),
    ).not.toContain('data-ya-resource="local-file"');
    expect(markdownAugmentCacheDiagnostics()).toMatchObject({
      cacheHits: 0,
      retainedEntries: 1,
      workStarts: 2,
    });
  });

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
      sourceRevision: () => 1,
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
