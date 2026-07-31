// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const stylesheetUrl = new URL(
  "../../components/UserTurnNavigator.module.css",
  import.meta.url,
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readStylesheet(): Promise<string> {
  return readFile(stylesheetUrl, "utf8");
}

function getRuleDeclarations(css: string, selector: string): string {
  const match = new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`).exec(
    css,
  );
  expect(
    match,
    `${selector} should have a dedicated rule in UserTurnNavigator.module.css.`,
  ).not.toBeNull();
  return match?.[1] ?? "";
}

describe("turn navigation preview CSS contract", () => {
  it("keeps collapsed search previews readable with a one-line box", async () => {
    const css = await readStylesheet();
    const declarations = getRuleDeclarations(
      css,
      ".preview.searchPreview:not(.expanded)",
    );
    const compactDeclarations = getRuleDeclarations(
      css,
      ".preview.searchPreview.compact:not(.expanded)",
    );

    for (const rule of [declarations, compactDeclarations]) {
      expect(rule).toMatch(
        /height:\s*var\(--user-turn-nav-search-preview-collapsed-height,\s*15px\)\s*;/,
      );
      expect(rule).toMatch(
        /max-height:\s*var\(--user-turn-nav-search-preview-collapsed-height,\s*15px\)\s*;/,
      );
      expect(rule).toMatch(/padding:\s*0 5px\s*;/);
      expect(rule).toMatch(/font-size:\s*var\(--font-size-xs\)\s*;/);
      expect(rule).toMatch(/line-height:\s*13px\s*;/);
      expect(rule).not.toMatch(/max-height:\s*1\.25em\s*;/);
    }
  });

  it("keeps pinned search-preview expansion anchored horizontally", async () => {
    const css = await readStylesheet();
    const declarations = getRuleDeclarations(
      css,
      ".preview.expanded.pinnedExpanded",
    );

    expect(
      declarations,
      "Pinned expansion must not shift the preview left/right; moving the hitbox away from the pointer makes search-result hover flicker.",
    ).not.toMatch(/transform\s*:[^;]*translateX\s*\(/);
    expect(
      declarations,
      "Pinned expansion must not replace the base translateY with a two-axis translate; the right edge must stay under the pointer.",
    ).not.toMatch(/transform\s*:[^;]*translate\s*\(\s*[^,\s)]+/);
    expect(declarations).toMatch(/z-index:\s*3\s*;/);
  });
});
