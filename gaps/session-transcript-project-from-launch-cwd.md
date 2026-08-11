---
slug: session-transcript-project-from-launch-cwd
noticed: 2026-07-06
where: routes/sessions.ts PUT /projects/:projectId/sessions/:sessionId/project; resume cwd resolution
---

**Gap:** A session's transcript project can be recorded from a *launch cwd*
rather than the transcript's real home. Two connected symptoms, both observed
on one restart-handoff codex session (rollout `019f30db-...`, real home
`/local/graehl/trtllm-speculative/draft`):

1. A YA resume launched the codex process under `/home/graehl/agents` instead
   of the session's own recorded cwd, so the agent created files in the wrong
   directory. Resume derives cwd from the *URL* project (`getOrCreateProject`
   in the resume route), so a resume issued under the wrong project runs there.
2. The "move session to project" endpoint derives `transcriptProjectId` as
   `metadata?.transcriptProjectId ?? process?.projectId ?? projectId`. A live
   process's `projectId` is its launch cwd, which for codex is unrelated to
   where the rollout lives (codex addresses transcripts by the rollout's own
   `session_meta.cwd`). Moving such a session wrote `transcriptProjectId` =
   the launch cwd's project, i.e. a project that does not contain the
   transcript.

Invariant violated: for a provider whose transcript location is intrinsic to
the session file (codex: `session_meta.cwd`), the transcript project must be
derived from the file, never from a live process's launch cwd or the URL the
request happened to arrive on.

**Noticed while:** fixing the redirect loop / unviewable-session bug
(commit "Fix redirect loop that made moved sessions unviewable"). That commit
makes the bad state non-fatal — the loop is broken and a stale transcript
pointer self-heals to the working project — but does not stop the bad pointer
from being written, nor fix the wrong resume cwd.

**Planned remediation:**
[`docs/tactical/104-provider-session-identity-and-reactivation.md`](../docs/tactical/104-provider-session-identity-and-reactivation.md)
defines one provider/transcript/working-project resolver for the move, resume,
and reactivate paths. This gap remains open until transcript location no longer
falls back to a process launch project or an arbitrary request URL.
