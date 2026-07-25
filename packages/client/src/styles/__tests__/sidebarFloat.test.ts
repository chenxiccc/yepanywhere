// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const stylesheetUrl = new URL("../index.css", import.meta.url);

function declarationsFor(css: string, selector: string): string {
  const declarations = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
  ).exec(css)?.[1];
  expect(
    declarations,
    `${selector} should have a dedicated CSS rule.`,
  ).toBeDefined();
  return declarations ?? "";
}

describe("minimized desktop sidebar CSS contract", () => {
  it("floats only the restore toggle at the 2px viewport inset", async () => {
    const css = await readFile(stylesheetUrl, "utf8");
    const restoreDeclarations = declarationsFor(
      css,
      ".sidebar-floating-restore",
    );
    const minimizeDeclarations = declarationsFor(css, ".sidebar-minimize");

    expect(restoreDeclarations).toMatch(/position:\s*fixed\s*;/);
    expect(restoreDeclarations).toMatch(/top:\s*2px\s*;/);
    expect(restoreDeclarations).toMatch(/left:\s*2px\s*;/);
    expect(minimizeDeclarations).toMatch(/top:\s*0\s*;/);
    expect(minimizeDeclarations).toMatch(/right:\s*0\s*;/);
    expect(minimizeDeclarations).toMatch(/width:\s*14px\s*;/);
    expect(minimizeDeclarations).toMatch(/height:\s*14px\s*;/);
  });
});
