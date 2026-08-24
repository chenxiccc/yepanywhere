# Agent Session Access

> Proposal: local agents — first consumer, a supervising steward agent —
> search, browse, and message YA sessions through a small shipped script
> layer over the existing localhost REST surface; a YA-written
> filesystem/git mirror of session state is rejected.

Topic: agent-session-access

Status: direction proposal, 2026-08-24. Nothing is implemented; the
script layer, the search route, and the steward conventions below are
candidate work, not contracts. The launch-time half (PATH injection,
capability fragment, vanilla instruction scope) lives in
[`new-session-agent-tooling.md`](new-session-agent-tooling.md).

See also:
[`core-service-api.md`](core-service-api.md) — the external-consumer
seam (D0 thin client, D3 API doc, resolved localhost posture) this
proposal rides on;
[`session-wake.md`](session-wake.md) — implemented automation-to-session
turn delivery;
[`all-session-content-search.md`](all-session-content-search.md) — the
current search boundary;
[`cross-host-delegation.md`](cross-host-delegation.md) — the adapter
layering rule;
[`claude-cross-session-messaging.md`](claude-cross-session-messaging.md)
— the authority boundary and provider-native comparison;
[`session-ownership.md`](session-ownership.md);
[`project-queue.md`](project-queue.md);
[`security.md`](security.md).

## Direction: scripts over the existing REST surface

YA's `/api/*` routes already cover everything an agent-side consumer
needs: the global session catalog (`createGlobalSessionsRoutes`), full
normalized transcript reads (the session detail route in
`routes/sessions.ts`), sending a user message
(`POST /api/sessions/:sessionId/messages`), create/resume/fork,
`pending-input`, `mark-seen`, and Project Queue enqueue
(`routes/project-queue.ts`). On the default server this surface is
reachable from localhost with no credential; the loopback bind is the
trust boundary (`core-service-api.md`, resolved decision 3).

The proposal is therefore not a new API but a supported consumer of the
existing one: a handful of shipped scripts (indicative names —
`ya-sessions`, `ya-transcript`, `ya-search`, `ya-send`, `ya-new`) that
wrap those routes, plus the D3 API documentation deliverable already
named in `core-service-api.md`. This matches the standing layering rule:
REST, CLI, MCP, and skills are consumers or adapters over one
application service, never independent orchestration implementations
(`cross-host-delegation.md`).

Scripts speak canonical YA session ids (usually equal to the provider
session id), per `AGENTS.md` § Provider Session Identity. Provider-native
ids stay internal resume/debug detail.

## The search gap

Catalog metadata search exists; transcript-content search does not
(`all-session-content-search.md`). The dormant index design in its
sketches companion is sized for keystroke-latency UI search. An agent
tolerates seconds, so the agent-facing v1 can be much smaller: a bounded
server-side scan route over normalized visible-turn text (or, before any
server change, a script that pages session transcripts and greps
client-side). The sketches' corpus rules still govern what search may
return — visible user/assistant conversation text, not hidden context,
thinking, or tool payloads — and any new route needs the normal
capability review before the shipped web client may depend on it. If the
bounded scan proves too slow at real corpus sizes, the sketched index
becomes its backing store rather than a competing design.

## The steward use case

The motivating consumer is an optional supervising agent session — the
*steward agent* — that tracks other sessions' requests and deliverables.
Its bookkeeping conventions (request files in a watched directory,
replies at a related path, git-committed or not) are steward policy, not
YA features: the steward maintains its own repository using the
read/search/send primitives. YA deliberately does not write that
directory — see the rejection below.

Delivery paths the steward composes from existing YA machinery:

- **Message a live or resumable session**: the messages route for
  ordinary sends; the wake endpoint (`session-wake.md`) when the target
  may need resume-from-idle or when only the wake credential pair is at
  hand. Long payloads belong in files the worker reads; the message or
  wake text is the doorbell plus a path.
- **Dispatch new work**: Project Queue enqueue, which already hands
  queued requests to an idle project (`project-queue.md`).
- **File-based intake**: the request-intake half of the steward design
  overlaps the recorded missing feature in
  `gaps/at-session-launching.md` (YA launching due `at/` queue jobs);
  a steward wanting YA-driven intake should extend that design rather
  than invent a second file-watch convention.

## Authority and ownership boundaries

Two existing contracts bound every steward interaction and must be
restated in any implementation's docs:

- **Steward text is agent-authored input, never human authority.** It
  cannot approve permission requests, change the receiving session's
  settings, or raise any ceiling the user set — the same boundary
  `claude-cross-session-messaging.md` § The YA Authority Boundary draws
  for peer messages. This adds no new enforcement burden: a localhost
  process already holds single-operator power over YA (`security.md`),
  so the scripts add convenience, not authority.
- **One writer per provider transcript.** A steward interacts with a
  YA-supervised session only through YA. Driving it via provider-native
  resume/CLI risks a second writer forking or corrupting the transcript;
  the ownership rules in `session-wake.md` § Provider-CLI injection
  fallback apply verbatim.

## Rejected: YA-written filesystem/git mirror

Considered and rejected (2026-08-24): a YA mode persisting a
(git-controlled) directory view of session existence and activity, with
bidirectional save/restore. Reasons:

- It duplicates state the already-open localhost API serves, adding a
  second surface with its own consistency and staleness burden.
- Mirroring *activity* is high-rate; the bounded-resource mandates
  (`architecture-mandates.md`) would force it down to a turn-boundary
  existence ledger — at which point it is a strictly worse projection of
  the global-sessions route.
- The restore direction re-derives portable session bundles, which is
  `federated-super-sessions.md`, a separately designed problem.
- The steward can maintain its own git conventions from the scripts, so
  YA writing files adds no capability.
- Any YA-owned writes near a project would still need the explicit
  opt-in `project-directory-storage.md` requires.

A one-directional read-only export could be reconsidered only for a need
the live API cannot serve (for example offline audit of a stopped
server), and then as a new proposal, not a revival of this one.

## Naming

*Steward agent* (and *steward mailbox* for its request/deliverable
store) is the tentative vocabulary: "supervisor" collides with the
server's `Supervisor` class and YA's own product description, and
"inbox" collides with YA's Inbox attention view (`inbox.md`). Glossary
rows carry the unconfirmed marker until the terms are confirmed.

## Compatibility and defaults

New routes (the bounded search scan) are additive and capability-gated
per `server-capabilities.md` before the shipped client uses them; the
scripts themselves are same-host consumers and may ride the current
surface immediately. Shipped-script exposure inside sessions is
launch-time behavior owned by `new-session-agent-tooling.md` and ships
default-off per `vanilla-defaults.md`.
