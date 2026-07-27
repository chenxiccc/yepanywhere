import { describe, expect, it } from "vitest";
import { reflowCommitMessage } from "./reflowCommitMessage";

describe("reflowCommitMessage", () => {
  it("folds likely hard-wrapped prose into a soft-wrapping paragraph", () => {
    const first =
      "Rendered commit prose is commonly hard-wrapped for a readable terminal";
    const second =
      "but those stored breaks become jagged in the narrow source review pane.";

    expect(reflowCommitMessage(`${first}\n${second}`)).toBe(
      `${first} ${second}`,
    );
  });

  it("folds a lone short final line after a full prose line", () => {
    const first =
      "A manually wrapped paragraph can leave only a few words on its final";

    expect(reflowCommitMessage(`${first}\nline.`)).toBe(`${first} line.`);
  });

  it("preserves paragraphs, list starts, and hanging indentation", () => {
    const first =
      "Keep structure that carries meaning instead of treating every newline";
    const input = [
      first,
      "as disposable prose wrapping.",
      "",
      "- A bullet remains on its own line.",
      "  Its hanging continuation remains indented.",
      "* Star bullets remain distinct.",
      "• Typographic bullets remain distinct.",
      "2. Numbered bullets remain distinct too.",
    ].join("\n");

    expect(reflowCommitMessage(input)).toBe(
      [
        `${first} as disposable prose wrapping.`,
        "",
        "- A bullet remains on its own line.",
        "  Its hanging continuation remains indented.",
        "* Star bullets remain distinct.",
        "• Typographic bullets remain distinct.",
        "2. Numbered bullets remain distinct too.",
      ].join("\n"),
    );
  });

  it("preserves consecutive short table or diagram lines", () => {
    const diagram = ["before | after", "-------+------", "wide   | narrow"];

    expect(reflowCommitMessage(diagram.join("\n"))).toBe(diagram.join("\n"));
  });
});
