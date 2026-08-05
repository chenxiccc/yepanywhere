# Session Initial Load Performance

Status: Active implementation experiment.

Progress:

- [x] 2026-06-28: Captured a long Codex session whose initial transcript load
  is visibly slow on mobile.
- [x] Confirmed the server response is not the dominant local bottleneck.
- [x] Confirmed `tailCompactions: 2` does not bound sessions with exactly two
  compaction boundaries.
- [x] 2026-07-06: Fixed the exactly-two-boundary discontinuity; once two
  compact boundaries exist, `tailCompactions: 2` starts at the first boundary.
- [x] Compared the existing `tailTurns` escape hatch as a proxy for chunked
  initial rendering.
- [x] Add a default-off Appearance setting for session loading progress.
- [x] Measure progress-only observability on the observed slow session.
- [x] Try a React transition around the initial transcript reveal.
- [x] Measure whether the transition changes responsiveness or just status.
- [x] Try progressive transcript mounting behind the same Appearance setting.
- [x] Measure first rows, stable rows, worst long task, and visible progress.
- [x] Revise progressive mounting to hide partial transcript chunks and reveal
  only after progress reaches 100%.
- [x] Scope progressive mounting to one initial-render cycle per session so
  composer edits and subsequent transcript updates do not re-open the loading
  overlay after the session is visible.
- [ ] Decide whether the implementation is worth keeping or should be replaced
  by a more direct virtualization/tailing strategy.

## Observed Session

Profile target:

- Public route:
  `https://latest.yepanywhere.com/macbook/projects/L1VzZXJzL2tncmFlaGwvY29kZS95ZXBhbnl3aGVyZQ/sessions/019f0e46-d9f0-7ae1-a7de-9b88aa53b3c8`
- Local route:
  `https://127.0.0.1:3400/projects/L1VzZXJzL2tncmFlaGwvY29kZS95ZXBhbnl3aGVyZQ/sessions/019f0e46-d9f0-7ae1-a7de-9b88aa53b3c8`
- Provider: Codex
- User-observed symptom: on a phone, `Loading session...` remains visible for
  roughly 10 seconds and the page is not interactable.

This session is a useful boundary case because it is not exceptionally large
by user-turn count, but it expands into a large render tree:

- API `session.messageCount`: 307
- API returned `messages`: 1,815
- Render items: 1,140
- Message rows: 1,100
- Tool rows: 609
- DOM nodes after load: roughly 26k-27k in the measured Chromium runs

## Historical Compact-Tail Edge Case

The client requests `tailCompactions: 2` on initial session detail loads. For
this session, the server returned the full transcript because the session had
exactly two compact boundaries and the old pagination condition treated that
as an untruncated window:

- `pagination.totalCompactions`: 2
- `pagination.hasOlderMessages`: false
- `pagination.returnedMessageCount`: 1,815

The old server behavior in `packages/server/src/sessions/pagination.ts` was:

```ts
if (compactIndices.length <= tailCompactions) {
  return everything;
}
```

That meant `tailCompactions=2` did not start at the first compact boundary
until a third boundary existed. A session with exactly two boundaries could be
larger than the same session immediately after its third compaction.

This has since been corrected: only sessions with fewer than the requested
number of compact boundaries return the full transcript. With
`tailCompactions=2`, a one-compaction session still returns the beginning,
`C1`, and the tail; an exactly-two-compaction session starts at `C1`.

Even if the implementation sliced from the first boundary when there are
exactly two boundaries, this session would still return about 1,428 messages.
That would help, but it would not be enough to make the mobile initial render
cheap.

## Local Measurements

Raw session REST request:

- `GET /api/projects/.../sessions/...?...tailCompactions=2`
- Download size: about 4.7 MB
- Local `curl` total time: about 0.24-0.27 seconds

Headless Chromium, desktop viewport (`1440x1000`, no CPU throttle):

- Stable transcript rows: about 2.4 seconds wall time
- Response JSON parse: about 125 ms
- State queued -> first transcript rows: about 638 ms
- State queued -> stable rows: about 1.46 seconds
- Long tasks: 3, total about 744 ms
- Worst RAF gap: about 733 ms

Headless Chromium, mobile-shaped viewport (`456x1024`, 4x CPU throttle):

- Stable transcript rows: about 6.5-7.8 seconds wall time
- Response JSON parse: about 170-190 ms
- State queued -> first transcript rows: about 2.4-2.7 seconds
- State queued -> stable rows: about 5.3-6.5 seconds
- Long tasks: about 4.3-5.7 seconds total
- Worst RAF gap: about 2.8-3.1 seconds

Interpretation:

- The backend and transfer time are not the main bottleneck for this session.
- `preprocessMessages` itself is not the main bottleneck in the measured run;
  `MessageList` preprocessing was single-digit milliseconds.
- The dominant cost is mounting, committing, styling, laying out, and running
  renderer effects for a full transcript with 1,100 rows and 609 tool rows.
- The old `Loading session...` paint remains visible while this work blocks the
  main thread, so adding subtext alone will not make the page interactive.

## 2026-08-05 Built-Server Cold Revisit

Tactical 089 measured a different 44,026,530-byte Codex session against a fresh
production build on an unused port and disposable YA app-data. The server was
reported as ready in 36-42 ms and listener-ready in 40-47 ms according to its
late internal timer, but that clock starts after module evaluation and
synchronous provider-watcher construction. An external
process-to-first-static-response clock measured 1,859 ms. A warm pre-entry
probe attributed about 566 ms to the server module graph/top-level setup before
Codex discovery, 155 ms to an isolated Codex discovery/version probe, about
0.46 s to the four provider scans/watcher attachments, and about 39 ms to the
`NO_BACKEND_RELOAD` source watcher. From the client session hook, the detail
response arrived at 3,075 ms, data was ready at 3,158 ms, and the transcript
commit effect ran at 3,265 ms.

That session's server read was 477 ms (333 ms file read, 133 ms parse, 13,617
entries, roughly +160 MiB heap/+175 MiB RSS). Client preprocessing was only
9.3 ms and the observed commit long task 119 ms. Route isolation identified the
larger delay: the sidebar Inbox badge mounted a global `/api/inbox` request,
which took 4.108 s and launched cold all-project/all-provider summary work. A
standalone `/api/projects` request took 0.463 s and launched no session parse.

This extends, rather than contradicts, the earlier long-DOM result. Initial
session latency has at least two independent regimes:

- large returned row count makes browser commit/layout dominant; and
- a cold server can delay even a bounded client render through competing global
  reconciliation.

The server-side correction is for boot to reconcile each previously used
provider store once in the background, publish Inbox shards progressively, and
keep selected-session routes independent of completion. The browser-side
progressive/windowed rendering work remains necessary for high-row-count tails.
Cold boot also needs a process-entry clock, post-bind advisory CLI probing and
source watching, and a measured bundle/lazy-import pass over the production
server graph. Readiness must include a useful selected-session route rather
than only static HTML. See
[`089-main-thread-startup-cpu-investigation.md`](089-main-thread-startup-cpu-investigation.md),
[`093-provider-session-reconciliation.md`](093-provider-session-reconciliation.md),
and [`topics/inbox.md`](../../topics/inbox.md).

## Existing Tailing Proxy

The URL-level `tailTurns` option gives a useful proxy for what a chunked initial
render could buy:

| Query | Messages | Rows | Mobile-shaped stable rows | Worst long task |
| --- | ---: | ---: | ---: | ---: |
| default | 1,815 | 1,100 | ~7.0 s | ~2.7 s |
| `tailTurns=10` | 694 | 435 | ~3.5 s | ~1.3 s |
| `tailTurns=5` | 289 | 186 | ~3.5 s stable, ~0.8 s first rows | ~0.8 s |

The stable-row time for `tailTurns=5` was still around 3.5 seconds in one run
because post-load effects and the session-preview refresh continued to do work,
but first transcript rows appeared much sooner and the worst single block was
far smaller.

## React Concurrency Notes

The client is on React 19. React has concurrent rendering features that are
relevant, but they are not an automatic fix for this load shape.

Useful primitives:

- [`startTransition` / `useTransition`](https://react.dev/reference/react/useTransition):
  mark non-urgent state updates so React can render them in the background and
  let more urgent interactions interrupt the work.
- [`useDeferredValue`](https://react.dev/reference/react/useDeferredValue):
  keep showing an older value while a slower subtree re-renders against a newer
  value in the background.
- `Suspense`: expose loading boundaries when data or code for a subtree is not
  ready.

Limits for YA's initial transcript load:

- React cannot yield during synchronous work before a state update, such as
  response JSON parsing, message tagging, deduplication, or any explicit loops
  the app runs in one task.
- React can time-slice render work, but the commit phase that inserts a large
  DOM tree is still synchronous from the user's point of view.
- Browser style/layout work for 1,100 mounted rows is outside React's scheduler.
- Transitions are best at keeping already-visible UI responsive while a new
  tree is prepared. They do not by themselves make mounting thousands of DOM
  nodes cheap.

For this case, React concurrency is a supporting tool, not the whole strategy.
The app still needs to reduce or split the amount of transcript DOM committed at
once.

## Improvement Directions

### Observability First

Add persistent, user-visible and loggable phase reporting around:

- fetch start / response headers / JSON parse complete;
- message merge and state queue;
- render work scheduled;
- first transcript rows committed;
- transcript rows stable;
- long task count and worst main-thread gap when available.

The existing `markReloadPerfPhase` hook already covers several of these phases
for one-off probes. The gap is production-visible status and trace capture,
especially on mobile where DevTools is not available.

Status text can truthfully report progress between tasks, for example:

- "Fetching session..."
- "Loaded 1,815 messages..."
- "Preparing transcript..."
- "Rendering 1,100 rows..."

But it must not imply the app can update during a multi-second synchronous
commit. If the implementation wants continuously updating progress, the work
has to be chunked or moved off the main thread.

### Progressive Initial Mount

Render a small recent slice first, then add older rows in yielded batches. This
could be implemented without changing the server contract at first by splitting
the loaded `RenderItem[]` client-side, though server-side tailing would reduce
payload and parse cost too.

Open details:

- Preserve scroll-to-bottom behavior for live tails.
- Preserve "Load older messages" and `tailFrom` semantics.
- Treat the loading overlay as an initial-load affordance only. After the first
  reveal for a session id, normal composer edits, pending messages, streamed
  updates, and appended transcript rows must render in place without showing the
  progress overlay again.
- Decide whether older batches prepend, append above, or hydrate placeholders.
- Avoid row-height changes above a scrolled-back reader unless the user asked
  for older content.

### Hydration Visibility Experiment

2026-06-28 follow-up measurement on the observed session used a mobile-shaped
Chromium viewport (`456x1024`) with 4x CPU throttling and the progress setting
forced on in the browser harness. The harness measured time from navigation to
progress bar display, progress reaching 100%, and the overlay being removed
with 1,162 rendered rows present.

| Variant | Progress shown | 100% | Reveal | Long-task total | Worst long task |
| --- | ---: | ---: | ---: | ---: | ---: |
| Previous `visibility: hidden` | 2.19-2.25 s | 5.67-6.01 s | 6.05-6.49 s | 3.9-4.2 s | 582-590 ms |
| Hydration rows `display: none` | 1.61-1.62 s | 3.86-3.94 s | 4.18-4.30 s | 3.1-3.6 s | 473-524 ms |
| Hydration rows `content-visibility: hidden` | 1.80 s | 5.28 s | 5.72 s | 4.6 s | 558 ms |
| `display: none` plus direct-child `content-visibility: auto` after reveal | 1.48 s | 3.83 s | 4.07 s | 2.8 s | 461 ms |

Interpretation:

- `visibility: hidden` still pays style/layout for hidden rows during every
  batch, so it improves perceived status but leaves much of the layout cost in
  the chunk loop.
- `display: none` during hydration was the best low-risk change. It reduced
  measured reveal time by roughly 1.9-2.2 seconds versus the previous rule.
- Adding `content-visibility: auto` after reveal helped only slightly beyond
  `display: none` and carries more risk around scroll height, browser
  find-in-page, quote selection, and search anchors. Keep that as a future
  virtualization-like experiment rather than the immediate tactical change.
- After applying the `display: none` rule in the real stylesheet, a follow-up
  implementation check measured progress shown at 1.96 s, 100% at 4.22 s, and
  reveal at 4.72 s. That run still improved total reveal time versus the
  previous baseline, but had a larger worst RAF gap (949 ms), so manual mobile
  feel should be checked before treating this as settled.

### Stronger Default Tail Bound

For sessions where compact boundaries do not bound the tail enough, add a
second cap such as recent user turns, render items, or estimated rows. The
existing `tailTurns` API is proof that a turn-based cap works mechanically, but
turn count is not a direct proxy for render cost: one turn can contain hundreds
of tool rows.

Any default change is user-visible because older transcript content would no
longer be present immediately on first load. Per `topics/vanilla-defaults.md`,
that should be approached as configurable/default-off until the UX tradeoff is
explicitly accepted.

### Virtualization

The large-scope proposal in `ARCHITECTURE.md` is now directly relevant. This
profile shows a real long-session case where row count and full DOM mount are
the dominant browser costs, not formatter work.

Virtualization would bound mounted rows, but it is still the highest-risk
option because it interacts with:

- auto-scroll and follow-current behavior;
- search anchors and browser find-in-page;
- selection/copy affordances;
- quote anchors;
- streaming markdown DOM updates;
- scrollback stability.

### Smaller Tactical Cleanup

There is duplicated preprocessing on the initial load path:

- `SessionPage` calls `preprocessMessages(messages)` for activity UI.
- `MessageList` calls `preprocessMessages(messages, augments)` again for
  rendering.

This was not the dominant cost in this profile, but it is on the same critical
path and should be removed or shared when touching the load/render pipeline.

## Working Hypothesis

The practical first implementation slice should be:

1. Add durable observability for the phase timings and long-task evidence.
2. Use that observability to prove the long block on real mobile devices.
3. Prototype progressive initial mounting behind a development flag or
   default-off setting.
4. Re-profile this session before deciding whether full virtualization is
   necessary.

This keeps the first change lower risk than virtualization while still attacking
the observed failure mode: the page cannot update progress or accept input while
it commits the full transcript in one large block.

## Active Experiment Plan

User request, 2026-06-28: add an Appearance setting that enables more detailed
session loading progress, then try the likely render-yielding experiments
against this exact slow session. The user will manually check after each change,
so each implementation step should leave the app in a coherent state.

Constraints:

- Preserve vanilla defaults: progress details and progressive transcript
  behavior are YA-novel and must be configurable/default-off.
- Use client i18n for the new Appearance copy and loading status text.
- Do not change the server session loading contract in the first experiment.
- Keep scroll-to-bottom behavior for a freshly opened session.
- Prefer a URL/dev escape hatch only as a profiling aid; the product control is
  the Appearance setting.

Measurement target:

- Route:
  `https://127.0.0.1:3400/projects/L1VzZXJzL2tncmFlaGwvY29kZS95ZXBhbnl3aGVyZQ/sessions/019f0e46-d9f0-7ae1-a7de-9b88aa53b3c8`
- Browser profile: mobile-shaped viewport (`456x1024`) with 4x CPU throttle.
- Metrics per run: first visible transcript rows, stable transcript rows,
  total long-task time, worst long task or RAF gap, visible loading/progress
  states.

### Experiment A: Progress Only

Expose more truthful load phases when the Appearance setting is enabled:

- fetching session;
- parsing/loaded message count;
- preparing transcript state;
- rendering transcript rows;
- rendered first slice / rows stable when detectable.

Expected outcome: more useful status before React blocks, but no major
improvement in the multi-second unresponsive render block.

Implementation result:

- Added the default-off Appearance setting "Session Loading Progress".
- Added hook-level progress phases for fetching, loaded/preparing, rendering,
  complete, and error.
- Added one opt-in timer yield before queuing the initial transcript state so
  "Rendering 1,815 messages..." can paint before the expensive mount.

Mobile-shaped benchmark (`456x1024`, 4x CPU throttle):

| Mode | First rows | Final rows stable | Worst long task | Worst RAF gap |
| --- | ---: | ---: | ---: | ---: |
| Setting off, full render | ~3.59 s | ~6.14 s wall | ~2.47 s | ~2.71 s |
| Progress setting on | ~3.30 s | ~6.53 s wall | ~2.33 s | ~2.60 s |

Visible status events with the setting on:

- ~0.59 s: "Fetching session..."
- ~0.96 s: "Rendering 1815 messages..."

Interpretation: observability works, but the page still waits for one large
transcript mount. This confirms status text alone is insufficient.

### Experiment B: Transition Reveal

Wrap the initial transcript reveal in a React transition, with the progress UI
outside the transitioned subtree where practical.

Expected outcome: may keep the shell/status paint more responsive while React
prepares work, but it probably will not split the large DOM commit/layout cost.

Implementation result:

- With the same setting enabled, wrapped the initial transcript reveal in
  `startTransition`.
- Kept the REST snapshot and buffered stream flush ordered together so live
  stream events merge on top of the loaded transcript.

Mobile-shaped benchmark:

| Mode | First rows | Final rows stable | Worst long task | Worst RAF gap |
| --- | ---: | ---: | ---: | ---: |
| Transition reveal | ~3.87 s | ~6.17 s wall | ~1.48 s | ~1.73 s |

Interpretation: React transition reduced the worst observed block, but first
content still appeared as one full transcript commit. It is useful, but not
enough by itself.

### Experiment C: Progressive Mount

When the setting is enabled, render a recent transcript slice first, then yield
between batches while adding older render groups. Keep the initial view pinned
to the live tail unless the user scrolls away.

Expected outcome: first useful content appears much earlier and the worst
single main-thread block shrinks. Total time to fully mount all older transcript
rows may stay similar or increase slightly.

Open implementation concerns:

- Transcript search and anchors must not silently navigate to rows that are not
  mounted yet.
- Find-in-page cannot find unmounted older content until hydration completes.
- Batches that prepend older content above the viewport must preserve the live
  tail position.
- Streaming/current-turn rows should not be delayed behind older-history
  hydration.

Implementation result:

- When the setting is enabled, `MessageList` renders the recent transcript tail
  first and hydrates older timeline entries in timer-yielded batches.
- Transcript search disables progressive slicing and forces the full timeline
  into the DOM.
- Hydration pauses if the reader has scrolled away from the tail, avoiding
  automatic prepends above a scrolled-back viewport.
- Tuned targets for this session: about 120 render items initially, then about
  90 render items per batch.

Mobile-shaped benchmark after tuning:

| Mode | First rows | Final rows stable | Worst long task | Worst RAF gap |
| --- | ---: | ---: | ---: | ---: |
| Progressive mount | ~2.69 s | ~9.39 s wall | ~0.69 s | ~0.78 s |
| Setting off, full render after implementation | ~4.55 s | ~7.35 s wall | ~3.10 s | ~3.45 s |

Observed progressive row/status events:

| Time | Rows | Status |
| ---: | ---: | --- |
| ~2.69 s | 124 | Rendering transcript 12% |
| ~3.42 s | 291 | Rendering transcript 18% |
| ~4.17 s | 435 | Rendering transcript 25% |
| ~4.82 s | 629 | Rendering transcript 42% |
| ~5.67 s | 866 | Rendering transcript 52% |
| ~6.62 s | 1085 | Rendering transcript 88% |
| ~7.50 s | 1191 | Rendering transcript 98% |
| ~7.81 s | 1192 | complete |

Interpretation: progressive mounting trades longer total full hydration for a
much smaller worst block and visible incremental progress. This matches the
desired mobile UX better than progress-only or transition-only.

Manual-check finding: this first progressive variant exposed partial content as
soon as the first chunk committed, and hydration paused when the reader scrolled
away from the tail. That was too easy to interpret as "stuck" because a user
could scroll to the visible partial transcript and freeze the status at an
intermediate percentage.

### Experiment D: Hidden Hydration Then Reveal

Revised direction, 2026-06-28: keep the progress surface visible, continue
mounting transcript chunks invisibly, and reveal the transcript only after the
hidden DOM reaches 100%.

Implementation result:

- The setting now shows a centered progress panel with a real progress bar.
- The render phase keeps the same visible "Loading session..." header as the
  REST load phase; only the detail line changes to progress text.
- Transcript chunks mount under a hidden, non-interactive message-list state
  while progress updates.
- Hydration no longer pauses when the user scrolls during progress.
- Once all hidden chunks are mounted, progress shows 100% briefly, then the
  full transcript is revealed.

Mobile-shaped benchmark after revision:

| Mode | First hidden rows | First visible rows | Reveal | Worst long task | Worst RAF gap |
| --- | ---: | ---: | ---: | ---: | ---: |
| Hidden hydration | ~2.2-2.6 s | ~7.3-9.8 s | ~7.3-9.8 s | ~0.63-0.91 s | ~0.69-1.08 s |

Observed hidden hydration events:

| Time | Mounted rows | Visible rows | Status |
| ---: | ---: | ---: | --- |
| ~2.2-2.6 s | 124 | 0 | Rendering transcript 12% |
| ~2.9-3.3 s | 291 | 0 | Rendering transcript 18% |
| ~3.4-4.1 s | 435 | 0 | Rendering transcript 25% |
| ~4.1-4.9 s | 629 | 0 | Rendering transcript 42% |
| ~4.7-6.0 s | 866 | 0 | Rendering transcript 52% |
| ~5.5-7.6 s | 1085 | 0 | Rendering transcript 88% |
| ~6.4-8.5 s | 1191 | 0 | Rendering transcript 98% |
| ~6.6-9.2 s | 1192 | 0 | Rendering transcript 100% |
| ~7.3-9.8 s | 1192 | 1192 | revealed |

Targeted scroll check: after forcing the session scroll container to the top at
about 3.2 seconds, hydration still completed and revealed all 1,192 measured
rows at about 7.0-7.6 seconds. This directly addresses the manual-check freeze.

Interpretation: hidden hydration matches the requested UX better than visible
chunking. It keeps the page responsive and the progress bar honest, while still
avoiding partial transcript content. The total time before usable transcript
content is longer than visible chunking because the user waits for the full
hidden mount.

Residual concerns:

- Browser find-in-page still cannot find hidden/unmounted rows until hydration
  completes and the transcript is revealed.
- This is not a substitute for true virtualization; it only splits the initial
  mount cost.
