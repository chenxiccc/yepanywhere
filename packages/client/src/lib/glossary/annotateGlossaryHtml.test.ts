import { compileGlossaryArtifact } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { annotateGlossaryHtml } from "./annotateGlossaryHtml";

function artifact() {
  const result = compileGlossaryArtifact(
    [
      {
        termMarkdown: "**published oracle**",
        definitionMarkdown: "The best published system.",
        glossaryDirectory: "",
        glossaryOrder: 0,
        rowOrder: 0,
      },
    ],
    "source-v1",
  );
  if (!result.ok) throw new Error(result.diagnostic.message);
  return result.artifact;
}

describe("annotateGlossaryHtml", () => {
  it("wraps a match without changing visible text", () => {
    const source = "<p>The published oracle wins.</p>";
    const result = annotateGlossaryHtml(source, artifact());
    const template = document.createElement("template");
    template.innerHTML = result.html;
    const term = template.content.querySelector<HTMLElement>(
      "[data-glossary-term]",
    );

    expect(result.changed).toBe(true);
    expect(template.content.textContent).toBe("The published oracle wins.");
    expect(term?.textContent).toBe("published oracle");
    expect(term?.title).toBe("published oracle: The best published system.");
    expect(term?.dataset.tooltip).toBeUndefined();
    expect(term?.tabIndex).toBe(0);
  });

  it("matches across ordinary inline formatting", () => {
    const result = annotateGlossaryHtml(
      "<p>A published <strong>oracle</strong> wins.</p>",
      artifact(),
    );
    const template = document.createElement("template");
    template.innerHTML = result.html;
    const terms = template.content.querySelectorAll("[data-glossary-term]");

    expect(terms).toHaveLength(2);
    expect(template.content.textContent).toBe("A published oracle wins.");
    expect(terms[0]?.getAttribute("tabindex")).toBe("0");
    expect(terms[0]?.getAttribute("role")).toBe("button");
    expect(terms[1]?.hasAttribute("tabindex")).toBe(false);
    expect(terms[1]?.hasAttribute("role")).toBe(false);
  });

  it("does not enter links, code, or existing tooltip owners", () => {
    const source = [
      "<p><a href='/'>published oracle</a></p>",
      "<p><code>published oracle</code></p>",
      "<p><span data-tooltip='owned'>published oracle</span></p>",
    ].join("");
    const result = annotateGlossaryHtml(source, artifact());

    expect(result).toEqual({ changed: false, html: source });
  });

  it("leaves a whole file link intact when its label contains a term", () => {
    const pathArtifact = compileGlossaryArtifact(
      [
        {
          termMarkdown: "**performance-regression-suite**",
          definitionMarkdown: "The performance regression suite.",
          glossaryDirectory: "",
          glossaryOrder: 0,
          rowOrder: 0,
        },
      ],
      "source-v2",
    );
    if (!pathArtifact.ok) throw new Error(pathArtifact.diagnostic.message);
    const path = "topics/performance-regression-suite.md";
    const source = `<a data-fixed-font-file-path="${path}" href="/file">${path}</a>`;

    const result = annotateGlossaryHtml(source, pathArtifact.artifact);

    expect(result).toEqual({ changed: false, html: source });
    expect(result.html).not.toContain("data-glossary-term");
  });

  it("does not match across block boundaries", () => {
    const result = annotateGlossaryHtml(
      "<p>published</p><p>oracle</p>",
      artifact(),
    );
    expect(result.changed).toBe(false);
  });
});
