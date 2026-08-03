// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const indexStylesheetUrl = new URL("../index.css", import.meta.url);
const rendererStylesheetUrl = new URL("../renderers.css", import.meta.url);
const sourceModeTabsStylesheetUrl = new URL(
  "../../pages/SourceModeTabs.module.css",
  import.meta.url,
);
const blameViewStylesheetUrl = new URL(
  "../../pages/BlameView.module.css",
  import.meta.url,
);
const gitStatusPageStylesheetUrl = new URL(
  "../../pages/GitStatusPage.module.css",
  import.meta.url,
);

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
      ".diff-gutter-aligned",
      "--diff-gutter-width",
    );

    expect(diff).toMatch(/--diff-gutter-width:\s*1rem\s*;/);
    expect(diff).toMatch(/--diff-line-inline-inset:\s*0\.375rem\s*;/);
    expect(diff).toMatch(/--diff-gutter-content-gap:\s*0\.375rem\s*;/);
  });

  it("keeps frequent repository actions left-anchored and width-stable", async () => {
    const [indexCss, rendererCss] = await Promise.all([
      readFile(indexStylesheetUrl, "utf8"),
      readFile(rendererStylesheetUrl, "utf8"),
    ]);
    const actionGroup = getLastRuleDeclarations(
      rendererCss,
      ".source-control-action-row .repo-status-action-group",
    );
    const review = getLastRuleDeclarations(
      rendererCss,
      ".source-control-action-row .review-tray-button",
    );
    const indicator = getRuleDeclarationsContaining(
      indexCss,
      ".git-status-action-indicator",
      "width",
    );
    const projectSelector = getRuleDeclarationsContaining(
      indexCss,
      ".source-header-identity .project-selector-container",
      "flex",
    );
    const projectSelectorButton = getRuleDeclarationsContaining(
      indexCss,
      ".source-header-identity .project-selector-button",
      "max-width",
    );

    expect(actionGroup).toMatch(/width:\s*100%\s*;/);
    expect(review).toMatch(/margin-left:\s*auto\s*;/);
    expect(indicator).toMatch(/width:\s*0\.75rem\s*;/);
    expect(indicator).toMatch(/flex:\s*0\s+0\s+0\.75rem\s*;/);
    expect(projectSelector).toMatch(/flex:\s*0\s+0\s+auto\s*;/);
    expect(projectSelectorButton).toMatch(
      /max-width:\s*calc\(100%\s*\+\s*2\s*\*\s*var\(--space-2\)\)\s*;/,
    );
  });

  it("wraps header navigation from intrinsic content demand", async () => {
    const css = await readFile(gitStatusPageStylesheetUrl, "utf8");
    // Placement follows rendered width, so no viewport threshold decides
    // whether identity and mode navigation share the header row.
    const header = getLastRuleDeclarations(
      css,
      ".sourceHeader :global(.session-header-inner)",
    );
    const identity = getLastRuleDeclarations(
      css,
      ".sourceHeader :global(.session-header-left)",
    );
    const actions = getLastRuleDeclarations(
      css,
      ".sourceHeader :global(.session-header-actions)",
    );

    expect(header).toMatch(/flex-wrap:\s*wrap\s*;/);
    expect(identity).toMatch(/flex:\s*1\s+1\s+max-content\s*;/);
    expect(actions).toMatch(/flex:\s*1\s+0\s+max-content\s*;/);
    expect(actions).toMatch(/max-width:\s*100%\s*;/);
  });

  it("keeps the unified Changes revision control usable at phone width", async () => {
    const [indexCss, rendererCss, sourceModeTabsCss] = await Promise.all([
      readFile(indexStylesheetUrl, "utf8"),
      readFile(rendererStylesheetUrl, "utf8"),
      readFile(sourceModeTabsStylesheetUrl, "utf8"),
    ]);
    // `SourceModeTabs` owns the stacked phone layout as a module variant; the
    // page only chooses it with `variant="stacked"`.
    const mobileTabs = getLastRuleDeclarations(
      sourceModeTabsCss,
      ".tabs.stacked",
    );
    const historyParentLink = getLastRuleDeclarations(
      rendererCss,
      ".source-history-parent-link",
    );
    const cleanLanding = getLastRuleDeclarations(
      indexCss,
      ".working-tree-clean-landing",
    );
    // The action row keeps every button at its label width; only the longest
    // label gives up space, so no track may stretch to absorb the slack.
    const actionGroupRules = [
      ...rendererCss.matchAll(
        /\.source-control-action-row \.repo-status-action-group\s*\{([^}]*)\}/g,
      ),
    ].map((match) => match[1] ?? "");
    const checkRemote = getLastRuleDeclarations(
      rendererCss,
      ".source-control-action-row .git-status-check-remote .git-status-action-label",
    );

    expect(mobileTabs).toMatch(
      /grid-auto-columns:\s*minmax\(0,\s*1fr\)\s*;/,
    );
    expect(mobileTabs).toMatch(/grid-auto-flow:\s*column\s*;/);
    expect(actionGroupRules.length).toBeGreaterThan(0);
    for (const rule of actionGroupRules) {
      expect(rule).not.toMatch(/1fr/);
    }
    expect(checkRemote).toMatch(/min-width:\s*0\s*;/);
    expect(checkRemote).toMatch(/text-overflow:\s*ellipsis\s*;/);
    expect(historyParentLink).toMatch(/display:\s*flex\s*;/);
    expect(historyParentLink).toMatch(/width:\s*100%\s*;/);
    expect(cleanLanding).toMatch(/min-height:\s*min\(24rem,\s*48vh\)\s*;/);
    expect(cleanLanding).not.toMatch(/max-width:/);
  });

  it("prioritizes the filename and uses compact diff controls", async () => {
    const css = await readFile(rendererStylesheetUrl, "utf8");
    const identity = getRuleDeclarationsContaining(
      css,
      ".git-diff-file-identity",
      "min-width",
    );
    const title = getLastRuleDeclarations(
      css,
      ".git-diff-pane-toolbar .git-diff-preview-title",
    );
    const path = getLastRuleDeclarations(css, ".git-diff-toolbar-path");
    const icon = getLastRuleDeclarations(css, ".diff-toolbar-icon-button");
    const hunk = getLastRuleDeclarations(css, ".diff-hunk-indicator");

    expect(identity).toMatch(/min-width:\s*0\s*;/);
    expect(title).toMatch(/font-size:\s*0\.74rem\s*;/);
    expect(path).toMatch(/flex:\s*0\s+1000\s+auto\s*;/);
    expect(path).toMatch(/direction:\s*rtl\s*;/);
    expect(icon).toMatch(/width:\s*24px\s*;/);
    expect(icon).toMatch(/padding:\s*0\s*;/);
    expect(hunk).toMatch(/min-width:\s*1\.9rem\s*;/);
  });

  it("uses compact blame columns and one scrollbar per provenance run", async () => {
    // `BlameView` owns the blame grid as a module; only its placement by
    // `BlameBrowser` stays in the legacy stylesheet.
    const css = await readFile(blameViewStylesheetUrl, "utf8");
    const row = getLastRuleDeclarations(css, ".row");
    const lineNumber = getLastRuleDeclarations(css, ".lineNumber");
    const code = getLastRuleDeclarations(css, ".code");
    const scrollRun = getLastRuleDeclarations(css, ".run.scrollable");

    expect(row).toContain("var(--blame-hash-column-width)");
    expect(row).toContain("var(--blame-line-number-column-width)");
    expect(row).toMatch(/minmax\(max-content,\s*1fr\)/);
    expect(row).not.toContain("44px");
    expect(lineNumber).toMatch(/text-align:\s*right\s*;/);
    expect(scrollRun).toMatch(/overflow-x:\s*auto\s*;/);
    expect(code).not.toMatch(/overflow-x:\s*auto\s*;/);
  });
});
