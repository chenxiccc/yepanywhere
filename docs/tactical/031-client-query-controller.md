# Client Query Controller

Status: In progress; retained query controller and Sidebar starred projection
landed through 2026-06-29. A 2026-08-05 new-session audit triggered the next
slice: retain one source-scoped version/capability snapshot and stop repeated
route-local `/api/version` work.

This note tracks the next data-fetching cleanup after the client summary store
work. The immediate forcing bug is Sidebar session coverage: after a browser
refresh on routes such as Agents, Sidebar can render only the subset of session
entities that its own small feeds happened to load; visiting All Sessions warms
the same normalized store and makes the missing rows appear.

The broader problem is the same class: many client hooks still own ad-hoc
`useEffect` fetch lifecycles, local in-flight refs, debounce timers, and
loading/error state. That makes it easy for route-local fetches to incidentally
populate shared summary state, and hard for a component to state "this surface
requires this data coverage" without duplicate requests.

The follow-up forcing bug was the same layer from another angle: Agents polled
`/api/processes?includeTerminated=true` every 30 seconds because it had no
shared retained-query revalidation path for phone wake, tab foreground,
reconnect, or session metadata changes. That belongs here, not in a separate
"live collection" abstraction.

## Progress

- 2026-06-28: Added the minimal client query controller scaffold and focused
  unit tests. No feed has been migrated yet, so there is no user-visible
  behavior change in this slice.
- 2026-06-28: Moved `useGlobalSessionsFeed` onto the controller. Global-session
  list requests now use coverage-aware dedupe, stats fetches use a separate
  query key, and rows still normalize into `clientSummaryStore`.
- 2026-06-28: Mounted Sidebar session feed coverage from `NavigationLayout`, so
  the app shell retains Sidebar's global and starred session queries
  independently of the visual Sidebar branch.
- 2026-06-28: Corrected Sidebar Recent and Older rendering to use retained
  query memberships instead of broad "all known entity" projections that varied
  with fetch completion order.
- 2026-06-28: Fixed the remaining active-session race by allowing older full
  session snapshots to backfill missing fields left by newer partial live
  updates. The timestamp guards still protect newer values, but no longer keep
  active starred records too incomplete for Sidebar row rendering.
- 2026-06-29: Folded the Agents/Inbox live freshness follow-up back into this
  controller plan. The next target is retained-query revalidation for
  processes/Agents, not a parallel live-collection hook.
- 2026-06-29: Added `useRetainedClientQuery` as the React-facing retained
  query revalidation layer and moved `useProcesses` onto it. Agents no longer
  uses a 30s poll; the process list now fetches after readiness, revalidates
  on retained wake/reconnect/session/process events, and patches custom titles
  immediately from `session-metadata-changed`.
- 2026-06-29: Moved `InboxContext` onto `useRetainedClientQuery` while keeping
  stable tier ordering and snapshot reporting in the provider. Inbox now uses
  the same retained wake/reconnect/session/process-event refresh shape as
  Agents, with manual refresh still forcing server sort order.
- 2026-06-29: Moved `useProjects` and `useProject` onto
  `useRetainedClientQuery`. Project list/detail snapshots still report into
  `clientSummaryStore`; retained revalidation now owns initial fetch,
  wake/reconnect refresh, and project activity debounce, while project detail
  keeps filtering activity to the selected project.
- 2026-06-29: Added explicit session observation provenance in the summary
  reducer. Global-session rows are named as fuller snapshots, Inbox rows as
  partial snapshots, and activity-bus reducers as partial events so freshness
  guards no longer hide which paths can only observe part of a session row.
- 2026-06-29: Documented the session-page duplicate-request follow-up in
  `034-session-page-request-dedupe.md` and closed the first retained-query
  fan-out gap. Forced retained revalidation now bypasses fresh cache entries
  but still shares compatible in-flight requests, so multiple mounted consumers
  of the same source/key do not duplicate refresh/reconnect fetches.
- 2026-06-29: Moved `useServerSettings` onto a source-keyed retained query
  with a small shared settings snapshot store. Multiple shell/session/settings
  consumers now share one `/api/settings` GET, reconnect/refresh revalidation
  coalesces, secure remote clients wait for connection readiness, and
  successful PUT responses update every mounted consumer.
- 2026-06-29: Added a Playwright request census script for session-page reload
  debugging. `pnpm --filter client request:census -- --url <url>` groups
  requests by method, full path/query, and resource type so duplicate-looking
  DevTools rows can be separated from real duplicate keys.
- 2026-06-29: Moved `usePublicShareStatus` onto a source-keyed retained query
  with a small shared status snapshot store. Initial status reads and
  wake/reconnect refreshes now share in-flight work, and `poll: true` retains
  one source-level poll owner instead of starting one timer per hook instance.
- 2026-06-29: Investigated the remaining session-page `/api/inbox` duplicates.
  They were activity-driven, not a fixed inbox poll: global
  `session-updated` events from already-known sessions caused full inbox
  snapshots about one debounce window later. Added retained-query event
  filtering so Inbox patches content-only updates from `clientSummaryStore`
  when the current tier can be updated locally, and revalidates the full inbox
  for unknown rows, unread-tier promotions, or other membership-affecting
  events.
- 2026-06-29: Changed Sidebar Starred to render from the known starred entity
  projection while still retaining the starred sessions query for coverage,
  pagination, and server reconciliation. This fixes the metadata-toggle window
  where a row left Last 24 Hours before the server-owned starred membership had
  refetched.
- 2026-08-05: A fresh production New Session request census found 21 initial
  fetches. Most have distinct owners, but selected-page readiness competes with
  global sessions, Inbox, processes, queue, usage, and development-status work.
  Added a scheduling handoff and located one direct duplicate
  `useReloadNotifications` status read.
- 2026-08-05: The follow-on timer audit found that retaining a query still does
  not retain its revalidation owner. Sidebar mounts four feed hooks for two
  query keys, and Project Queue adds one five-second poll per mounted consumer
  while backlog exists. Added the query-entry ownership correction below.
- 2026-08-05: The server observer/catalog contract added coherent catalog
  epochs/generations and short-lived client interest. Added a browser reuse
  slice that prevents sequential mounts and capable sibling tabs from
  requesting an unchanged generation while keeping server dedupe authoritative.
- 2026-08-05: Moved activity subscriptions and the revalidation debounce out of
  hook instances into one owner per `(sourceKey, queryKey)`
  (`lib/clientQueryRevalidation.ts`). The owner unions its subscribers' events,
  keeps one timer, and revalidates with the widest coverage among them so a
  50-row consumer is satisfied by the 100-row consumer's refetch. This removes
  the fast-response duplicate recorded below: one `reconnect` across two
  consumers now costs one request rather than two.
- 2026-08-05: Replaced Project Queue's per-consumer five-second interval with
  one source-level backstop owner that arms a single timer for the earliest
  instant the server reported (`nextAttemptAt` / `quietEligibleAt`), falls back
  to five seconds only while a project is `ready` or `dispatching`, and arms
  nothing for a blocked or paused backlog whose transitions arrive as events.
  Measured 480 -> 8 reads over ten minutes with four mounted consumers, and the
  deadline-aware owner is also more punctual than the interval it replaced.
- 2026-08-05: Moved `useVersion` onto a source-keyed retained query with a
  small shared version snapshot store, completing step 9. All 34 consumers
  subscribe to one snapshot, the pending speech-backend follow-up is retained
  once per source instead of once per mounted hook, and `freshOnMount` became a
  `{ fresh: true }` coverage query so an update check cannot be answered by an
  ordinary read. Requests now wait for remote secure-connection readiness and
  accept snapshots by request-started time, neither of which the previous hook
  did.

## Context

`clientSummaryStore` is the canonical normalized cache for shared summary
facts. It owns session/project/queue/inbox records and query membership. Feed
hooks still own request lifecycle:

- source-key capture;
- remote connection readiness;
- REST requests;
- loading/error state;
- pagination;
- request-started timestamps;
- snapshot reporting into `clientSummaryStore`.

That split remains correct. The missing layer is a shared query controller for
feed lifecycle, so multiple mounted consumers can ask for the same source/query
coverage without each hook independently issuing a request.

The existing client has partial patterns, but no common query layer:

- `useProviders` has a module-level TTL cache and shared in-flight promise.
- `useVersion` coalesces non-fresh version requests.
- `useBackgroundRevalidation` has hook-local in-flight suppression and a
  minimum interval, but is intentionally narrow and background-only.
- `useSessionMessages` has specialized in-flight suppression, incremental
  merge, and dev-only warm loading for transcripts.
- `InboxContext` is close to a singleton feed owner, with debounced activity-bus
  refetches and store snapshot reporting.
- `useGlobalSessionsFeed`, `useProjects`, `useProjectQueues`,
  `useServerSettings`, `usePublicShareStatus`, and similar hooks are still
  largely mount/effect fetchers.

Server-side code already uses this vocabulary more rigorously: index services
and provider readers have in-flight maps, TTL caches, and invalidation rules.
The client needs a small version of that for shared summary/list/config data.

## Current Fetch Inventory

Audited 2026-06-28. This is the starting map for migration priority.

| Surface / hook | Endpoint shape | Current behavior | Query-controller fit |
| --- | --- | --- | --- |
| `useGlobalSessionsFeed` | `/api/sessions`, optional `/api/sessions/stats` | Source-scoped snapshot reporting, local loading/error, local debounce, local request sequence, no shared in-flight dedupe. `limit` is part of the query key, so 50-row Sidebar and 100-row All Sessions fetches do not satisfy each other. | First target. Needs coverage-aware rows and separate stats handling. |
| `useSidebarSessionFeeds` | two `useGlobalSessionsFeed` instances | Visual Sidebar owns unfiltered and starred fetches. Rows render from broad entity projections, so coverage is implicit and can be accidentally warmed by All Sessions. | Replace with an app-shell retainer plus shared global-session controls. |
| `useProjects` | `/api/projects` | Source-scoped snapshot reporting plus retained query lifecycle. Revalidates on readiness, refresh/reconnect, and project-affecting process/session events. Previously owned `hasFetchedRef`, loading/error, and debounce locally. | Completed retained-revalidation target. |
| `useProject` | `/api/projects/:id` | Source-scoped detail snapshot reporting plus retained query lifecycle. Refresh/reconnect revalidate the retained detail query; process/session events revalidate only when they match the selected project. | Completed retained-revalidation target. |
| `InboxContext` | `/api/inbox` | App-scoped singleton feed owner. Stable tier ordering and source-scoped snapshot reporting stay provider-owned; readiness, retained query lifecycle, and wake/reconnect/activity refetch now go through `useRetainedClientQuery`. Locally patchable `session-updated` rows patch through the summary store without a full inbox snapshot; unknown content updates and unread-tier promotions still revalidate so membership can be discovered. | Completed second retained-revalidation target. Keep tier-order policy local. |
| `useProcesses` | `/api/processes?includeTerminated=true` | Source-keyed process snapshot plus retained controller query. Revalidates on readiness, refresh/reconnect, process/session events, and patches metadata titles locally. Previously used hook-local rows plus a fixed 30s poll. | Completed first retained-revalidation target. A process summary store slice can wait. |
| `useProjectQueues` | `/api/project-queue` for the global queue feed; `/api/projects/:id/queue` for mutations | Source-scoped global queue snapshots plus per-project mutation reporting. Retained lifecycle owns wake/reconnect/events, but every mounted hook also starts a five-second forced poll while relevant queue/recovery rows exist. | Retained feed landed; query-entry revalidation/poll removal remains in step 11. Keep mutations project-scoped. |
| `useServerSettings` | `/api/settings` | Source-keyed retained query plus a small shared settings snapshot store. Initial GETs and reconnect/refresh revalidation share in-flight work; successful PUT responses update the shared snapshot. | Completed config-feed target. Keep mutations hook-local. |
| `useVersion` | `/api/version` | Source-keyed retained snapshot plus a small shared version snapshot store. Every consumer subscribes; a mount after the snapshot resolves issues no request. One retained follow-up owner per source re-reads while a speech backend is validating. `freshOnMount` retains a `{ fresh: true }` coverage query so an update check never settles for an in-flight ordinary read. | Completed config/capability target. Per-hook debounce timers remain until step 11. |
| `useProviders` | `/api/providers` | Five-minute provider/model snapshots and in-flight work are source-keyed, but one aggregate response still waits for every provider and survives neither browser nor server restart. | Provider-local/durable catalog redesign belongs to tactical 094; reuse query-controller lifecycle without flattening provider freshness into one flag. |
| `usePublicShareStatus` | `/api/public-shares/status` | Source-keyed retained query plus a small shared status snapshot store. Initial reads and wake/reconnect refreshes share in-flight work; `poll: true` now retains one source-level poll owner instead of one timer per hook. | Completed config/live-status target. A server activity event could later replace the remaining single poll owner. |
| `useRecentSessions` | `/api/recents` plus mutations | Hook-local rows with optimistic local move/clear. New Session consumes only project ids, but the server sequentially resolves a provider-aware summary for every recent visit; live `limit=30` took 6.496 s. | Triggered narrow recent-project/source-scoped membership work in tactical 095; do not normalize transcript detail. |
| `useSessionMessages` / `useSession` | `/api/projects/:projectId/sessions/:sessionId` plus stream endpoints | Specialized transcript logic: source-scoped dev warm cache, JSONL cursoring, stream buffering, replay dedupe, incremental message merge, older-page loading, pending-input/session metadata integration. | Deliberately not a controller target. Keep specialized. |

Findings:

- The original immediate bug was specific to global-session row coverage. That
  path now proves the query key, coverage, and Sidebar retainer shape.
- The next shared gap was retained-query revalidation. The controller can dedupe
  an `ensureClientQuery` call; `useRetainedClientQuery` is now the first
  React-facing layer that centralizes activity-bus refresh, reconnect,
  debounce, readiness, and forced refetch for a retained feed. Forced
  revalidation still bypasses fresh cache entries, but no longer bypasses
  compatible in-flight requests.
- Several hooks already solve one query-cache concern locally, but each solves a
  different subset: in-flight dedupe, TTL, debounce, stale response protection,
  or background revalidation.
- `useVersion` remains source-blind and request-only. `useProviders` has since
  become source-keyed, but its all-provider server barrier and restart lifetime
  are catalog-ownership faults rather than reasons to copy its cache shape.
- Inbox remains the reference for feed-local policies that should not move into
  the generic controller: stable tier ordering, accepted-snapshot shaping, and
  manual refresh semantics.
- Transcript/session detail loading is intentionally outside the scope. Its
  merge and stream rules are endpoint-specific and load-bearing.

## Fresh New Session request census

An isolated production server with fresh browser context issued 21 fetches
during the first roughly 650 ms of an ordinary New Session load:

| Owner group | Requests observed |
|---|---|
| New Session | `/api/providers`, `/api/settings/remote-executors`, `/api/recents?limit=30`, selected `/api/projects/:id`, provider subscription usage |
| Shared configuration/capabilities | `/api/version`, `/api/auth/status`, `/api/onboarding`, `/api/settings`, `/api/public-shares/status` |
| Navigation/summary feeds | `/api/sessions?limit=50`, starred sessions, `/api/projects`, `/api/inbox`, `/api/project-queue`, incremental sessions |
| Process/development shell | `/api/processes?includeTerminated=true`, two `/api/dev/status` reads, `/api/status/workers`, `/api/dev/safe-restart` |

This is not a claim of 21 duplicate queries. Most requests return different
facts and several retained feeds deliberately outlive the current route. It is
a scheduling finding: a selected page competes immediately with global
collection and diagnostic work even when the selected controls need only
settings plus the selected provider/project facts.

The cold disposable-data sample made that competition visible. The provider
request took about 5.21 seconds, both initial session-list requests about 3.56
seconds, and Inbox about 0.50 seconds; provider controls appeared at about 5.50
seconds. Tactical 094 owns provider readiness, tactical 095 owns recent-project
defaulting, and tactical 093 owns server-side asynchronous Inbox/session-corpus
reconciliation. This tactical owns client request retention, coalescing, and
start priority.

One request is directly redundant. `useReloadNotifications()` calls
`/api/dev/status` to determine the mode, then manual mode calls
`syncFromServer()`, which calls `/api/dev/status` again before requesting
workers and safe-restart state. Each hook instance also owns its own one-second
connection-state interval. The app mounts the hook globally; Settings and the
Development pane can add consumers. The isolated production build still had
`noFrontendReload: true`, so the development-status family was present in the
ordinary page census.

Retained app-shell feeds should begin from one source-level coordinator and
yield the first scheduling turn to the selected route's minimum facts. This is
not permission to make Sidebar coverage visual-state-dependent again: the
global/starred retainers stay app-shell-owned, but can start after the first
stable page/shell commit and reconcile in place. Process, Inbox, and usage work
likewise follows its owning urgency instead of racing all selected-route
prerequisites at mount time.

## Retention currently duplicates revalidation owners

`NavigationLayout` calls `useRetainSidebarSessionFeeds()`, which mounts global
and starred `useGlobalSessionsFeed()` hooks. The rendered `Sidebar` then mounts
the same two feeds again to obtain controls. The default app shell therefore
has four hook-local event subscriptions, debounce timers, connection polls, and
loading states for two controller query keys.

Initial requests share in-flight work. Forced revalidation has a subtler stale
generation defect: every `useGlobalSessionsFeed` caller first calls
`invalidateClientQuery()`, then `ensureClientQuery({ force: true })`. The first
caller starts the shared request; a duplicate caller advances `staleVersion`
before joining that in-flight promise. The completed request sees a newer stale
generation and deliberately cannot clear `stale`, so an otherwise accepted
shared result remains eligible for another fetch.

`useRetainedClientQuery` avoids that exact invalidation order, but still
installs one activity listener/debounce owner per hook call. In-flight sharing
contains simultaneous requests; it does not make event/timer ownership
source/query-scoped.

Project Queue demonstrates the cost when hooks add their own recovery loop.
Sidebar plus New Session, Session, Projects, Inbox, or Global Sessions can
mount several `useProjectQueues()` consumers. When any relevant queue or
recovered-session row exists, every instance force-refetches the same global
route every five seconds. The route then recomputes project status and resolves
existing-session titles through provider/session summary lookup. Activity
events already invalidate the retained query; any missed-event backstop must be
one source/query owner with an exact deadline, not one interval per component.

## Session Observation Semantics

Session collection records are a union of observations, not a single endpoint
response. The normalized entity map may know a session because a fuller list
row arrived, because an Inbox snapshot mentioned it, or because a live event
reported one field group. Query membership is separate from entity
completeness.

The reducer now names each session observation:

| Source | Kind | Completeness |
| --- | --- | --- |
| `global-sessions` | `full-snapshot` | Mostly full `GlobalSessionItem` rows from `/api/sessions`. These are the best source for fields required by `sessionCollectionRecordToGlobalSessionItem(...)`, but the request timestamp can be older than newer live events that already reached the client. |
| `inbox` | `partial-snapshot` | Inbox tier snapshots. These carry title, project, unread, and inferred lifecycle hints for sessions in inbox buckets, but they are not complete global-session rows. |
| `session-created` | `partial-event` | A broad live event for a new session. It may carry many row fields, but it is still an event observation and can omit metadata or project display fields. |
| `session-updated` | `partial-event` | Content-only observation: title, updated time, message count, model, last agent text. |
| `metadata-changed` | `partial-event` | Metadata/project observation: custom title, archive/star state, parent id, project id. |
| `process-state` | `partial-event` | Lifecycle/project observation: activity and pending input, with project id. It does not prove content or metadata completeness. |
| `session-status` | `partial-event` | Ownership/project observation. It can clear lifecycle activity when ownership returns to none. |
| `session-seen` | `partial-event` | Unread observation only. |

Merge rules:

- Freshness is tracked by field group (`contentObservedAt`,
  `metadataObservedAt`, `projectObservedAt`, `lifecycleObservedAt`,
  `unreadObservedAt`) instead of one record timestamp.
- Newer observations protect populated fields from older snapshots.
- Older observations may still backfill fields that are empty, so a newer
  partial event cannot make a session permanently too incomplete to render.
- Lifecycle activity is intentionally stricter than ordinary optional fields:
  a newer observation that clears activity should not be undone by an older full
  snapshot that still saw the session as active.
- The timestamp is client-side observation time. For HTTP snapshots it is the
  request-started time captured before the fetch; for live events it is the
  client receive/reduce time unless a caller passes a test timestamp.
- `sessionCollectionRecordToGlobalSessionItem(...)` still drops records missing
  required row fields. That is a useful guard, but reducers should treat dropped
  rows as incomplete observations, not as proof the session is absent.

## Sidebar Starred Projection Decision

Status: Implemented 2026-06-29.

Sidebar has two different list responsibilities:

- Starred is a metadata-derived pin surface. If the client already knows a
  complete session row and then observes `isStarred: true`, the row should move
  into Starred immediately. Waiting for `/api/sessions?starred=true` to refetch
  creates a bad intermediate state: the same metadata event removes the row
  from Recent/Older, so the row appears to disappear.
- Recent and Older are coverage/list surfaces. They are tied to server-owned
  pagination, archive filtering, and the Sidebar global feed's loaded window.
  Rendering every known entity there would make the Sidebar depend on whichever
  other page happened to warm the normalized store.

The resulting split is intentional:

- Sidebar still mounts the global and starred session feeds through
  `useSidebarSessionFeeds`, including when the visual Sidebar is collapsed or
  closed. Those feeds keep coverage independent of route-local pages.
- Recent and Older render from the retained global query membership, then apply
  the derived recent/older selectors.
- Starred renders from `useStarredSessionRecords()`, the normalized known-entity
  projection. The retained starred query remains responsible for discovering
  older starred rows, filling gaps, pagination, and reconciling with the server.
- `selectStarredSessionRecords(...)` still filters `isArchived !== true`. If a
  session's archived state is unknown because only partial observations have
  arrived, the client cannot infer absence from the server's default
  non-archived query. The retained starred feed is the reconciliation path.

## Library Options

These libraries solve much of the generic server-state problem:

- TanStack Query: query keys, stale/fresh state, in-flight dedupe, background
  refetch, pagination, structural sharing, and cache garbage collection.
  Reference: https://tanstack.com/query/latest/docs/framework/react/overview
- SWR: a smaller stale-while-revalidate hook model with caching, revalidation,
  request deduplication, focus/reconnect behavior, and pagination helpers.
  Reference: https://swr.vercel.app/
- RTK Query: endpoint/parameter cache keys, subscription reference counts,
  request dedupe, cache lifetime, invalidation, and streaming update hooks.
  Reference:
  https://redux-toolkit.js.org/rtk-query/usage/cache-behavior

All three are credible options if YA's hand-built controller starts growing
into an underpowered reimplementation. Do not dismiss them on name familiarity
alone.

The first recommended step is still a small YA-owned controller. YA's hard part
is not only HTTP caching. REST snapshots, activity-bus events, successful local
mutations, source-scoped host caches, and field-group stale protection all feed
`clientSummaryStore`. An external query cache would still need adapters that
normalize every accepted result into the summary store, and would become a
second cache unless integrated carefully.

## Decision

Build a narrow client query controller for summary/list/config feeds.

Do not move transcript loading, stream state, or provider replay state into this
controller. Session detail loading already has bespoke rules around JSONL
cursors, stream buffering, replay dedupe, and incremental merges. Keep that
state local to `useSession`, `useSessionMessages`, and stream hooks.

The controller should be boring:

```ts
ensureQuery({
  sourceKey,
  key,
  coverage,
  staleTimeMs,
  fetch,
  applySnapshot,
});
```

It should provide:

- stable query-key serialization;
- source-key scoping;
- in-flight request sharing for identical or compatible coverage;
- fresh/stale timestamps;
- optional minimum refetch intervals;
- explicit invalidation;
- loading/error state selected by hooks;
- pagination or coverage metadata where the endpoint needs it;
- snapshot reporting into the appropriate store/action supplied by the caller.

It should not own canonical row objects for summary data. Accepted snapshots
still normalize into `clientSummaryStore`; UI rows still render from store
selectors.

## Coverage Model

The controller needs a concept of coverage, not only exact query identity.
Global sessions expose the problem clearly:

- Sidebar may need "unfiltered non-archived global sessions, at least 50 rows."
- Recent Sessions dropdown may need the same query, at least 15 rows.
- All Sessions may need the same query, at least 100 rows plus page controls.

A 100-row unfiltered fetch should satisfy a 50-row sidebar requirement for that
same source and filter shape. A 15-row dropdown fetch should not satisfy a
50-row requirement. `limit` is therefore partly coverage, not always a distinct
cache identity.

Suggested normalized shape:

```ts
interface QueryBaseKey {
  sourceKey: ClientSummarySourceKey;
  endpoint: "global-sessions";
  projectId?: string | null;
  searchQuery?: string;
  includeArchived?: boolean;
  starred?: boolean;
}

interface Coverage {
  minRows?: number;
  includeStats?: boolean;
  pagesLoaded?: number;
}
```

Stats should usually be separate from row coverage. `includeStats: true` should
not force a distinct row cache when the row query shape is otherwise identical.

## Sidebar Target

Sidebar should not rely on incidental store warming from All Sessions.

Introduce an app-shell retainer, likely under `NavigationLayout`, that ensures
Sidebar's session coverage while the app section is mounted. The visual
`Sidebar` component can remain collapsed, mobile-hidden, or temporarily absent;
the retainer still keeps the required query warm for the current source.

Target shape:

```tsx
function SidebarDataRetainer() {
  useGlobalSessionsQueryCoverage({
    minRows: SIDEBAR_SESSION_PAGE_SIZE,
  });
  useGlobalSessionsQueryCoverage({
    starred: true,
    minRows: SIDEBAR_SESSION_PAGE_SIZE,
  });
  return null;
}
```

The visual Sidebar keeps rendering from `clientSummaryStore` selectors and keeps
calling shared `loadMore` controls when the scroll container nears the end.

## Activity Bus Integration

The controller should not replace `activityBus`.

Activity events remain the fast path for local updates. The controller reacts to
events only for fetch-side lifecycle:

- mark relevant query keys stale;
- debounce reconciliation refetches;
- trigger a fetch on reconnect/refresh only when the query is retained and the
  connection is ready;
- avoid publishing authoritative empty snapshots before remote readiness.

Reducers and selectors remain in `clientSummaryState` / `clientSummaryStore`.
The controller should not duplicate session projection logic.

## Retained Query Revalidation

The controller core knows which queries are retained and can share in-flight
work. The React-facing revalidation layer tells retained feeds how to revalidate
when the app receives a wake, reconnect, mutation, or activity signal. Without
that layer, each hook rebuilds the same mechanics:

- local debounce timers;
- local readiness guards;
- local `activityBus` subscriptions;
- local force-refetch calls;
- local "do not flash loading over existing data" behavior.

Use a small React-facing layer on top of the controller. The first
implementation is `useRetainedClientQuery`:

```ts
useRetainedClientQuery({
  sourceKey,
  key,
  coverage,
  enabled,
  ready,
  staleTimeMs,
  revalidateOn,
  fetcher,
  applySnapshot,
});
```

The exact API can change, but the behavior should not:

- initial ensure runs once after `enabled && ready`;
- `refresh` and `reconnect` mark retained queries stale and schedule one
  debounced ensure;
- endpoint-specific activity events can invalidate or refetch matching query
  keys;
- no fixed polling interval is introduced;
- no request is started before the React-level readiness gate opens;
- `fetchJSON` remains the transport-level secure-connection wait;
- background revalidation errors preserve existing data and avoid loading
  flashes;
- unmounted entries do not keep timers, subscriptions, or server resources
  alive.

Local reducers still remain the fast path. For example, a
`session-metadata-changed` event should update any normalized session facts
immediately when it contains enough data, then invalidate retained server-owned
memberships only when membership or denormalized row fields may have changed.

Retained collection entries also carry the server's catalog epoch/generation.
That value is a conditional reconciliation token, not a substitute for query
coverage or field-group fidelity. Multiple filters can read the same server
generation while retaining different memberships, and a newer partial event
can patch one field without proving the full query current.

## Mutations

Shared mutation helpers remain a separate but related track from
`030-client-summary-store-closeout.md`.

After a successful mutation:

- report the accepted fact into `clientSummaryStore`;
- invalidate query keys whose server-owned membership may have changed;
- refetch retained stale queries through the controller, not through every
  mounted component independently.

Examples:

- star/unstar changes starred query membership and derived Sidebar sections;
- archive/unarchive changes default non-archived query membership;
- mark read/unread affects inbox membership and unread filters/counts;
- project queue create/update/delete/retry mutations update queue summaries and
  targeted-session badges.

## Implementation Chunks

### 1. Document Current Fetch Inventory

Status: Completed 2026-06-28.

Acceptance:

- clear list of first-class feeds vs deliberately-specialized hooks;
- no code behavior change.

### 2. Add A Minimal Query Controller Module

Status: Completed 2026-06-28.

Create a small client module, likely under `packages/client/src/lib/`, with
query entries keyed by source and normalized query key.

Initial capabilities:

- `ensureQuery(...)`;
- `invalidateQuery(...)` / `invalidateQueries(predicate)`;
- retained subscriber count;
- in-flight promise reuse;
- `fetchedAt`, `requestStartedAt`, and `error`;
- optional `staleTimeMs`;
- test reset helper.

Do not implement broad garbage collection, retries, persistence, or Suspense in
the first slice. Add those only after a concrete caller needs them.

Acceptance:

- two concurrent ensures for the same key/coverage call the fetcher once;
- a fresh entry satisfies a later ensure without network work;
- a larger coverage request fetches when a smaller cached coverage is
  insufficient;
- source keys isolate otherwise-identical queries;
- a late response writes through the source captured at request start.

### 3. Move Global Sessions Feed Onto The Controller

Status: Completed 2026-06-28.

Refactor `useGlobalSessionsFeed` so it asks the controller to ensure row
coverage and publishes accepted snapshots into `clientSummaryStore`.

Global sessions specifics:

- split base key from coverage (`limit`);
- keep stats separate from row coverage;
- keep `loadMore` based on query state ids and the last complete record until
  the server exposes an opaque cursor;
- preserve existing race policy based on `requestStartedAt`;
- keep event-created and metadata events reporting into the summary store.

Acceptance:

- Sidebar, All Sessions, and Recent Sessions do not issue duplicate initial
  requests for compatible global-session coverage;
- a 100-row All Sessions fetch satisfies the 50-row Sidebar need;
- a 15-row dropdown fetch does not block Sidebar from fetching 50 rows;
- mounted hooks still expose loading/error/refetch/loadMore controls;
- rows still come from `clientSummaryStore` selectors, never from hook-local
  response arrays.

### 4. Add Sidebar Data Retainer

Status: Completed 2026-06-28.

Mount a retainer in the navigation/app shell so Sidebar's required coverage is
ensured independently of the current page and visual sidebar state.

Acceptance:

- refreshing on Agents shows Sidebar session sections after the sidebar-retained
  queries resolve, without visiting All Sessions first;
- collapsed desktop Sidebar and closed mobile Sidebar do not disable data
  coverage for the mounted app shell;
- route-specific pages no longer need to warm the sidebar's data accidentally;
- no extra duplicate `/api/sessions` request when All Sessions is already
  retaining compatible coverage.

### 5. Move Agents Processes Onto The Controller

Status: Completed 2026-06-29.

Move `useProcesses` from a mount fetch plus 30s poll to a retained controller
query.

Process list specifics:

- add a process-list query key for `/api/processes?includeTerminated=true`;
- keep `useProcesses` local-state-backed in the first slice unless another
  surface needs process rows from `ClientSummaryState`;
- source-key the query so hosted/remote sources do not leak process rows;
- use retained-query revalidation for initial load, `refresh`, `reconnect`,
  `process-state-changed`, `session-created`, and session metadata/update
  events;
- patch custom titles locally from metadata events when the event carries
  enough data;
- fall back to a coalesced refetch when an event only identifies the affected
  session;
- remove `POLL_INTERVAL_MS` and `setInterval` from `useProcesses`.

Acceptance:

- [x] opening `/agents` performs one ready-gated process-list request;
- [x] StrictMode or multiple Agents consumers share the source-keyed process
  snapshot and controller query instead of owning independent poll loops;
- [x] backgrounding a tab or waking a phone causes at most one coalesced refresh
  after the connection is usable;
- [x] custom session titles appear on the Agents page without waiting for a timed
  poll;
- [x] existing rows stay visible during background revalidation failures;
- [x] no process-list request starts before remote secure-connection readiness.

### 6. Move Inbox Onto Retained Revalidation

Status: Completed 2026-06-29.

Move `InboxContext` from bespoke readiness, debounce, and activity-event fetch
timers onto `useRetainedClientQuery`, while preserving its app-scoped provider
role and stable tier ordering.

Inbox specifics:

- keep `/api/inbox` payload handling in `InboxContext`;
- keep `mergeWithStableOrder` and tier-order refs local to the provider;
- keep accepted snapshot reporting through `reportInboxCollectionSnapshot`;
- use retained-query revalidation for initial load, `refresh`, `reconnect`,
  `process-state-changed`, `session-status-changed`, `session-seen`,
  `session-created`, `session-metadata-changed`, and `session-updated`;
- filter `session-updated` revalidation when the updated session is already in
  a tier whose content fields can patch through `clientSummaryStore` without
  recomputing membership (`needsAttention`, `active`, or `recentActivity`);
- preserve remote secure-connection readiness gating;
- preserve manual `refresh()` as a server-sort refresh rather than a stable
  merge refresh.

Acceptance:

- [x] no `/api/inbox` request starts before remote secure-connection readiness;
- [x] source switches reset stable tier order;
- [x] refresh/reconnect events coalesce into one retained-query refetch;
- [x] existing rows remain selected from `clientSummaryStore`;
- [x] locally patchable `session-updated` events patch inbox rows without
  forcing a full `/api/inbox` refresh, while unknown rows and unread-tier
  promotions still revalidate;
- [x] manual refresh can still force server sort order.

### 7. Move Projects Onto Retained Revalidation

Status: Completed 2026-06-29.

Move `useProjects` and `useProject` from hook-local fetch/debounce state onto
`useRetainedClientQuery`, while preserving their client-summary snapshot
reporting.

Project specifics:

- keep project records in `clientSummaryStore`;
- use a list query key for `/api/projects`;
- use per-project detail query keys for `/api/projects/:id`;
- preserve remote secure-connection readiness gating;
- revalidate the project list on `refresh`, `reconnect`,
  `process-state-changed`, `session-status-changed`, and `session-created`;
- revalidate project detail on `refresh` and `reconnect`;
- for project detail, filter process/session activity events to the selected
  project before scheduling revalidation.

Acceptance:

- [x] project list responses still feed the shared project collection;
- [x] project detail responses still update list consumers through shared
  project records;
- [x] project list wake/reconnect events coalesce into one retained-query
  refetch;
- [x] project detail ignores unrelated project activity;
- [x] no project request starts before remote secure-connection readiness.

### 8. Move Adjacent Summary Feeds Opportunistically

Status: Project queues complete; remaining adjacent feeds are follow-on.

After global sessions, processes, inbox, and projects prove the controller
shape, migrate only feeds that get a clear simplification:

- project queues: completed with a global `/api/project-queue` feed query and
  project-scoped mutation responses;
- server settings;
- version/provider catalog if their existing module-level caches can be
  replaced with the generic controller cleanly.

Acceptance:

- fewer hook-local `hasFetchedRef`, `inFlightRef`, and debounce implementations;
- existing store snapshot reporting remains source-scoped;
- no transcript/session-stream code moves into the query controller.

### 9. Retain One Version and Capability Snapshot Per Source

Status: Completed 2026-08-05. Ordinary `/api/version` assembly no longer
launches a subprocess, and the 34 `useVersion()` call sites now share one
source-keyed retained snapshot with one pending-validation follow-up owner.

Measured: the install version, development `git describe` name, package root,
and install source cannot change while the process runs, so they are computed
once and shared, with concurrent first callers joining one probe and a failed
probe clearing itself for retry. Over 20 requests across five samples, the
previous per-request shape ran 20 probes at a 307.75 ms median (15.39 ms per
request); the retained snapshot ran 1 probe at a 17.01 ms median (0.85 ms per
request) — 95.00% of probes avoided, 18.09x. `fresh=1` deliberately does not
clear it, since its contract promises a fresh check of the dynamic
sandbox/device facts, which read from their owning services. Run `pnpm --filter
@yep-anywhere/server benchmark:version-route` to repeat the measurement.

There are currently 34 `useVersion()` call sites. The hook shares only a
request that is concurrently in flight; after it resolves, a later mount starts
another `/api/version`. On the live development server, ordinary calls ranged
from 45 ms to 680 ms. Twenty sequential calls caused about 989 kB of server
logical reads. The server recomputes `getCurrentVersionInfo()` on every request,
which runs `git describe` in a source checkout, while sandbox/device/update
subsystems separately apply their own caches.

The same hook-local shape multiplies pending validation: every mounted
`useVersion()` whose speech backend is pending schedules its own one-second
timer. Concurrent timers may happen to share one in-flight request, but the
contract should have one source-level revalidation owner rather than relying on
timer alignment.

Move the resolved version response into a source-keyed retained snapshot and
use `useRetainedClientQuery` for readiness, reconnect, and explicit refresh.
All 34 consumers subscribe; none owns an initial request or pending-state poll.
Keep `freshOnMount` as a deliberate force-refresh request for the About/update
surface, coalesced with another compatible fresh request for that source.

On the server, cache process-generation facts such as current version,
development `git describe`, package root, and install source. Continue to read
dynamic sandbox/device/voice state from their owning service snapshots; do not
introduce a second cache that can contradict them. Ordinary `/api/version`
response assembly launches no subprocess. `fresh=1` explicitly refreshes only
the dynamic facts whose public contract promises a fresh check.

Measured (client): over one 58-second session in which the app's 34 consumers
mount as routes and settings panes open, against a server that reports a
validating speech backend for its first three seconds, the previous hook issued
25 requests (1.18 MB) and armed 39 retry timers; the retained snapshot issues 4
requests (189 kB) and arms 3. Consumers needing to wait for a response fell
from 34 to 12, and total consumer wait from 8,076 ms to 540 ms (14.96x) — the
22 consumers mounting after the snapshot resolves now render with it already in
hand. Both arms end with every consumer holding a snapshot and with validation
followed until it settles; the benchmark asserts both. Run `pnpm --filter
@yep-anywhere/client benchmark:version-snapshot` to repeat it.

The measured arm-B dedupe is the real `ensureClientQuery`, not a restatement of
it, so the benchmark cannot drift from the shipped controller. What it does
model is the React layer: the mount effect and the 500 ms revalidation debounce.

Acceptance:

- [x] one connected source has at most one ordinary version request in flight and
  one retained resolved snapshot, independent of mounted consumer count;
- [x] source switches never expose another host's capabilities, version, voice
  backends, sandbox state, device bridge, or client defaults;
- [x] mounting New Session, Sidebar, Message Input, Settings, and usage telemetry
  after the snapshot resolves issues zero additional ordinary version requests;
- [x] a pending speech backend schedules one source-level follow-up and stops when
  the snapshot is no longer pending;
- [x] ordinary server reads run no Git, npm, sandbox, bridge, or provider child;
- [x] reconnect and explicit/fresh refresh preserve their current semantics and
  stale-response ordering; and
- [x] tests cover multiple consumers, sequential mounts, source transitions,
  pending-to-ready polling, reconnect, and a forced About refresh.

One deliberate semantic change: because the About surface retains a
`{ fresh: true }` coverage query rather than issuing a one-off check, *every*
acquisition it owns is an update check — including its reconnect revalidation,
which previously was an ordinary read. That keeps About from showing a stale
update verdict after a reconnect, and it is scoped to the one mounted surface
that asked for fresh data. Every other consumer's reconnect stays ordinary.

### 10 — stage app-shell feeds after selected-page readiness

Status: Implementation handoff, triggered by the 2026-08-05 request census.

Give each retained source one bootstrap coordinator that schedules selected
route requirements, stable navigation counts/coverage, and supplementary
diagnostic/usage work in that order. Reuse the existing query keys and retained
owners; do not create a second cache or route-local copy of global feeds.

Fold reload notification status/workers/safe-restart into one source-level
snapshot/acquisition. Determine the mode from that result once, remove the
second `/api/dev/status` read, and replace hook-instance connection intervals
with the shared connection/activity signal already used for retained-query
revalidation. Production/static deployments with no development reload work
should not request worker or safe-restart detail merely because the hook is
globally mounted.

Acceptance:

- one source generation performs at most one initial request for each exact
  retained query key, independent of StrictMode or mounted consumer count;
- New Session's settings/provider/project minimum facts are scheduled before
  global sessions, Inbox, process enrichment, and subscription telemetry;
- Sidebar global/starred coverage remains app-shell-retained and appears in
  place after its query settles, without waiting for a route visit;
- app-shell scheduling never starts a second server-owned global reconciliation
  already in progress under tactical 093;
- reload notifications issue one mode/status acquisition, no hook-local
  one-second connection intervals, and no inapplicable worker/safe-restart
  detail requests; and
- a fresh-browser request census records start order, exact-key duplicates,
  first page/control readiness, and final navigation/inbox reconciliation for
  local, remote, and production-static modes.

### 11 — make revalidation owned by the retained query entry

Status: Mostly complete 2026-08-05. The Project Queue deadline backstop landed,
and activity subscriptions plus debounce timers now belong to a per-`(sourceKey,
queryKey)` owner in `lib/clientQueryRevalidation.ts`. The Sidebar
duplicate-retainer fix (four hook instances for two query keys) remains, as does
consuming forced-generation transitions through the owner.

Measured: 26 mounted consumers across 8 retained queries over 15 activity
events — 64 `activityBus` listeners become 21 (67.19%), 165 debounce timers
become 54, and 165 revalidation requests become 54 (3.06x). The request figure
is arm A's fast-response case; when a response outlives the gap between consumer
timers its extra requests join the open one, and both arms issue one per event.
Run `pnpm --filter @yep-anywhere/client benchmark:query-revalidation-owner`.
The measured arm drives the real owner and the real `activityBus`.

Move activity subscriptions, debounce/deadline timers, reconnect/refresh
handling, and forced-generation transitions from hook instances into the
`(sourceKey, queryKey)` retained controller entry.

The general migration has a constraint worth knowing before starting it: one
`(sourceKey, queryKey)` entry can have subscribers with *different* coverage
and different `fetcher`/`applySnapshot` closures — `useGlobalSessionsFeed` at
50 rows and at 100 rows is the live example. So the owner cannot simply adopt
the first subscriber's callbacks; it needs the merged coverage (`mergeCoverage`
already exists for this) and a rule for which subscriber's fetcher runs. Until
that is settled, moving the timers alone would silently narrow coverage. Subscribers declare coverage
and revalidation policy; one compatible owner schedules/acquires the result and
publishes controller state to all hooks.

Make the Sidebar visual component select retained membership and invoke shared
query controls without mounting the same two acquisition hooks already owned
by `NavigationLayout`. Keep the retainer independent of expanded/collapsed or
mobile-open state.

Step 9 pinned down what the per-hook timer actually costs. Two mounted
`useVersion()` consumers each arm their own 500 ms debounce on `reconnect`. If
the first hook's revalidation is still open when the second timer fires, the
second joins it and the event costs one request. If the response landed first —
which is the common case for a fast endpoint — the entry has no in-flight
request to join, and the second hook's forced revalidation starts a second
round trip for the same event. So the duplicate is real but latency-dependent,
which is why it is invisible in tests that use a deferred response and shows up
under a fast one. `useVersion.test.tsx` documents that boundary.

Remove `useProjectQueues()`'s per-consumer five-second interval. Consume
`project-queue-changed`, session-queue persistence, process/session, reconnect,
and refresh events through one query owner. If server scheduler status needs a
time backstop, arm one source-level timeout for the earliest reported
`nextAttemptAt`; tactical 040 owns making title/status response assembly a
retained projection rather than a provider read.

Acceptance:

- [x] two or twenty hooks retaining the same source/query install one event-policy
  owner and at most one debounce/deadline timer;
- a duplicate forced revalidation joins the in-flight generation without
  advancing its stale version, and successful completion makes the entry fresh;
- Sidebar has exactly two retained feed acquisitions (global and starred), not
  separate retainer and visual copies;
- component unmount removes its retention need but does not tear down a query
  still retained elsewhere; the last release clears owner timers/listeners;
- [x] Project Queue with backlog performs no five-second per-component polling and
  remains current through events plus one exact source-level deadline backstop;
  and
- tests vary mount order, StrictMode, Sidebar visibility, simultaneous events,
  source switch, reconnect, one rejected request, and last-subscriber release.

### 12 — reuse catalog generations across browser clients

Consume tactical 093's approved catalog epoch/generation on collection
snapshots and deltas. A retained query sends its known generation on
revalidation; the server may answer no-change, bounded deltas, or a replacement
snapshot. Sequential component mounts therefore reuse both the client entry
and accepted server generation instead of re-fetching unchanged rows. Falling
outside the server's bounded delta window cleanly requests a replacement.

Add optional source/auth/schema-scoped compact snapshot persistence in
IndexedDB, with byte/age eviction. `BroadcastChannel` or a small local-storage
notice advertises the newest stored generation to same-origin tabs. Where the
browser supports it, Web Locks or a short renewable lease may elect one tab to
perform a cold acquisition while followers load the accepted snapshot and
observe publication. Owner loss, private/evicted storage, unsupported APIs,
and another device fall back to the ordinary server path.

Do not persist transcripts, provider payloads, credentials, or component-local
selection/scroll state. Do not make browser election the herd-control boundary:
all devices and fallback requests must still join tactical 093's server-side
single-flight computation. Interest messages carry only debounced stable
session/query-window identities with TTL; one tab's hidden stale viewport must
not keep a server lease alive.

Acceptance:

- sequential mounts with an accepted generation issue no replacement snapshot
  request unless coverage, source, epoch, freshness, or fidelity requires it;
- capable sibling tabs perform at most one cold acquisition for one
  source/query generation and all accept the same published snapshot;
- loss, corruption, eviction, quota failure, or lack of browser coordination
  APIs falls back without correctness loss or retry storms;
- persisted compact data is source/auth/schema scoped, byte/age bounded, and
  contains no transcript/provider payload;
- visible/hover interest is debounced, expiring, and unionable by the server;
  and
- multiple devices requesting the same stale projection still cause one
  server-side derivation.

## Non-Goals

- Do not replace `clientSummaryStore`.
- Do not store full transcripts, stream deltas, rendered markdown, or composer
  state in the controller.
- Do not introduce polling loops as part of this cleanup.
- Do not require browser storage or cross-tab locking for correctness.
- Do not adopt React Query/SWR/RTK Query in the first patch.
- Do not make the controller understand every endpoint on day one.
- Do not treat a short paginated response as proof that unrelated entities do
  not exist.

## Verification Checklist

- Refresh `/agents` and verify Sidebar no longer depends on visiting
  `/sessions`.
- Verify source switching in hosted remote mode does not leak prior-host query
  data.
- Verify late responses update the captured source, not the current source.
- Verify remote feeds do not publish empty snapshots before secure connection
  readiness.
- Verify activity-bus-created sessions remain visible through stale older
  snapshots.
- Verify Agents no longer polls, but still refreshes on tab foreground, phone
  wake, reconnect, and relevant process/session events.
- Verify Agents custom titles update from metadata changes or the next
  coalesced retained-query refresh.
- Verify Inbox uses the same retained refresh path while preserving stable tier
  ordering and manual server-sort refresh.
- Verify Project Queue feed refreshes through one global retained query rather
  than one request per project on the Projects page.
- Verify project list/detail feeds use retained refresh while preserving shared
  project record updates and detail-event filtering.
- Verify later `useVersion` consumers reuse one source-scoped resolved snapshot
  and that pending capability validation has one follow-up owner.
- Verify selected-route facts start before retained global/diagnostic feeds,
  without making Sidebar coverage depend on whether Sidebar is visible.
- Verify reload notifications perform one source-level status acquisition and
  no per-consumer connection interval or inapplicable worker-detail request.
- Verify duplicate query retainers share one event/debounce owner, successful
  forced revalidation clears stale state, and Project Queue has no
  per-component five-second poll.
- Verify catalog generation reuse across sequential mounts and sibling tabs,
  including storage eviction/owner-loss fallback and source/epoch changes.
- Verify star/archive/read mutations update store-backed surfaces immediately
  and invalidate retained server-owned memberships.
- Verify StrictMode or multiple mounted consumers do not double-fetch the same
  compatible query.
- Verify transcript/session detail flows still use their specialized merge and
  stream paths.
