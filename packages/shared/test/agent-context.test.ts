import { describe, expect, it } from "vitest";
import {
  buildEffectiveAgentContext,
  LATEX_MATH_RENDERING_CLIENT_CAPABILITY,
} from "../src/agent-context.js";

describe("buildEffectiveAgentContext", () => {
  it("recommends explicit LaTeX delimiters", () => {
    expect(LATEX_MATH_RENDERING_CLIENT_CAPABILITY).toBe(
      "The client renders Markdown, including LaTeX math. Prefer \\( ... \\) for inline math and \\[ ... \\] for display math. Use LaTeX notation where it improves clarity.",
    );
  });

  it("preserves plain global instructions when no hints are enabled", () => {
    expect(
      buildEffectiveAgentContext({
        globalInstructions: "Use TypeScript strict mode.",
      }),
    ).toBe("Use TypeScript strict mode.");
  });

  it("preserves raw global instruction spacing when no hints are enabled", () => {
    expect(
      buildEffectiveAgentContext({
        globalInstructions: "  Keep exact spacing.  ",
      }),
    ).toBe("  Keep exact spacing.  ");
  });

  it("adds client capabilities before global instructions when enabled", () => {
    expect(
      buildEffectiveAgentContext({
        globalInstructions: "Use TypeScript strict mode.",
        hints: { latexMathRendering: true },
      }),
    ).toBe(
      `[Client capabilities]\n${LATEX_MATH_RENDERING_CLIENT_CAPABILITY}\n\n[Global instructions]\nUse TypeScript strict mode.`,
    );
  });

  it("omits empty sections", () => {
    expect(
      buildEffectiveAgentContext({
        globalInstructions: "   ",
        hints: { latexMathRendering: true },
      }),
    ).toBe(`[Client capabilities]\n${LATEX_MATH_RENDERING_CLIENT_CAPABILITY}`);
  });
});
