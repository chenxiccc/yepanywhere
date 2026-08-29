# Opened perf sprint: measured UI latency owners from the 2026-08-28 run

The 2026-08-28 system-observed sprint
([report](../topics/performance-regression-suite.runs/20260828-system-observed-sprint.md))
closed with no accepted candidate but measured several UI operations whose
observed cost exceeds a 5% recovery bar, plus obvious bounded fixes and
measurement steps. This gap is the opened follow-up sprint: the remaining
selection, its order, and the dependency structure. Completed items are
deleted here, and an owning gap closes per `gaps/README.md` when its fix lands.

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
its result gates item 3.

### 2 — Instrument, then narrow, server persisted-message augmentation

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

### 3 — Render-window virtualization, main slice

The report's highest-benefit target, gated on item 1's re-measurement
showing settled full-history DOM size or tail latency is still material.
Evidence: the 360-turn full projection mounted 722 rows, ~19,000 elements,
46,500 nodes, and 26,500 layout objects; full-projection typing reached
229–235 ms and scroll accumulated 5.16–5.75 s of long-task time. Contract,
wake conditions, and acceptance live in
[`full-transcript-render-window-virtualization`](full-transcript-render-window-virtualization.md).

### 4 — Re-check tooltip reveal as transcript amplification

After item 3 (or any change that bounds mounted rows). Evidence: a themed
tooltip reveal on the large mounted transcript cost 445–462 ms after its
configured 80 ms delay, including a ~300 ms long task — over five times the
intended budget. The trace shows coupling to mounted size, not that
`TooltipLayer` owns the time, so repeat the reveal with bounded rows first;
edit tooltip code only if the long task survives virtualization.

## Considered and not selected

- The five-lane human-send visibility regression (+13.0%) is the sprint's
  end-to-end sensitivity headline, not an item: it has no identified owner
  and is the metric items 1–3 should move.
- Preprocessing/grouping loop rewrites: measured bodies were already
  sub-millisecond; the ~100 ms append residual is attributed via item 2's
  marks instead.
- The single-scenario weighted-score screen remains measurement-suite work
  tracked by the report's final disposition, not perf recovery.

Found 2026-08-29 while triaging the 2026-08-28 system-observed sprint report
into an opened follow-up perf sprint.
