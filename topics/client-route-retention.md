# Client Route Retention

> Client route retention is YA's bounded browser-side policy for making
> ordinary back/forward and nearby app navigations return to recently visited
> pages instantly by preserving page state, scroll position, and fresh-enough
> data without turning every route into an unbounded transcript cache.

Topic: client-route-retention

Status: Source Control and production session-return snapshots implemented
2026-06-30. YA now has a bounded in-tab route-retention registry plus Source
Control warm-return retention for Git status data, selected file,
page/diff scroll, and diff view mode. Session detail routes retain a bounded
source-scoped snapshot with transcript data, pagination/cursor state, agent
content indexes, and scroll anchor state, then revalidate by delta fetch in the
background. The broader Settings/Inbox/Agents/Projects route-state rollout
remains a future phase.

Related context:

- [Client Global Store](client-global-store.md) covers normalized
  client-wide summary/list/config data, not transcript or whole-route state.
- [Memory Growth](memory-growth.md) explains why the old unbounded in-tab
  session-load cache was developer-only and why the production session snapshot
  path is source-scoped, TTL-bound, entry-capped, and byte-capped.
- [Session Initial Load Performance](../docs/tactical/033-session-initial-load-performance.md)
  profiles long-session load costs and separates server response time from
  client mount and render cost.
- [Client Query Controller](../docs/tactical/031-client-query-controller.md)
  documents the retained-query layer for project, session-list, inbox, and
  config feeds.
- [Rendering Performance](../packages/client/RENDERING_PERFORMANCE.md)
  defines transcript render and virtualization constraints.

## Problem

Cold navigation to a short session can tolerate a one or two second loading
delay. Immediate route return should not. The common flow of opening a
session, clicking away to Source Control, and using browser back should feel
instant because the tab just rendered that same page.

The same courtesy applies broadly: Source Control, Settings, Inbox, Agents,
Projects, and ordinary session detail routes should reuse recent in-tab state
when the route, source, and freshness window make that safe. Background
revalidation is fine; a blocking full-page loading state on immediate return is
the defect this topic addresses.

## UX Contract

- Browser back or forward to a recently visited route in the same tab shows the
  last useful view immediately.
- The restored view includes lightweight page state such as scroll position,
  selected item, open tab, filter text, and disclosure state when those values
  are meaningful for the page.
- Fresh-enough retained data may revalidate in the background. The refresh
  must not replace an instantly restored view with a blocking spinner.
- Mutations invalidate or patch retained state deliberately. A user action such
  as refreshing Source Control, changing a setting, archiving an inbox item, or
  deleting a session must not leave browser back showing impossible state.
- Retention is source-scoped. A local source, remote source, project id,
  provider session id, auth state, and route parameter set must not reuse
  another source's retained view.
- A browser reload remains a cold start for route data and exact DOM geometry.
  Session scroll memory is the narrow durable exception: site storage preserves
  the device-specific furthest-seen content anchor and follow state, not the
  transcript snapshot.

## Boundaries

Client route retention is not provider prompt caching, offline support, or a
license to keep every visited transcript in memory. It is a bounded in-tab
latency courtesy for recent route returns.

Do not implement the first version as a generic "keep every route component
mounted" wrapper. That makes the happy path fast, but hidden mounted routes can
continue effects, polling, streams, and provider-session liveness work after
the user left the page. That conflicts with YA's architecture mandate that idle
provider sessions and closed tabs must not indefinitely consume server
resources. Component keep-alive can be considered later for small static pages,
but session pages should restore from explicit snapshots and reconnect or catch
up intentionally.

## State Classes

Summary, list, and configuration feeds belong in the retained-query and
client-global-store layers. This includes project summaries, session lists,
queue summaries, inbox state, provider/config snapshots, and similar small
records.

View state belongs in a small route-state registry keyed by source and route.
Examples are Source Control's selected project and selected file, Settings'
selected category and scroll position, Inbox filters and scroll position, and
Projects or Agents list filters.

Session transcript detail is the high-cost state class. Production retention
keeps a small number of recent session snapshots, but the snapshot must stay
source-scoped, memory-bounded, freshness-aware, and invalidation-aware. It also
records enough cursor information to fetch only the delta after restore.

Composer drafts and provider text inputs should keep using their existing
draft/input mechanisms. Route retention may restore focus and scroll, but it
should not create a second persistence surface for user-authored text.

## Implementation Plan

### Phase 0: Measure The Current Defect

Add a small navigation timing probe around route mount, first useful paint, and
replacement of blocking loading UI for these flows:

- session -> Source Control -> browser back to session
- session -> Settings -> browser back to session
- Source Control -> session -> browser back to Source Control
- Inbox -> session -> browser back to Inbox

Record cold versus warm-return behavior separately. The metric that matters for
this feature is time from route activation to first useful restored view, not
only network request duration.

### Phase 1: Add A Route Retention Registry

Introduce a source-scoped route-retention registry under `NavigationLayout`.
The registry should store lightweight route view state and references to
retained data already owned by the retained-query or session snapshot layers.

Required behavior:

- key by source, project, route id, route params, and query params that affect
  the view
- expose synchronous `read`, `write`, `patch`, and `invalidate` operations
- apply least-recently-used eviction and a short TTL
- clear or partition on source change, auth change, project deletion, and route
  parameter changes
- keep approximate memory accounting for large entries
- publish developer diagnostics for retained entries, evictions, and misses
- keep React external-store snapshot reads quiet: observing an expired entry
  returns a miss without mutating the registry or notifying mounted
  subscribers during render. Ordinary reads and the next registry write own
  expiry diagnostics and reclamation.

This registry should not own long transcript arrays by default. It should own
small view-state records and delegate bulky data to the class-specific owner.

### Phase 2: Make Source Control The First Slice

Source Control is a good first target because it is the named pain case and
the state is bounded compared with transcripts.

Implementation shape:

- move Git status data behind the retained-query layer or a source-scoped
  Source Control snapshot store
- retain selected project, selected file, selected diff, scroll positions, and
  the status revision used to render the diff
- on browser back, render the last status and selected diff synchronously
- revalidate in the background and patch the view if the repository status
  changed
- invalidate after Source Control mutations such as stage, unstage, discard,
  commit, refresh, or branch-affecting operations

The acceptance check for the first slice is simple: session -> Source Control
-> browser back returns to the session without a blocking session spinner, and
Source Control -> session -> browser back returns to the same selected file or
diff before the background refresh completes.

### Phase 3: Extend Lightweight Routes

After Source Control, extend the same registry to Settings, Inbox, Agents, and
Projects.

Settings should restore category, scroll, expanded sections, and unsaved local
form state where that state already has a safe owner. Inbox should restore
filters, selected item, scroll, and retained feed data. Agents and Projects
should restore selected rows, filters, and scroll while their retained queries
refresh in the background.

These routes should not need mounted component keep-alive. Synchronous retained
data plus restored view state should be enough to avoid the full-page loading
experience.

### Phase 4: Productionize Session Return Snapshots

Session detail routes need a special snapshot because messages, tool-call
state, agent content, and pagination can be large. The old development-only
in-tab session-load cache proved the warm-return shape, but retained every
visited transcript and was therefore not a production design.

`SessionRouteSnapshot` contains:

- source key, project id, YA session id, route params, and tail-window params
- session metadata
- visible messages and pagination state
- tool-use and agent-content indexes needed to render the restored transcript
- last message id or other provider cursor for delta fetch
- scroll anchor and follow-tail state
- creation time, last access time, TTL, and approximate byte count

On warm route return, `useSessionMessages` synchronously hydrates from a fresh
matching snapshot, renders without a blocking loading state, and then requests
only the delta after the retained cursor. If the snapshot is missing, expired,
over budget, source-mismatched, or structurally inconsistent, it falls back to
the normal initial load path. A retained return also skips the progressive
initial-render progress overlay; that overlay remains for cold long-session
loads where it is still useful.

Default limits are conservative: retain up to three session snapshots per tab,
expire entries after five minutes, cap total retained bytes at 24 MiB, and evict
least-recently-used entries first. Long-session snapshots retain the currently
loaded tail/window; they do not force a whole-transcript load.

### Phase 5: Verification

Unit tests:

- route-retention registry source isolation and route-key matching
- LRU, TTL, memory-cap, and explicit invalidation behavior
- Source Control mutation invalidates or patches retained status
- session snapshot hydrate-and-delta path does not cross source or route
  parameter boundaries
- session snapshot TTL, entry cap, and byte cap

Browser tests:

- session -> Source Control -> browser back shows the session content
  immediately and preserves scroll
- Source Control -> session -> browser back restores selected file or diff
  immediately
- Settings and Inbox restore selected category/filter/scroll without a
  blocking full-page spinner
- retained session return opens the background catch-up path and appends new
  messages without duplicating existing rows

Performance and memory checks:

- warm-return first useful view target: within one animation frame when data is
  retained, or within a small budget such as 100 ms on development hardware
- no hidden route keeps a stream, poll loop, or provider session alive after
  navigation away
- mobile-width smoke test after visiting several sessions confirms eviction
  happens before retained transcript memory grows without bound

## Follow-On: DOM Linger

[`session-dom-linger-speedup.md`](session-dom-linger-speedup.md) records the
separate 60-second hidden-DOM linger for the most recently left session route;
the first one-session underlay slice landed on 2026-07-01.
That is intentionally not the baseline route-retention mechanism: it trades a
small bounded amount of continued mounted-route work for even faster return
when the user immediately bounces away and back.

## Contract: Coming Back To Where You Left Off

Maintainer-confirmed contract (2026-07-03, clarified 2026-08-26; previously a
2026-07-02 lean): returning to a session resumes at the *furthest position the
user has seen*. Landing on never-seen content is the failure to avoid; output
that arrived while away belongs below the restored viewport (surfaced by the
new-output-below follow affordance), not silently scrolled past.

For browser reloads and multiple tabs, the return point is a device-specific
high-water mark: each visible tab may advance it, and site storage keeps the
furthest turn seen by any tab without granting an exclusive lease. An active
turn counts before it completes. Within the winning turn, expanded view keeps
the furthest activity and content offset; Conversation View keeps the turn as
the return context. Scrolling upward never moves the durable return point
backward, even within that turn. Different sessions have different keys, so
split-screen viewing advances both independently. Exact DOM pixel geometry
remains an in-tab hint; the content anchor and follow state survive reload.
Cross-device/server sharing is not yet part of this contract.

Concurrent tabs publish independently keyed immutable observations rather than
overwriting one shared snapshot. Readers merge those observations by the same
furthest-seen ordering, and opportunistic cleanup retains a winning observation
before removing dominated ones. An interleaved nearer write therefore cannot
erase a farther cursor.

The retained anchor remains authoritative while the initial transcript is
still growing asynchronously. Before the reader takes control, every observed
height change reapplies that anchor so an early browser clamp cannot strand the
viewport above the saved content. A user scroll or explicit Follow action ends
that retry and transfers ownership to the reader. Because the high-water mark
lives in site storage, a same-origin server process restart followed by reload
restores it without depending on server memory or route-cache state.

Which mode *engages* the restore is policy (`sessionScrollBehavior.ts`;
mode decisions in
[`docs/tactical/047-session-scroll-memory-policy.md`](../docs/tactical/047-session-scroll-memory-policy.md)):
the default `live-tail` returns cursors recorded while following to the live
tail, while `remember-place` restores the furthest-seen anchor. A parked
`live-tail` cursor also restores its anchor. The capture
machinery is load-bearing regardless of active mode: anchors are captured
even at bottom, each anchor carries neighbor row ids and a timestamp for
recovery when the exact row is gone, and snapshot publication is gated to
settled (post-hydration) content. A visible incomplete turn advances the turn
frontier; new visible activities advance the expanded-view position. Completing
a turn while visibly following must publish a fresh observation even without a
scroll event. Activating Follow is itself a return-state transition: it must
publish the resulting live-tail observation immediately, before a route switch
or reload can unmount the view. A change that stops capturing at-bottom anchors,
overwrites settled snapshots with transient hydration geometry, or drops the
context fallbacks breaks this contract even while the `live-tail` default hides
the loss.

## Known Divergence Risks: Warm Restore vs Cold Reload (2026-07-02)

Investigated after upstream defaulted the retention features off during the
intermittent scroll-reset investigation (upstream commit `45279b9b`). The
question: can a cached return with delta catch-up land the viewport somewhere
a cold reload never would, especially when the server moved while the user was
away? Four gaps, ordered by user impact. Correctness criterion: the restore
target is the furthest position the user saw in any visible tab, even if follow
mode was engaged when they left (§ Contract: Coming Back To Where You Left
Off).

1. **Follow-mode returns can still choose newest-bottom over furthest-seen
   content.** Before 2026-07-03, `captureScrollSnapshot` suppressed anchor
   capture when `atBottom`, so the data needed to do better was never captured.
   The 2026-07-03 scroll-memory slice now captures anchors even when the
   viewport is at bottom and routes restore through a browser-local policy.
   The default `live-tail` policy maps recorded follow intent to
   scroll-to-bottom with follow re-engaged, so when the server moved while away
   a warm return can still intentionally land at the *new* bottom. The
   `remember-place` policy can instead restore the captured high-water anchor.
2. **Anchor miss falls back to stale pixel geometry.** When `findRenderRow`
   misses the anchor id, restore clamps the captured `scrollTop` into the
   current `scrollHeight`. After a delta merge, partial progressive hydration,
   or any layout change, equal pixels are different content — a position a
   cold reload never produces. Reachable when the anchor row's chunk has not
   hydrated yet, when the anchor message was deleted server-side (edit-turn
   truncation, rewritten history), or when the row id belonged to
   restructured agent content.
3. **One-shot restore race — fixed 2026-08-26.** The progressive-hydration
   wait already delayed restore until the anchor row mounted, but that mounted
   row could still grow after the first restore as markdown and transcript
   content finished rendering. Chrome clamped the early target to the short
   document's current maximum (often zero), then left the viewport there as
   the document grew. The retained anchor now remains pending through
   `ResizeObserver` height changes until a user scroll or explicit Follow takes
   ownership. A focused 500-to-5500-pixel growth test and browser coverage for
   sidebar A -> B -> A, reload, and same-origin server restart guard the fix.
4. **The delta merge is union-only, so rewritten histories diverge in
   content, not just position.** On cursor miss the server returns the full
   list (`sliceAfterMessageIdWithMatch` with `found: false`) without
   surfacing that to the client; for Claude SDK providers the cursor is
   ignored entirely (`primaryReaderAfterMessageId` forced undefined), so
   every warm return unions cached-with-full. `mergeJSONLMessages` never
   drops cached rows absent from the fresh response (only
   `pruneSupersededSdkSiblings`). After an edit-turn truncation or external
   rewrite, the warm transcript can show rows a cold reload would not, and
   the scroll anchor can be one of those phantom rows.

## Gap-Closing Plan: Position-Faithful Warm Restore

Target invariant: a warm restore resolves to the same content position a cold
reload would produce given the same reading history — the furthest-seen row
when one is recorded, else the tail — and snapshots are captured only from
settled content.

**Slice 1 — capture side (partially landed 2026-07-03).**

- Capture the anchor unconditionally: `atBottom` becomes a restore-policy bit
  rather than capture suppression. The anchor capture and policy split landed
  on 2026-07-03. Neighbor/timestamp context also landed on 2026-07-03: each
  captured anchor can include the anchored message's persisted timestamp and
  the ids of the previous and next rendered rows.
- Gate `publishScrollSnapshot` on settled content: no snapshot writes between
  warm-hydration start and progressive-render completion. This landed on
  2026-07-03 at the `MessageList` publisher, before the single
  `updateRouteScrollSnapshot` writer can patch the session detail store; the
  publisher emits one settled snapshot when progressive reveal completes. Keep
  the existing restore-side discard heuristics (the `skip` decision in
  `decideSessionScrollRestore`) as regression guards.
- Diagnostics: emit a divergence event (the `reportStoreDivergence` pattern)
  whenever a restore resolves by anything other than the exact anchor, with a
  miss reason. This converts the scroll-reset investigation from anecdotes to
  data.

**Slice 2 — restore side (partially landed 2026-07-03).**

- Make the restore pending rather than one-shot: hold the snapshot until (a)
  the anchor row mounts, then anchor with `topOffset`; or (b) progressive
  hydration completes without it. The pending-anchor wait landed for
  `remember-place` on 2026-07-03, including suppression of the competing
  initial tail-follow effect while the anchor is still mounting.
  Neighbor/timestamp fallback also landed on 2026-07-03: after hydration
  completes without the exact anchor, restore resolves by neighboring rendered
  row, then nearest timestamped row. Raw pixel `scrollTop` remains only as the
  final fallback for a transcript with no surviving reference points, and
  should fire the slice-1 diagnostic once diagnostics land.
- Keep the resolved restore pending while its mounted content grows. This
  landed on 2026-08-26: transcript height changes reapply the retained anchor
  until the reader scrolls or activates Follow, covering late markdown/render
  growth after both warm navigation and cold reload.

**Slice 3 — truth reconciliation.**

- Server: plumb the existing match flag from `sliceAfterMessageIdWithMatch`
  through `loadProviderSession` into the session response as `cursorFound`.
  A Claude-SDK full response counts as cursor-not-found-with-full-truth.
- Client: when the incremental response is actually a full window (cursor
  missed, or provider always returns full), reconcile deletions instead of
  unioning: within the fresh window's range — at or after its oldest message —
  drop cached rows whose ids are absent from the response, preserving only
  local rows newer than the fresh watermark (in-flight stream messages that
  raced the fetch). Absence *below* the window floor is windowing, not
  deletion, and must not evict older loaded pages.
- Fixture test: cached transcript plus rewritten server transcript (edit-turn
  truncation) — warm-load content must equal cold-load content, and an anchor
  on a deleted row must resolve by neighbor.

**Slice 4 — the follow-mode semantic (needs upstream alignment).**

- With anchors always captured, add the restore policy for `atBottom` returns
  when the server moved: restore the furthest-seen anchor, leave follow
  disengaged, rely on the existing jump-to-latest affordance, and optionally
  render a new-messages divider at the old watermark.
- Default: ship opt-in. The current follow-to-new-bottom return is a
  deliberate convention, not a bug, and upstream has just tightened
  tail-follow expectations, so the default flips only by explicit agreement.

Ordering rationale: slice 1 is pure capture/diagnostics and unblocks the rest;
slice 2 removes the reset mechanism; slice 3 makes warm content equal cold
content; slice 4 is the semantic improvement and the only part with a default
question. Regression tests ride each slice (the anchored-top MessageList test
from the 2026-07-02 fixes shows the pattern; slice 3 belongs in the
sessionDetail reducer fixture suite). The open timing-instrumentation item in
`docs/tactical/041-cached-session-restore-performance.md` rides slice 1's
diagnostics.

## Open Questions

- What exact freshness window should non-session routes use by default? Source
  Control may need a shorter TTL than Settings or project summaries.
- Should long-session snapshots retain only the visible tail by default, or
  should they retain any previously loaded older pages until the memory cap
  evicts them?
- Do we want a small debug surface in Settings that lists retained route
  entries, approximate memory, last access time, and miss reason?
- Should browser back prefer an immediate stale view plus background refresh
  even when a mutation happened in another tab, or should cross-tab mutation
  broadcast force a cold reload?

## Recommended First Change

Do not start with a universal component keep-alive. Start with a
source-scoped route retention registry, wire Source Control's bounded state
through it, and add browser tests for the session <-> Source Control back
button flow. Then productionize session detail snapshots as a separate step
with explicit memory caps and catch-up semantics.
