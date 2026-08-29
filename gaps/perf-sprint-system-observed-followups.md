# Opened perf sprint: measured UI latency owners from the 2026-08-28 run

The 2026-08-28 system-observed sprint
([report](../topics/performance-regression-suite.runs/20260828-system-observed-sprint.md))
closed with no accepted candidate but measured several UI operations whose
observed cost exceeds a 5% recovery bar, plus obvious bounded fixes and
measurement steps. This gap is the opened follow-up sprint: the selection,
its order, and the dependency structure. It coordinates and sequences the two
existing item gaps rather than replacing them; each item below is deleted
here (and its own gap closed per `gaps/README.md`) as it lands.

Selection criteria applied to the report: (a) an obvious logical
improvement/fix, and (b) evidence that on its own supports recovering at
least 5% of an observed end-to-end UI operation.

## Ordered items

### 1 — Split older-page prepend into yielded semantic chunks

First slice of
[`full-transcript-render-window-virtualization`](full-transcript-render-window-virtualization.md),
independent of everything else, so it goes first. Evidence: one older-page
prepend on a live long transcript produced a 1.27-second long task, a 305 ms
key-to-frame delay, and two 10-second control-action timeouts. Chunked
commits with yields between them, preserving the existing older-page scroll
anchor, attack that single large commit directly; any recovery of the
multi-second stall clears 5% many times over. Re-measure after this step —
its result gates item 5.

### 2 — Land client phase marks (shared instrumentation)

Both remaining client diagnoses need the same marks, so build them once
before either trace: route click, snapshot/cache lookup and hit identity,
hydration, state queue, `MessageList` projection/grouping, React
render/commit, layout, and readable paint, plus remount/DOM-reuse/
subscription/retained-byte counters. Include the report's clock-validation
probe: a test-only 50 ms delay at cache lookup/hydration must shift the
painted endpoint by about 50 ms; the same delay after state queue but
outside the relevant commit must not. This item is measurement, not a
perf win itself; it is the dependency for items 3 and 4's client residual.

### 3 — Attribute, then reduce, cached sidebar-switch remount

Owned by
[`cached-large-session-sidebar-remount-latency`](cached-large-session-sidebar-remount-latency.md);
depends on item 2's marks. Evidence: pooled cached A/B switch medians of
803 ms fresh, 910 ms after 65 s idle, and 1,054 ms after one append, with
119–465 ms of long-task work while the compact destination held only 42
rows — a 5% recovery is 40–53 ms against a measured 175–465 ms long-task
share, so headroom is ample. Run the interleaved two-arm trace from that
gap (idle-only vs append-only, alternating arm order), then apply its
bounded fix ladder starting with removing avoidable snapshot-to-projection
reconstruction. Two-session DOM keepalive stays prohibited until the
memory/stream/focus/expiry evidence that gap requires.

### 4 — Instrument, then narrow, server persisted-message augmentation

Server-side and independent of the client track; can proceed in parallel
after item 1. Evidence: warm 360-turn append detail spent 94–113 ms of its
175–203 ms total (49–57%) in the augmentation call in
`packages/server/src/routes/sessions.ts` and the message-wide `Promise.all`
in `packages/server/src/sessions/persisted-augments.ts`; the cold request
spent 324 of 417 ms there. Halving warm augmentation saves 47–57 ms, about
a quarter of that server operation. First instrument cache hit/miss and
changed-message counts (plus the 50 ms in-augmentation delay probe to
confirm the clock is on the endpoint path); the obvious fix — reusing
augmentation for unchanged rows on the delta route — is applied only if the
counts show unchanged rows are being re-augmented, since skipping work
blind risks stale enriched output.

### 5 — Render-window virtualization, main slice

The report's highest-benefit target, gated on item 1's re-measurement
showing settled full-history DOM size or tail latency is still material.
Evidence: the 360-turn full projection mounted 722 rows, ~19,000 elements,
46,500 nodes, and 26,500 layout objects; full-projection typing reached
229–235 ms and scroll accumulated 5.16–5.75 s of long-task time. Contract,
wake conditions, and acceptance live in
[`full-transcript-render-window-virtualization`](full-transcript-render-window-virtualization.md).

### 6 — Re-check tooltip reveal as transcript amplification

After item 5 (or any change that bounds mounted rows). Evidence: a themed
tooltip reveal on the large mounted transcript cost 445–462 ms after its
configured 80 ms delay, including a ~300 ms long task — over five times the
intended budget. The trace shows coupling to mounted size, not that
`TooltipLayer` owns the time, so repeat the reveal with bounded rows first;
edit tooltip code only if the long task survives virtualization.

## Considered and not selected

- The five-lane human-send visibility regression (+13.0%) is the sprint's
  end-to-end sensitivity headline, not an item: it has no identified owner
  and is the metric items 1–5 should move.
- Preprocessing/grouping loop rewrites: measured bodies were already
  sub-millisecond; the ~100 ms append residual is attributed via item 2's
  marks instead.
- The single-scenario weighted-score screen and interleaved-arm harness
  reuse are measurement-suite work tracked by the report's final
  disposition, not perf recovery.

Found 2026-08-29 while triaging the 2026-08-28 system-observed sprint report
into an opened follow-up perf sprint.
