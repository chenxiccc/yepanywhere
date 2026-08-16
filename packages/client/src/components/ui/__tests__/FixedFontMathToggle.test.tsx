import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UI_KEYS } from "../../../lib/storageKeys";
import {
  FixedFontMathToggle,
  mayHaveFixedFontRichContent,
  renderFixedFontMath,
  renderFixedFontRichContent,
} from "../FixedFontMathToggle";

describe("FixedFontMathToggle", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.removeItem(UI_KEYS.tooltipMode);
  });

  it("uses a precomputed render result for toggle state and display", () => {
    render(
      <FixedFontMathToggle
        sourceText="plain text"
        precomputedRendered={{
          html: "<strong>precomputed</strong>",
          changed: true,
        }}
        sourceView={<pre>plain text</pre>}
        renderRenderedView={(html) => (
          <div
            // biome-ignore lint/security/noDangerouslySetInnerHtml: test-controlled precomputed HTML
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      />,
    );

    expect(screen.getByText("precomputed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show source" })).toBeTruthy();
  });

  it("uses exclusive concise tooltip attributes for rendered file links", () => {
    window.localStorage.setItem(UI_KEYS.tooltipMode, "native");
    render(
      <FixedFontMathToggle
        sourceText="[notes](docs/notes.md)"
        precomputedRendered={{
          html: '<a href="/notes" data-fixed-font-file-path="docs/notes.md" data-tooltip="docs/notes.md">notes</a>',
          changed: true,
        }}
        sourceView={<pre>[notes](docs/notes.md)</pre>}
        renderRenderedView={(html) => (
          <div
            // biome-ignore lint/security/noDangerouslySetInnerHtml: test-controlled precomputed HTML
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      />,
    );

    const link = screen.getByRole("link", { name: "notes" });
    expect(link.getAttribute("title")).toBe("docs/notes.md");
    expect(link.getAttribute("data-tooltip")).toBeNull();
  });
});

describe("fixed-font LaTeX delimiters", () => {
  const bracketedMath = [
    "Let \\(R=\\max S_{\\text{read}}\\).",
    "",
    "\\[",
    "(R+1)+(L-1-W)",
    "\\]",
  ].join("\n");

  it("renders bracketed inline and display math in math-only mode", () => {
    const rendered = renderFixedFontMath(bracketedMath);

    expect(rendered.changed).toBe(true);
    expect(rendered.html).toContain('class="katex"');
    expect(rendered.html).toContain('class="katex-display"');
    expect(rendered.html).not.toContain("\\(R=");
    expect(rendered.html).not.toContain("\\[");
  });

  it("renders multiline bracketed display math in rich mode", () => {
    const rendered = renderFixedFontRichContent(bracketedMath);

    expect(rendered.changed).toBe(true);
    expect(rendered.html).toContain('class="katex-display"');
    expect(rendered.html).not.toContain("\\[");
    expect(rendered.html).not.toContain("\\]");
  });

  it("renders bracketed display math within one diff lane", () => {
    const diff = [
      "-\\[",
      "-e_t(y)=old_t",
      "-\\]",
      "+\\[",
      "+e_t(y)=(Wh_t+b)_y",
      "+\\]",
    ].join("\n");
    const rendered = renderFixedFontMath(diff, { diffAware: true });

    expect(rendered.changed).toBe(true);
    expect(rendered.html.match(/class="katex-display"/g)).toHaveLength(2);
    expect(rendered.html).toContain(
      "fixed-font-rendered-line fixed-font-diff-removed",
    );
    expect(rendered.html).toContain(
      "fixed-font-rendered-line fixed-font-diff-added",
    );
    expect(rendered.html).not.toContain("+e_t");
  });

  it("leaves display math literal when its diff lanes are mixed", () => {
    const rendered = renderFixedFontMath(
      ["+\\[", "-e_t(y)=old_t", "+\\]"].join("\n"),
      { diffAware: true },
    );

    expect(rendered.html).not.toContain('class="katex-display"');
    expect(rendered.html).toContain("\\[");
    expect(rendered.html).toContain("e_t(y)=old_t");
    expect(rendered.html).toContain("\\]");
  });

  it("does not treat escaped or unclosed bracket delimiters as math", () => {
    expect(renderFixedFontMath(String.raw`literal \\(x\\)`)).toMatchObject({
      changed: false,
    });
    expect(renderFixedFontMath(String.raw`unclosed \(x`)).toMatchObject({
      changed: false,
    });
    expect(renderFixedFontMath("\\[\n\n\\]")).toMatchObject({
      changed: false,
    });
  });
});

describe("mayHaveFixedFontRichContent", () => {
  it("rejects plain output without running the rich renderer", () => {
    expect(mayHaveFixedFontRichContent("plain output\nwithout markup")).toBe(
      false,
    );
  });

  it("accepts common markdown and math candidates conservatively", () => {
    expect(mayHaveFixedFontRichContent("## Heading")).toBe(true);
    expect(mayHaveFixedFontRichContent("value is $x^2$")).toBe(true);
    expect(mayHaveFixedFontRichContent("value is \\(x^2\\)")).toBe(true);
    expect(mayHaveFixedFontRichContent("\\[\nx^2\n\\]")).toBe(true);
    expect(mayHaveFixedFontRichContent("| a | b |\n| - | - |")).toBe(true);
  });
});

describe("fixed-font file-link hints", () => {
  it("omits redundant click instructions", () => {
    const rendered = renderFixedFontRichContent("[notes](docs/notes.md)", {
      projectId: "project-1",
    });

    expect(rendered.html).toContain('data-tooltip="/docs/notes.md"');
    expect(rendered.html).not.toContain("Click to view");
    expect(rendered.html).not.toContain("middle-click");
  });

  it("links a server-confirmed bare path as one exact anchor", () => {
    const path = "topics/performance-regression-suite.md";
    const rendered = renderFixedFontRichContent(
      `228 ${path}\nwc: topics/commits.md: missing`,
      {
        projectId: "project-1",
        projectPathLinks: [{ filePath: path, text: path }],
      },
    );
    const template = document.createElement("template");
    template.innerHTML = rendered.html;
    const links = template.content.querySelectorAll(
      "a[data-fixed-font-file-path]",
    );

    expect(rendered.changed).toBe(true);
    expect(links).toHaveLength(1);
    expect(links[0]?.textContent).toBe(path);
    expect(links[0]?.getAttribute("data-fixed-font-file-path")).toBe(path);
    expect(template.content.textContent).toContain("topics/commits.md");
  });
});
