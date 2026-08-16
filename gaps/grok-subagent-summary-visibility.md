# Grok child sessions are not nested under the parent in YA

Grok Build's TUI treats subagents as first-class delegated work: a
lifecycle block in the parent scrollback, a Ctrl+G tasks pane, and Enter
opens a framed child transcript. On disk (1.0.4 / grok-build source):

- Parent dir `~/.grok/sessions/<encoded-cwd>/<parent-id>/subagents/<id>/meta.json`
  holds `SubagentMeta` (`subagent_id`, `parent_session_id`,
  `child_session_id`, `subagent_type`, `description`, `status`,
  `started_at` / `completed_at`, …).
- The child is also a normal sibling session directory under the same
  encoded cwd. `child_session_id` is the same UUID as `subagent_id`.
- Nesting is hard-capped at one.

YA today maps live `spawn_subagent` to `spawn_agent` rows only.
`GrokSessionReader.getAgentSession` returns `null`,
`listProviderChildSessions` is absent, and `listSessions` includes every
session directory — so a spawned child can appear as an extra top-level YA
session, violating the provider-child identity contract in
`topics/provider-child-sessions.md`.

Proposed work (summary visibility first, reuse the Claude strip/page):

1. `listProviderChildSessions(parentId)`: readdir the parent's
   `subagents/*/meta.json` only. Do not parse `updates.jsonl`. Map
   `description` → title, `subagent_type` → agentType, timestamps →
   `updatedAt`.
2. `getAgentSession(childId)`: load the sibling child session through the
   existing Grok `updates.jsonl` replay and report `meta.status`.
3. Exclude those child ids from Grok `listSessions` / index rows so they
   stay nested, not sibling YA sessions. Do not treat
   `summary.json` `parent_session_id` (fork/restore) as a subagent link.
4. Then the existing metadata/list attach and nested
   `/sessions/:sid/agents/:id` page work with no new capability.

Live TUI extras (tasks-pane kill, framed prompt area) stay out of this
slice. Child views stay read-only; Grok's TUI is already mostly
observational for children.

Found 2026-08-16 while adding Claude subagent strip/page/list visibility
and reading Grok 1.0.4 `16-subagents.md` / `17-sessions.md` plus
`xai-org/grok-build` `SubagentMeta`.
