import { describe, expect, it } from "vitest";
import {
  GLOSSARY_ARTIFACT_VERSION,
  GLOSSARY_LIMITS,
  compileGlossaryArtifact,
  flattenGlossaryInlineMarkdown,
  matchGlossaryText,
  parseFirstGlossaryTable,
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

  it("flattens formatting while retaining visible labels and literals", () => {
    expect(
      flattenGlossaryInlineMarkdown(
        "**Term** with `literal  code` and [visible](./hidden) &amp; \\*",
      ),
    ).toBe("Term with literal code and visible & *");
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

  it("round-trips a versioned JSON artifact", () => {
    const artifact = compile([row("**serialized term**")]);
    const restored = JSON.parse(JSON.stringify(artifact)) as GlossaryArtifact;
    expect(restored.version).toBe(GLOSSARY_ARTIFACT_VERSION);
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

  it("compiles a generous 999-row graph and scans a long miss under the cold budget", () => {
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
    expect(artifact.terminals).toHaveLength(999);
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
