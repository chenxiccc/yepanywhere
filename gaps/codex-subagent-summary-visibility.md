# Codex idle lists omit children until a child projection is already accepted

Claude's 2026-08-16 strip / nested page / idle-list work
(`topics/provider-child-sessions.md`) already consumes
`ProviderChildSessionSummary` and `GET .../agents/:agentId`. Codex already
implements both reader methods: `listProviderChildSessions` / the accepted
projection, and `getAgentSession` by child thread id. Spawned work is a
separate rollout (`session_meta.source.subagent.thread_spawn`) and is
excluded from top-level session counts.

What is still missing versus Claude-parity **summary** visibility:

- Project and global list attach use `accepted-or-cheap`. A cold Codex
  projection therefore omits `providerChildren` on the first list walk after
  restart; `listAcceptedProviderChildSessions` does kick a background
  rebuild, so a later walk can fill in. Sidebar pills and idle cards stay
  empty until that publish.
- The session strip's "recently active" count is a parent-`in-turn` plus
  3-minute mtime heuristic. Codex already emits `subagent_activity`
  (`packages/server/src/codex/subagentActivity.ts`) on the parent
  transcript; that live suffix is not folded into the strip or pill.
- The nested child page should work when `getAgentSession` finds the child
  rollout, but there is no focused UI capture or test that a Codex
  `spawn_agent` Open control reaches
  `/sessions/:sid/agents/:childThreadId` and renders the child rollout.

First-party Codex (Desktop / TUI) shows spawned threads as named workers
under the parent, not as extra top-level sessions. YA already matches that
identity contract.

Proposed work (small slices, in order):

1. Keep list attach accepted-or-cheap, but treat a *published* empty
   projection as "no children" and an unpublished cold miss as "omit"
   (`undefined`), so the next collection snapshot after background publish
   can attach without waiting for a process row.
2. Optionally overlay the latest `subagent_activity` text onto the strip
   for the matching child id when the parent is in-turn.
3. Add a Codex fixture test that metadata + `getAgentSession(childThreadId)`
   feed the existing strip / Open / nested page.

Do not parse parent rollouts on every global list read.

Found 2026-08-16 while adding Claude subagent strip/page/list visibility
and comparing first-party Codex thread spawn to YA.
