# Ask Session

> Proposal: an agent-invocable exact-session ask command plus structured
> candidate search; the calling agent chooses the target, delivery and every
> synchronous wait are bounded, replies can defer to a later turn, and each
> exchange is represented by a retained ask record.

Topic: ask-session

Status: proposal, 2026-08-24. Nothing is implemented. Depends on the
[`agent-session-access.md`](agent-session-access.md) script layer; the
expected heavy caller is a boss agent ([`boss-mode.md`](boss-mode.md)),
but any session may ask. Inspired by the `~/agents` research-advisor
protocol's ask/tell split, generalized from one designated advisor to
caller-selected YA targets.

See also:
[`agent-session-access.md`](agent-session-access.md);
[`boss-mode.md`](boss-mode.md);
[`session-wake.md`](session-wake.md) — the reply doorbell and
resume-then-deliver ladder;
[`cross-host-delegation.md`](cross-host-delegation.md) — ask records are
the local form of its delegation records;
[`claude-cross-session-messaging.md`](claude-cross-session-messaging.md)
— the provider-native analog and the authority boundary;
[`inbox.md`](inbox.md) — the distinct user-attention surface;
[`project-queue.md`](project-queue.md);
[`emulated-slash-commands.md`](emulated-slash-commands.md);
[`vanilla-defaults.md`](vanilla-defaults.md).

## Command and surfaces

The primary surfaces are scripts on the supervised session's PATH,
advertised by the
`new-session-agent-tooling.md` capability fragment:

```text
ya-sessions search "<project/topic description>" --format json
ya-ask --session <ya-session-id> "<question>"
ya-ask --session <ya-session-id> --to "<action>"
ya-ask --session <ya-session-id> --wait --timeout 300 "<question>"
```

A question expects an answer; `--to <action>` fires a task with a
deliverable expectation — the ask/tell distinction of the advisor
protocol. A composer `/ask` emulated command is a possible second
surface later; same mechanism underneath, per
`emulated-slash-commands.md`.

## Routing: caller-selected structured candidates

`ya-ask` accepts one exact canonical YA session id and performs no target
reasoning. When the caller does not know the id, `ya-sessions search` returns a
bounded JSON candidate set with the YA session id, project id/path, provider,
title or summary, liveness, last activity, and match evidence. It does not pick
a winner or launch a model. The invoking agent already has the request
description and uses those facts to select a target.

A recently active, semantically relevant session is usually preferable to a
long-idle one. When no candidate is suitable, the caller explicitly creates or
queues work in a chosen project through `ya-new` or the Project Queue script,
then calls `ya-ask` with the resulting exact id. These remain separate
operations so a failed search cannot silently spend model quota or create work
in the wrong project.

A later human-only one-shot `/ask` surface may justify an LLM dispatcher when
usage evidence shows that the convenience repays its model cost and retained
session lifecycle. It is not part of the agent-invoked v1.

## Delivery and reply

Delivery reuses existing machinery: the messages route for a live
target; the `session-wake.md` resume-then-deliver ladder for an idle
one. The request envelope carries the caller's YA session id (already
in the environment as `AGENTCTL_SESSION_ID`), a request id, and reply
instructions.

Reply is the same machinery pointed backwards, in one of the
`agent-cli` output-channel classes (the channel taxonomy and the stdout
deferral envelope are owned by `~/agents` `topics/agent-cli.md`):

- **Route unspecified (default)**: `ya-ask` blocks on stdout for 30 seconds by
  default, or an invoker-selected shorter/longer timeout. A reply inside the
  window returns on stdout like any short verb. On expiry the call
  returns a structured deferral envelope as its last stdout line —
  request id, the channel the reply will arrive on (a turn into the
  calling session), expected duration when known, how to poll — and
  the exchange continues async: the caller ends its turn, and the
  responder's `ya-reply <request-id> ...` lands the reply as a turn in
  the calling session, resuming it if idle — exactly the case
  session-wake was built for.
- **`--async`**: timeout zero; the deferral envelope is emitted
  immediately and the caller never waits.
- **`--wait`**: use a five-minute default for a decision that genuinely blocks
  the caller. `--timeout <s>` may shorten or extend it, but the server rejects
  values above the hard 30-minute maximum. Reaching that maximum returns the
  same deferral envelope; it never leaves a script, provider turn, or server
  waiter blocked indefinitely.

Every synchronous waiter is owned by both a deadline and the calling request.
Caller disconnect, process cancellation, or abort releases the waiter without
discarding an already-delivered ask. Target deletion, launch failure, terminal
provider failure, explicit ask cancellation, and ask-record expiry resolve the
wait immediately with a structured terminal result containing the request id
and status. A target becoming merely idle is not terminal; the bounded timeout
still applies. No reply path may retain a waiter after its HTTP request or
deadline ends.

Long replies go in files; the delivered turn is a doorbell plus
pointer (the wake path's text cap makes that split mandatory there
anyway).

## Ask records

The genuinely new server object. For the drawer to render outstanding
asks without parsing transcripts, YA persists a small record per
exchange: request id, caller session, resolved target or created
session, question-vs-action intent, status (dispatched/delivered/answered/
target-failed/cancelled/expired), reply pointer, timestamps, and
parentage (the ask that triggered this ask, if any — so chains are at
least visible).

This is the same shape as the delegation record in
`cross-host-delegation.md`; the ask flow is its same-host degenerate
case. There must be one record concept that the cross-host layer later
extends, not two parallel ledgers. Records are bounded and retired
(architecture-mandates: no unbounded retention, no polling left behind
by a completed exchange).

## Asks drawer

A small client surface: a composer-nearby circle counting unread
replies for the current session's outstanding asks, opening a drawer
that lists them — status, target, click-through to the responder
session or the reply. It is not Inbox (`inbox.md` is user attention
across sessions; this is one session's outstanding delegations).

Per `vanilla-defaults.md` it ships default-off and renders nothing when
the feature is off or the session has no ask records. Placement follows
`composer-bottom-bar-overflow.md` and `session-ui-customization.md`.

## Boundaries

Restated from the owning topics, all binding here:

- Ask and reply text is agent-authored input, never human authority
  (`claude-cross-session-messaging.md` § The YA Authority Boundary): it
  cannot approve permission requests or raise user-set ceilings.
- One writer per provider transcript: all delivery goes through YA
  routes (`session-ownership.md`, `session-wake.md` § Provider-CLI
  injection fallback).
- Wake rate limits apply to reply delivery; recorded parentage makes
  ask-triggers-ask chains auditable. Agent-invoked asks launch no dispatcher
  session.
- Claude's native `ListAgents`/`SendMessage` stays an optional provider
  capability, not this protocol.

## Open decisions

- Ask-record retention bounds and expiry semantics for never-answered
  asks.
- Whether a human-only `/ask` composer surface and dispatcher are justified
  after the script proves the flow.
- Drawer scope: strictly per-session, or a global variant later.
