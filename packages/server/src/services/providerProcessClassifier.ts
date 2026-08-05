/**
 * Recognize which provider harness a host process is running, from executable
 * position alone.
 *
 * This is tactical 093's third adapter kind — the native process classifier —
 * held apart from `HostAgentProcessService` so that plan's process
 * reconciliation can reuse recognition without depending on the host process
 * inventory, its `ps` ownership, or its caching. Nothing here retains raw
 * command text; the caller reduces argv to a `ProviderName` while parsing its
 * one snapshot and keeps only that.
 */
import type { ProviderName } from "@yep-anywhere/shared";

function basename(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

function providerForExecutableName(value: string): ProviderName | undefined {
  const name = basename(value).replace(/\.exe$/i, "");
  switch (name) {
    case "claude":
      return "claude";
    case "codex":
      return "codex";
    case "gemini":
    case "gemini-cli":
      return "gemini";
    case "grok":
      return "grok";
    case "opencode":
      return "opencode";
    case "pi":
      return "pi";
    default:
      return undefined;
  }
}

function isGenericRuntime(value: string): boolean {
  const name = basename(value).replace(/\.exe$/i, "");
  return (
    name === "node" ||
    name === "nodejs" ||
    name === "bun" ||
    name === "deno" ||
    /^python(?:\d+(?:\.\d+)*)?$/.test(name)
  );
}

/**
 * Classify only executable-position tokens. Later command arguments may be
 * prompts or paths and must not make an unrelated process look like an agent.
 */
export function classifyProviderProcess(
  commandName: string,
  executableTokens: readonly string[],
): ProviderName | undefined {
  const direct = providerForExecutableName(commandName);
  if (direct) return direct;

  const runtime = executableTokens[0] ?? commandName;
  if (!isGenericRuntime(runtime)) return undefined;

  for (const token of executableTokens.slice(1, 4)) {
    const byName = providerForExecutableName(token);
    if (byName) return byName;

    const normalized = token.replaceAll("\\", "/").toLowerCase();
    if (
      normalized.includes("/@anthropic-ai/claude-code/") ||
      normalized.includes("/node_modules/claude-code/")
    ) {
      return "claude";
    }
    if (
      normalized.includes("/@openai/codex/") ||
      normalized.includes("/node_modules/@openai/codex-")
    ) {
      return "codex";
    }
    if (
      normalized.includes("/@google/gemini-cli/") ||
      normalized.includes("/node_modules/@google/gemini-cli/")
    ) {
      return "gemini";
    }
  }

  return undefined;
}
