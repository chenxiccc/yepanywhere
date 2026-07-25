import { describe, expect, it } from "vitest";
import {
  CLAUDE_EXTENDED_CONTEXT_WINDOW,
  CODEX_DEFAULT_CONTEXT_WINDOW,
  CODEX_GPT56_CONTEXT_WINDOW,
  DEFAULT_CONTEXT_WINDOW,
  getModelContextWindow,
} from "../src/app-types.js";

describe("getModelContextWindow", () => {
  it("returns default window for unknown model", () => {
    expect(getModelContextWindow("unknown-model")).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("uses codex fallback when provider is codex and model is missing", () => {
    expect(getModelContextWindow(undefined, "codex")).toBe(
      CODEX_DEFAULT_CONTEXT_WINDOW,
    );
  });

  it("detects codex and gpt-5 models as 258K", () => {
    expect(getModelContextWindow("codex-5.3")).toBe(
      CODEX_DEFAULT_CONTEXT_WINDOW,
    );
    expect(getModelContextWindow("gpt-5-codex")).toBe(
      CODEX_DEFAULT_CONTEXT_WINDOW,
    );
    expect(getModelContextWindow("openai/gpt-5")).toBe(
      CODEX_DEFAULT_CONTEXT_WINDOW,
    );
  });

  it("uses the corrected 272K window for GPT-5.6 variants", () => {
    expect(getModelContextWindow("gpt-5.6-sol")).toBe(
      CODEX_GPT56_CONTEXT_WINDOW,
    );
    expect(getModelContextWindow("openai/gpt-5.6-terra")).toBe(
      CODEX_GPT56_CONTEXT_WINDOW,
    );
  });

  it("detects explicit Claude 1M model variants", () => {
    expect(getModelContextWindow("fable")).toBe(CLAUDE_EXTENDED_CONTEXT_WINDOW);
    expect(getModelContextWindow("claude-fable-5")).toBe(
      CLAUDE_EXTENDED_CONTEXT_WINDOW,
    );
    expect(getModelContextWindow("sonnet[1m]")).toBe(
      CLAUDE_EXTENDED_CONTEXT_WINDOW,
    );
    expect(getModelContextWindow("opus[1m]")).toBe(
      CLAUDE_EXTENDED_CONTEXT_WINDOW,
    );
    expect(getModelContextWindow("claude-opus-4-8[1m]")).toBe(
      CLAUDE_EXTENDED_CONTEXT_WINDOW,
    );
    expect(getModelContextWindow("claude-opus-5")).toBe(
      CLAUDE_EXTENDED_CONTEXT_WINDOW,
    );
    expect(getModelContextWindow("claude-sonnet-5")).toBe(
      CLAUDE_EXTENDED_CONTEXT_WINDOW,
    );
    expect(getModelContextWindow("anthropic.claude-opus-5")).toBe(
      CLAUDE_EXTENDED_CONTEXT_WINDOW,
    );
    expect(getModelContextWindow("claude-opus-4-8")).toBe(200_000);
  });

  it("keeps non-codex provider fallback at default", () => {
    expect(getModelContextWindow(undefined, "codex-oss")).toBe(
      DEFAULT_CONTEXT_WINDOW,
    );
  });
});
