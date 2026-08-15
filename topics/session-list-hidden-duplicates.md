# Session List Hidden Duplicates

> Session duplicate hiding is only a decluttering affordance: a session may be
> hidden as a duplicate only when a same-title, user-facing representative is
> visible in the same list scope, and YA-created helper sessions must never hide
> their source sessions or current user-facing forks.

Topic: session-list-hidden-duplicates

See also: [sidebar-session-ordering](sidebar-session-ordering.md) (active-row
stability and the sidebar sections), [side-session-config](side-session-config.md)
(helper sessions are bounded implementation work), [recaps](recaps.md) and
[session-retitle](session-retitle.md) (features that create temporary helper
forks), [fork-from-turn](fork-from-turn.md) (user-facing forks and
fork-after-summary).

## Reported Failure

The reported session
`019f050c-cd29-71d0-8cea-e0203a3e5037` appeared only under the sidebar's
`1 hidden (duplicate titles)` expander for the project
`L2xvY2FsL2dyYWVobC95ZXBhbnl3aGVyZQ` (`/local/graehl/yepanywhere`). Its title
matched `019f04f2-e32b-7070-9115-2421798c6794`, but that fact was not
trustworthy enough to justify hiding the opened/current row.

Evidence from live local state:

- `019f050c...` is a Codex fork whose rollout file starts with
  `forked_from_id: 019f04f2-e32b-7070-9115-2421798c6794`.
- The direct session metadata route then reported that source through the
  overloaded parent field:
  `/api/projects/.../sessions/019f050c.../metadata` includes
  `parentSessionId: 019f04f2...`.
- The project/global list routes did not include `parentSessionId` for either
  row because `SessionIndexService.CachedSessionSummary` does not persist or
  rebuild that field. The Codex reader extracts it, but the list cache drops it.
- The sidebar then groups idle rows by `(provider, projectId, normalized-title)`
  and keeps the duplicate with the highest `messageCount`. The parent had
  `messageCount: 198`; the currently owned fork had `messageCount: 81`, so the
  current fork was hidden.

This is a real bug even though a same-title row exists: the relationship and
user-facing priority that would make hiding defensible were missing from the
list data, and `messageCount` is not a safe proxy for "main session".

## Contract

- Duplicate hiding must be conservative. If YA cannot prove that the hidden row
  has a same-title representative visible in the same rendered list scope, the
  row stays visible.
- "Same title" means the effective full display title after custom-title
  resolution, not the truncated `title` field used for compact row text. Sharing
  the first 120 displayed characters is not enough.
- The current route session must never be hidden by duplicate grouping.
- Active and queued sessions must never be hidden by duplicate grouping. Their
  rows represent actionable live state; a shared title does not prove identity.
- A session owned by this YA server must not be hidden merely because it is
  idle. `ownership.owner === "self"` is live supervision state even when
  `activity` is neither `in-turn` nor `waiting-input`.
- Provider or YA fork lineage is display data. List APIs, collection-store
  records, and cache entries must preserve `forkedFromSessionId`; they must
  separately preserve a `/btw` aside's typed `parentSessionId` Mother link so
  duplicate grouping can distinguish source, child, and helper rows.
- YA-created helper sessions are not representative sessions. Retitle
  generators, recap generators, fork-summary generators, and future temporary
  "summarize this" workers must be demoted below their source session and below
  any user-facing target fork, regardless of `messageCount` or recency.
- `messageCount` is only a late tie-breaker among rows with the same
  user-facing priority. A helper can briefly have more messages than the source
  it acts on; that must never let it hide the source.
- Starred, current, owned/live, and explicitly user-facing child sessions outrank
  ordinary idle rows. Archived helper rows should normally be absent from the
  default list; if they appear through an include-archived/search/debug surface,
  they must not become duplicate representatives.
- The hidden-count affordance must explain itself locally. A section-level
  `(N hidden)` is acceptable only when each hidden row's representative is also
  visible in that section; otherwise the UI should render the row or group
  hidden duplicates under the representative that justifies hiding them.

## Fix Plan

1. Preserve fork lineage through the list cache.
   - Add lineage fields to `CachedSessionSummary`, `toCachedSummary()`, and
     `buildSummariesFromIndex()`.
   - Bump the session-index schema version so old cache files missing lineage
     are rebuilt. The current local cache has no `parentSessionId` for
     `019f050c...` even though the direct reader can extract it.
   - Add index tests proving a cached Codex fork keeps its source relationship
     across the fast path and after restart.

2. Keep session-list projections lineage-complete.
   - Confirm project list, global list, session collection store ingestion,
     `SessionCollectionRecord`, and `sessionCollectionRecordsToGlobalSessionItems`
     all preserve the typed Mother link and ordinary fork provenance.
   - Add route/store coverage for a list response where a Codex fork's lineage
     is visible without opening the detail route.

3. Replace the duplicate representative heuristic.
   - Normalize duplicate keys from the effective full display title:
     `customTitle ?? fullTitle ?? title ?? initialPrompt`, not truncated `title`
     first.
   - Score representatives by user-facing priority before `messageCount`:
     current route session, active/owned row, starred row, non-helper source or
     user-facing fork, ordinary idle row, archived/helper row.
   - Treat known YA helper titles/metadata as helper rows until a richer
     explicit helper-purpose field exists. Longer term, persist a small
     `sessionRole`/`helperPurpose` metadata value when YA creates generator
     forks so the UI does not infer role from title text.

4. Make duplicate hiding fail open.
   - If the chosen representative would not render in the same section, render
     the would-be hidden row instead of counting it.
   - Never put `currentSessionId` or `ownership.owner === "self"` in the hidden
     bucket.
   - Consider moving from one section-level `(N hidden)` footer to per-
     representative hidden groups, so the visible row that justifies hiding is
     visually adjacent to the hidden duplicates.

5. Pin regressions.
   - Sidebar: current idle same-title fork remains visible even when parent has
     higher `messageCount`.
   - Sidebar: owned idle same-title session remains visible.
   - Sidebar/global sessions: helper generator with more messages cannot hide
     source session.
   - Sidebar: rows that only share truncated `title` but differ in `fullTitle`
     are not grouped.
   - Session index: cached Codex fork summaries preserve
     `forkedFromSessionId`.

## Implementation Notes

The immediate fix originally preserved the then-overloaded `parentSessionId`
in session-index cache entries and bumped the cache schema so existing
lineage-less cache files rebuilt. The 2026-08-01 lineage split now preserves
`forkedFromSessionId` for ordinary Fork/Clone/helper copies and keeps
`parentSessionId` plus `parentSessionKind` for `/btw` Mother relationships.
Existing summary-index entries normalize their legacy bare parent link into
fork provenance on load; provider summaries never stored the interactive
Mother relationship.
Sidebar duplicate grouping now keys by the effective full title and fails open
for current, self-owned, or lineage-related rows. That intentionally leaves a
same-title parent/fork pair visible until YA has explicit helper-purpose
metadata; a visible extra row is preferable to hiding the source/current
session behind a duplicate affordance.

Automatic forked-recap helpers publish their archived title and lineage on the
existing `session-metadata-changed` channel as soon as that metadata is
durable. The event may race transcript discovery in either direction: an early
metadata patch survives the later partial `session-created` observation, while
a later patch removes an already discovered helper from ordinary list
projections. Neither ordering may leave a copied source-title row visible until
reload.

### Active/pinned rows stay visible

The sidebar's active/queued "pinned" set (rows where `activity` is
`in-turn`/`waiting-input`, or the row is a project-queue target) bypasses title
deduplication. A previous mitigation collapsed same-title pinned rows to hide
stale activity left behind when a provider session id rotated. That crossed the
contract boundary: title equality cannot establish that two independently live
or queued rows are interchangeable, so it could hide a real active session.

Stale rotated activity must instead be expired or remapped at the collection
store/source-event boundary once the replacement identity is known. Until that
upstream proof exists, the fail-open behavior is to show the extra pinned row.
A dev-only (`import.meta.env.DEV`) console log in `Sidebar` reports duplicate-
title groups and any truly repeated id to keep that upstream defect observable.

## Non-Goals

- Do not remove duplicate hiding entirely; it remains useful as a decluttering
  option when the proof above holds.
- Do not make every provider expose a full branch tree before fixing this. The
  minimal requirement is preserving the parent/fork fact already available from
  Codex and YA metadata.
- Do not infer helper identity only from `messageCount`, recency, or title
  length. Those are presentation facts, not role facts.
