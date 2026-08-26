# Transcript Virtualization

> Bound the session transcript's browser cost — DOM size and per-tick
> render/style/layout work — to the viewport rather than to total session
> length, so a long or streaming session cannot grow native browser memory
> without limit.

See also:
- [`memory-growth.md`](memory-growth.md) — the measured root cause this plan
  fixes (§ *2026-07-09: real cause of the "10 GB tab"*): a non-virtualized
  transcript re-rendered every second, native RSS climbing with a flat V8 heap.
- [`client-route-retention.md`](client-route-retention.md) — bounded in-tab
  snapshot retention; virtualization is orthogonal (bounds a single live view;
  retention bounds cross-route caching).
- [`../packages/client/RENDERING_PERFORMANCE.md`](../packages/client/RENDERING_PERFORMANCE.md)
  — render pipeline and the "rich formatters see one block, not the transcript"
  invariants virtualization must preserve.

Topic: transcript-virtualization

Status: Stage 1 item 1 landed (stabilize MessageList's callback props): idle CPU
~22% → ~9%, per-second O(rows) re-render gone. The Stage 2
`content-visibility: auto` experiment was retired on 2026-08-26 after confirmed
scroll-position failures and severe amplification in a real long-session
reload. The bounded semantic client window is the shipped transcript bound.

2026-07-09 (follow-up, measured): **Stage 1 items 2–3 are moot, not
"re-prioritized."** Direct render-count instrumentation on the full-transcript
idle page (temporary `window.__mlRender`/`__riRender` counters + CDP profile)
showed `MessageList` re-renders **0.1/s** (item 1's memo holds) and
`RenderItemComponent` re-renders are a **one-shot settling burst** (identical
count over a 10 s and a 30 s window), not steady churn. So the row-map inline
arrows (item 2) are never recreated on idle, and `staleNowMs` is already gated
to the single latest-visible row (item 3). Items 2–3 target re-render churn
that measurement shows does not occur; they are at most defensive hardening for
a future where `MessageList` re-renders often again.

2026-08-23 (active-stream follow-up): the idle conclusion above still holds,
but active output is exactly the case where `MessageList` renders often again.
In a 7,543-element real-work tab, one changed live tail re-entered all 40
historical assistant galleries. The defensive boundary from items 2–3 is now
landed: projected render items, turn groups, and display rows retain identity,
and memoized user/assistant turn entries receive only row-local age state. A
40-turn text probe and a 20-turn explored-tool probe now enter only the changed
current turn. A post-fix real-tab trace during continued assistant text,
thinking, tool, and processing-typewriter updates recorded a 46.6 ms maximum
key-to-frame delay across 193 keystrokes, with no delayed keystrokes or long
tasks. One isolated frame gap reached 100.7 ms rather than the earlier sustained
200-plus-ms delays. That confirmation closed the associated active-stream
typing-latency gap.

The **actual** residual per-second re-render was elsewhere: the
`AgentContentContext` provider built a fresh `value` object every render, so
each SessionPage status-timer tick (~1/s) changed the context value and
re-rendered every subagent (`TaskRenderer`/`SpawnAgentRenderer`) consumer and
its nested rows *through* their `memo` boundaries (context bypasses `memo`).
Fixed 2026-07-09 by wrapping that value in `useMemo`
(`contexts/AgentContentContext.tsx`); the CPU profile's
`propagateParentContextChanges` / `formatAbsoluteTimestamp` idle hotspots
disappear after the fix. See `memory-growth.md` § *2026-07-09 follow-up*.

After that fix, idle transcript DOM is static (~1 mutation/s: only the
processing indicator), and the remaining steady idle cost is content-
visibility's cheap recalc-style re-evaluation. Measurement caveat: the shared
dev server's load/highlight timing is noisy; only quiescence-gated samples
(DOM-mutation rate below threshold before measuring) are trustworthy — a fixed
settle sometimes catches load-time shiki highlighting.

## Problem (one line)

`MessageList` mounts every message as live DOM and re-renders the whole list
~once per second even when idle, so both DOM footprint and per-tick main-thread
work are O(transcript length). Native browser memory (Blink style/layout/paint,
allocator high-water) grows over hours to many GB while the V8 heap stays flat.
Full measurement and evidence: `memory-growth.md`.

## Measurement harness (reproduce before and after each stage)

Headless Chromium against a running server, loading the full transcript via
`?tailTurns=100000`, sampling on an **idle** page (no interaction, no
streaming). The signal is not heap size — it is **idle CPU-busy and
`RecalcStyleCount`/`LayoutCount` deltas that scale with row count**, plus
process-tree RSS trend. Key CDP calls:

- `Performance.getMetrics` → `RecalcStyleCount`, `LayoutCount`, `LayoutObjects`,
  `Nodes`, `JSEventListeners`, `ScriptDuration`, `TaskDuration` (diff two reads
  over an idle window; `TaskDuration/window` ≈ CPU-busy fraction).
- `Profiler.start/stop` → confirm `MessageAge`/`RenderItemComponent`/`jsxDEV`
  appear on an idle page (they must not, once fixed).
- `HeapProfiler.collectGarbage` before DOM-counter reads so counts are retained,
  not garbage.

Acceptance: idle full-transcript page should sit at ~0% CPU with no periodic
row rendering; RSS should plateau, not trend up, over a multi-minute idle hold.
(Baseline before fix: 22% idle CPU at 1145 rows; target: ≪1%.)

## Stage 1 — stop the per-second whole-transcript re-render (low risk)

Cheap, behavior-preserving. Do these, then re-measure:

1. **Stabilize `MessageList`'s props** so its `memo` actually holds across a
   SessionPage per-second re-render. Confirmed unstable inline arrows:
   `getComposerDraft` (`SessionPage.tsx:4544`), `onCancelForkSummary` (`:4580`),
   `onToggleForkSummaryAutoOpen` (`:4583`). Wrap in `useCallback` (the functions
   they call — `cancelForkSummaryJob`, `setForkSummaryAutoOpen` — are already
   stable; `getComposerDraft` reads a ref, deps `[]`). Audit the remaining
   `MessageList` props for any other per-render-fresh value; the memo only holds
   if *all* props are stable.
2. **[MEASURED MOOT 2026-07-09] Stabilize the row-map inline arrows** in
   `MessageList` (~lines 2341, 2348, 2353): the conditional
   `() => onTrimBeforeUserMessage(item.id)` etc. These are only recreated when
   `MessageList`'s body re-runs, and item 1 makes that ~0.1/s on idle, so the
   arrows are stable-in-practice and cost nothing on an idle page. Worth doing
   only as defensive hardening (so a future change that re-renders `MessageList`
   often does not resurrect the churn) — not a current win.
3. **[MEASURED MOOT 2026-07-09] Decouple per-row clocks.** Already effectively
   done in code: `getRenderItemStaleNowMs` (`lib/sessionDetail/timeline.ts`)
   returns `undefined` for every row except the one whose timestamp equals
   `latestVisibleTimestampMs`, so only that single row receives the live
   `nowMs`; the broadcast this item worried about does not exist. The only
   residue is that `buildTimelineEntryDisplayRows` rebuilds on the 30 s
   `useRelativeNow` tick — a 30 s cadence, not per-second.
4. Re-measure with the render-count probe (below). **Done 2026-07-09:**
   `MessageList` 0.1/s, `RenderItemComponent` one-shot settling — no steady row
   re-renders. The residual re-render was the `AgentContentContext` value (item
   5), not any broadcast prop value.
5. **[LANDED 2026-07-09] Memoize the `AgentContentContext` value.** This was the
   real per-second re-render source. The provider (`contexts/
   AgentContentContext.tsx`) rebuilt its `value` object every render; it
   re-renders on every SessionPage status-timer tick (~1/s), and context
   propagation re-renders all subagent consumers (`TaskRenderer`,
   `SpawnAgentRenderer`, and their nested rows) *through* `memo`. Wrapped in
   `useMemo` keyed on its contents (all deps already stable on idle:
   `agentContent`/`toolUseToAgent` are memoized upstream in
   `useSessionMessages`, `loadAgentContent`/`isLoading` are `useCallback`).
   Behavior-preserving.

**Why 2–3 turned out moot (not merely deferred):** the earlier note assumed a
per-second, O(rows) transcript re-render survived item 1. Direct measurement
falsified that — item 1's memo holds and the per-row clock is already gated. The
residual idle re-render was context-driven (item 5), which prop/clock
memoization cannot touch. Items 2–3 stay open only as optional hardening; they
do not block Stage 2 and do not reduce measured idle cost today.

Stage 1 does not bound the DOM — a very long session is still a large static
DOM — but it removes the per-second O(N) churn, which is the growth engine.

## Stage 2 — bound rendered cost to the viewport

Goal: a very long transcript should cost the browser (Blink style/layout/paint/
raster memory, and any per-tick layout) only for what's near the viewport, not
for the whole history.

### Retired experiment: `content-visibility: auto`

Experimented 2026-07-09; default rejected 2026-07-10.

Initial decision: realize Stage 2 first with CSS `content-visibility: auto` on
transcript rows (plus `contain-intrinsic-size: auto <estimate>`), **not** JS row
unmounting.
Rationale — the hard part of JS windowing is that every coupling below assumes
rows stay in the DOM; `content-visibility: auto` keeps the DOM intact and only
tells the browser to skip rendering work (and discard rendered state) for
off-screen subtrees. So it bounds the native-memory / layout cost — the actual
defect — while the turn rail's rect reads, in-transcript search `scrollIntoView`,
selection/comment anchors, and native find-in-page keep working unchanged. It is
~a few lines of CSS versus a large, risky refactor, and was expected to be
behavior-preserving. `contain-intrinsic-size: auto Xpx` gives off-screen rows a
placeholder height and remembers the real size after first render, keeping the
scrollbar stable.

Landed 2026-07-09 (`.message-render-row` in `index.css`). Measured at 1532 rows:
layout objects ~70,100 → ~2,750, RSS ~970 → ~820 MB, DOM node count unchanged.
Verified couplings held: turn-rail markers stay distributed and click-to-jump
scrolls correctly (rail reads still work because the DOM is intact), initial
scroll-to-bottom works, and paint containment did **not** clip the age chip or
hover quote circles.

Measured tradeoff: idle style-recalc roughly doubled (content-visibility state is
re-evaluated on each of the ~7.5 per-second widget-driven layouts), so idle CPU
on the full transcript rose ~9% → ~16%. This is amplification of the residual
per-second widget churn, not new work of its own — Stage 1 items 2–3 (stop those
per-second layouts) remove both the residual and this amplification, so they are
the natural next step. `contain-intrinsic-size: auto 120px` (auto remembers real
heights) measured the same idle cost as a fixed size but gives better scroll
stability, so it is the shipped form.

Residual risk still to watch in real use (not a headless-provable): scroll-
position drift as far-off-screen intrinsic estimates correct to real heights on
first scroll-through; `auto` minimizes it. If it janks in practice, add height-
model marker placement (below) rather than reaching for full unmounting.

2026-07-10 follow-up: a completed Codex session on the hosted mobile client
reported repeated downward scroll corrections during its first upward traversal,
then stability after roughly ten corrections. That symptom matches the residual
risk above: each row starts with the 120px fallback, then records its real height
when it first becomes relevant. A browser-local, default-on Performance setting
scoped the CSS optimization so the same device and session could disable it for
a direct A/B check. Disabling it fixed the regression, including for the short,
finished session. That falsifies the behavior-preserving premise: variable row
heights and bottom-anchored transcript scrolling make first-reveal geometry
corrections user-visible.

Decision: default the experiment off immediately. The ~150 MB RSS reduction
measured above does not justify fighting the reader's scroll position, and the
experiment does not bound retained transcript data.

2026-07-10 explored-rendering hardening: grouped exploration rows publish a
bounded intrinsic-height estimate derived from their visible entry/detail-row
count, capped at the group's existing scrollable-body height.

2026-08-26 retirement: a 45,103-message Codex session reopened with the
experiment enabled at 3,461 rendered rows and roughly 178,000 DOM elements.
The tab spent about 60% of its observed lifetime in long tasks, with frame gaps
up to 11.9 seconds, while intrinsic-height correction also left the reader at
the start of the compact tail. After disabling the experiment and remounting
against the bounded active window, the page held 310 rows and roughly 13,750
elements, with a 237 ms worst frame gap. The row reduction came from the active
window rather than CSS, but the experiment amplified the unbounded state and
made scroll recovery unreliable. The comparison toggle, preference plumbing,
and transcript CSS were removed; no runtime path now enables this experiment.

### Approved direction: bounded semantic client window

Do not hide an unbounded transcript behind estimated-height spacers. Keep the
full transcript canonical on the server and model the active client transcript
as a contiguous, recent semantic window. Drop an older prefix only at safe turn
boundaries, retain pagination metadata, and expose omitted history through the
existing Load older path. The approved first implementation deliberately uses
semantic compaction/turn limits rather than a byte bound; one unusually large
retained turn may therefore remain large. Trimming must also prune
message-associated augment and tool/agent maps.

This direction is approved for implementation but has not landed. The tactical
contract is
[`060-bounded-active-transcript-window.md`](../docs/tactical/060-bounded-active-transcript-window.md):
default-on with a Performance setting to disable it, only while following the
bottom, a greater-than-60-second boundary-age guard, two-compaction retention,
30-to-20 turn hysteresis, and mount-scoped suppression after Load older.

Implement it against:

- [`memory-growth.md`](memory-growth.md), which distinguishes bounded initial
  loading from growth of the active client tail;
- [`Session Catch-up Must Not Fetch Full Transcripts`](../docs/tactical/055-session-catchup-unbounded-fetch.md),
  which defines the server/catch-up bounding invariant and explicit full-history
  escape hatch;
- [`session-detail-data-layer.md`](session-detail-data-layer.md), whose canonical
  reducer and loaded-window metadata are the natural ownership boundary; and
- the earlier [`initial-load performance investigation`](../docs/tactical/033-session-initial-load-performance.md),
  which already warned that `content-visibility` risked scroll height, browser
  find, selection, and search anchors.

The JS spacer-window design below remains research, not the chosen fallback. It
preserves a continuous synthetic scroll range but shares the same hard geometry
and anchoring problems that invalidated the CSS shortcut.

### Open architecture: whole-session search across a bounded window

The current in-session Ctrl+R, Ctrl+S, and Ctrl+Alt+S search operates only on
loaded render items. The bounded defect is tracked in
[`gaps/isearch-stops-at-loaded-transcript.md`](../gaps/isearch-stops-at-loaded-transcript.md):
an exhausted reverse search can request older user-turn-bounded pages and rerun
the existing projection while preserving query, direction, selection, and
scroll restoration.

A later whole-session search design should avoid making repeated search load
and retain every full message. One option is a server-owned session digest in
which each durable searchable row contributes a stable source id/cursor,
searchable excerpt, and approximate rendered or cumulative height. Selecting a
digest match would hydrate a bounded real-transcript window around its cursor,
preserve search state, and replace estimated geometry with measured row heights
as content mounts. The loaded rows remain authoritative; height metadata is an
approximation and cannot become a layout contract.

Before choosing an endpoint, compare a compact digest transferred once for
client-side search with server-side query results plus a coarse full-session
height index. A digest makes repeated search responsive but may remain large
for extreme sessions. Server-side queries bound transfer but add round trips
and require explicit ordering and version consistency while the transcript
grows. This is a single-session windowing concern. The independent
cross-session corpus and indexing proposal remains in
[`all-session-content-search.md`](all-session-content-search.md).

### Research design: JS windowed rendering

Render only rows near the viewport (plus a small overscan); replace off-screen
runs with spacer elements sized from measured/estimated row heights. Bounds both
DOM size and per-tick work to the viewport.

This is not a drop-in list virtualizer — it must integrate with existing
transcript machinery. Known couplings to solve (each currently assumes all rows
are in the DOM):

- **Variable row heights.** Text/tool/code/thinking rows differ widely and
  reflow (ResizeObserver in `TextBlock`, media previews, code highlight). Need a
  measured-height cache keyed by stable row id, with estimate-then-correct so the
  scrollbar and anchoring don't jump.
- **Scroll anchoring / follow-bottom.** `MessageList` already has substantial
  anchor/follow/snapshot logic (rect reads, `isAtScrollBottom`, scroll snapshot
  publish). Virtualization changes what "scrollHeight" means; anchoring must be
  driven by the height model, not by rects of rows that may be unmounted.
- **Turn rail (`UserTurnNavigator`).** It computes marker positions by calling
  `getBoundingClientRect` on every user-turn row (`UserTurnNavigator.tsx` ~519).
  Off-screen rows won't exist. Marker layout must derive from the height model /
  row offsets, not live DOM rects. This is a real, required sub-task.
- **In-transcript search / isearch** (`useMessageListIsearch`) scans and scrolls
  to matches across the whole transcript. Jumping to a match must mount its row
  (scroll the height model to it), and match highlighting must survive
  mount/unmount.
- **Selection, quote anchors, comment anchors** reference live DOM; ensure
  anchors resolve after a row remounts (store by row id + offset, re-resolve on
  mount).
- **Progressive initial render** (`getProgressiveTimelineVisibility`) already
  stages the first paint; fold it into the window model rather than layering a
  second mechanism.

Default/rollout: keep behavior identical for short sessions (window ≥ list ⇒ no
change). Gate behind a setting or size threshold initially so the non-buggy
short-session path is untouched (see the UI-changes-preserve-defaults rule).

## Non-goals

- Not a replacement for `tailTurns` load bounding — that limits what the server
  *sends*; virtualization limits what the browser *renders*. They compose:
  virtualization lets the default load window grow back without a memory cost.
- Not prompt caching, offline, or cross-route retention (that is
  `client-route-retention.md`).
