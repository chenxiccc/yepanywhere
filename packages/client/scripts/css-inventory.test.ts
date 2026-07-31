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
      coupled: 1,
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
    expect(widget?.coupledRules).toHaveLength(1);
    expect(widget?.unresolvedRules).toHaveLength(1);
    expect(widget?.coverage).toBeGreaterThan(0.5);
  });
});
