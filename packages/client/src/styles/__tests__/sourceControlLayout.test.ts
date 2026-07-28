// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const indexStylesheetUrl = new URL("../index.css", import.meta.url);
const rendererStylesheetUrl = new URL("../renderers.css", import.meta.url);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getLastRuleDeclarations(css: string, selector: string): string {
  const matches = [
    ...css.matchAll(
      new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`, "g"),
    ),
  ];
  expect(matches.length, `${selector} should have a CSS rule`).toBeGreaterThan(
    0,
  );
  return matches.at(-1)?.[1] ?? "";
}

function getRuleDeclarationsContaining(
  css: string,
  selector: string,
  needle: string,
): string {
  const matches = [
    ...css.matchAll(
      new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`, "g"),
    ),
  ].filter((match) => match[1]?.includes(needle));
  expect(
    matches.length,
    `${selector} should have a CSS rule containing ${needle}`,
  ).toBeGreaterThan(0);
  return matches.at(-1)?.[1] ?? "";
}

describe("Source Control workbench layout CSS contract", () => {
  it("uses the full page and flexible detail tracks", async () => {
    const [indexCss, rendererCss] = await Promise.all([
      readFile(indexStylesheetUrl, "utf8"),
      readFile(rendererStylesheetUrl, "utf8"),
    ]);

    const page = getLastRuleDeclarations(
      indexCss,
      ".main-content-constrained.source-control-main-content .page-content-inner",
    );
    expect(page).toMatch(/max-width:\s*none\s*;/);
    expect(page).toMatch(/margin:\s*0\s*;/);

    for (const selector of [
      ".commit-browser-columns",
      ".working-tree-browser-columns",
      ".blame-browser-columns",
    ]) {
      const grid = getRuleDeclarationsContaining(
        rendererCss,
        selector,
        "grid-template-columns",
      );
      expect(grid).toMatch(/minmax\(0,\s*1fr\)/);
      expect(grid).not.toContain("--content-max-width");
    }
  });

  it("fills the remaining wide-page height with internally scrolling panes", async () => {
    const [indexCss, rendererCss] = await Promise.all([
      readFile(indexStylesheetUrl, "utf8"),
      readFile(rendererStylesheetUrl, "utf8"),
    ]);

    const page = getLastRuleDeclarations(
      indexCss,
      ".source-control-main-content > .page-scroll-container > .page-content-inner",
    );
    expect(page).toMatch(/height:\s*100%\s*;/);
    expect(page).toMatch(/display:\s*flex\s*;/);
    expect(page).toMatch(/min-height:\s*0\s*;/);

    const status = getLastRuleDeclarations(
      indexCss,
      ".source-control-main-content .git-status",
    );
    expect(status).toMatch(/flex:\s*1\s*;/);
    expect(status).toMatch(/min-height:\s*0\s*;/);

    const lists = getLastRuleDeclarations(
      rendererCss,
      ".commit-list-column,\n  .commit-files-column,\n  .working-tree-files-column",
    );
    expect(lists).toMatch(/overflow-y:\s*auto\s*;/);
    expect(lists).not.toMatch(/max-height:\s*calc\(100vh/);

    const diff = getLastRuleDeclarations(
      indexCss,
      ".source-control-main-content .git-diff-preview-pane",
    );
    expect(diff).toMatch(/height:\s*100%\s*;/);
    expect(diff).toMatch(/max-height:\s*none\s*;/);

    const blame = getLastRuleDeclarations(
      rendererCss,
      ".blame-browser-columns > .blame-view",
    );
    expect(blame).toMatch(/height:\s*100%\s*;/);
    expect(blame).toMatch(/max-height:\s*none\s*;/);
  });

  it("keeps the authored diff gutter compact", async () => {
    const css = await readFile(rendererStylesheetUrl, "utf8");
    const diff = getRuleDeclarationsContaining(
      css,
      ".source-diff-pane",
      "--source-diff-gutter-width",
    );

    expect(diff).toMatch(/--source-diff-gutter-width:\s*1rem\s*;/);
    expect(diff).toMatch(/--source-diff-line-inline-inset:\s*0\.375rem\s*;/);
    expect(diff).toMatch(/--source-diff-gutter-content-gap:\s*0\.375rem\s*;/);
  });
});
