# Heartbeat Ownership And Timers

Related topic: [Session liveness and queue intent](session-liveness.md).

This topic disambiguates YA's heartbeat-shaped mechanisms. They share timing
language, but they do not share ownership or evidence semantics.

## Contracts

- Server subscription heartbeats are transport/status frames. The session
  subscription emits a `heartbeat` event on its interval with
  `Process.getLivenessSnapshot()`, so connected clients receive the server's
  provider/session view even when no normal transcript message is moving.
- Server-to-client liveness updates are the product contract. The server owns
  the direct measurements and confirmations of activity or inactivity because
  it can see provider messages, process state, queue state, raw provider
  cadence, and provider probes more directly than the browser can.
- The liveness snapshot is authoritative for provider/session progress. Its
  timestamps come from provider messages, raw provider cadence, state changes,
  and provider probes. They are not derived from the last React render, DOM
  change, spinner tick, relative-time update, or other UI-visible movement.
- Synthetic heartbeat turns are currently server-owned. The client owns the
  settings UI and local optimistic state, but `Supervisor.runHeartbeatSweep()`
  decides whether to queue the configured user-message text for an opted-in
  idle session.
- New sessions snapshot their heartbeat interval and message from the first
  available tier: project override, global setting, then the built-in default.
  Project defaults seed only missing session metadata; they do not rewrite an
  existing session and do not opt a session into heartbeat turns.
- Heartbeat messages are bounded to 2,000 characters at every settings and
  session-metadata write boundary. The shared editor starts at one line and
  grows through four lines before scrolling, so a multi-line message remains
  practical without dominating either settings surface.
- Synthetic heartbeat turns must use the shared session-liveness contract:
  queue for `verified-idle`, and also for deliberately supported doubtful
  liveness states where YA cannot verify that the agent is making progress but
  the provider can accept the configured heartbeat as steering.
- The quiet-period anchor for a synthetic heartbeat turn is the latest real
  provider/session liveness signal accepted by the server, not the last
  UI-visible transcript movement. A transport heartbeat that merely proves the
  socket is alive does not itself prove provider progress.
- A pending foreground shell command row, spinner, or PTY-backed "Command via
  PTY" state is not by itself agent progress and must not reset the heartbeat
  quiet-period timer. The exception is recent actual output arriving in that
  PTY window; new output may count as a real liveness signal.
- The contract allows that PTY-output exception to be applied on the server or
  the client; this is an implementation boundary, not a claim about the current
  code path. If the client applies it, its inputs must still be server-reported
  tool/PTY evidence and liveness timestamps, not DOM movement, spinner
  animation, or local rendering cadence.
- For steering-capable providers, heartbeat is the configured auto-nudge when
  YA is in doubt about whether the agent is making progress. For
  non-steering providers, a heartbeat while the agent is still inside a
  foreground command has no useful delivery path and should remain deferred.
- The warning state that says the session may be waiting for input in another
  process is a primary diagnostic narrowing for this contract: it identifies a
  pending-tool/ownership ambiguity, not proof of useful agent progress.
- Client-local timers are client-owned. Relative-time labels, connection stale
  checks, long-press gestures, and any future client-owned periodic UI/message
  scheduler should use the browser event loop and compare wall-clock time
  against the most recent server-supplied liveness snapshot.

## Timer Behavior

- A client scheduled callback does not require a new server event in order to
  fire. If the client schedules a timeout or interval, and no later event
  updates the recent-live anchor, the callback still runs when the browser
  event loop gets a chance and observes that the old anchor is still old.
- Client timers are not exact clocks. Background tabs, mobile sleep, and main
  thread work may clamp or delay callbacks. Timer logic must therefore compare
  `Date.now()` or an injected wall-clock against the stored snapshot timestamp
  instead of assuming every interval tick happened on time.
- Delayed client timers must not invent liveness. On resume after suspension,
  the client may refresh, reconnect, or update elapsed labels, but provider
  progress claims still come from the next server snapshot or provider event.
- When the server confirms activity or inactivity, the client should display
  that server snapshot instead of replacing it with a locally inferred status.
- Server-owned synthetic heartbeat turn scheduling does not depend on an open
  session UI. One process-wide timer wakes at the earliest deadline any source
  reports, then reads current heartbeat settings plus the process liveness
  snapshot.
- A source that cannot prove a later deadline — queued work draining, liveness
  YA has not verified, a patient entry waiting on a state change — asks for the
  fallback recheck instead. That recheck is the fixed interval this scheduler
  replaced, so no situation is visited more often than it used to be.
- A heartbeat opt-in or a shorter global quiet period must announce itself to
  the supervisor (`notifyHeartbeatScheduleChanged`). With deadlines rather than
  a poll, an already-quiet session that becomes eligible would otherwise wait
  for some unrelated event to re-plan the timer.
- Unowned heartbeat candidates are retained, exact session projections rather
  than the result of a recurring project/provider search. Metadata and provider
  catalog reconciliation establish provider/transcript project identity; file,
  ownership, liveness, and metadata events update that row.
- Whether an unowned candidate ends in a pending tool call is a compact fact
  tied to an observed transcript source version. Unchanged negative results do
  not require another full transcript read, while append/replacement/truncation
  invalidates the fact.
- Candidate deadlines are scheduled by one process-wide owner. The next due
  timer compares wall-clock time with the latest real activity anchor; it does
  not run one interval per session or search all projects on a fixed tick.
- Older metadata missing exact transcript location is repaired once through
  bounded provider-catalog reconciliation. An unresolved candidate cannot
  authorize automatic resume and must not retry by repeatedly scanning every
  project/provider.

## Unowned Resume Exemptions

The unowned-candidate heartbeat path (`Supervisor.queueHeartbeatTurnForCandidate`)
can spawn a fresh provider process to resume a session with no live process when
the session is heartbeat-opted-in and its transcript ends in a pending tool call.
That power needs explicit exemptions, or a session the user has dismissed keeps
being resurrected (observed 2026-07-19: a killed, archived Codex session was
auto-resumed from its rollout three times in one day):

- **Archived sessions are never candidates.** Archiving says the user is done;
  the candidate filter uses `isUnownedHeartbeatResumeEligible`
  (`sessions/resume-exemption.ts`), which excludes `isArchived` metadata.
- **Explicit Kill blocks all auto-resume.** The Agents-page Kill button sends
  `blockResume: true` on `POST /api/processes/:id/abort`. After the shutdown is
  verified, the server clears the session's heartbeat opt-in and persists an
  `autoResumeDisabled` YA metadata marker checked by the shared automatic-
  resume gate. The unowned heartbeat candidate scan and cold fork-recap route
  both obey it. Provider transcripts are never renamed or hidden: the session
  remains in history and can be deliberately continued. Explicitly re-enabling
  heartbeat turns clears the marker because that fresh opt-in authorizes
  automatic turns. If persisting the exemption fails, the abort response and
  Agents page report that the process stopped but automatic resume was not
  disabled.
- The session-page Stop fallback abort, btw-aside cleanup aborts, and internal
  process-rotation aborts do **not** block resume; only the explicit Kill
  gesture opts in.

## Representative Change Types

- Moving synthetic heartbeat turn generation between server and client.
- Changing what events refresh a client's recent-live display.
- Changing subscription heartbeat payloads or intervals.
- Changing the liveness snapshot fields used by client stale/recent labels.
- Changing where the PTY no-recent-output exception is evaluated.
- Adding any client-owned periodic configured message or reminder scheduler.

## Tests That Should Fail On Contract Regressions

- A synthetic heartbeat turn queues from an opted-in idle server process even
  when no browser session page is open.
- A synthetic heartbeat turn does not queue while the snapshot is
  `verified-waiting-provider`, or while a non-steering provider is still inside
  foreground command work.
- A synthetic heartbeat turn queues for a steering-capable session in a
  doubtful long-silent state once the quiet period has elapsed without recent
  real PTY output.
- One eligible unowned session among many projects performs only an exact
  candidate/tail lookup at its deadline; unchanged negative pending-tool state
  and unresolved location do not create fixed-interval corpus reads.
- A server with nothing opted in and no patient entries arms no heartbeat timer
  at all, and an opted-in idle session is visited at its threshold rather than
  on every fixed tick in between.
- A settled unowned candidate is rechecked no more often than one idle
  threshold, and a fresh opt-in still schedules without waiting for unrelated
  activity.
- If the client handles the PTY exception, it uses server-reported PTY output
  timing and still treats a quiet foreground PTY as non-progress.
- A client relative-time or stale callback still fires when no new events have
  updated the stored liveness timestamp.
- Client UI movement alone does not refresh provider progress or reset the
  synthetic heartbeat quiet-period anchor.
