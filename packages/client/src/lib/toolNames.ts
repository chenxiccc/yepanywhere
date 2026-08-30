// An alias here asserts the provider tool's input schema is compatible with
// the canonical renderer it routes to. Spec:
// topics/provider-read-edit-disciplines.md § How YA maps named blocks to one
// presentation.
const TOOL_NAME_ALIASES: Record<string, string> = {
  shell_command: "Bash",
  exec_command: "Bash",
  write_stdin: "WriteStdin",
  wait: "WriteStdin", // detached code-mode cell poll; same shell presentation
  update_plan: "UpdatePlan",
  apply_patch: "Edit",
  web_search_call: "WebSearch",
  search_query: "WebSearch",
  Agent: "Task", // SDK 0.2.76+ renamed Task → Agent
  view_image: "ViewImage",
  imageView: "ViewImage",
};

export function canonicalizeToolName(toolName: string): string {
  return (
    TOOL_NAME_ALIASES[toolName] ??
    TOOL_NAME_ALIASES[toolName.toLowerCase()] ??
    toolName
  );
}

export type ExplorationKind = "read" | "search" | "list";

// Classifies read/search/list-shaped actions for explored-run grouping.
// Unlike TOOL_NAME_ALIASES, membership asserts nothing about input schema, so
// provider tool names can be classified without routing them to a canonical
// renderer. Spec: topics/provider-read-edit-disciplines.md § Exploration-kind
// classification.
const EXPLORATION_TOOL_KINDS: Record<string, ExplorationKind> = {
  read: "read",
  grep: "search",
  search: "search",
  grepsearch: "search",
  grep_search: "search",
  glob: "list",
  ls: "list",
  list: "list",
  listdir: "list",
  list_dir: "list",
  "list-dir": "list",
};

export function getExplorationKind(toolName: string): ExplorationKind | null {
  return (
    EXPLORATION_TOOL_KINDS[canonicalizeToolName(toolName).toLowerCase()] ?? null
  );
}
