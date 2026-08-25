import { describe, expect, it } from "vitest";
import {
  annotateShikiSourceOffsets,
  splitHighlightedSourceAfterLine,
} from "../shikiHtml";

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

describe("splitHighlightedSourceAfterLine", () => {
  it("keeps the highlighted document shell and partitions numbered rows", () => {
    const html =
      '<pre class="shiki" style="background:#fff"><code class="language-ts"><span class="line" data-line="8">eight</span><span class="line" data-line="9">nine</span><span class="line" data-line="10">ten</span></code></pre>';

    const split = splitHighlightedSourceAfterLine(html, 9);

    expect(split).not.toBeNull();
    for (const half of [split?.before, split?.after]) {
      expect(half).toContain('class="shiki"');
      expect(half).toContain('style="background:#fff"');
      expect(half).toContain('class="language-ts"');
    }
    expect(split?.before).toContain("eight");
    expect(split?.before).toContain("nine");
    expect(split?.before).not.toContain("ten");
    expect(split?.after).not.toContain("eight");
    expect(split?.after).not.toContain("nine");
    expect(split?.after).toContain("ten");
  });

  it("declines a split when the requested row is absent", () => {
    expect(
      splitHighlightedSourceAfterLine(
        '<pre><code><span class="line" data-line="1">one</span></code></pre>',
        2,
      ),
    ).toBeNull();
  });
});
