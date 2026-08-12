// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { getSemanticHtmlClipboardPayload } from "../semanticHtmlClipboard";

describe("getSemanticHtmlClipboardPayload", () => {
  it("keeps semantic markup while removing viewer presentation", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<p class="rendered" style="color: red"><strong>Rich</strong> text <span class="katex-html">visual math</span></p>';
    document.body.append(root);
    const paragraph = root.querySelector("p");
    expect(paragraph).toBeTruthy();
    const range = document.createRange();
    range.selectNode(paragraph as HTMLParagraphElement);

    expect(getSemanticHtmlClipboardPayload(root, [range])).toEqual({
      html: "<p><strong>Rich</strong> text </p>",
      text: "Rich text ",
    });

    root.remove();
  });

  it("rejects a stored range outside the owning selection root", () => {
    const root = document.createElement("div");
    const outside = document.createElement("p");
    root.textContent = "inside";
    outside.textContent = "outside";
    document.body.append(root, outside);
    const range = document.createRange();
    range.selectNodeContents(outside);

    expect(getSemanticHtmlClipboardPayload(root, [range])).toBeNull();

    root.remove();
    outside.remove();
  });
});
