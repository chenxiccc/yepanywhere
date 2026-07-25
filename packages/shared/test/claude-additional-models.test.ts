import { describe, expect, it } from "vitest";
import {
  MAX_CLAUDE_ADDITIONAL_MODELS,
  parseClaudeAdditionalModelSelections,
} from "../src/claude-additional-models.js";

describe("parseClaudeAdditionalModelSelections", () => {
  it("preserves valid exact ids and saved provenance", () => {
    expect(
      parseClaudeAdditionalModelSelections([
        {
          id: "claude-opus-4-8",
          label: "Opus 4.8",
          origin: "registry",
        },
        {
          id: "claude-future-6[1m]",
          label: "claude-future-6[1m]",
          origin: "custom",
        },
      ]),
    ).toEqual([
      {
        id: "claude-opus-4-8",
        label: "Opus 4.8",
        origin: "registry",
      },
      {
        id: "claude-future-6[1m]",
        label: "claude-future-6[1m]",
        origin: "custom",
      },
    ]);
  });

  it.each([
    null,
    [{ id: "claude-opus-4-8", label: "Opus 4.8", origin: "old" }],
    [{ id: " claude-opus-4-8", label: "Opus 4.8", origin: "registry" }],
    [{ id: "claude-opus-4-8", label: " Opus 4.8", origin: "registry" }],
    [
      { id: "duplicate", label: "First", origin: "custom" },
      { id: "duplicate", label: "Second", origin: "custom" },
    ],
    Array.from({ length: MAX_CLAUDE_ADDITIONAL_MODELS + 1 }, (_, index) => ({
      id: `model-${index}`,
      label: `Model ${index}`,
      origin: "custom",
    })),
  ])("rejects invalid selections %#", (value) => {
    expect(parseClaudeAdditionalModelSelections(value)).toBeNull();
  });
});
