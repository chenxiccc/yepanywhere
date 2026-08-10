# Accepted Codex steering message is absent from the live session UI

During an active Codex turn, YA accepted the steering message
`oh i think you are interp the diff as being between HEAD^1 and HEAD. actually i
prefer cumulative diff HEAD^1 and worktree.` and the agent received it, but the
mounted session UI did not show the sent user row. The Codex rollout persisted
both the `response_item` user message and `event_msg.user_message` at
`2026-08-10T03:04:47.556Z`, so this is a live echo/reconciliation omission rather
than lost provider input.

Reload immediately restored the missing turn in the correct session. Durable
provider replay is therefore healthy for this observation; the failing boundary
is the already-mounted live presentation before reload.

Investigation is deferred because it is unrelated to the file-viewer diff work
in progress. Reproduce against the active Codex steering path, then trace the
optimistic user echo through live session-detail reconciliation and durable
provider replay. The governing contract is
`topics/message-control-steer-queue-btw-later-interrupt.md` under **Deferred
queue reconciliation**: a server-accepted in-turn steer remains visible through
the provider turn boundary and reload reconciles it with the durable row.

First probe (user hypothesis, unverified): inspect whether the optimistic row is
still present in client state and the DOM but displaced, clipped, or scrolled
out when the end of Conversation View or a thinking panel changes height. Only
move inward to stream/replay reconciliation if the row is actually absent.

Found 2026-08-10 while adding file-viewer version-control actions.
