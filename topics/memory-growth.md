# Memory-growth notes

## Browser-tab lifetime memory

- **2026-07-28 long-session observation and goal.** One long-lived session tab
  reached roughly 5 GB of browser-process memory; reloading the same session
  returned it to roughly 200 MB. This delta is not by itself proof of a JS,
  DOM, or native leak—the browser may retain useful history, caches, rendered
  resources, or allocator high-water—but it is direct evidence that the
  long-lived default scales much worse than a fresh equivalent view and leaves
  substantial efficiency headroom.

  The out-of-box goal is for a continuously open session to converge toward
  reload-like memory without requiring the reader to choose a manual “start at
  this turn” boundary. Very old content should automatically **freeze** into a
  lightweight semantic placeholder/window boundary once it is outside the
  active reading neighborhood, then **revive transparently** from canonical
  session data when the reader scrolls, searches, follows an anchor, or
  otherwise navigates back to it. Freezing must release unreachable render
  trees, highlighted HTML, media/object URLs, message-owned augments, and other
  content-proportional client state while preserving order, stable anchors,
  pagination, comments, and scroll restoration. Manual tail/start controls
  remain useful overrides and diagnostics, not the normal memory-management
  requirement.

  Investigation should compare settled live-tab and post-reload samples using
  browser-process memory alongside JS heap, DOM/row counts, retained
  session-store bytes, route snapshots, highlighted/media resources, and active
  object URLs. Quiescence-gate measurements so load-time highlighting and
  streaming bursts are not mislabeled as retained growth.
- Long-session pages must not do whole-transcript React work on idle timers.
  Relative-age labels are useful UI, but historical rows should not receive a
  changing clock prop every tick. The only transcript row that needs a live
  stale-age clock by default is the latest visible timestamp row; older row
  age labels can stay at their mount-time relative age until some real session
  data changes.
- Compact-tail REST loading is part of the memory contract for Codex sessions:
  normal session-page loads should request a bounded recent tail such as the
  last two compaction windows. Full direct session REST payloads can be tens of
  megabytes and thousands of normalized renderable messages, so they are
  diagnostic/debug surfaces rather than the default browser transcript load.
- Compact-boundary tails are not by themselves a sufficient browser bound for
  Claude sessions with sparse compaction. Normal client session loads also send
  a conservative recent-turn cap, currently `tailTurns=20`. The turn cap
  narrows the default two-compaction scope; it never expands that scope unless
  `fullHistory=1` explicitly authorizes access across older compactions. This
  keeps both sparse-compaction Claude sessions and many-compaction Codex turns
  from rendering nearly the whole transcript by default.
- Initial loading applies `tailTurns=<n>` and
  `tailFrom=<message-id>` only to the initial non-incremental session detail
  response; streaming and `afterMessageId` refreshes append normally. The
  client store now auto-trims old prefixes while the reader follows the bottom,
  periodically restoring approximately the same semantic bounds as a fresh
  load. See
  [`docs/tactical/060-bounded-active-transcript-window.md`](../docs/tactical/060-bounded-active-transcript-window.md).
- CSS `content-visibility: auto` is not a safe default bound for transcript
  rows. A hosted mobile client confirmed repeated scroll-position corrections
  as variable-height rows replaced their intrinsic fallback sizes on first
  reveal. The browser-local experiment remains available but defaults off; see
  [`transcript-virtualization.md`](transcript-virtualization.md). A future bound
  should instead be explicit in the session-detail data model: keep the server
  transcript canonical, retain a contiguous recent semantic window on the
  client, and recover omitted history through pagination. That direction is now
  approved for implementation; the tactical contract is linked above.
- The old in-tab session-load cache was a developer convenience only:
  `VITE_SESSION_LOAD_CACHE=true` retained every visited transcript without
  production eviction or source/query invalidation. It proved the warm-return
  shape but was not the product path.
- Production session route retention uses explicit `SessionRouteSnapshot`
  entries instead: source-scoped, route/tail-window keyed, five-minute TTL,
  three-entry default cap, 24 MiB total byte cap, least-recently-used eviction,
  retained delta cursor, and retained scroll anchor. It is meant to work in
  development, production builds, and hosted/relay clients.
- Growth attribution is sampled, not reconstructed: when client log
  collection is active, `[ClientTelemetry]` entries (15 s cadence) carry JS
  heap size, DOM/row counts, and the session-detail store's deduped
  live-retained vs warm-cache byte aggregates
  (`getSessionTranscriptMemoryStats`, also shown in Performance settings).
  A multi-day tab that balloons should be explained from those samples
  before anyone reaches for a live heap snapshot.
- The bounded active-window feature does not add a per-trim log or telemetry
  event. Existing 15-second client samples already show the outcome through
  DOM message-row counts and deduped live/warm transcript bytes; store coverage
  proves an accepted trim reduces both its message count and approximate byte
  charge. This avoids duplicative console/log traffic and records no message
  content.
- Any future client-side transcript cache beyond `SessionRouteSnapshot` needs
  an explicit design note before it ships: what user-visible behavior it
  changes, what data it retains, its eviction policy, memory/entry limits,
  low-memory mobile behavior, invalidation and staleness rules, and why those
  trade-offs are acceptable. Ad hoc transcript caching must not be enabled by
  default.

## 2026-07-10: bounded active transcript window decision

The active mounted session should not retain every message received since the
page opened. Implement a client-local prefix trim that makes the retained
window approximate a fresh default page load without forcing provider
compaction or re-fetching the tail from the server.

Contract:

- Auto-trim is browser-local, default-on, and disableable in Performance
  settings. An explicitly stored disabled preference remains authoritative.
- Trim only while the reader is following the bottom. The operation should be
  silent and preserve bottom-follow across the atomic store update.
- Keep the last two compact windows and approximately the default recent-turn
  tail. Turn trimming uses hysteresis rather than trimming after every new turn;
  the initial target is 20 turns with a 30-turn trigger.
- The proposed retained-window start must be more than 60 seconds old. A
  missing or invalid boundary timestamp means do not trim. There is no timer:
  reconsider on later transcript growth.
- Loading older history suppresses auto-trim for the rest of that mounted
  session. Unmount resets the suppression; a later mount starts from the normal
  server-bounded tail again.
- The trim is an explicit session-detail reducer transition. It updates loaded-
  window pagination and prunes message-owned augments, tool/agent mappings, and
  completed agent content that is no longer reachable from retained rows.
- This policy intentionally does not impose a byte bound. It follows roughly
  the same semantic limits as reload; one unusually large retained turn may
  still be large.

The hot-path predicate must be cheap. Streaming tokens, placeholder updates,
metadata, augments, subagent updates, and scroll snapshots should exit through
constant-time gates without scanning the transcript. Only a new relevant user
turn/compact boundary, a persisted batch that can contain one, or a cached
age-delayed candidate becoming eligible should invoke the bounded planning
walk. Do not add a polling timer for this feature.

## 2026-07-09: real cause of the "10 GB tab" — un-virtualized transcript re-rendered every second

The `tailTurns=20` default (above) is a **mitigation, not the fix**. Measured
root cause of the browser-tab RSS growth:

- **It is not a JS/DOM leak.** On an idle session page, `usedJSHeapSize`, DOM
  node count, and JS listener count are flat over minutes. Heap-snapshot leak
  hunts correctly find nothing — the growth is native (Blink style/layout/paint
  objects, allocator high-water), which `usedJSHeapSize` does not count. That is
  why a tab reaches many GB while the V8 heap stays flat. Prior "there is no
  leak" conclusions were right *about the heap* and stopped one step short.
- **The transcript is not virtualized.** `MessageList` renders every message as
  a live DOM subtree (`MessageList.tsx`, `timelineEntryRows.map`). Native memory
  scales with total content (nodes, layout objects, raster), not viewport.
- **The whole transcript re-renders ~once per second, even when idle.** Measured
  headless (Playwright + CDP `Performance.getMetrics`/`Profiler`) against the
  live dev server, session `858312bb-…` idle (WebSocket messages = 0, rAF ≈ 0):

  | tail | rows | DOM nodes | JS heap | idle CPU-busy |
  |------|------|-----------|---------|---------------|
  | 20   | 244  | 12,985    | flat 65 MB  | 11% |
  | 400  | 1145 | 58,509    | flat 117 MB | 22% |

  Idle CPU scales with row count. The CPU profile shows `MessageAge` /
  `RenderItemComponent` / `jsxDEV` / React reconciliation hot, scheduled from
  microtask state flushes (not streaming). Two independent 5 s profiles (shorter
  than the 30 s clock) still show row rendering ⇒ rows re-render ~every second.
- **Trigger:** ~9 `setInterval(…, 1000)` timers on the session page (drafts,
  file-activity, reload-notify, liveness, …) re-render SessionPage every second.
  `MessageList` is `memo`-wrapped, but its memo is defeated by unstable
  inline-callback props from SessionPage — `getComposerDraft`
  (`SessionPage.tsx:4544`), `onCancelForkSummary` (`:4580`),
  `onToggleForkSummaryAutoOpen` (`:4583`) — so it re-executes and re-creates /
  reconciles all N row elements every second (the `jsxDEV` cost). Session-level
  clocks broadcast as per-row props (`staleNowMs`, `latestVisibleTimestampMs`,
  `isStreaming`) plus conditional inline arrows in the row map (`MessageList.tsx`
  ~2341/2348/2353) additionally break row-level `memo`.

So per-second O(N) style-recalc + layout + reconcile (recalcStyle counters climb
continuously on an idle page) churns native memory with a flat JS heap.
`tailTurns=20` only shrinks N; it does not stop the per-second O(N) churn or
bound the DOM. Streaming compounds it: each new message re-renders all N rows
while the transcript keeps growing.

Fix is staged — see [`transcript-virtualization.md`](transcript-virtualization.md):
(1) stabilize the memo-breaking props and decouple per-row clocks so an idle
transcript does ~zero work; (2) virtualize/window the transcript so DOM size and
per-tick work are bounded by viewport, not history.

Open item for the implementer: after (1), re-measure idle CPU with the probe in
that plan. If rows still re-render every second, a broadcast prop *value*
(`isStreaming`, or a liveness-derived value) is still changing each tick — trace
it before assuming (1) is complete.

### 2026-07-09 follow-up: the residual idle re-render was context, not clocks

Answering the open item above with direct measurement (temporary
`window.__mlRender` / `window.__riRender` render counters + CDP profile +
DOM-mutation observer, on the same full-transcript idle page):

- **`MessageList` re-renders ~0.1/s** on idle — item 1's `memo` holds. It is
  *not* re-rendering every second.
- **`RenderItemComponent` re-renders are a one-shot settling burst**, not steady
  churn: the same count over a 10 s and a 30 s idle window.
- The re-render that *did* persist was **context-driven**: `AgentContentContext`
  built a fresh `value` object every provider render. The provider re-renders on
  each SessionPage status-timer tick (~1/s), so the context value changed every
  second and re-rendered every subagent consumer (`TaskRenderer`,
  `SpawnAgentRenderer`, nested rows) — context propagation goes *through* `memo`,
  which is why item 1's prop stabilization did not stop it. The CPU-profile
  hotspots (`propagateParentContextChanges`, `formatAbsoluteTimestamp`,
  `jsxDEV`) drop after wrapping that value in `useMemo`.
- After the fix, the idle transcript DOM is essentially static (~1 mutation/s,
  only the processing indicator). No steady DOM growth, no leak — confirming the
  original "flat heap" reading was right; the cost was wasted render-phase work,
  now removed at its source.

Consequence for the plan: `transcript-virtualization.md` Stage 1 items 2–3
(row-map inline arrows; per-row clock decoupling) are **moot**, not merely
deferred — the churn they target does not occur once the context value is
memoized. The per-row clock was already gated in code
(`getRenderItemStaleNowMs` returns `undefined` for non-latest rows).

Measurement caveat: the shared dev server's load/highlight timing is noisy. A
fixed post-load settle sometimes catches load-time shiki re-highlight (bursts of
`fixed-font-rendered__content` / `shiki-container` child-list mutations that
*do* settle). Trust only quiescence-gated samples — poll the transcript
DOM-mutation rate and measure only once it falls below a small threshold.

## 2026-05-12: heartbeat session `019e1ac6-c836-7e33-891e-2ba878d27ca5`

- Confirmed metadata persisted for `019e1ac6-c836-7e33-891e-2ba878d27ca5` includes:
  - `heartbeatTurnsEnabled: true`
  - `heartbeatTurnsAfterMinutes: 30`
  - `heartbeatForceAfterMinutes: 5`
  - provider `codex`.
- `session-metadata.json` is authoritative at `~/.yep-anywhere/session-metadata.json`.

## Heartbeat pipeline checkpoints that could block delivery

- For owned processes, supervisor checks:
  - heartbeat enabled for session,
  - `process.isTerminated === false`,
  - `process.queueDepth === 0`,
  - `process.isProcessAlive === true`,
  - state/derived status is either `idle` + `verified-idle` OR `in-turn` +
    one of `verified-progressing`, `recently-active-unverified`,
    `long-silent-unverified`.
- For unowned candidates, it additionally requires `hasPendingToolCall === true`,
  candidate provider supports steering, and metadata flag enabled.
- No explicit heartbeat text is sent if any of the above are false.

## Current observed evidence

- Search across `~/.yep-anywhere` did not find any
  `heartbeat_turn_queued`/`heartbeat_turn_failed` entries containing the session.
- No session-specific heartbeat trace exists in local persisted JSONL logs.
- `recents.json` shows this session was visited at `2026-05-12T14:56:52.826Z`.
- Index metadata (`~/.yep-anywhere/indexes/...json`) shows it is the most
  recently updated `tend` session and near context/window limits (~93% usage),
  but this does not itself indicate heartbeat state.

## Likely next checks

- At runtime, inspect the live process object for this session:
  `getProcessForSession(sessionId)` state fields (`isProcessAlive`, `queueDepth`,
  derived liveness) at heartbeat tick.
- Confirm heartbeat scheduler is actually running and logger sink captures
  `heartbeat_turn_*` events in the server runtime you are attached to.
