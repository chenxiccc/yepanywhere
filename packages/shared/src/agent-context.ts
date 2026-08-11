export interface AgentContextHints {
  latexMathRendering?: boolean;
}

export const LATEX_MATH_RENDERING_CLIENT_CAPABILITY =
  "The client renders Markdown, including LaTeX math. Prefer \\( ... \\) for inline math and \\[ ... \\] for display math. Use LaTeX notation where it improves clarity.";

export function buildEffectiveAgentContext({
  globalInstructions,
  hints,
}: {
  globalInstructions?: string | null;
  hints?: AgentContextHints | null;
}): string | undefined {
  const rawGlobalInstructions = globalInstructions || "";
  const trimmedGlobalInstructions = rawGlobalInstructions.trim();
  const clientCapabilities: string[] = [];

  if (hints?.latexMathRendering) {
    clientCapabilities.push(LATEX_MATH_RENDERING_CLIENT_CAPABILITY);
  }

  if (clientCapabilities.length === 0) {
    return rawGlobalInstructions || undefined;
  }

  const sections = [`[Client capabilities]\n${clientCapabilities.join("\n")}`];
  if (trimmedGlobalInstructions) {
    sections.push(`[Global instructions]\n${trimmedGlobalInstructions}`);
  }

  return sections.join("\n\n");
}
