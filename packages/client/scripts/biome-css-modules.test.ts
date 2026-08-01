import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const fixture = path.join(
  repoRoot,
  "packages/client/src",
  `.biome-module-contract-${process.pid}.module.css`,
);

afterEach(() => fs.rmSync(fixture, { force: true }));

describe("Biome CSS Module policy", () => {
  it("rejects module-only lint violations", () => {
    fs.writeFileSync(
      fixture,
      `
        @value danger: red;
        .root.one.two.three.four {
          color: red;
          color: blue !important;
        }
      `,
    );

    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts/biome.cjs"), "lint", fixture],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain("noDuplicateProperties");
    expect(output).toContain("noImportantStyles");
    expect(output).toContain("noValueAtRule");
    expect(output).toContain("noExcessiveSelectorClasses");
  });
});
