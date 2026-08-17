# A session launched by another session's background command shows no link to its launcher

An agent can start a whole second harness process with a backgrounded Bash
call — `claude --resume <uuid> --print ... < task.md` — instead of a subagent.
YA records both sides correctly but connects neither to the other, so the work
looks orphaned from both directions.

What the launcher writes is a plain Bash tool call whose result carries
`toolUseResult.backgroundTaskId`. YA renders that as the "Background: <id>"
chip in `packages/client/src/components/renderers/tools/BashRenderer.tsx:242`,
and nothing more — the id names a harness-local output file
(`/tmp/claude-<pid>/<project>/<session>/tasks/<id>.output`), not a session.

What the child writes is an ordinary top-level session jsonl in the same
project directory. YA lists it, but as an unrelated session: nothing marks it
as launched by the first one.

Subagent detection is not the missing piece and is working correctly. It keys
on `agentId` + `isSidechain: true`
(`packages/server/src/augments/message-utils.ts:126`), and these transcripts
contain no sidechain entries at all, because no subagent was ever created.

The link is recoverable without new provider support. The background command
text contains `--resume <uuid>` for a resumed child, and a child started fresh
under `--output-format stream-json` announces its new `session_id` in the init
event written to that task output file. Either gives a launcher→child session
edge that the Agents view or the session hovercard could show.

Not fixed in place: the surrounding work was a transcript-rendering fix for
harness continuation entries, and this needs a new cross-session relationship
(discovery, storage, and a surface to show it), not a rendering tweak.

Found 2026-08-17 while tracing why an "Opus 5 task btthdjvcf" reported by one
session appeared nowhere in YA's subagent visualization.
