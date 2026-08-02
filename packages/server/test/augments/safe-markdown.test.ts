import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  isLocalFilePath,
  localMediaApiUrl,
  parseMarkdownSourceSpans,
  renderSafeMarkdown,
} from "../../src/augments/safe-markdown.js";

describe("Markdown plugin dependency resolution", () => {
  it("uses YA's exact markdown-it and KaTeX runtimes", () => {
    const serverRequire = createRequire(import.meta.url);
    const pluginRequire = createRequire(
      serverRequire.resolve("@mdit/plugin-katex"),
    );

    expect(serverRequire("markdown-it/package.json").version).toBe("15.0.0");
    expect(serverRequire("katex/package.json").version).toBe("0.16.45");
    expect(realpathSync(pluginRequire.resolve("markdown-it"))).toBe(
      realpathSync(serverRequire.resolve("markdown-it")),
    );
    expect(realpathSync(pluginRequire.resolve("katex"))).toBe(
      realpathSync(serverRequire.resolve("katex")),
    );
  });
});

describe("renderSafeMarkdown — math", () => {
  it("renders inline $…$ through katex", () => {
    const html = renderSafeMarkdown("price: $x^2 + 1$ end");
    // placeholder is substituted with katex HTML
    expect(html).not.toContain("yepkatex-placeholder");
    expect(html).toContain('class="katex"');
    expect(html).toContain("end</p>");
  });

  it("renders block $$…$$ in display mode", () => {
    const html = renderSafeMarkdown("$$\n\\frac{1}{2}\n$$");
    expect(html).toContain("katex-display");
    expect(html).not.toContain("yepkatex-placeholder");
  });

  it("renders bracket-delimited inline and display math through katex", () => {
    const html = renderSafeMarkdown(String.raw`
For each token \(t\), it formed only a local emission score:

\[
e_t(y)=(Wh_t+b)_y
\]
`);

    expect(html.match(/class="katex"/g)).toHaveLength(2);
    expect(html).toContain('class="katex-display"');
    expect(html).toContain('class="msupsub"');
    expect(html).not.toContain("\\(t\\)");
    expect(html).not.toContain("\\[");
  });

  it("keeps escaped, empty, and unclosed bracket delimiters literal", () => {
    const escaped = renderSafeMarkdown(String.raw`literal \\(x\\) and \\[y\\]`);
    const empty = renderSafeMarkdown("\\[\n\n\\]");
    const unclosed = renderSafeMarkdown(String.raw`unclosed \(x`);

    expect(escaped).not.toContain('class="katex"');
    expect(empty).not.toContain('class="katex"');
    expect(unclosed).not.toContain('class="katex"');
  });

  it("keeps unclosed display-math delimiters literal", () => {
    const dollars = renderSafeMarkdown("$$\nx + y");
    const brackets = renderSafeMarkdown("\\[\nx + y");

    expect(dollars).not.toContain('class="katex"');
    expect(dollars).toContain("$$");
    expect(brackets).not.toContain('class="katex"');
    expect(brackets).toContain("x + y");
  });

  it("does not close bracketed math at escaped closing delimiters", () => {
    const html = renderSafeMarkdown(String.raw`
\[
x \\] + y
\]
`);

    expect(html.match(/class="katex"/g)).toHaveLength(1);
    expect(html).toContain('class="katex-display"');
    expect(html).not.toContain("<p>+ y");
  });

  it("keeps bracket delimiters literal inside code", () => {
    const html = renderSafeMarkdown(
      "inline `\\(x_t\\)`\n\n```text\n\\[\nx_t\n\\]\n```",
    );

    expect(html).not.toContain('class="katex"');
    expect(html).toContain("<code>\\(x_t\\)</code>");
    expect(html).toContain("\\[\nx_t\n\\]");
  });

  it("does not treat currency-like $100 and $200 as math", () => {
    const html = renderSafeMarkdown("price is $100 and $200 total");
    expect(html).not.toContain("katex");
    expect(html).toContain("$100");
    expect(html).toContain("$200");
  });

  it("does not treat $ with trailing space as inline math", () => {
    const html = renderSafeMarkdown("single dollar $ followed by text$");
    expect(html).not.toContain("katex");
  });

  it("escapes katex-invalid input as an error span rather than crashing", () => {
    const html = renderSafeMarkdown("bad: $\\undefinedmacro{x}$ done");
    // katex prints the error span itself (has class "katex-error") when
    // throwOnError: false; our sanitize pass strips style attrs it
    // disallows but keeps span+class.
    expect(html).toContain("done");
  });

  it("blocks javascript: hrefs in katex \\href (trust: false)", () => {
    // If trust were left enabled, \href could emit a dangerous link.
    const html = renderSafeMarkdown("$\\href{javascript:alert(1)}{x}$");
    // The rendered output must not produce an executable link href.
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it("still renders non-math markdown unchanged", () => {
    const html = renderSafeMarkdown("**bold** and `code`");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
  });

  it("links existing project files in assistant inline code", () => {
    const html = renderSafeMarkdown(
      "See `topics/security.md:12` and `topics/missing.md`.",
      {
        projectFileLinks: {
          projectId: "project-1",
          projectPath: "/workspace/project",
          fileExists: (_absolutePath, relativePath) =>
            relativePath === "topics/security.md",
        },
      },
    );

    expect(html).toContain(
      'href="/projects/project-1/file?path=topics%2Fsecurity.md&amp;line=12"',
    );
    expect(html).toContain('class="fixed-font-file-link"');
    expect(html).toContain('data-ya-resource="project-file"');
    expect(html).toContain('data-ya-project-id="project-1"');
    expect(html).toContain('data-ya-path="topics/security.md"');
    expect(html).toContain('data-ya-line="12"');
    expect(html).toContain('data-ya-private-project-file-link="true"');
    expect(html).toContain("<code>topics/security.md:12</code>");
    expect(html).toContain("<code>topics/missing.md</code>");
    expect(html).not.toContain("topics%2Fmissing.md");
  });

  it("leaves inline code unlinked without authenticated project context", () => {
    const html = renderSafeMarkdown("See `topics/security.md`.");

    expect(html).toContain("<code>topics/security.md</code>");
    expect(html).not.toContain("/projects/");
    expect(html).not.toContain("fixed-font-file-link");
  });

  it("strips inline HTML in surrounding prose", () => {
    const html = renderSafeMarkdown("plain <script>bad()</script> $y$ end");
    expect(html).not.toContain("<script>");
    expect(html).toContain('class="katex"');
  });

  it("handles multiple inline math spans in a single call", () => {
    const html = renderSafeMarkdown("$a$ and $b$ and $c$");
    // three independent katex renders
    const count = (html.match(/class="katex"/g) ?? []).length;
    expect(count).toBe(3);
  });

  it("renders inline math inside markdown list items", () => {
    const html = renderSafeMarkdown("- first $x^2$\n- second $y^2$");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>first ");
    const count = (html.match(/class="katex"/g) ?? []).length;
    expect(count).toBe(2);
  });

  it("renders inline math inside markdown table cells", () => {
    const html = renderSafeMarkdown(
      "| expr | value |\n| --- | --- |\n| $x^2$ | $\\frac{1}{2}$ |",
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<td>");
    const count = (html.match(/class="katex"/g) ?? []).length;
    expect(count).toBe(2);
  });

  it("does not leave rendered formulas HTML-escaped in markdown output", () => {
    const html = renderSafeMarkdown("row: $x^2$");
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("&lt;span class=&quot;katex&quot;");
    expect(html).not.toContain("$x^2$");
  });
});

describe("parseMarkdownSourceSpans", () => {
  it("maps headings, table rows, references, and math to exact source lines", () => {
    const markdown = [
      "# Heading",
      "",
      "paragraph",
      "",
      "| a | b |",
      "| - | - |",
      "| c | d |",
      "",
      "[later][ref]",
      "",
      "[ref]: https://example.com",
      "",
      "\\[",
      "x + y",
      "\\]",
    ].join("\n");

    const spans = parseMarkdownSourceSpans(markdown);
    expect(
      spans
        .filter((span) =>
          [
            "heading_open",
            "paragraph_open",
            "table_open",
            "tr_open",
            "reference_definition",
            "math_block",
          ].includes(span.type),
        )
        .map(({ type, startLine, endLine }) => ({ type, startLine, endLine })),
    ).toEqual([
      { type: "heading_open", startLine: 1, endLine: 1 },
      { type: "paragraph_open", startLine: 3, endLine: 3 },
      { type: "table_open", startLine: 5, endLine: 7 },
      { type: "tr_open", startLine: 5, endLine: 5 },
      { type: "tr_open", startLine: 7, endLine: 7 },
      { type: "paragraph_open", startLine: 9, endLine: 9 },
      { type: "reference_definition", startLine: 11, endLine: 11 },
      { type: "math_block", startLine: 13, endLine: 15 },
    ]);
  });

  it("keeps one-based line maps accurate across CRLF and Unicode", () => {
    const spans = parseMarkdownSourceSpans("α heading\r\n\r\nβ paragraph\r\n");
    const paragraphs = spans.filter((span) => span.type === "paragraph_open");

    expect(paragraphs).toMatchObject([
      { startLine: 1, endLine: 1 },
      { startLine: 3, endLine: 3 },
    ]);
  });
});

const MARKDOWN_PERF_CHUNK = [
  "## Representative heading",
  "",
  "A paragraph with **bold**, `code`, and https://example.com/path?q=1.",
  "",
  "- first list item",
  "- second list item",
  "",
  "| name | value |",
  "| --- | ---: |",
  "| alpha | 123 |",
  "",
].join("\n");

function markdownFixture(bytes: number): string {
  return MARKDOWN_PERF_CHUNK.repeat(
    Math.ceil(bytes / MARKDOWN_PERF_CHUNK.length),
  ).slice(0, bytes);
}

function p95Milliseconds(operation: () => void, samples: number): number {
  const timings: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    operation();
    timings.push(performance.now() - startedAt);
  }
  timings.sort((left, right) => left - right);
  return timings[Math.ceil(timings.length * 0.95) - 1] ?? 0;
}

describe("Markdown performance smoke", () => {
  it("keeps positioned parsing and safe rendering within regression budgets", () => {
    const cases = [
      { bytes: 16 * 1024, samples: 7, parseBudgetMs: 30, renderBudgetMs: 120 },
      {
        bytes: 256 * 1024,
        samples: 5,
        parseBudgetMs: 250,
        renderBudgetMs: 1000,
      },
    ];

    for (const testCase of cases) {
      const markdown = markdownFixture(testCase.bytes);
      parseMarkdownSourceSpans(markdown);
      renderSafeMarkdown(markdown);

      const parseP95Ms = p95Milliseconds(
        () => parseMarkdownSourceSpans(markdown),
        testCase.samples,
      );
      const renderP95Ms = p95Milliseconds(
        () => renderSafeMarkdown(markdown),
        testCase.samples,
      );

      console.info(
        `MARKDOWN_PERF: bytes=${testCase.bytes} parse_p95_ms=${parseP95Ms.toFixed(2)} render_p95_ms=${renderP95Ms.toFixed(2)}`,
      );
      expect(parseP95Ms).toBeLessThan(testCase.parseBudgetMs);
      expect(renderP95Ms).toBeLessThan(testCase.renderBudgetMs);
    }
  }, 15_000);
});

describe("renderSafeMarkdown — local file links", () => {
  it("routes local markdown links through the rendered text file endpoint", () => {
    const html = renderSafeMarkdown("[notes](/tmp/session-notes.md)");

    expect(html).toContain(
      'href="/api/local-file?path=%2Ftmp%2Fsession-notes.md&amp;render=1"',
    );
    expect(html).toContain('data-ya-resource="local-file"');
    expect(html).toContain('data-ya-path="/tmp/session-notes.md"');
    expect(html).toContain('data-ya-render-markdown="true"');
    expect(html).not.toContain("/api/local-image");
  });

  it("keeps line hints out of local markdown link paths", () => {
    const html = renderSafeMarkdown("[notes](/tmp/session-notes.md:8)");

    expect(html).toContain(
      'href="/api/local-file?path=%2Ftmp%2Fsession-notes.md&amp;render=1&amp;line=8"',
    );
    expect(html).toContain('title="/tmp/session-notes.md:8"');
    expect(html).toContain('data-ya-line="8"');
    expect(html).not.toContain("session-notes.md%3A8");
  });

  it("adds semantic metadata to local text file links", () => {
    const html = renderSafeMarkdown(
      "[probe json](C:/tmp/playbox-zero-g-compare.json:12:4)",
    );

    expect(html).toContain(
      'href="/api/local-file?path=C%3A%2Ftmp%2Fplaybox-zero-g-compare.json&amp;line=12&amp;column=4"',
    );
    expect(html).toContain('data-ya-resource="local-file"');
    expect(html).toContain('data-ya-path="C:/tmp/playbox-zero-g-compare.json"');
    expect(html).toContain('data-ya-line="12"');
    expect(html).toContain('data-ya-column="4"');
    expect(html).toContain('data-ya-render-markdown="false"');
  });

  it("keeps local media links on the media endpoint", () => {
    const html = renderSafeMarkdown("[shot](/tmp/screenshot.png)");

    expect(html).toContain(
      'href="/api/local-image?path=%2Ftmp%2Fscreenshot.png"',
    );
    expect(html).toContain('class="local-media-link"');
    expect(html).toContain('class="local-media-inline-toggle"');
    expect(html).toContain('class="local-media-inline-preview"');
    expect(html).toContain('data-expanded="false"');
    expect(html).toContain('aria-label="Expand image"');
    expect(html).toContain('data-ya-resource="local-media"');
    expect(html).toContain('data-ya-path="/tmp/screenshot.png"');
    expect(html).toContain('data-ya-media-type="image"');
  });

  it("starts local video media placeholders collapsed", () => {
    const html = renderSafeMarkdown("[clip](/tmp/demo.mp4)");

    expect(html).toContain('href="/api/local-image?path=%2Ftmp%2Fdemo.mp4"');
    expect(html).toContain('class="local-media-link"');
    expect(html).toContain('data-media-type="video"');
    expect(html).toContain('data-expanded="false"');
    expect(html).toContain('aria-label="Expand video"');
    expect(html).toContain('data-ya-media-type="video"');
  });

  it("resolves relative local file links against a base directory", () => {
    const html = renderSafeMarkdown("[peer](docs/peer.md)", {
      localFileBasePath: "/workspace/project",
    });

    expect(html).toContain(
      'href="/api/local-file?path=%2Fworkspace%2Fproject%2Fdocs%2Fpeer.md&amp;render=1"',
    );
    expect(html).toContain('title="/workspace/project/docs/peer.md"');
    expect(html).toContain('data-ya-path="/workspace/project/docs/peer.md"');
  });

  it("preserves line hints on relative local file links", () => {
    const html = renderSafeMarkdown("[peer](docs/peer.md:12)", {
      localFileBasePath: "/workspace/project",
    });

    expect(html).toContain(
      'href="/api/local-file?path=%2Fworkspace%2Fproject%2Fdocs%2Fpeer.md&amp;render=1&amp;line=12"',
    );
    expect(html).toContain('title="/workspace/project/docs/peer.md:12"');
  });

  it("resolves relative local images as inline media placeholders", () => {
    const html = renderSafeMarkdown("![diagram](assets/diagram.svg)", {
      localFileBasePath: "/workspace/project/docs",
    });

    expect(html).toContain(
      'href="/api/local-image?path=%2Fworkspace%2Fproject%2Fdocs%2Fassets%2Fdiagram.svg"',
    );
    expect(html).toContain(
      'data-media-path="/workspace/project/docs/assets/diagram.svg"',
    );
    expect(html).toContain('class="local-media-inline-preview"');
  });

  it("can emit direct local images for standalone rendered documents", () => {
    const html = renderSafeMarkdown("![diagram](assets/diagram.svg)", {
      localFileBasePath: "/workspace/project/docs",
      inlineLocalImages: true,
    });

    expect(html).toContain(
      '<img src="/api/local-image?path=%2Fworkspace%2Fproject%2Fdocs%2Fassets%2Fdiagram.svg" alt="diagram"',
    );
    expect(html).toContain(
      'data-ya-path="/workspace/project/docs/assets/diagram.svg"',
    );
    expect(html).toContain('data-ya-resource="local-media"');
    expect(html).not.toContain("local-media-inline-preview");
  });

  it("rewrites Windows drive paths with forward slashes to local media links", () => {
    const html = renderSafeMarkdown(
      "[Sample image](C:/tmp/playbox-autocollider-provider-fit.png)",
    );

    expect(html).toContain('class="local-media-link"');
    expect(html).toContain('data-media-type="image"');
    expect(html).toContain(
      "path=C%3A%2Ftmp%2Fplaybox-autocollider-provider-fit.png",
    );
  });

  it("recognizes Windows drive paths with backslashes", () => {
    const filePath = String.raw`C:\tmp\playbox-autocollider-provider-fit.png`;

    expect(isLocalFilePath(filePath)).toBe(true);
    expect(localMediaApiUrl(filePath)).toBe(
      "/api/local-image?path=C%3A%5Ctmp%5Cplaybox-autocollider-provider-fit.png",
    );
  });

  it("repairs backslash drive paths before Markdown consumes escapes", () => {
    const html = renderSafeMarkdown(
      String.raw`[capture](D:\repo\.artifacts\ui-testing\capture.png)`,
    );

    expect(html).toContain(
      "path=D%3A%2Frepo%2F.artifacts%2Fui-testing%2Fcapture.png",
    );
    expect(html).toContain(
      'data-ya-path="D:/repo/.artifacts/ui-testing/capture.png"',
    );
    expect(html).not.toContain("repo.artifacts");
  });

  it("repairs angle-enclosed image paths with spaces on any drive", () => {
    const html = renderSafeMarkdown(
      String.raw`![capture](<E:\folder with spaces\.artifacts\capture.png>)`,
    );

    expect(html).toContain(
      "path=E%3A%2Ffolder%20with%20spaces%2F.artifacts%2Fcapture.png",
    );
    expect(html).toContain(
      'data-ya-path="E:/folder with spaces/.artifacts/capture.png"',
    );
  });

  it("preserves line hints and titles on repaired local-file links", () => {
    const html = renderSafeMarkdown(
      String.raw`[report](F:\repo\.artifacts\report.md:12:4 "details")`,
    );

    expect(html).toContain(
      "path=F%3A%2Frepo%2F.artifacts%2Freport.md&amp;render=1&amp;line=12&amp;column=4",
    );
    expect(html).toContain('title="details"');
    expect(html).toContain('data-ya-line="12"');
    expect(html).toContain('data-ya-column="4"');
  });

  it("repairs drive paths supplied by reference definitions", () => {
    const html = renderSafeMarkdown(String.raw`[capture][artifact]

[artifact]: G:\repo\.artifacts\capture.png`);

    expect(html).toContain("path=G%3A%2Frepo%2F.artifacts%2Fcapture.png");
    expect(html).toContain('data-ya-path="G:/repo/.artifacts/capture.png"');
  });

  it("does not rewrite Windows-looking links inside code", () => {
    const markdown = [
      "Inline: `[capture](H:\\repo\\.artifacts\\capture.png)`",
      "",
      "```text",
      "[capture](H:\\repo\\.artifacts\\capture.png)",
      "```",
    ].join("\n");
    const html = renderSafeMarkdown(markdown);

    expect(html).toContain(
      String.raw`<code>[capture](H:\repo\.artifacts\capture.png)</code>`,
    );
    expect(html).toContain(
      String.raw`[capture](H:\repo\.artifacts\capture.png)`,
    );
    expect(html).not.toContain("/api/local-image?path=H");
  });

  it("does not broaden drive-path handling to UNC paths", () => {
    const html = renderSafeMarkdown(
      String.raw`[capture](\\server\share\.artifacts\capture.png)`,
    );

    expect(html).not.toContain("/api/local-image");
    expect(html).not.toContain("data-ya-resource");
  });
});
