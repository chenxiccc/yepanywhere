# Long-session old-content motion might recur

Commit `5b976d6c` fixed one proved cause of the observed long-session symptom:
reload-safe Codex reattach no longer republishes a completed active-turn
snapshot as fresh live activity. The original observation was broader than a
precise row-order claim, however: old material appeared to scroll by quickly
around compaction/replay in a session running longer than 24 hours. A similar
visual effect after that commit could be a separate viewport/follow defect even
when the final transcript contains no duplicate or reordered rows.

## Remaining candidate

While following the live tail, a third retained compact boundary can make the
active-window policy remove an old prefix
(`packages/client/src/lib/sessionDetail/activeWindowTrimPolicy.ts`).
`MessageList` then restores the new bottom in a layout effect and schedules a
second bottom write 50 ms later
(`packages/client/src/components/MessageList.tsx`). The current focused test
asserts the final `scrollTop` and follow state after a trim, but cannot observe
an intermediate browser paint
(`packages/client/src/components/__tests__/MessageList.scroll.test.tsx`).

This is not yet a demonstrated defect. Keep it open only as the recurrence
stub: a report after `5b976d6c` should first distinguish transient viewport
motion from transcript data reinsertion.

## Related live-tail signal

Before the server/page reload that activated the current fixes, a direct Codex
steer's optimistic echo appeared in Conversation View and then usually
disappeared on the next Conversation View update during high-rate thinking and
tool activity. Reload restored the user row, and the provider had already
responded to it. After reload, an ordinary-rate session kept the accepted steer
visible immediately, well before the busy provider responded. The observed
failure is therefore not initial echo omission; a later live-view update
invalidated the visible result, and the current fixes appear to mitigate at
least that path.

This proves delivery and persistence for the reported steer, but it does not
identify whether the pre-reload live view removed the row from client data or
only lost its viewport position. The update-driven disappearance most directly
matches the stale persisted-tail replacement fixed by `4feffd93`. The former
fast-burst follow race in
[`topics/scrollback-view-stability.md`](../topics/scrollback-view-stability.md)
could also leave the row in the DOM but above the visible tail; sticky explicit
Follow intent fixed that race on 2026-08-18. Treat a repeat on the reloaded
client as new evidence and first determine whether follow intent was already
active or was deliberately released.

## Reproduced old-turn data injection

On 2026-08-27, one live tab showed a much older completed turn at its bottom and
omitted the user's accepted `status` steer, while a fresh tab reconstructed the
correct tail from provider persistence. The Codex app-server notification queue
still contained notifications for the old turn when YA started consuming the
current one. The adapter treated the first different turn id as a live Core-id
correction, published the old content with receipt-time timestamps, and stopped
on that old turn's terminal event.

The provider adapter now records a monotonic receipt sequence on every
notification and captures a barrier before `turn/start`. Different-turn
notifications already queued at that barrier are suppressed and logged once as
a stale aggregate; post-barrier id changes retain the real Core-id race repair.
This closes the proved data-injection mechanism without closing the separate
unproved compaction-trim paint candidate that keeps this gap open.

## Reproduced steering paint gap

On 2026-08-26, steering an in-progress Conversation view turn while following
reproduced a transient geometry defect on current `main`. After the optimistic
user row committed, a layout-phase probe still observed the old bottom; the
send path did not write the new bottom until its passive effect ran after
paint. Moving that first write into the committing layout phase removes the
intermediate position while retaining the existing delayed catch-up writes.

The parked resume-position retry introduced by `cbf796fe` was not active in
this reproduction. The separate compaction-driven prefix-trim candidate above
remains unproved and keeps this gap open.

## Evidence to collect on recurrence

- Record whether the event followed a backend reattach, a natural compaction,
  or both, whether the view was following the bottom, and whether output was
  arriving in a fast burst.
- Sample animation-frame `scrollTop`, `scrollHeight`, bottom gap, and first/last
  visible render ids across transcript mutations. Also record active-window
  trim revisions and JavaScript scroll writes without transcript content.
- Compare the canonical message ids immediately before and after the event. If
  they remain stable while visible ids move, investigate geometry; if old ids
  are newly inserted, return to stream/persisted reconciliation.
- For a disappearing steer, separately record whether its canonical/render id
  remains in the DOM. Presence distinguishes the fast-burst follow race from a
  stale-tail replacement without relying on the visual impression alone.

## Paths that can close it

- [`topics/scrollback-view-stability.md`](../topics/scrollback-view-stability.md)
  owns the two follow regimes and the requirement to capture intent and restore
  geometry before paint. Route transcript shrink/growth through one atomic
  geometry transaction if the browser trace exposes an intermediate frame.
- [`docs/tactical/060-bounded-active-transcript-window.md`](../docs/tactical/060-bounded-active-transcript-window.md)
  already requires a following-bottom trim to remain at bottom with no visible
  one-frame jump. Close the gap with a real-browser regression that exercises a
  compaction-driven prefix trim; final-state jsdom assertions alone are not the
  stated contract.
- [`topics/stream-persisted-render-parity.md`](../topics/stream-persisted-render-parity.md)
  and
  [`topics/session-detail-data-layer.md`](../topics/session-detail-data-layer.md)
  own the alternate data-path diagnosis. If the trace shows actual reinsertion,
  make replay/REST catch-up converge atomically in the canonical reducer rather
  than adding a scroll workaround.
- [`packages/client/RENDERING_PERFORMANCE.md`](../packages/client/RENDERING_PERFORMANCE.md)
  forbids reconnect or stream effects from unexpectedly changing past-row
  height. Use that boundary if the motion comes from late rendering rather than
  prefix trimming.

Delete this gap when a reproduced recurrence is fixed with the applicable
browser contract, or when an equivalent browser regression proves the
compaction/reattach transition has no painted intermediate motion. Absence of a
single repeat is not closure evidence.

Found 2026-08-11 while fixing completed Codex snapshot replay after a reported
long-session compaction/replay visual disturbance.
