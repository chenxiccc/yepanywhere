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

## Evidence to collect on recurrence

- Record whether the event followed a backend reattach, a natural compaction,
  or both, and whether the view was following the bottom.
- Sample animation-frame `scrollTop`, `scrollHeight`, bottom gap, and first/last
  visible render ids across transcript mutations. Also record active-window
  trim revisions and JavaScript scroll writes without transcript content.
- Compare the canonical message ids immediately before and after the event. If
  they remain stable while visible ids move, investigate geometry; if old ids
  are newly inserted, return to stream/persisted reconciliation.

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
