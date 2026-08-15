# Session Wake Turns

> Implemented: an authenticated server endpoint lets automation — first
> client: `agentctl` job completion — queue a real user turn into one specific
> session, so an agent that ended its turn with detached work in flight is
> woken by the completion event itself rather than by a timer or by the user
> noticing the silence.

Topic: session-wake

Related topic: [heartbeat ownership and timers](heartbeat.md) — the
timer-driven counterpart; wake turns are the event-driven one.
Related topic: [session liveness and queue intent](session-liveness.md).
Related topic: [session ownership](session-ownership.md) — why a second
writer on a provider transcript is never acceptable.
Related topic: [YA environment variables](ya-env-vars.md) and
[subprocess environment boundaries](subprocess-environment.md) — the
injection channels.

## Motivation

Codex-class providers give an agent a new turn only when a message
arrives or a tool call returns; there is no background-job completion
notification. An agent that ends its turn while a detached GPU job runs
is dead until the user types (observed 2026-08-09: a queued training
chain finished 15 minutes after the agent's final status turn, and the
GPU sat idle ten hours). Synthetic heartbeat turns bound that damage to
one quiet period; a wake turn removes the latency for the common case —
a supervised job finishing — and carries the completion facts in the
turn text.

## Contracts

- A wake turn is an ordinary queued user turn (the same server-side
  enqueue path heartbeat turns use), not a new message kind. It obeys
  the normal queue/steer delivery semantics, resets the same liveness
  anchors, and is visible in the transcript like any user message.
- Endpoint: a session-scoped wake route accepting
  `Authorization: Bearer <wake token>` and JSON `{text, source?,
  jobId?}`. Clients never construct the URL: they receive it fully
  formed in `YEP_SESSION_WAKE_URL` and treat it as opaque, so the
  route's exact path shape stays an implementation detail. Credentials are
  checked before any payload read. The HTTP body has an 8 KiB streamed hard
  limit (with declared length used only for early rejection); text is capped
  at 2000 characters and delivered verbatim.
- Auth is a per-session wake token — an HMAC of the YA session id under
  a persistent, owner-readable server secret — verified statelessly with a
  constant-time compare.
  Possession authorizes exactly one thing: queueing text into that one
  session. The cookie-auth surface is not involved, and the token never
  appears in logs.
- Feature-gated at delivery time, default off (vanilla-defaults): a
  global `wakeTurnsEnabled` server setting enables the endpoint, and
  per-session `wakeTurnsEnabled` metadata overrides it (`null` clears the
  override). A POST for a disabled session is rejected with 403; invalid
  credentials receive 401 without consulting or revealing the feature gate.
- Delivery ladder, server-owned:
  - live registered process → queue the turn;
  - no live process → resume-then-deliver through the same
    automatic-resume gate as unowned heartbeat candidates — never for
    archived or `autoResumeDisabled` sessions. Unlike the heartbeat
    candidate path, a transcript ending in a pending tool call is not
    required: the wake text is itself the reason to resume.
  - Explicit Kill semantics are unchanged: `autoResumeDisabled` blocks
    wake resume exactly as it blocks heartbeat resume.
- Env injection: provider children of a supervised session receive
  `YEP_SESSION_WAKE_URL` and `YEP_SESSION_WAKE_TOKEN` through the same
  channels that carry `AGENTCTL_SESSION_ID` today — spawn env for
  Codex, the agentctl `BASH_ENV` bridge for Claude. Injection is
  unconditional once the server supports the feature; the settings act
  at delivery time. This keeps enabling mid-session working without a
  process rotation, and the env inert while the feature is off. A plain local
  HTTP server derives the URL from its live localhost port. Remote executors
  and self-signed-HTTPS servers require `YEP_SESSION_WAKE_BASE_URL` to name an
  HTTP(S) origin the child can reach and trust. Claude remote resumes receive
  the env at spawn; a brand-new remote Claude session cannot receive it after
  its canonical id is learned because YA has no remote shell-env mutation
  channel yet.
- Per-session rate limit: burst capacity 3, refilling one wake per minute.
  Excess wakes receive 429 and are logged, never queued unboundedly. The
  in-memory buckets are LRU-bounded and refill from request timestamps, so
  wake handling creates no polling or timers (architecture-mandates).

## The agentctl client

The first producer is an `agentctl` plugin (`agentctl_plugins/wake.py`
in the agentctl repo, summarized in that repo's `topics/agentctl.md`):

- Arms only for agent-level launches (launch depth 0) whose launcher
  env carries `YEP_SESSION_WAKE_URL`; a `--no-wake` launch flag opts
  out.
- Fires from `on_finish` in the detached run wrapper — which survives
  agent-session teardown and inherited the launch-time env — so the
  wake happens even when the launching turn is long gone.
- The POSTed text is one factual line, e.g.
  `[agentctl-wake] job <name> finished returncode=<rc> elapsed=<t>
  log=<path> out=<path>`, with the last log line appended on failure.
  What to do on receipt (consume the completion, launch the successor)
  is the agent's standing instructions, not the wake text's job.
- Best-effort: stdlib HTTP, short timeout, one retry; on failure it
  writes one line to the job log and stops. Heartbeat turns, when
  enabled, remain the backstop for missed wakes.

### Provider-CLI injection fallback (not implemented)

The shipped `agentctl` wake plugin does not invoke a provider CLI when the YA
environment is absent. Any future fallback must obey these ownership rules:

When no wake env is present but a provider session id is known, direct
CLI injection is permitted only for providers whose CLI can append a
turn to the same durable session, and only after an unowned check —
never against a session a live process owns, since a second writer
forks or corrupts the transcript (session-ownership):

- Codex: a verified same-rollout resume command is safe only when nothing owns
  the rollout — no YA server supervising the session and no live process
  writing the file. The exact CLI contract must be re-verified against the
  pinned Codex version before implementation.
- Claude: headless `--resume` continues under a new session id, so CLI
  injection cannot wake the original session; do not use it there. The
  Claude harness has native wakeup mechanisms instead.

Under YA supervision the POST is strictly preferred: the server keeps
ownership, delivery, and liveness bookkeeping coherent, and the turn
lands in the live supervised process instead of a competing one.

## Representative Change Types

- Adding the wake route, token minting, or delivery-time gating.
- Changing wake env injection channels or names.
- Changing resume-on-wake eligibility or its interaction with archived
  and `autoResumeDisabled` state.
- Changing wake rate limits or the text cap.

## Tests That Should Fail On Contract Regressions

- A wake POST with a valid token queues a user turn on a live opted-in
  session even when no browser session page is open.
- A wake POST with a wrong token, or for a disabled session, is
  rejected and queues nothing.
- A wake POST for an opted-in session with no live process resumes it
  and delivers the turn; the same POST for an archived or
  `autoResumeDisabled` session does neither.
- Wake turns respect the per-session rate limit, and dropped wakes are
  logged rather than delivered late.
- Env injection provides the URL and token to the Codex spawn env and
  the Claude `BASH_ENV` bridge without either value reaching logs.
