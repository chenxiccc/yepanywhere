# Copilot subagent activity has no YA summary surface

GitHub Copilot (CLI, VS Code agent mode, and the official Copilot SDK)
does spawn isolated sub-agents. First-party visibility is event-shaped,
not a Claude-style sibling JSONL tree:

- SDK / CLI: custom agents plus lifecycle events on the **parent**
  session (`subagent.started` / `completed` / `failed`, envelope
  `agentId` / `toolCallId`). Docs tell hosts to build an agent-tree UI
  from those events. There is no documented durable child transcript
  directory analogous to Claude `subagents/` or Codex child rollouts.
- VS Code: `agent/runSubagent`; nesting off by default.
- Copilot CLI: model-initiated delegation and a `/subagents` picker.

YA has no first-class `copilot` provider (`topics/copilot-provider.md`
Architecture C is still a plan). The near-term path is OpenCode with
`github-copilot/*` models (`topics/opencode-copilot.md`).
`OpenCodeSessionReader.getAgentSession` returns `null`,
`getAgentMappings` is empty, and there is no
`listProviderChildSessions`. OpenCode `task` parts are normalized toward
YA `Task` for rendering, but they do not become provider-child
summaries.

Proposed work (do not invent a persistence layout Copilot does not have):

1. **OpenCode / Copilot-via-OpenCode (near-term):** if the OpenCode
   store keeps task/child rows keyed to a parent `ses_*`, expose them as
   `ProviderChildSessionSummary` from a cheap listing (no full message
   walk). Map `task` tool ids so the existing strip / Open / nested page
   can show at least title, type, and last activity. If the store has no
   child transcript, the nested page stays a summary-only empty state.
2. **Architecture C (when a YA Copilot provider exists):** persist the
   parent-stream lifecycle events into the same summary shape and render
   live count/running from `subagent.started` until `completed`/`failed`.
   Only add `getAgentSession` if the SDK later exposes a child log.
3. Keep Copilot child ids out of top-level YA session lists.

Until (1) or (2) lands, Copilot-backed sessions get only the generic
parent tool row.

Found 2026-08-16 while adding Claude subagent strip/page/list visibility
and comparing Copilot SDK custom-agent events to YA's OpenCode reader.
