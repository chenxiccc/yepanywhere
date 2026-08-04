import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const glossaryTermCss = readFileSync(
  fileURLToPath(
    new URL("../src/components/GlossaryTerm.module.css", import.meta.url),
  ),
  "utf8",
);

interface TextMetrics {
  containerHeight: number;
  containerWidth: number;
  rects: Array<{ height: number; width: number; x: number; y: number }>;
  text: string;
}

async function measurePhrase(page: import("@playwright/test").Page) {
  return page.locator("#sample").evaluate((container): TextMetrics => {
    const phrase = "source path";
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let textNode: Text | null = null;
    let start = -1;
    while (walker.nextNode()) {
      const candidate = walker.currentNode as Text;
      const offset = candidate.data.indexOf(phrase);
      if (offset >= 0) {
        textNode = candidate;
        start = offset;
        break;
      }
    }
    if (!textNode || start < 0) throw new Error("fixture phrase not found");

    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + phrase.length);
    const containerRect = container.getBoundingClientRect();
    return {
      containerHeight: containerRect.height,
      containerWidth: containerRect.width,
      rects: Array.from(range.getClientRects(), (rect) => ({
        height: rect.height,
        width: rect.width,
        x: rect.x,
        y: rect.y,
      })),
      text: container.textContent ?? "",
    };
  });
}

function expectMetricNeutral(after: TextMetrics, before: TextMetrics) {
  expect(after.text).toBe(before.text);
  expect(after.containerHeight).toBe(before.containerHeight);
  expect(after.containerWidth).toBe(before.containerWidth);
  expect(after.rects).toHaveLength(before.rects.length);
  for (const [index, rect] of after.rects.entries()) {
    const original = before.rects[index];
    expect(original).toBeDefined();
    if (!original) continue;
    expect(rect.height).toBe(original.height);
    expect(rect.width).toBeLessThanOrEqual(original.width);
    expect(Math.abs(rect.x - original.x)).toBeLessThanOrEqual(1 / 64);
    expect(rect.y).toBe(original.y);
  }
}

test("glossary term decoration preserves text metrics", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 360 });
  await page.setContent(`
    <style>
      :root { --link-color: #2467c4; }
      body { margin: 20px; }
      #sample {
        box-sizing: border-box;
        width: 238px;
        margin: 0;
        font: 17px/25px system-ui, sans-serif;
        letter-spacing: 0.13px;
      }
      ${glossaryTermCss}
    </style>
    <p id="sample">A compact source path example wraps near an edge.</p>
  `);

  const plain = await measurePhrase(page);
  await page.locator("#sample").evaluate((container) => {
    const textNode = container.firstChild;
    if (!(textNode instanceof Text)) throw new Error("invalid fixture");
    const phrase = "source path";
    const start = textNode.data.indexOf(phrase);
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + phrase.length);
    const wrapper = document.createElement("span");
    wrapper.className = "term";
    wrapper.dataset.glossaryTerm = "true";
    wrapper.setAttribute("role", "button");
    wrapper.tabIndex = 0;
    wrapper.title = "The project-relative path of rendered source text.";
    range.surroundContents(wrapper);
  });

  const decorated = await measurePhrase(page);
  expectMetricNeutral(decorated, plain);

  const term = page.locator("[data-glossary-term]");
  await term.hover();
  expect(await measurePhrase(page)).toEqual(decorated);
  await term.focus();
  await expect(term).toBeFocused();
  expect(await measurePhrase(page)).toEqual(decorated);
});
