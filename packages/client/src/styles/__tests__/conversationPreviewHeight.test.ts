// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const stylesheetUrl = new URL("../index.css", import.meta.url);

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
    `${selector} should have a dedicated rule in index.css.`,
  ).not.toBeNull();
  return match?.[1] ?? "";
}

describe("conversation preview height contract", () => {
  it("caps the thinking preview to a viewport fraction and scrolls past it", async () => {
    const css = await readStylesheet();
    const declarations = getRuleDeclarations(
      css,
      ".conversation-thinking-preview-content",
    );
    // Viewport-relative cap (contains vh, not a fixed pixel budget) so the
    // preceding non-thinking turn keeps space; overflow scrolls internally.
    // See topics/responsive-layout-gaps.md.
    expect(
      declarations,
      "thinking preview must cap its height relative to the viewport, not a fixed px",
    ).toMatch(/max-height:[^;]*vh[^;]*;/);
    expect(declarations).toMatch(/overflow:\s*auto\s*;/);
  });

  it("caps the recent-activity list to the preview budget and clips overflow", async () => {
    const css = await readStylesheet();
    const declarations = getRuleDeclarations(
      css,
      ".conversation-recent-activities",
    );
    // Fills the height beside the preview and clips the oldest rows, rather
    // than showing a fixed row count.
    expect(
      declarations,
      "recent-activity list must bound its height to the viewport-relative preview budget",
    ).toMatch(/max-height:[^;]*vh[^;]*;/);
    expect(declarations).toMatch(/overflow:\s*hidden\s*;/);
  });
});
