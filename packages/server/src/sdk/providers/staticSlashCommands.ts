import type { ProviderName, SlashCommand } from "@yep-anywhere/shared";

export const CODEX_BUILTIN_COMMANDS: readonly SlashCommand[] = [
  {
    name: "compact",
    description: "",
    invocation: { kind: "native", prefix: "/" },
  },
  {
    name: "goal",
    description: "",
    invocation: { kind: "native", prefix: "/" },
  },
  {
    name: "status",
    description: "show current session configuration and token usage",
    invocation: { kind: "native", prefix: "/" },
  },
  {
    name: "usage",
    description: "view account token usage",
    argumentHint: "[daily|weekly|cumulative]",
    invocation: { kind: "native", prefix: "/" },
  },
];

export function getStaticSlashCommandsForProvider(
  provider: ProviderName | undefined,
): SlashCommand[] | null {
  return provider === "codex" ? [...CODEX_BUILTIN_COMMANDS] : null;
}
