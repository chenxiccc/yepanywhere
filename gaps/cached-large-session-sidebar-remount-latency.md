# Cached large-session sidebar switches still remount slowly

The saved browser settings enable a 256 MiB, 72-hour transcript cache and
session DOM linger, but repeated sidebar switching between two cached large
sessions remains slow. A frozen synthetic trace with two 360-turn sessions
measured 18 switches per ordered phase: pooled switch-to-next-paint medians
were 803 ms immediately after warm setup, 910 ms after 65 seconds without
injected activity, and 1,054 ms after one deterministic append. Individual
switches ranged from 600 to 1,437 ms and carried 119–465 ms of long-task work.

This directionally matches the user's observation that switching is rapid just
after a reload and worsens after time or subsequent session activity, but does
not yet separate those causes. The synthetic trace used frozen private-session
settings rather than reloading the user's private session. Its phases always
ran fresh, then idle, then append. The third repetition's fresh median was
already 1,087 ms, so phase order, elapsed time, ambient demand, repetition, and
activity are confounded.

The trace did not show corresponding short-window retention growth. Each
repetition ended with 42 rendered rows, 1,307 elements, 2,621 nodes, and 821
listeners. Initial JavaScript heap was 63.1–65.8 MiB and final heap was about
64.1 MiB. The cache held roughly 2.3 MiB. A monotonic DOM/listener/heap leak is
therefore not the demonstrated cause.

The current one-session DOM-linger contract deliberately covers a session to a
non-session route and back. Direct session A to session B replaces the lingered
route, so returning to A uses its retained snapshot but remounts the session
component and rebuilds projection/DOM. Likely owners span
`NavigationLayout.tsx`, `useSessionMessages.ts`, and `MessageList.tsx` rather
than the cache fetch alone.

First run an interleaved causal measurement:

- arm A: fresh switches, 65 seconds idle, another no-activity switch phase;
- arm B: fresh switches, immediate deterministic append, then another switch
  phase without the idle delay;
- alternate arm order across repetitions and retain host pressure;
- mark route click, snapshot lookup/hit identity, hydration, state queue,
  projection/grouping, React render/commit, layout, and readable paint; and
- count remounts, DOM reuse, live subscriptions, cache/store bytes, heap,
  listeners, and process memory.

A speculative test-only 50 ms delay at cache lookup or hydration should move
the painted endpoint by approximately 50 ms if that boundary is on the critical
path. A matched delay after state queue but outside the relevant commit should
not. Use this only to validate attribution; measure the actual optimization
on/off before predicting user benefit.

If remount/commit/layout dominates, compare these bounded fixes in order:

1. remove avoidable snapshot-to-projection reconstruction while retaining the
   current one-live-session resource contract;
2. apply render-window virtualization so remount cost depends on the visible
   chunks, especially for full activity/history; and
3. only with memory, stream-ownership, focus, mobile, and expiry evidence,
   consider a second short-lived inert DOM entry for direct A/B return.

Do not keep two full transcript DOMs merely because it makes one synthetic
switch fast. The second entry can duplicate streams, focus/shortcut handling,
provider liveness, and hundreds of MiB of browser state. Render-window
virtualization also cannot be credited as the complete fix in advance: this
trace's slow compact destination contained only 42 rows.

Acceptance: with the user's cache and Conversation View settings, repeated
cached A/B switches stay within a 100 ms heavy-redraw budget after both idle
time and appended activity; no blocking loader replaces the useful snapshot;
content, scroll, draft, stream, and source/session identity remain correct;
and memory, subscriptions, DOM, and listeners remain bounded through expiry.

Evidence and full conditions:
[`20260828-system-observed-sprint.md`](../topics/performance-regression-suite.runs/20260828-system-observed-sprint.md).

Found 2026-08-28 while exercising repeated cached sidebar switching under the
first system-observed performance sprint.
