# Agent Session Access

> Proposal: local agents — first consumer, a supervising boss agent — search,
> browse, and message YA sessions through shipped scripts over a scoped channel
> to the existing REST application service; a YA-written
> filesystem/git mirror of session state is rejected.

Topic: agent-session-access

Status: direction proposal, 2026-08-24. Nothing is implemented; the
script layer, the search route, and the boss conventions below are
candidate work, not contracts. The launch-time half (PATH injection,
capability fragment, scoped endpoint channel, virgin instruction scope) lives in
[`new-session-agent-tooling.md`](new-session-agent-tooling.md).

See also:
[`core-service-api.md`](core-service-api.md) — the external-consumer
seam (D0 thin client, D3 API doc, resolved localhost posture) this
proposal rides on;
[`ask-session.md`](ask-session.md) — the packaged ask/reply flow built
on these primitives;
[`boss-mode.md`](boss-mode.md) — the delegated-orchestration working
mode;
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

## Direction: scripts over a scoped REST channel

YA's `/api/*` routes already cover everything an agent-side consumer
needs: the global session catalog (`createGlobalSessionsRoutes`), full
normalized transcript reads (the session detail route in
`routes/sessions.ts`), sending a user message
(`POST /api/sessions/:sessionId/messages`), create/resume/fork,
`pending-input`, `mark-seen`, and Project Queue enqueue
(`routes/project-queue.ts`). On the default server this surface is
reachable from localhost with no credential; the loopback bind is the
trust boundary (`core-service-api.md`, resolved decision 3).

The proposal is therefore not a second orchestration API but a supported,
scoped consumer of the existing application service: a handful of shipped
scripts (indicative names —
`ya-sessions`, `ya-transcript`, `ya-search`, `ya-send`, `ya-new`) that
wrap those routes, plus the D3 API documentation deliverable already
named in `core-service-api.md`. This matches the standing layering rule:
REST, CLI, MCP, and skills are consumers or adapters over one
application service, never independent orchestration implementations
(`cross-host-delegation.md`).

The scripts never guess `localhost`, a port, or the active profile. A launch
with agent tooling enabled receives the originating server's exact child-
reachable base URL and an ephemeral API token through the channel owned by
`new-session-agent-tooling.md`. The token authorizes only the catalog,
transcript/search, message, session-create, and Project Queue operations the
shipped scripts expose. It is not the operator's general login credential and
cannot call settings, permission approval, provider control, or other ambient
administration routes. Multiple servers and auth-enabled loopback listeners
therefore remain unambiguous even though the ordinary single-server default
also happens to accept unauthenticated loopback requests.

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

## The boss use case

The motivating consumer is an optional supervising agent session — the
*boss agent* ([`boss-mode.md`](boss-mode.md)) — that tracks other
sessions' requests and deliverables.
Its bookkeeping conventions (request files in a watched directory,
replies at a related path, git-committed or not) are boss policy, not
YA features: the boss maintains its own repository using the
read/search/send primitives. YA deliberately does not write that
directory — see the rejection below.

Delivery paths the boss composes from existing YA machinery — packaged
as the ask/reply flow in [`ask-session.md`](ask-session.md):

- **Message a live or resumable session**: the messages route for
  ordinary sends; the wake endpoint (`session-wake.md`) when the target
  may need resume-from-idle or when only the wake credential pair is at
  hand. Long payloads belong in files the worker reads; the message or
  wake text is the doorbell plus a path.
- **Dispatch new work**: Project Queue enqueue, which already hands
  queued requests to an idle project (`project-queue.md`).
- **File-based intake**: the request-intake half of the boss design
  overlaps the recorded missing feature in
  `gaps/yacron-scheduler.md` (durable future prompts through yacron); a boss
  wanting YA-driven intake should extend that design rather than invent a
  second scheduler or file-watch convention.

## Authority and ownership boundaries

Three contracts bound every boss interaction and must be
restated in any implementation's docs:

- **Boss text is agent-authored input, never human authority.** It
  cannot approve permission requests, change the receiving session's
  settings, or raise any ceiling the user set — the same boundary
  `claude-cross-session-messaging.md` § The YA Authority Boundary draws
  for peer messages. This adds no new enforcement burden: a localhost
  process already holds single-operator power over YA (`security.md`),
  so the scripts add convenience, not authority.
- **One writer per provider transcript.** A boss agent interacts with a
  YA-supervised session only through YA. Driving it via provider-native
  resume/CLI risks a second writer forking or corrupting the transcript;
  the ownership rules in `session-wake.md` § Provider-CLI injection
  fallback apply verbatim.
- **Scoped launch authority.** A tool-enabled child receives only its own
  short-lived API token and exact server endpoint. The scripts do not recover
  another process's credentials, fall back to a guessed port, or broaden the
  token when one operation is unavailable.

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
- The boss can maintain its own git conventions from the scripts, so
  YA writing files adds no capability.
- Any YA-owned writes near a project would still need the explicit
  opt-in `project-directory-storage.md` requires.

A one-directional read-only export could be reconsidered only for a need
the live API cannot serve (for example offline audit of a stopped
server), and then as a new proposal, not a revival of this one.

## Naming

*Boss agent* (and *boss mailbox* for its request/deliverable store) is
the confirmed vocabulary; the collision analysis — `Supervisor` class,
Inbox view, and *steward* being reserved for the `~/agents` on-deck
queue-tending mode — lives in [`boss-mode.md`](boss-mode.md) § Naming.

## Compatibility and defaults

New routes (the bounded search scan) are additive and capability-gated
per `server-capabilities.md` before the shipped client uses them; the
scripts themselves are same-host consumers and may ride the current
surface immediately. Shipped-script exposure inside sessions is
launch-time behavior owned by `new-session-agent-tooling.md` and ships
default-off per `vanilla-defaults.md`.
