/** Format Codex subagent activity consistently for live and persisted events. */
export function formatCodexSubagentActivity(
  kind: string,
  agentPath: string,
): string {
  const target = agentPath ? `: ${agentPath}` : "";
  switch (kind) {
    case "started":
      return `Subagent started${target}`;
    case "interacted":
      return `Subagent updated${target}`;
    case "interrupted":
      return `Subagent interrupted${target}`;
    default:
      return `Subagent ${kind}${target}`;
  }
}
