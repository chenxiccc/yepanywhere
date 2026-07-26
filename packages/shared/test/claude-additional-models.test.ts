import { describe, expect, it } from "vitest";
import {
  MAX_CLAUDE_ADDITIONAL_MODELS,
  MAX_CLAUDE_ADDITIONAL_MODEL_ID_LENGTH,
  MAX_CLAUDE_ADDITIONAL_MODEL_LABEL_LENGTH,
  isValidClaudeAdditionalModelId,
  isValidClaudeAdditionalModelLabel,
  parseClaudeAdditionalModelSelections,
} from "../src/claude-additional-models.js";

const CONTROL_CHAR = String.fromCharCode(1);

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

describe("isValidClaudeAdditionalModelId", () => {
  it("accepts a bounded whitespace-free id", () => {
    expect(isValidClaudeAdditionalModelId("claude-opus-4-8[1m]")).toBe(true);
  });

  it.each([
    "",
    "has space",
    "line\nbreak",
    `ctrl${CONTROL_CHAR}char`,
    "x".repeat(MAX_CLAUDE_ADDITIONAL_MODEL_ID_LENGTH + 1),
  ])("rejects %j", (id) => {
    expect(isValidClaudeAdditionalModelId(id)).toBe(false);
  });
});

describe("isValidClaudeAdditionalModelLabel", () => {
  it("accepts a bounded trimmed control-free label", () => {
    expect(isValidClaudeAdditionalModelLabel("Opus 4.8")).toBe(true);
  });

  it.each([
    "",
    " untrimmed",
    `ctrl${CONTROL_CHAR}char`,
    "x".repeat(MAX_CLAUDE_ADDITIONAL_MODEL_LABEL_LENGTH + 1),
  ])("rejects %#", (label) => {
    expect(isValidClaudeAdditionalModelLabel(label)).toBe(false);
  });

  it("rejects a custom id that is a valid id but an invalid label", () => {
    // The exact divergence the client add-custom path must also catch: a custom
    // entry stores label = id, so an id longer than the label bound is a valid
    // id yet an invalid label, and would 400 at the server if only id-checked.
    const longId = "x".repeat(MAX_CLAUDE_ADDITIONAL_MODEL_LABEL_LENGTH + 1);
    expect(isValidClaudeAdditionalModelId(longId)).toBe(true);
    expect(isValidClaudeAdditionalModelLabel(longId)).toBe(false);
  });
});
