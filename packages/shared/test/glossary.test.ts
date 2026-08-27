import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  GLOSSARY_ARTIFACT_VERSION,
  GLOSSARY_LIMITS,
  compileGlossaryArtifact,
  flattenGlossaryInlineMarkdown,
  matchGlossaryText,
  normalizeGlossaryText,
  parseFirstGlossaryTable,
  parseGlossaryInline,
  splitGlossaryAlternatives,
  type GlossaryArtifact,
  type GlossaryLimits,
  type GlossaryRowInput,
} from "../src/glossary/index.js";

function row(
  termMarkdown: string,
  definitionMarkdown = "A definition",
  overrides: Partial<GlossaryRowInput> = {},
): GlossaryRowInput {
  return {
    definitionMarkdown,
    glossaryDirectory: "docs/paper",
    glossaryOrder: 0,
    rowOrder: 0,
    termMarkdown,
    ...overrides,
  };
}

function compile(rows: GlossaryRowInput[]): GlossaryArtifact {
  const result = compileGlossaryArtifact(rows, "fixture-v1");
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.diagnostic.message);
  return result.artifact;
}

function forms(artifact: GlossaryArtifact): string[] {
  return artifact.terminals.map((terminal) => terminal.normalizedForm).sort();
}

describe("glossary Markdown parsing", () => {
  it("selects the first table and retains every authored cell", () => {
    const parsed = parseFirstGlossaryTable(`
# Vocabulary

| term | definition | references |
| :--- | --- | ---: |
| **alpha** | Uses [a label](./paper.md) | \`x|y\` |
| escaped \\| pipe | second | ./other/GLOSSARY.md |

| ignored | table |
| --- | --- |
| later | no |
`);

    expect(parsed?.startLine).toBe(4);
    expect(parsed?.rows).toHaveLength(2);
    expect(parsed?.rows[0]).toMatchObject({
      definitionMarkdown: "Uses [a label](./paper.md)",
      sourceLine: 6,
      termMarkdown: "**alpha**",
    });
    expect(parsed?.rows[0]?.cellsMarkdown[2]).toBe("`x|y`");
    expect(
      flattenGlossaryInlineMarkdown(parsed?.rows[1]?.termMarkdown ?? ""),
    ).toBe("escaped | pipe");
  });

  it("ignores table-shaped examples in fenced and indented code", () => {
    const parsed = parseFirstGlossaryTable(`
\`\`\`markdown
| fenced | example |
| --- | --- |
| wrong | no |
\`\`\`

    | indented | example |
    | --- | --- |
    | wrong | no |

~~~markdown
| tilde fenced | example |
| --- | --- |
| wrong | no |
~~~

| term | definition |
| --- | --- |
| **actual** | selected |
`);

    expect(parsed?.rows).toHaveLength(1);
    expect(parsed?.rows[0]).toMatchObject({
      definitionMarkdown: "selected",
      termMarkdown: "**actual**",
    });
  });

  it("flattens formatting while retaining visible labels and literals", () => {
    expect(
      flattenGlossaryInlineMarkdown(
        "**Term** with `literal  code` and [visible](./hidden) &amp; \\*",
      ),
    ).toBe("Term with literal code and visible & *");
  });

  it("preserves literal intraword and unmatched delimiter punctuation", () => {
    expect(flattenGlossaryInlineMarkdown("snake_case")).toBe("snake_case");
    expect(flattenGlossaryInlineMarkdown("grow*able")).toBe("grow*able");
    expect(flattenGlossaryInlineMarkdown("x~y")).toBe("x~y");
    expect(flattenGlossaryInlineMarkdown("unmatched*")).toBe("unmatched*");
    expect(flattenGlossaryInlineMarkdown("__bold__ *emphasis* ~~old~~")).toBe(
      "bold emphasis old",
    );
  });

  it("excludes Markdown comments from visible term text", () => {
    expect(
      flattenGlossaryInlineMarkdown(
        "**session scroll memory** <!-- unconfirmed: 2026-07-04 -->",
      ),
    ).toBe("session scroll memory");
  });

  it("splits only top-level unescaped comma alternatives", () => {
    expect(
      splitGlossaryAlternatives(
        "first, escaped\\, comma, **bold, comma**, `code, comma`, [label, x](url)",
      ),
    ).toEqual([
      "first",
      "escaped\\, comma",
      "**bold, comma**",
      "`code, comma`",
      "[label, x](url)",
    ]);
  });

  it("splits after literal intraword strong-marker characters", () => {
    expect(splitGlossaryAlternatives("literal__name, second")).toEqual([
      "literal__name",
      "second",
    ]);
  });

  it("keeps the root project glossary fully bold and compilable", () => {
    const markdown = readFileSync(
      new URL("../../../GLOSSARY.md", import.meta.url),
      "utf8",
    );
    const parsed = parseFirstGlossaryTable(markdown);
    expect(parsed).not.toBeNull();
    if (!parsed) return;

    for (const glossaryRow of parsed.rows) {
      for (const alternative of splitGlossaryAlternatives(
        glossaryRow.termMarkdown,
      )) {
        const visiblePieces = parseGlossaryInline(alternative).pieces.filter(
          (piece) => piece.text.trim().length > 0,
        );
        expect(
          visiblePieces.every((piece) => piece.required),
          `Expected a fully bold term at GLOSSARY.md:${glossaryRow.sourceLine}`,
        ).toBe(true);
      }
    }

    const rows = parsed.rows.map((glossaryRow) => ({
      definitionMarkdown: glossaryRow.definitionMarkdown,
      glossaryDirectory: "",
      glossaryOrder: 0,
      rowOrder: glossaryRow.rowOrder,
      termMarkdown: glossaryRow.termMarkdown,
    }));
    const result = compileGlossaryArtifact(rows, "root-fixture");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(forms(result.artifact)).toContain("client source runtime topology");
    expect(
      parsed.rows.find(
        (glossaryRow) =>
          flattenGlossaryInlineMarkdown(glossaryRow.termMarkdown) ===
          "momentum",
      )?.termMarkdown,
    ).toBe("**momentum**");
  });
});

describe("glossary phrase compilation", () => {
  it("expands only authored optional tokens around required bold spans", () => {
    const artifact = compile([
      row("per-language **published oracle**"),
      row("**typed** one-to-one **overlap F1**", "score", { rowOrder: 1 }),
    ]);

    expect(forms(artifact)).toEqual([
      "per-language published oracle",
      "published oracle",
      "typed one-to-one overlap f1",
      "typed overlap f1",
    ]);
    expect(forms(artifact)).not.toContain("typed arbitrary overlap f1");
  });

  it("clones bold hyphenated text with spaces", () => {
    expect(forms(compile([row("**client-source-runtime-topology**")]))).toEqual(
      ["client source runtime topology", "client-source-runtime-topology"],
    );
  });

  it("clones hyphens only inside a partially bold phrase", () => {
    expect(forms(compile([row("per-language **published-oracle**")]))).toEqual([
      "per-language published oracle",
      "per-language published-oracle",
      "published oracle",
      "published-oracle",
    ]);
  });

  it("keeps an unbolded phrase wholly required", () => {
    const artifact = compile([row("ordinary complete phrase")]);
    expect(forms(artifact)).toEqual(["ordinary complete phrase"]);
    expect(artifact.terminals[0]?.requiredBoldCodePoints).toBe(0);
  });

  it("produces four forms for two optional tokens", () => {
    expect(forms(compile([row("left **required** right")]))).toEqual([
      "left required",
      "left required right",
      "required",
      "required right",
    ]);
  });

  it("rejects a third optional token without a slower fallback", () => {
    const result = compileGlossaryArtifact(
      [row("one two **required** three")],
      "fixture-v1",
    );
    expect(result).toEqual({
      diagnostic: {
        code: "too-many-optional-tokens",
        message: "Glossary phrase exceeds 2 optional tokens",
      },
      ok: false,
    });
  });

  it("deduplicates one row's expansions and concatenates conflicting rows", () => {
    const artifact = compile([
      row("**shared term**, shared term", "Root meaning", {
        glossaryDirectory: "",
      }),
      row("shared term", "Paper meaning", {
        glossaryOrder: 1,
        rowOrder: 3,
      }),
    ]);
    const terminal = artifact.terminals.find(
      (candidate) => candidate.normalizedForm === "shared term",
    );

    expect(terminal?.contributions).toHaveLength(2);
    expect(terminal?.definitionText).toBe(
      "shared term: Root meaning\n\nshared term: Paper meaning",
    );
  });

  it("prefixes the first-listed case only when the definition needs it", () => {
    const prefixed = compile([row("**YA**, **ya**", "Yep Anywhere")]);
    const selfLabelled = compile([row("**YA**, **ya**", "YA is Yep Anywhere")]);

    expect(prefixed.terminals[0]?.definitionText).toBe("YA: Yep Anywhere");
    expect(selfLabelled.terminals[0]?.definitionText).toBe(
      "YA is Yep Anywhere",
    );
  });

  it("round-trips a versioned JSON artifact", () => {
    const artifact = compile([row("**serialized term**")]);
    const restored = JSON.parse(JSON.stringify(artifact)) as GlossaryArtifact;
    expect(restored.version).toBe(GLOSSARY_ARTIFACT_VERSION);
    expect(restored.version).toBe(2);
    expect(matchGlossaryText("A serialized term.", restored)).toHaveLength(1);
  });

  it("enforces aggregate row, form, paragraph, phrase, and state limits", () => {
    const base: GlossaryLimits = { ...GLOSSARY_LIMITS };
    expect(
      compileGlossaryArtifact([row("one"), row("two")], "v", {
        ...base,
        maxRows: 1,
      }),
    ).toMatchObject({ ok: false, diagnostic: { code: "too-many-rows" } });
    expect(
      compileGlossaryArtifact([row("left **middle** right")], "v", {
        ...base,
        maxExpandedForms: 3,
      }),
    ).toMatchObject({
      ok: false,
      diagnostic: { code: "too-many-expanded-forms" },
    });
    expect(
      compileGlossaryArtifact(
        [row("same"), row("same", "two", { glossaryOrder: 1 })],
        "v",
        { ...base, maxDefinitionParagraphsPerForm: 1 },
      ),
    ).toMatchObject({
      ok: false,
      diagnostic: { code: "too-many-definition-paragraphs" },
    });
    expect(
      compileGlossaryArtifact([row("lengthy")], "v", {
        ...base,
        maxPhraseCodePoints: 3,
      }),
    ).toMatchObject({ ok: false, diagnostic: { code: "phrase-too-long" } });
    expect(
      compileGlossaryArtifact([row("states")], "v", {
        ...base,
        maxTrieStates: 2,
      }),
    ).toMatchObject({
      ok: false,
      diagnostic: { code: "too-many-trie-states" },
    });
  });
});

describe("compiled glossary matching", () => {
  it("matches case-insensitively across normalized whitespace with source offsets", () => {
    const text = "Before PUBLISHED\n\tOracle, after";
    const matches = matchGlossaryText(
      text,
      compile([row("**published oracle**", "Best system")]),
    );

    expect(matches).toEqual([
      expect.objectContaining({
        definitionText: "published oracle: Best system",
        end: text.indexOf(","),
        start: text.indexOf("PUBLISHED"),
      }),
    ]);
    expect(text.slice(matches[0]?.start, matches[0]?.end)).toBe(
      "PUBLISHED\n\tOracle",
    );
  });

  it("matches all-caps glossary entries only against all-caps text", () => {
    const artifact = compile([row("**YA**", "Yep Anywhere")]);
    const text = "YA Ya ya";

    expect(
      matchGlossaryText(text, artifact).map((match) =>
        text.slice(match.start, match.end),
      ),
    ).toEqual(["YA"]);
  });

  it("uses a lowercase alternative to opt into case-insensitive matching", () => {
    const artifact = compile([row("**YA**, **ya**", "Yep Anywhere")]);
    const text = "YA Ya ya";

    expect(
      matchGlossaryText(text, artifact).map((match) =>
        text.slice(match.start, match.end),
      ),
    ).toEqual(["YA", "Ya", "ya"]);
  });

  it("matches mixed case exactly plus initial capitalization", () => {
    const artifact = compile([row("**eBay**", "Marketplace")]);
    const text = "eBay EBay ebay EBAY";

    expect(artifact.terminals[0]?.caseSensitiveForms).toEqual(["EBay", "eBay"]);
    expect(
      matchGlossaryText(text, artifact).map((match) =>
        text.slice(match.start, match.end),
      ),
    ).toEqual(["eBay", "EBay"]);
  });

  it("keeps legacy artifacts case-insensitive", () => {
    const artifact = compile([row("**eBay**", "Marketplace")]);
    artifact.version = 1;
    for (const terminal of artifact.terminals) {
      delete terminal.caseSensitiveForms;
    }

    expect(matchGlossaryText("eBay EBay ebay EBAY", artifact)).toHaveLength(4);
  });

  it("uses one context-independent Unicode fold for compile and match", () => {
    const artifact = compile([row("**ος**", "Greek sigma")]);
    const text = "ΟΣ ος οσ";
    const matchedText = matchGlossaryText(text, artifact).map((match) =>
      text.slice(match.start, match.end),
    );

    expect(normalizeGlossaryText("ΟΣ")).toBe("οσ");
    expect(normalizeGlossaryText("ος")).toBe("οσ");
    expect(matchedText).toEqual(["ΟΣ", "ος", "οσ"]);
  });

  it("normalizes combining and Hangul clusters without Intl.Segmenter", async () => {
    const segmenterDescriptor = Object.getOwnPropertyDescriptor(
      Intl,
      "Segmenter",
    );
    Object.defineProperty(Intl, "Segmenter", {
      configurable: true,
      value: undefined,
    });
    vi.resetModules();
    try {
      const fallback = await import("../src/glossary/normalization.js");
      expect(fallback.normalizeGlossaryText("CAFÉ")).toBe("café");
      expect(fallback.normalizeGlossaryText("가")).toBe("가");
    } finally {
      if (segmenterDescriptor) {
        Object.defineProperty(Intl, "Segmenter", segmenterDescriptor);
      }
      vi.resetModules();
    }
  });

  it("requires phrase-edge boundaries while retaining literal punctuation", () => {
    const artifact = compile([
      row("**term**"),
      row("**score/F1**", "slash", { rowOrder: 1 }),
    ]);
    const text = "term terminal preterm score/F1 score-F1";
    expect(
      matchGlossaryText(text, artifact).map((match) =>
        text.slice(match.start, match.end),
      ),
    ).toEqual(["term", "score/F1"]);
  });

  it("treats lexical hyphens as significant word characters", () => {
    const artifact = compile([
      row("source-path", "hyphenated"),
      row("source path", "spaced", { rowOrder: 1 }),
      row("source", "short", { rowOrder: 2 }),
    ]);
    const text = "source-path source path - source";

    expect(
      matchGlossaryText(text, artifact).map((match) => ({
        definition: match.definitionText,
        text: text.slice(match.start, match.end),
      })),
    ).toEqual([
      { definition: "source-path: hyphenated", text: "source-path" },
      { definition: "source path: spaced", text: "source path" },
      { definition: "source: short", text: "source" },
    ]);
  });

  it("matches both authored and spaced forms of a bold hyphenated term", () => {
    const artifact = compile([row("**source-path**", "path")]);
    const text = "source-path and source path";

    expect(
      matchGlossaryText(text, artifact).map((match) =>
        text.slice(match.start, match.end),
      ),
    ).toEqual(["source-path", "source path"]);
  });

  it("selects the longest visible match when candidates overlap", () => {
    const artifact = compile([
      row("**alpha**"),
      row("**alpha beta**", "long", { rowOrder: 1 }),
      row("**beta**", "tail", { rowOrder: 2 }),
    ]);
    const text = "alpha beta";
    const matches = matchGlossaryText(text, artifact);
    expect(matches).toHaveLength(1);
    expect(text.slice(matches[0]?.start, matches[0]?.end)).toBe("alpha beta");
  });

  it("preserves Unicode source offsets through compatibility normalization", () => {
    const artifact = compile([row("**café**")]);
    const text = "A CAFE\u0301 result";
    const [match] = matchGlossaryText(text, artifact);
    expect(text.slice(match?.start, match?.end)).toBe("CAFE\u0301");
  });

  it("selects dense disjoint candidates under the indexed overlap budget", () => {
    const artifact = compile([row("**term**")]);
    const text = "term ".repeat(12_000);
    const startedAt = performance.now();
    const matches = matchGlossaryText(text, artifact);
    const elapsedMs = performance.now() - startedAt;

    expect(matches).toHaveLength(12_000);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it("maps compatibility-composed graphemes back to their full source span", () => {
    const artifact = compile([row("**가**")]);
    const text = "A 가 result";
    const [match] = matchGlossaryText(text, artifact);

    expect(text.slice(match?.start, match?.end)).toBe("가");
  });

  it("compiles 999 hyphen-alias rows and scans a long miss under the cold budget", () => {
    const rows = Array.from({ length: 999 }, (_, index) =>
      row(`**term-${index}**`, `definition ${index}`, { rowOrder: index }),
    );
    const startedAt = performance.now();
    const artifact = compile(rows);
    const matches = matchGlossaryText(
      "unrelated text ".repeat(20_000),
      artifact,
    );
    const elapsedMs = performance.now() - startedAt;

    expect(matches).toEqual([]);
    expect(artifact.terminals).toHaveLength(1_998);
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
