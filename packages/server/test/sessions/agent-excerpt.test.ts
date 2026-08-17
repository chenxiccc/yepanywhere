import { describe, expect, it } from "vitest";
import {
  extractLastAgentExcerpt,
  formatAgentExcerpt,
} from "../../src/sessions/agent-excerpt.js";
import type { Message } from "../../src/supervisor/types.js";

function assistant(content: Message["message"]): Message {
  return { type: "assistant", message: content };
}

describe("extractLastAgentExcerpt (provider-independent)", () => {
  it("keeps the last lines of the most recent assistant turn", () => {
    const messages: Message[] = [
      { type: "user", message: { role: "user", content: "go" } },
      assistant({
        role: "assistant",
        content: [{ type: "text", text: "first\nsecond\nthird\nfourth" }],
      }),
    ];
    expect(extractLastAgentExcerpt(messages)).toBe("second\nthird\nfourth");
  });

  it("falls back to an earlier text turn when the latest is tool-only", () => {
    const messages: Message[] = [
      assistant({
        role: "assistant",
        content: [{ type: "text", text: "earlier reply" }],
      }),
      { type: "user", message: { role: "user", content: [] } },
      assistant({
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
      }),
    ];
    expect(extractLastAgentExcerpt(messages)).toBe("earlier reply");
  });

  it("ignores hidden thinking when choosing recent visible activity", () => {
    const messages: Message[] = [
      assistant({
        role: "assistant",
        content: [{ type: "text", text: "visible reply" }],
      }),
      assistant({
        role: "assistant",
        content: [{ type: "thinking", thinking: "private reasoning" }],
      }),
    ];
    expect(extractLastAgentExcerpt(messages)).toBe("visible reply");
  });

  it("uses provider away summaries before older assistant text", () => {
    const messages: Message[] = [
      assistant({
        role: "assistant",
        content: [{ type: "text", text: "older reply" }],
      }),
      {
        type: "system",
        subtype: "away_summary",
        content: "Fresh recap. (disable recaps in /config)",
      },
    ];
    expect(extractLastAgentExcerpt(messages)).toBe("Fresh recap.");
  });

  it("clips long one-line excerpts at the end, not from the middle", () => {
    const excerpt = formatAgentExcerpt(
      `First sentence. ${"continued detail ".repeat(80)}`,
    );
    expect(excerpt.startsWith("…")).toBe(false);
    expect(excerpt.startsWith("First sentence.")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("labels the trailing tool when there is no agent prose", () => {
    const messages: Message[] = [
      assistant({
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Edit", input: {} }],
      }),
    ];
    expect(extractLastAgentExcerpt(messages)).toBe("⚙ Edit");
  });

  it("detects assistant turns by message.role (normalized non-Claude shape)", () => {
    const messages: Message[] = [
      // type left generic to mimic a provider whose converter sets only role.
      {
        type: "message",
        message: { role: "assistant", content: "shipped it" },
      },
    ];
    expect(extractLastAgentExcerpt(messages)).toBe("shipped it");
  });

  it("skips the synthetic placeholder for a turn no model ran", () => {
    // Claude Code writes this assistant-shaped entry when it restarts a dead
    // session without calling the model. Quoting it would report "No response
    // requested." as the agent's latest word, hiding the real last turn.
    const messages: Message[] = [
      assistant({
        role: "assistant",
        content: [
          { type: "text", text: "API Error: The operation timed out." },
        ],
      }),
      assistant({
        role: "assistant",
        model: "<synthetic>",
        content: [{ type: "text", text: "No response requested." }],
      }),
    ];
    expect(extractLastAgentExcerpt(messages)).toBe(
      "API Error: The operation timed out.",
    );
  });

  it("keeps a real turn whose text matches the placeholder wording", () => {
    const messages: Message[] = [
      assistant({
        role: "assistant",
        model: "claude-opus-4-5",
        content: [{ type: "text", text: "No response requested." }],
      }),
    ];
    expect(extractLastAgentExcerpt(messages)).toBe("No response requested.");
  });
});
