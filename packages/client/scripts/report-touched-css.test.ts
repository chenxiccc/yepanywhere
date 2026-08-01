import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildInventory } from "../../../scripts/css-inventory.ts";
import { buildTouchedReport } from "../../../scripts/report-touched-css.ts";

const fixtureDir = path.resolve("scripts/fixtures/css-touched");
const inventory = buildInventory({
  cssDir: fixtureDir,
  srcDir: fixtureDir,
  ownerDir: fixtureDir,
});

function fixture(name: string): string {
  return path.join(fixtureDir, name);
}

describe("touched CSS ownership report", () => {
  it("surfaces a bounded local owner as an opportunity", () => {
    const report = buildTouchedReport([fixture("Local.tsx")], inventory);

    expect(report.owners).toHaveLength(1);
    expect(report.owners[0]).toMatchObject({
      disposition: "opportunity",
      reasons: [],
      owner: {
        ownedLines: 6,
        stylesheets: ["scripts/fixtures/css-touched/global.css"],
        dynamicClasses: [],
      },
    });
  });

  it("marks coupled ownership as a deferral", () => {
    const report = buildTouchedReport([fixture("CoupledA.tsx")], inventory);

    expect(report.owners).toHaveLength(1);
    expect(report.owners[0]?.disposition).toBe("defer");
    expect(report.owners[0]?.reasons).toContain(
      "no independently owned rule slice",
    );
    expect(report.owners[0]?.reasons).toContain("1 coupled rule(s)");
  });

  it("marks ownership scattered across stylesheets as a deferral", () => {
    const report = buildTouchedReport([fixture("Scattered.tsx")], inventory);

    expect(report.owners).toHaveLength(1);
    expect(report.owners[0]?.disposition).toBe("defer");
    expect(report.owners[0]?.reasons).toContain(
      "ownership is scattered across 3 stylesheets",
    );
  });

  it("never presents generated or unresolved evidence as mechanical", () => {
    const report = buildTouchedReport([fixture("Generated.tsx")], inventory);

    expect(report.owners).toHaveLength(1);
    expect(report.owners[0]?.disposition).toBe("defer");
    expect(report.owners[0]?.reasons).toContain(
      "1 unresolved rule(s) involving generated/shared vocabulary",
    );
  });

  it("omits clean and module-only components", () => {
    const report = buildTouchedReport(
      [fixture("ModuleOnly.tsx"), fixture("Clean.tsx")],
      inventory,
    );

    expect(report.owners).toEqual([]);
  });

  it("reports changed legacy stylesheets without treating modules as legacy", () => {
    const report = buildTouchedReport(
      [fixture("global.css"), fixture("ModuleOnly.module.css")],
      inventory,
      "fixture",
      { cssDir: fixtureDir },
    );

    expect(report.changedLegacyStylesheets).toEqual([
      "scripts/fixtures/css-touched/global.css",
    ]);
  });
});
