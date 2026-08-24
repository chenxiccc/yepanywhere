// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  getSemanticHtmlClipboardPayload,
  getSemanticHtmlClipboardPayloadFromHtml,
} from "../semanticHtmlClipboard";

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

  it("builds a safe semantic payload from a detached rendered document", () => {
    const payload = getSemanticHtmlClipboardPayloadFromHtml(`<!doctype html>
      <html>
        <head><style>h1 { color: red }</style></head>
        <body>
          <h1 class="title" onclick="alert('no')">Guide</h1>
          <script>window.evil = true</script>
          <p><strong>Rich</strong> text</p>
        </body>
      </html>`);

    expect(payload?.html).toContain("<h1>Guide</h1>");
    expect(payload?.html).toContain("<p><strong>Rich</strong> text</p>");
    expect(payload?.html).not.toMatch(/script|onclick|class=|style=/);
    expect(payload?.text).toContain("Guide");
    expect(payload?.text).toContain("Rich text");
  });

  it("allows only inert semantic elements and attributes", () => {
    const payload = getSemanticHtmlClipboardPayloadFromHtml(`
      <form action="https://attacker.test/submit">
        <a href="javascript:alert('no')">linked text</a>
        <input name="secret" value="copied">
        <button formaction="https://attacker.test/button">Send</button>
      </form>
      <iframe src="https://attacker.test/embed">frame fallback</iframe>
      <img src="https://attacker.test/pixel" alt="tracking pixel">
      <table><tr><th scope="col" colspan="2" style="color:red">Safe</th></tr></table>
    `);

    expect(payload?.html).toContain("<a>linked text</a>");
    expect(payload?.html).toContain("Send");
    expect(payload?.html).toContain(
      '<table><tbody><tr><th scope="col" colspan="2">Safe</th></tr></tbody></table>',
    );
    expect(payload?.html).not.toMatch(
      /(?:href|src|action|formaction|input|button|iframe|img)=?/i,
    );
  });
});
