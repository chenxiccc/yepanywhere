// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const stylesheetUrl = new URL("../index.css", import.meta.url);
// The session hover card owns its own module; the frontmost-surface contract
// follows it there rather than staying pinned to the legacy stylesheet.
const hovercardModuleUrl = new URL(
  "../../components/SessionHoverCard.module.css",
  import.meta.url,
);

describe("themed tooltip CSS contract", () => {
  it("is the frontmost selectable pointer surface", async () => {
    const css = await readFile(stylesheetUrl, "utf8");
    const hovercardCss = await readFile(hovercardModuleUrl, "utf8");
    const declarations = /\.ya-tooltip\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const richRootDeclarations =
      /\.external-session-risk--tooltip-visible\s*\{([^}]*)\}/.exec(css)?.[1] ??
      "";
    const richDeclarations =
      /\.external-session-risk-tooltip\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const hovercardDeclarations =
      /\.root\s*\{([^}]*)\}/.exec(hovercardCss)?.[1] ?? "";

    expect(declarations).toMatch(/position:\s*fixed\s*;/);
    expect(declarations).toMatch(/z-index:\s*2147483647\s*;/);
    expect(declarations).toMatch(/pointer-events:\s*auto\s*;/);
    expect(declarations).toMatch(/user-select:\s*text\s*;/);
    expect(richRootDeclarations).toMatch(/z-index:\s*2147483647\s*;/);
    expect(richDeclarations).toMatch(/z-index:\s*2147483647\s*;/);
    expect(hovercardDeclarations).toMatch(/z-index:\s*2147483647\s*;/);
    expect(hovercardDeclarations).toMatch(/pointer-events:\s*auto\s*;/);
  });
});
