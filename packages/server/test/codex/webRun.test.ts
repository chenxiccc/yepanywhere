import { describe, expect, it } from "vitest";
import {
  normalizeCodexCustomToolInvocation,
  normalizeCodexToolOutputWithContext,
} from "../../src/codex/normalization.js";
import {
  cleanWebRunMarkers,
  parseCodexWebRunOutput,
} from "../../src/codex/webRun.js";

// Citation markup delimiters (private-use characters; see webRun.ts).
const O = "\uE200";
const C = "\uE201";
const S = "\uE202";

const OPEN_OUTPUT = [
  "Script completed",
  "Wall time 0.8 seconds",
  "Output:",
  "README.md · facebook/covost2 at main (https://huggingface.co/datasets/facebook/covost2/blob/main/README.md)",
  `${O}cite${S}turn1view0${C} [wordlim: 200] Content type: text/html; Source: open({"ref_id":"turn0search4","lineno":null}); Total lines: 1174`,
  `L37: # ${O}cite${S}2† Datasets:${C} L38: `,
  "L39: * * *",
  `L40: ${O}cite${S}79†Image†huggingface.co${C} AI at Meta 13.5k`,
  "L41:     indented: yaml",
].join("\n");

const SEARCH_OUTPUT = [
  "Script completed",
  "Wall time 1.2 seconds",
  "Output:",
  "A Context-aware Framework for Translation-mediated Conversations (https://arxiv.org/abs/2412.04205)",
  `${O}cite${S}turn0academia12${C} [wordlim: 200] Published: 1.6 years ago; Title: A Context-aware Framework ... snippet prose.`,
  "More snippet prose on a second line.",
  "covost/README.md at main · facebookresearch/covost · GitHub (https://github.com/facebookresearch/covost/blob/main/README.md)",
  `${O}cite${S}turn0search0${C} [wordlim: 200] Published: 2.7 years ago; Crawled: last month; facebookresearch / covost Public archive ...`,
].join("\n");

const CLICK_OUTPUT = [
  "Script completed",
  "Wall time 0.8 seconds",
  "Output:",
  "huggingface.co (https://huggingface.co/datasets/facebook/covost2/resolve/main/covost2.py?download=true)",
  `${O}cite${S}turn2view0${C} [wordlim: 200] Content type: text/plain; Source: click({"ref_id":"turn1view1","id":46}); Redirected to URL: https://huggingface.co/api/resolve-cache/covost2.py; Total lines: 8`,
  "L0: # coding=utf-8 # Copyright 2021",
  "L1: # You may obtain a copy of the License",
].join("\n");

describe("cleanWebRunMarkers", () => {
  it("keeps only the label of inline link markers", () => {
    expect(cleanWebRunMarkers(`# ${O}cite${S}2† Datasets:${C} tail`)).toBe(
      "# Datasets: tail",
    );
    expect(
      cleanWebRunMarkers(`${O}cite${S}79†Image†huggingface.co${C} AI at Meta`),
    ).toBe("Image AI at Meta");
  });

  it("drops bare page-reference markers", () => {
    expect(cleanWebRunMarkers(`${O}cite${S}turn0search4${C} rest`)).toBe(
      " rest",
    );
  });
});

describe("parseCodexWebRunOutput", () => {
  it("parses an opened page into windowed lines with metadata", () => {
    const parsed = parseCodexWebRunOutput(OPEN_OUTPUT);
    expect(parsed).toBeDefined();
    expect(parsed?.result.durationSeconds).toBe(0.8);
    expect(parsed?.result.pages).toHaveLength(1);

    const page = parsed?.result.pages[0];
    expect(page).toMatchObject({
      title: "README.md · facebook/covost2 at main",
      url: "https://huggingface.co/datasets/facebook/covost2/blob/main/README.md",
      ref: "turn1view0",
      wordLimit: 200,
      contentType: "text/html",
      source: 'open({"ref_id":"turn0search4","lineno":null})',
      totalLines: 1174,
    });
    expect(page?.lines).toEqual([
      { n: 37, text: "# Datasets:" },
      { n: 38, text: "" },
      { n: 39, text: "* * *" },
      { n: 40, text: "Image AI at Meta 13.5k" },
      { n: 41, text: "    indented: yaml" },
    ]);
    // The envelope's first line never reaches rendered content.
    expect(parsed?.contentText).not.toContain("Script completed");
    expect(parsed?.contentText).not.toContain("Wall time");
  });

  it("parses search hits into snippet pages", () => {
    const parsed = parseCodexWebRunOutput(SEARCH_OUTPUT);
    expect(parsed?.result.durationSeconds).toBe(1.2);
    expect(parsed?.result.pages).toHaveLength(2);

    const [first, second] = parsed?.result.pages ?? [];
    expect(first).toMatchObject({
      title: "A Context-aware Framework for Translation-mediated Conversations",
      url: "https://arxiv.org/abs/2412.04205",
      ref: "turn0academia12",
      published: "1.6 years ago",
    });
    expect(first?.lines).toBeUndefined();
    expect(first?.text).toContain("Title: A Context-aware Framework");
    expect(first?.text).toContain("More snippet prose on a second line.");

    expect(second).toMatchObject({
      ref: "turn0search0",
      published: "2.7 years ago",
      crawled: "last month",
    });
    expect(second?.text).toContain("facebookresearch / covost Public archive");
  });

  it("parses click results with redirect metadata", () => {
    const page = parseCodexWebRunOutput(CLICK_OUTPUT)?.result.pages[0];
    expect(page).toMatchObject({
      contentType: "text/plain",
      redirectedUrl: "https://huggingface.co/api/resolve-cache/covost2.py",
      totalLines: 8,
    });
    expect(page?.lines).toHaveLength(2);
  });

  it("keeps balanced parentheses inside page URLs", () => {
    const output = [
      "Script completed",
      "Wall time 0.4 seconds",
      "Output:",
      "Function (mathematics) (https://en.wikipedia.org/wiki/Function_(mathematics))",
      `${O}cite${S}turn0view0${C} [wordlim: 200] Content type: text/html; Total lines: 1`,
      "L0: A function maps inputs to outputs.",
    ].join("\n");

    expect(parseCodexWebRunOutput(output)?.result.pages[0]).toMatchObject({
      title: "Function (mathematics)",
      url: "https://en.wikipedia.org/wiki/Function_(mathematics)",
    });
  });

  it("splits dash-divided page blocks and keeps error pages honest", () => {
    const output = [
      "Script completed",
      "Wall time 1.0 seconds",
      "Output:",
      "First page (https://example.org/a)",
      `${O}cite${S}turn12view0${C} [wordlim: 200] Content type: text/html; Total lines: 3`,
      "L0: alpha",
      "-".repeat(80),
      "Internal Error ()",
      `${O}cite${S}turn22view0${C} [wordlim: 200] Source: open({"ref_id":"https://api.example.org"}); Total lines: 1`,
      "L0: URL https://api.example.org is not safe to open (non-retryable error)",
      "-".repeat(80),
    ].join("\n");
    const pages = parseCodexWebRunOutput(output)?.result.pages ?? [];
    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({ title: "First page", totalLines: 3 });
    // The 80-dash divider is provider markup, never page content.
    expect(pages[0]?.lines).toEqual([{ n: 0, text: "alpha" }]);
    // A divider glued to the end of a content line is also markup.
    const glued = parseCodexWebRunOutput(
      [
        "Script completed",
        "Wall time 1.0 seconds",
        "Output:",
        "Glued (https://example.org/g)",
        `${O}cite${S}turn0view0${C} [wordlim: 200] Total lines: 1`,
        `L0: updated 4 years ago ${"-".repeat(80)}`,
        "Next (https://example.org/n)",
        `${O}cite${S}turn0view1${C} [wordlim: 200] Total lines: 1`,
        "L0: beta",
      ].join("\n"),
    )?.result.pages;
    expect(glued?.[0]?.lines).toEqual([{ n: 0, text: "updated 4 years ago" }]);
    expect(pages[1]).toMatchObject({ title: "Internal Error ()" });
    expect(pages[1]?.url).toBeUndefined();
    expect(pages[1]?.lines?.[0]?.text).toContain("not safe to open");
    // An in-content short dash rule survives.
    expect(cleanWebRunMarkers("a\n----------\nb")).toBe("a\n----------\nb");
  });

  it("keeps envelope-only output as cleaned text", () => {
    const parsed = parseCodexWebRunOutput(
      "Script completed\nWall time 1.0 seconds\nOutput:\nNo results found.",
    );
    expect(parsed?.result.pages).toEqual([]);
    expect(parsed?.result.text).toBe("No results found.");
  });

  it("fails closed on unrecognized text", () => {
    expect(parseCodexWebRunOutput("ordinary command output")).toBeUndefined();
    expect(parseCodexWebRunOutput("")).toBeUndefined();
  });
});

describe("web.run normalization", () => {
  it("normalizes a code-mode web__run call to the Web tool", () => {
    const invocation = normalizeCodexCustomToolInvocation(
      "exec",
      'const r = await tools.web__run({search_query:[{q:"covost2 download"}],response_length:"long"}); text(r);',
    );
    expect(invocation.toolName).toBe("Web");
    expect(invocation.input).toEqual({
      search_query: [{ q: "covost2 download" }],
      response_length: "long",
    });
  });

  it("normalizes Web output into structured pages", () => {
    const normalized = normalizeCodexToolOutputWithContext(OPEN_OUTPUT, {
      toolName: "Web",
      input: {},
    });
    expect(normalized.isError).toBe(false);
    expect(normalized.content).not.toContain("Script completed");
    const structured = normalized.structured as {
      pages: Array<{ totalLines?: number }>;
    };
    expect(structured.pages[0]?.totalLines).toBe(1174);
  });

  it("normalizes the code-mode content-block output shape", () => {
    const normalized = normalizeCodexToolOutputWithContext(
      [
        {
          type: "input_text",
          text: "Script completed\nWall time 1.2 seconds\nOutput:\n",
        },
        { type: "input_text", text: SEARCH_OUTPUT.split("Output:\n")[1] ?? "" },
      ],
      { toolName: "Web", input: {} },
    );
    const structured = normalized.structured as { pages: unknown[] };
    expect(structured.pages).toHaveLength(2);
  });

  it("leaves unrecognized Web output untouched", () => {
    const normalized = normalizeCodexToolOutputWithContext(
      "plain failure text",
      {
        toolName: "Web",
        input: {},
      },
    );
    expect(normalized.structured).toBeUndefined();
    expect(normalized.content).toBe("plain failure text");
  });
});
