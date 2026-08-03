/**
 * Coverage for the repo-root CSS analyzer (`scripts/find-unused-css.ts`).
 *
 * The analyzer lives at the repo root because it is a CLI, but the client is
 * the only package with CSS and the only package running vitest over tooling,
 * so its tests live here. Fixtures are in
 * `scripts/fixtures/find-unused-css/`.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  analyze,
  buildClassProducerUsageIndex,
  buildSourceUsageIndex,
  extractBindingUsage,
  extractComposes,
  extractModuleImports,
  extractSelectorClassNames,
  findSourceFiles,
  moduleContractIssues,
  parseArgs,
  splitGlobalReferences,
} from "../../../scripts/find-unused-css.ts";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/fixtures/find-unused-css",
);

function analyzeFixtures() {
  return analyze({ cssDir: fixtureDir, srcDir: fixtureDir }).result;
}

function moduleReport(basename: string) {
  const report = analyzeFixtures().modules.find(
    (candidate) => path.basename(candidate.cssFile) === basename,
  );
  if (!report) throw new Error(`no report for ${basename}`);
  return report;
}

function unusedNames(basename: string): string[] {
  return moduleReport(basename)
    .unused.map((selector) => selector.name)
    .sort();
}

describe("class-production evidence", () => {
  it("separates class-producing syntax from generic source strings", () => {
    const templateSource = [
      'const state = "active";',
      'const templateClass = `card $' +
        '{state === "active" ? "card-selected" : ""}`;',
      "export const view = <div className={templateClass} />;",
    ].join("\n");
    const source = new Map([
      [
        "Owner.tsx",
        `
          const status = "status";
          const state = "active";
          const finiteClass = state === "active" ? "card-active" : "card-idle";
          element.classList.add("card-mounted");
          export const view = (
            <div className={finiteClass} data-status={status} />
          );
        `,
      ],
      ["TemplateOwner.tsx", templateSource],
    ]);

    const permissive = buildSourceUsageIndex(source);
    const producers = buildClassProducerUsageIndex(source);

    expect(permissive.exact.get("status")).toBeDefined();
    expect(producers.exact.get("status")).toBeUndefined();
    expect(producers.exact.get("active")).toBeUndefined();
    expect(producers.exact.get("card-active")).toBeDefined();
    expect(producers.exact.get("card-idle")).toBeDefined();
    expect(producers.exact.get("card-selected")).toBeDefined();
    expect(producers.exact.get("card-mounted")).toBeDefined();
  });

  it("resolves shadowed class variables in their lexical scope", () => {
    const producers = buildClassProducerUsageIndex(
      new Map([
        [
          "ScopedOwner.tsx",
          `
            function Visible() {
              const classes = "alpha";
              return <div className={classes} />;
            }
            function Unused() {
              const classes = "beta";
              return <span />;
            }
          `,
        ],
      ]),
    );

    expect(producers.exact.has("alpha")).toBe(true);
    expect(producers.exact.has("beta")).toBe(false);
  });
});

describe("global class analysis", () => {
  it("reports a global class no source file mentions", () => {
    const { globalUnused } = analyzeFixtures();
    expect(globalUnused.map((cls) => cls.name)).toContain(
      "fixture-unused-global",
    );
  });

  it("matches complete class tokens instead of hyphenated prefixes", () => {
    const result = analyzeFixtures();
    expect(result.globalUnused.map((cls) => cls.name)).toContain(
      "fixture-prefix",
    );
    expect(result.globalUsed.map((cls) => cls.name)).toContain(
      "fixture-prefix-button",
    );
  });

  it("ignores source comments and sees non-client producers", () => {
    const result = analyzeFixtures();
    expect(result.globalUnused.map((cls) => cls.name)).toContain(
      "fixture-comment-only",
    );
    expect(result.globalUsed.map((cls) => cls.name)).toContain(
      "fixture-generated",
    );
  });

  it("sees a class pinned only by a regex-literal selector", () => {
    const used = analyzeFixtures().globalUsed.find(
      (cls) => cls.name === "fixture-regex-selector",
    );
    expect(used?.usedIn.map((file) => path.basename(file))).toEqual([
      "stylesheet-contract.test.ts",
    ]);
  });

  it("does not read regex punctuation or bare words as selectors", () => {
    // The same regex file names it twice: once as a plain alternative and once
    // after `\\.`, an escaped backslash rather than an escaped dot.
    expect(analyzeFixtures().globalUnused.map((cls) => cls.name)).toContain(
      "fixture-regex-noise",
    );
  });

  it("counts a module's :global(...) selector as global usage", () => {
    const used = analyzeFixtures().globalUsed.find(
      (cls) => cls.name === "fixture-modal-shell",
    );
    expect(used?.usedIn.map((file) => path.basename(file))).toEqual([
      "Widget.module.css",
    ]);
  });

  it("counts `composes ... from global` as global usage", () => {
    const used = analyzeFixtures().globalUsed.find(
      (cls) => cls.name === "fixture-composed-global",
    );
    expect(used?.usedIn.map((file) => path.basename(file))).toEqual([
      "Widget.module.css",
    ]);
  });

  it("does not treat module-scoped selectors as global classes", () => {
    const globalNames = analyzeFixtures().globalClasses.map((cls) => cls.name);
    expect(globalNames).not.toContain("root");
    expect(globalNames).not.toContain("stale");
  });
});

describe("module selector analysis", () => {
  it("resolves identically named selectors per module", () => {
    // Both modules define `.message`; only Sibling's is unused.
    expect(unusedNames("Widget.module.css")).toEqual(["stale"]);
    expect(unusedNames("Sibling.module.css")).toEqual(["message"]);
  });

  it("treats property and string-literal bracket access as usage", () => {
    const used = moduleReport("Widget.module.css")
      .selectors.filter((selector) => selector.usedIn.length > 0)
      .map((selector) => selector.name);
    expect(used).toContain("root");
    expect(used).toContain("bracket-access");
  });

  it("treats composes references as usage", () => {
    // `.tone` is composed locally; `.shared` is composed across modules.
    expect(unusedNames("Widget.module.css")).not.toContain("tone");
    expect(unusedNames("Shared.module.css")).toEqual(["shared-stale"]);
  });

  it("reports computed access as unknown rather than unused", () => {
    const report = moduleReport("Dynamic.module.css");
    expect(report.unknownReasons).toContain("computed-access");
    expect(report.unused).toEqual([]);
  });

  it("reports an unimported module as production-unreachable", () => {
    const report = moduleReport("Orphan.module.css");
    expect(report.unknownReasons).toEqual([]);
    expect(report.productionReachable).toBe(false);
    expect(report.productionUnused.map((selector) => selector.name)).toEqual([
      "orphan",
    ]);
  });

  it("distinguishes test-only and undeclared selector access", () => {
    const report = moduleReport("Widget.module.css");

    expect(report.testOnly.map((selector) => selector.name)).toEqual([
      "test-contract",
    ]);
    expect(report.productionUnused.map((selector) => selector.name)).toEqual([
      "stale",
      "test-contract",
    ]);
    expect(report.undeclared).toEqual([
      {
        name: "notDeclared",
        productionUsedIn: [expect.stringMatching(/Widget\.ts:\d+$/)],
        testUsedIn: [],
      },
    ]);
  });

  it("reports a side-effect import as unknown", () => {
    const report = moduleReport("SideEffect.module.css");
    expect(report.unknownReasons).toEqual(["side-effect-import"]);
    expect(report.unknownUsage[0]?.file).toMatch(/SideEffect\.ts$/);
  });

  it("judges a module reached only through composes", () => {
    const report = moduleReport("Shared.module.css");
    expect(report.importers).toEqual([]);
    expect(report.composers.map((file) => path.basename(file))).toEqual([
      "Widget.module.css",
    ]);
    expect(report.unknownReasons).toEqual([]);
    expect(report.productionReachable).toBe(true);
  });

  it("attributes module selectors to their owning file", () => {
    const report = moduleReport("Widget.module.css");
    for (const selector of report.selectors) {
      expect(path.basename(selector.cssFile)).toBe("Widget.module.css");
    }
  });

  it("does not extract selectors from CSS comments", () => {
    expect(
      moduleReport("Widget.module.css").selectors.map((item) => item.name),
    ).not.toContain("css");
  });

  it("requires global interop to exist and have a local anchor", () => {
    const valid = moduleReport("Widget.module.css");
    const invalid = moduleReport("InvalidGlobal.module.css");

    expect(valid.globalUses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "fixture-modal-shell",
          localAnchors: ["root"],
          kind: "selector",
        }),
        expect.objectContaining({
          name: "fixture-composed-global",
          localAnchors: ["badge"],
          kind: "composes",
        }),
      ]),
    );
    expect(valid.globalIssues).toEqual([]);
    expect(invalid.globalIssues.map((issue) => issue.issue).sort()).toEqual([
      "missing-global",
      "unanchored-global",
    ]);
  });

  it("turns every module contract category into a blocking issue", () => {
    const issues = moduleContractIssues(analyzeFixtures());
    const kinds = new Set(issues.map((issue) => issue.kind));

    expect(kinds).toEqual(
      new Set([
        "computed-access",
        "missing-global",
        "no-production-importer",
        "production-unused-selector",
        "side-effect-import",
        "test-only-selector",
        "unanchored-global",
        "undeclared-selector",
      ]),
    );
  });
});

describe("parsing helpers", () => {
  it("extracts selector nodes without reading quoted attribute values", () => {
    expect(
      extractSelectorClassNames(
        '.root[data-ext=".json"]:not(.disabled, .escaped\\:state)',
      ),
    ).toEqual(["root", "disabled", "escaped:state"]);
  });

  it("scans every package for generated vocabulary by default", () => {
    expect(parseArgs([]).srcDir).toBe("packages");
    expect(parseArgs(["--modules-check"]).modulesCheck).toBe(true);
  });

  it("scans package Playwright and script roots with package source", () => {
    const packageRoot = path.join(fixtureDir, "../css-package-roots");
    const files = findSourceFiles(path.join(packageRoot, "packages"), [
      ".tsx",
      ".ts",
      ".mjs",
      ".cjs",
    ]).map((file) =>
      path.relative(packageRoot, file).split(path.sep).join("/"),
    );

    expect(files).toEqual([
      "packages/client/src/Card.tsx",
      "packages/client/e2e/Card.spec.ts",
      "packages/client/scripts/card-smoke.cjs",
      "packages/client/scripts/card-smoke.mjs",
    ]);
  });

  it("separates :global(...) references from module-scoped selectors", () => {
    expect(splitGlobalReferences(":global(.modal):has(.content)")).toEqual({
      scoped: ":has(.content)",
      globalRefs: ["modal"],
    });
  });

  it("does not read :global syntax from quoted attribute values", () => {
    expect(
      splitGlobalReferences('.root[data-label=":global(.phantom)"]'),
    ).toEqual({
      scoped: '.root[data-label=":global(.phantom)"]',
      globalRefs: [],
    });
  });

  it("extracts default and namespace module imports", () => {
    expect(
      extractModuleImports(
        [
          'import styles from "./Widget.module.css";',
          'import * as other from "./Other.module.css";',
          'import "./SideEffect.module.css";',
          'import helper from "./helper.ts";',
        ].join("\n"),
      ),
    ).toEqual([
      { binding: "styles", specifier: "./Widget.module.css" },
      { binding: "other", specifier: "./Other.module.css" },
      { binding: null, specifier: "./SideEffect.module.css" },
    ]);
  });

  it("classifies binding access", () => {
    const usage = extractBindingUsage(
      [
        'import styles from "./Widget.module.css";',
        "const a = styles.root;",
        "const b = styles?.hover;",
        'const c = styles["bracket-access"];',
        "// styles.commented",
      ].join("\n"),
      "styles",
    );
    expect([...usage.names].sort()).toEqual([
      "bracket-access",
      "hover",
      "root",
    ]);
    expect(usage.computed).toBe(false);
  });

  it("flags a computed key and an opaque pass-through", () => {
    expect(extractBindingUsage("styles[key]", "styles").computed).toBe(true);
    expect(extractBindingUsage("classNames(styles)", "styles").computed).toBe(
      true,
    );
  });

  it("does not confuse a similarly named binding", () => {
    const usage = extractBindingUsage(
      "const x = other.styles; const y = myStyles.root;",
      "styles",
    );
    expect(usage.names.size).toBe(0);
    expect(usage.computed).toBe(false);
  });

  it("parses local, external, and global composes", () => {
    expect(
      extractComposes(
        [
          ".a { composes: tone strong; }",
          '.b { composes: shared from "./Shared.module.css"; }',
          ".c { composes: legacy from global; }",
        ].join("\n"),
      ),
    ).toEqual({
      local: ["tone", "strong"],
      external: [{ specifier: "./Shared.module.css", names: ["shared"] }],
      global: ["legacy"],
    });
  });
});
