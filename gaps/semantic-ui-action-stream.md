# Semantic UI actions have no replayable stream seam

YA translates raw browser input into meaningful operations, but those
operations currently remain ordinary callbacks scattered across their owning
components. There is no small typed seam through which a performance harness
can gather or replay actions after key/mouse interpretation and before their
domain effects. A timed recording of raw keys, coordinates, clicks, or wheel
deltas would be brittle under the timing and layout changes that a performance
experiment is intended to cause.

Nearby code already supplies most of the right boundaries. `MessageInput`
emits `onSend`/`onQueue` intent and `SessionPage.handleSend` performs the
semantic composer operation; `SessionListItem.handleSessionClick` owns session
navigation; and `MessageList.scrollToBottom` owns one transcript-scroll
operation. `logSessionUiTrace()` supplies an observation-only diagnostic log
with a cheap inactive check, but its string events are not a typed invokable
action contract. Do not turn that diagnostic log into a command bus or create
a second client state system.

Add one client-owned **semantic UI action** seam above raw input. Human handlers
and replay should invoke the same existing semantic executor. An optional
gatherer observes the typed action at that boundary; an enabled replayer invokes
it directly. Start with a deliberately small action vocabulary sufficient for
one representative session trace, likely composer submit/delivery intent,
session navigation, and transcript scroll-to-turn. Expand only when an actual
trace requires another action.

Each gathered action should carry a stable action kind and schema version,
session/source identity, the minimal semantic payload, and a causal/time anchor
against messages the YA client actually observed from its server. Prefer the
stream `eventId` or durable session-message identity when it survives replay;
also permit a quickly checkable canonical digest of the most recent session
message. A record can then mean “100 ms after observing message X, submit Y.”
Compute digests and serialize payloads only while gathering or replaying.

This does not require an explicit replayable or sniffable view-layer
abstraction. The server-message anchor supplies causal/time alignment. The
harness may use its ordinary browser selectors or rendered-state assertions to
wait for a needed screen condition and validate the outcome, without routing
render state through a second YA event stream.

Replay remains best-effort. If a candidate changes server completion timing or
message structure, the event identity/digest may not appear. The harness should
record anchor match coverage, timeout, and first consequential divergence,
retain the resulting client/server performance data, and limit causal claims
after divergence rather than silently substituting an unanchored sleep or raw
input.

The normal disabled path must be extremely small: one predictable enabled
check and the existing direct semantic call, with no timestamp, digest,
serialization, payload clone, listener traversal, timer, promise wrapper, or
retained record. Follow the inactive-gate shape of `logSessionUiTrace()`, but
make any capture-only detail construction lazy as well. Gathering and injection
are explicit performance-harness modes; ordinary production interaction does
not pay their data costs.

Acceptance for the first vertical slice:

- one human composer action and one harness replay traverse the same semantic
  executor without synthesizing DOM or raw input events;
- gathering produces a versioned action record anchored to an actual YA
  server/session message identity or canonical recent-message digest plus a
  relative delay;
- a harness-launched browser replays the record, checks the visible outcome,
  and records both client and server performance measurements;
- an unmatched message or screen condition produces an explicit divergence
  record while retaining the run's measurements;
- tests prove that disabled mode performs no capture-only work, and an on/off
  measurement bounds the remaining branch/call overhead; and
- replay does not weaken the existing requirement that all old turns remain
  scrollable, displayable, ordered, and content-identical.

This seam supports `gaps/full-stack-degradation-injection.md` and the
code-growth-regularized load-capacity sketch in
`~/agents/topics/perf.sketches.md`. It was not implemented during the survey
work because the action schema, first executor boundary, anchor digest, and
harness fixture format require a focused client/performance slice.

Found 2026-08-28 while designing log-based client/server performance replay.
