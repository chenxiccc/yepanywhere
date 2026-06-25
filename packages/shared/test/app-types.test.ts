import { describe, expect, it } from "vitest";
import {
  CLAUDE_EXTENDED_CONTEXT_WINDOW,
  CODEX_DEFAULT_CONTEXT_WINDOW,
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
  });

  it("detects DeepSeek V4 series as 1M context", () => {
    expect(getModelContextWindow("deepseek-v4-pro")).toBe(
      CLAUDE_EXTENDED_CONTEXT_WINDOW,
    );
    expect(getModelContextWindow("deepseek-v4-flash")).toBe(
      CLAUDE_EXTENDED_CONTEXT_WINDOW,
    );
    expect(getModelContextWindow("deepseek v4 flash")).toBe(
      CLAUDE_EXTENDED_CONTEXT_WINDOW,
    );
    expect(getModelContextWindow("DeepSeek-V4-Pro")).toBe(
      CLAUDE_EXTENDED_CONTEXT_WINDOW,
    );
    expect(getModelContextWindow("DEEPSEEKV4PRO")).toBe(
      CLAUDE_EXTENDED_CONTEXT_WINDOW,
    );
    expect(getModelContextWindow("deepseek-v4-pro[1m]")).toBe(
      CLAUDE_EXTENDED_CONTEXT_WINDOW,
    );
  });

  it("detects GLM 5.2 as 1M context", () => {
    expect(getModelContextWindow("glm-5.2")).toBe(
      CLAUDE_EXTENDED_CONTEXT_WINDOW,
    );
    expect(getModelContextWindow("glm5.2")).toBe(CLAUDE_EXTENDED_CONTEXT_WINDOW);
    expect(getModelContextWindow("GLM-5-2")).toBe(
      CLAUDE_EXTENDED_CONTEXT_WINDOW,
    );
    expect(getModelContextWindow("glm 5 2")).toBe(
      CLAUDE_EXTENDED_CONTEXT_WINDOW,
    );
    expect(getModelContextWindow("glm-5.2[1m]")).toBe(
      CLAUDE_EXTENDED_CONTEXT_WINDOW,
    );
  });

  it("keeps non-codex provider fallback at default", () => {
    expect(getModelContextWindow(undefined, "codex-oss")).toBe(
      DEFAULT_CONTEXT_WINDOW,
    );
  });
});
