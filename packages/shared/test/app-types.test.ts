import { describe, expect, it } from "vitest";
import {
  CLAUDE_EXTENDED_CONTEXT_WINDOW,
  CODEX_DEFAULT_CONTEXT_WINDOW,
  CODEX_GPT56_CONTEXT_WINDOW,
  DEFAULT_CONTEXT_WINDOW,
  getModelContextWindow,
  isAppMessage,
  isAppSession,
} from "../src/app-types.js";
import { toUrlProjectId } from "../src/projectId.js";

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

describe("isAppMessage", () => {
  it.each([
    ["an unknown discriminator", { type: "definitely-not-an-app-message" }],
    ["an incomplete system entry", { type: "system" }],
    [
      "a system subtype without its payload",
      { type: "system", subtype: "compact_boundary" },
    ],
    [
      "a provider completion without session identity",
      { type: "system", subtype: "turn_complete" },
    ],
    ["a summary without its leaf", { type: "summary", summary: "Recap" }],
    [
      "a summary without text",
      {
        type: "summary",
        leafUuid: "00000000-0000-4000-8000-000000000001",
      },
    ],
  ])("rejects %s", (_label, message) => {
    expect(isAppMessage(message)).toBe(false);
  });

  it("accepts complete system, provider, and summary entries", () => {
    expect(
      isAppMessage({
        type: "system",
        subtype: "compact_boundary",
        content: "Context compacted",
      }),
    ).toBe(true);
    expect(
      isAppMessage({
        type: "system",
        subtype: "api_error",
        level: "error",
      }),
    ).toBe(true);
    expect(
      isAppMessage({
        type: "system",
        subtype: "turn_complete",
        session_id: "session-1",
      }),
    ).toBe(true);
    expect(
      isAppMessage({
        type: "summary",
        summary: "Earlier work",
        leafUuid: "00000000-0000-4000-8000-000000000001",
      }),
    ).toBe(true);
  });
});

describe("isAppSession", () => {
  const session = {
    id: "session-1",
    projectId: toUrlProjectId("/repo"),
    title: "Session",
    fullTitle: "Session",
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:01:00.000Z",
    messageCount: 1,
    ownership: { owner: "none" },
    provider: "codex",
  };

  it.each([
    [
      "null nested content",
      { type: "user", message: { role: "user", content: [null] } },
    ],
    [
      "malformed tool use",
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: 42, name: "Read", input: {} }],
        },
      },
    ],
    [
      "malformed nested tool result",
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-1",
              content: [{ type: "text", text: 42 }],
            },
          ],
        },
      },
    ],
    [
      "role mismatch",
      {
        type: "user",
        message: { role: "assistant", content: "wrong role" },
      },
    ],
  ])("rejects %s", (_label, message) => {
    expect(isAppSession({ ...session, messages: [message] })).toBe(false);
  });

  it("accepts normalized cross-provider blocks without stripping fields", () => {
    expect(
      isAppSession({
        ...session,
        messageCount: 4,
        messages: [
          {
            type: "user",
            message: {
              role: "user",
              content: [
                { type: "input_image", image_url: "data:image/png;base64,x" },
              ],
            },
          },
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "call-1",
                  name: "custom",
                  input: ["scalar-compatible"],
                },
              ],
            },
          },
          {
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "call-1",
                  content: "provider-normalized",
                },
              ],
            },
          },
          {
            type: "system",
            subtype: "compact_boundary",
            content: "Context compacted",
            providerExtension: { future: true },
          },
        ],
      }),
    ).toBe(true);
  });
});
