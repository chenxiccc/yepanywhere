# Mobile Wake Session Lifecycle Reconciliation

Status: Implemented

## Reported failure

After a phone screen was turned off during an active turn and later restored,
the session detail view could keep showing the bottom thinking indicator and
Stop action after the provider had completed. Navigating away removed the
stale view state. The report came through the encrypted relay, but the relay
was not the source of the incorrect lifecycle fact.

## Evidence

The 2026-08-29 incident provides a complete server-side ordering around the
visible failure:

- the provider emitted its final answer at `12:40:00.164` CEST and the durable
  completion boundary at `12:40:00.194`;
- the supervised process became verified idle with no retained provider work
  and an empty queue at `12:40:00.202`;
- immediately before completion, the phone restored visibility and sent the
  wake ping plus session metadata reconciliation request;
- the server forwarded the idle process-state event to the phone's still-live
  activity subscription and forwarded the session status through its session
  stream;
- 78 ms after the idle transition, the phone requested the transcript catch-up
  that `useSession` schedules only after handling idle activity;
- the target subscriptions remained connected until the user navigated away
  roughly 51 seconds later.

Those observations rule out a running provider, retained background work, a
missed idle delivery, and a relay reconnect as the explanation. They show that
the client processed the authoritative idle event but later rendered an older
active lifecycle fact.

The vulnerable writer is
`packages/client/src/hooks/useSession.ts::reconcileSessionRuntime`. Phone wake
starts `GET /api/projects/:projectId/sessions/:sessionId/metadata`, then applies
its ownership, process state, and pending-input fields unconditionally when the
request finishes. If idle activity arrives while that request is in flight, a
response based on the earlier runtime point can restore `in-turn` after idle.
The stream-error recovery path has the same unguarded snapshot shape.

This is the state-consistency race already described in:

- `005-client-session-lifecycle-store.md`, which records that independent
  `useSession` state can retain stale activity;
- `006-client-session-collection-store.md`, whose race policy says a snapshot
  must not overwrite a field group changed by a newer event; and
- `021-client-connection-readiness-vs-state-consistency.md`, which explicitly
  distinguishes this race from relay connection readiness.

## Likely fix

Keep the change local to the current session-detail owner instead of enacting
the larger canonical detail-store proposal:

1. Record a monotonic lifecycle observation revision whenever live stream,
   activity, or local action state changes ownership, process state, pending
   input, or liveness.
2. Give each runtime snapshot request a generation and capture the lifecycle
   revision when the request starts.
3. Apply snapshot lifecycle fields only if the request is still the newest
   runtime snapshot and no lifecycle observation arrived after it started.
4. Continue applying independent provider-runtime and deferred-queue facts;
   they have separate freshness domains and should not be discarded merely
   because lifecycle changed.
5. Use the same guard for the stream-error recovery fallback so a failed old
   request cannot force a newer live session idle.

No server route, event, capability, transport framing, timer, or compatibility
contract changes. A reconnect or later visibility refresh can still heal a
missed event because its snapshot starts after the missed-event window.

## Implementation plan

### 1 — preserve newer session lifecycle observations

Add hook-local observation and request generations, and route lifecycle
setters through the observation boundary. Snapshot application uses the raw
React setters only after its freshness check succeeds.

### 2 — guard wake and stream-error runtime snapshots

Apply the same request token to explicit wake reconciliation and stream-error
recovery. Do not change transcript catch-up or connection behavior.

### 3 — cover the screen-wake ordering

Add a hook regression that holds the wake metadata request open, delivers idle
activity, resolves the older request as `in-turn`, and requires the UI to stay
idle. Keep existing coverage proving that a current reconnect snapshot still
repairs stale local state.

### 4 — publish the observable lifecycle contract

Update `topics/provider-state-machine.md` to state the event-versus-snapshot
freshness invariant, then run focused client tests plus repository checks.

## Verification

- `useSession` phone-wake stale-response and stream-error fallback regressions:
  61 tests passed without runtime warnings after rebasing.
- Full client suite after rebasing: 454 files and 4,039 tests passed.
- Repository typecheck, lint, and format check passed.
- Client console scan remained at its ratcheted baseline: 110 warnings, 61
  `console.warn` sites, and 92 `console.error` sites, all with `+0` delta.
