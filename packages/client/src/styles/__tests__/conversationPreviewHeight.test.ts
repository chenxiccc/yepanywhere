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
  it("caps the current thinking preview to a viewport fraction and scrolls past it", async () => {
    const css = await readStylesheet();
    const declarations = getRuleDeclarations(
      css,
      ".conversation-thinking-preview-content",
    );
    // Viewport-relative cap (contains vh, not a fixed pixel budget) so the
    // preceding non-thinking turn keeps space; overflow scrolls internally.
    // This is the measurement source, so it must NOT depend on the published
    // height — see topics/responsive-layout-gaps.md.
    expect(
      declarations,
      "current thinking preview must cap its height relative to the viewport, not a fixed px",
    ).toMatch(/max-height:[^;]*vh[^;]*;/);
    expect(declarations).toMatch(/overflow:\s*auto\s*;/);
  });

  it("caps the recent-activity list to the published thinking height and clips overflow", async () => {
    const css = await readStylesheet();
    const declarations = getRuleDeclarations(
      css,
      ".conversation-recent-activities",
    );
    // Never exceed the space the current thinking block requests: bound to the
    // measured --conversation-thinking-height, with a viewport-relative fallback
    // before the first measurement. Clips the oldest rows rather than showing a
    // fixed count.
    expect(
      declarations,
      "recent-activity list must cap to the published thinking height",
    ).toMatch(/max-height:\s*var\(\s*--conversation-thinking-height/);
    expect(declarations).toMatch(/overflow:\s*hidden\s*;/);
  });
});
