import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildInventory } from "../../../scripts/css-inventory.ts";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/fixtures/css-inventory",
);

describe("CSS migration inventory", () => {
  it("separates owned, coupled, generated, and unresolved rules", () => {
    const result = buildInventory({
      cssDir: fixtureDir,
      srcDir: fixtureDir,
      ownerDir: path.join(fixtureDir, "client"),
    });
    expect(result.ruleCounts).toEqual({
      owned: 4,
      coupled: 2,
      generated: 1,
      unresolved: 2,
    });
  });

  it("reports dynamic classes, test contracts, and composition edges", () => {
    const result = buildInventory({
      cssDir: fixtureDir,
      srcDir: fixtureDir,
      ownerDir: path.join(fixtureDir, "client"),
    });
    const widget = result.owners.find((owner) =>
      owner.owner.endsWith("client/Widget.tsx"),
    );
    expect(widget).toBeDefined();
    expect(widget?.dynamicClasses).toContain("widget-tone-success");
    expect(
      widget?.testFiles.some((file) => file.endsWith("Widget.test.tsx")),
    ).toBe(true);
    expect(widget?.coupledRules).toHaveLength(2);
    expect(widget?.unresolvedRules).toHaveLength(1);
    expect(widget?.coverage).toBeGreaterThan(0.5);
  });

  it("surfaces anchorless coupled rules under every involved owner", () => {
    const result = buildInventory({
      cssDir: fixtureDir,
      srcDir: fixtureDir,
      ownerDir: path.join(fixtureDir, "client"),
    });
    const widget = result.owners.find((owner) =>
      owner.owner.endsWith("client/Widget.tsx"),
    );
    const other = result.owners.find((owner) =>
      owner.owner.endsWith("client/Other.tsx"),
    );

    for (const owner of [widget, other]) {
      const sharedRule = owner?.coupledRules.find((rule) =>
        rule.classes.includes("shared-surface"),
      );
      expect(sharedRule).toBeDefined();
      expect(sharedRule?.anchorOwners).toHaveLength(0);
      expect(sharedRule?.involvedOwners).toHaveLength(2);
    }
  });

  it("reports a stylesheet-contract test that only uses regex selectors", () => {
    const result = buildInventory({
      cssDir: fixtureDir,
      srcDir: fixtureDir,
      ownerDir: path.join(fixtureDir, "client"),
    });
    const widget = result.owners.find((owner) =>
      owner.owner.endsWith("client/Widget.tsx"),
    );

    expect(
      widget?.testFiles.some((file) => file.endsWith("Widget.contract.test.ts")),
    ).toBe(true);
  });

  it("reports selector contracts from package Playwright roots", () => {
    const packageRoot = path.join(fixtureDir, "../css-package-roots");
    const result = buildInventory({
      cssDir: packageRoot,
      srcDir: path.join(packageRoot, "packages"),
      ownerDir: path.join(packageRoot, "packages/client/src"),
    });
    const card = result.owners.find((owner) =>
      owner.owner.endsWith("packages/client/src/Card.tsx"),
    );

    expect(
      card?.testFiles.some((file) =>
        file.endsWith("packages/client/e2e/Card.spec.ts"),
      ),
    ).toBe(true);
  });

  it("reports non-React consumers from package script roots", () => {
    const packageRoot = path.join(fixtureDir, "../css-package-roots");
    const result = buildInventory({
      cssDir: packageRoot,
      srcDir: path.join(packageRoot, "packages"),
      ownerDir: path.join(packageRoot, "packages/client/src"),
    });
    const card = result.owners.find((owner) =>
      owner.owner.endsWith("packages/client/src/Card.tsx"),
    );
    const scriptedRule = card?.ownedRules.find((rule) =>
      rule.classes.includes("fixture-package-script-card"),
    );

    expect(
      [...(scriptedRule?.testFiles ?? [])]
        .filter((file) => file.includes("packages/client/scripts/card-smoke."))
        .map((file) => path.extname(file))
        .sort(),
    ).toEqual([".cjs", ".mjs"]);
  });
});
