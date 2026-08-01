// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// The themed tooltip, the session hover card, and the risk affordance each own
// their module; the frontmost-surface contract follows them there rather than
// staying pinned to the legacy stylesheet.
const tooltipModuleUrl = new URL(
  "../../components/ui/TooltipLayer.module.css",
  import.meta.url,
);
const hovercardModuleUrl = new URL(
  "../../components/SessionHoverCard.module.css",
  import.meta.url,
);
const riskModuleUrl = new URL(
  "../../components/RiskAffordance.module.css",
  import.meta.url,
);

describe("themed tooltip CSS contract", () => {
  it("is the frontmost selectable pointer surface", async () => {
    const tooltipCss = await readFile(tooltipModuleUrl, "utf8");
    const hovercardCss = await readFile(hovercardModuleUrl, "utf8");
    const riskCss = await readFile(riskModuleUrl, "utf8");
    const declarations = /\.root\s*\{([^}]*)\}/.exec(tooltipCss)?.[1] ?? "";
    const richRootDeclarations =
      /^\.tooltipVisible\s*\{([^}]*)\}/m.exec(riskCss)?.[1] ?? "";
    const richDeclarations =
      /^\.tooltip\s*\{([^}]*)\}/m.exec(riskCss)?.[1] ?? "";
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
