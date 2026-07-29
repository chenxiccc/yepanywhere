import { describe, expect, it } from "vitest";
import { augmentTextBlocks } from "../../src/augments/markdown-augments.js";

describe("assistant markdown augments", () => {
  it("renders bracket-delimited inline and display math through katex", async () => {
    const text = String.raw`
For each token \(t\), it formed only a local emission score:

\[
e_t(y)=(Wh_t+b)_y
\]
`;
    const block: { _html?: string; text: string; type: "text" } = {
      text,
      type: "text",
    };
    const messages = [
      {
        type: "assistant",
        message: { content: [block] },
      },
    ];

    await augmentTextBlocks(messages);

    expect(block._html?.match(/class="katex"/g)).toHaveLength(2);
    expect(block._html).toContain('class="katex-display"');
    expect(block._html).toContain('class="msupsub"');
  });
});
