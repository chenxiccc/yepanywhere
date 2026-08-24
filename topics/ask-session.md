# Ask Session

> Proposal: an agent-invocable `ask a <description> session <question> |
> to <action>` command whose dispatcher matches the request against YA's
> session inventory, delivers it to a recently active match or launches
> a new session to do the work, returns the reply on stdout within an
> invoker-configured timeout or defers with a structured envelope to a
> reply turn in the calling session, persists each exchange as an ask
> record, and counts unread replies in a composer-adjacent asks drawer.

Topic: ask-session

Status: proposal, 2026-08-24. Nothing is implemented. Depends on the
[`agent-session-access.md`](agent-session-access.md) script layer; the
expected heavy caller is a boss agent ([`boss-mode.md`](boss-mode.md)),
but any session may ask. Inspired by the `~/agents` research-advisor
protocol's ask/tell split, generalized from one designated advisor to
description-addressed targets.

See also:
[`agent-session-access.md`](agent-session-access.md);
[`boss-mode.md`](boss-mode.md);
[`session-wake.md`](session-wake.md) — the reply doorbell and
resume-then-deliver ladder;
[`cross-host-delegation.md`](cross-host-delegation.md) — ask records are
the local form of its delegation records;
[`side-session-config.md`](side-session-config.md) — dispatcher cost and
model selection;
[`claude-cross-session-messaging.md`](claude-cross-session-messaging.md)
— the provider-native analog and the authority boundary;
[`inbox.md`](inbox.md) — the distinct user-attention surface;
[`project-queue.md`](project-queue.md);
[`emulated-slash-commands.md`](emulated-slash-commands.md);
[`vanilla-defaults.md`](vanilla-defaults.md).

## Command and surfaces

The primary surface is a script on the supervised session's PATH
(indicative name `ya-ask`), advertised by the
`new-session-agent-tooling.md` capability fragment:

```text
ya-ask "<project/topic description>" "<question>"
ya-ask "<project/topic description>" --to "<action>"
ya-ask --wait ...
```

A question expects an answer; `--to <action>` fires a task with a
deliverable expectation — the ask/tell distinction of the advisor
protocol. A composer `/ask` emulated command is a possible second
surface later; same mechanism underneath, per
`emulated-slash-commands.md`.

## Routing: an LLM dispatcher, not a server matcher

Free-text addressee descriptions need semantic matching, which the
server must not fake with a deterministic matcher. `ya-ask` engages a
small dispatcher session (opt-in, model and cost per
`side-session-config.md`) that reads the project/session catalog through
the same `agent-session-access.md` scripts and decides:

- **Direct delivery** to a matched target only when that target is
  *recently active* — recency judged from the same signals Inbox tiers
  use. Staleness matters: a long-idle session's context has rotted, and
  resurrecting it to answer usually serves worse than a fresh start.
- **Do the work**: no recently-active match → create a new session in
  the matched project (directly or via Project Queue dispatch) and give
  it the request.

The caller may skip the dispatcher when it already knows the target YA
session id.

## Delivery and reply

Delivery reuses existing machinery: the messages route for a live
target; the `session-wake.md` resume-then-deliver ladder for an idle
one. The request envelope carries the caller's YA session id (already
in the environment as `AGENTCTL_SESSION_ID`), a request id, and reply
instructions.

Reply is the same machinery pointed backwards, in one of the
`agent-cli` output-channel classes (the channel taxonomy and the stdout
deferral envelope are owned by `~/agents` `topics/agent-cli.md`):

- **Route unspecified (default)**: `ya-ask` blocks on stdout up to an
  invoker-configured timeout (`--timeout <s>`). A reply inside the
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
- **`--wait`**: block until the reply arrives, for questions a
  decision genuinely blocks on; the caller pays its own turn time.

Long replies go in files; the delivered turn is a doorbell plus
pointer (the wake path's text cap makes that split mandatory there
anyway).

## Ask records

The genuinely new server object. For the drawer to render outstanding
asks without parsing transcripts, YA persists a small record per
exchange: request id, caller session, resolved target or created
session, question-vs-action intent, status
(dispatched/delivered/answered/expired), reply pointer, timestamps, and
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
- Wake rate limits apply to reply delivery; dispatcher sessions are
  torn down like any helper; recorded parentage makes ask-triggers-ask
  chains auditable.
- Claude's native `ListAgents`/`SendMessage` stays an optional provider
  capability, not this protocol.

## Open decisions

- Dispatcher defaults: model tier, and whether a no-dispatcher
  deterministic mode (exact project/session id only) ships first.
- The default `--timeout` for route-unspecified asks.
- Ask-record retention bounds and expiry semantics for never-answered
  asks.
- Whether `/ask` (composer surface) ships with v1 or after the script
  proves the flow.
- Drawer scope: strictly per-session, or a global variant later.
