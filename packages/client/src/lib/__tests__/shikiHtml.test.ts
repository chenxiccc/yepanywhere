import { describe, expect, it } from "vitest";
import { annotateShikiSourceOffsets } from "../shikiHtml";

describe("annotateShikiSourceOffsets", () => {
  it("carries exact line and token offsets through compact Shiki HTML", () => {
    const source = 'const x = "<";\nreturn x;';
    const html =
      '<pre class="shiki"><code><span class="line"><span>const</span> x = <span>"&lt;"</span>;</span>\n<span class="line"><span>return</span> x;</span></code></pre>';
    const template = document.createElement("template");
    template.innerHTML = annotateShikiSourceOffsets(html, source) ?? "";

    const lines = template.content.querySelectorAll<HTMLElement>(".line");
    expect(lines[0]?.dataset.yaSourceStart).toBe("0");
    expect(lines[0]?.dataset.yaSourceEnd).toBe("14");
    expect(lines[1]?.dataset.yaSourceStart).toBe("15");
    expect(lines[1]?.dataset.yaSourceEnd).toBe("24");
    const tokens =
      template.content.querySelectorAll<HTMLElement>(".line > span");
    expect(
      Array.from(tokens).map((token) => [
        token.textContent,
        token.dataset.yaSourceStart,
        token.dataset.yaSourceEnd,
      ]),
    ).toEqual([
      ["const", "0", "5"],
      ['"<"', "10", "13"],
      ["return", "15", "21"],
    ]);
  });
});
