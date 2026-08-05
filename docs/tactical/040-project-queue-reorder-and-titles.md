# Project Queue Reorder And Titles

Status: title enrichment and project-local move-to-top slices complete; the
2026-08-05 retained-read/polling performance follow-up below is an
implementation handoff. Narrow-viewport visual QA also remains.

Topic: project-queue-reorder-and-titles

Related follow-ups:

- [`031-client-query-controller.md`](031-client-query-controller.md)
- [`089-main-thread-startup-cpu-investigation.md`](089-main-thread-startup-cpu-investigation.md)
- [`093-provider-session-reconciliation.md`](093-provider-session-reconciliation.md)
- [`topics/project-queue.md`](../../topics/project-queue.md)

## Problem Statement

The Project Queue manager needs two small but related usability upgrades:

- a control that moves an item to the top of that item's project queue;
- display text for the target session, not just the session id.

"Top" means top within the same project backlog. Project Queue is already a
project-scoped feature, so this does not need a new capability flag or a new
cross-project priority model before release.

Session-title display should be enriched by the server list API. The client
should not fan out one title request per queue row. The tactical dependency is
a clean server-side way to resolve a known session id to display metadata while
using the session index cache first.

## Decisions

- Keep reorder scope project-local. A move-to-top action must not move an item
  across projects or ahead of lower-level work that Project Queue already waits
  behind.
- Do not reuse the existing `promoted` event reason for manual reorder. In this
  feature, promotion already means scheduler dispatch from Project Queue into
  provider/session work. Use a reorder-oriented reason such as `reordered`.
- Add title fields to the queue list response. Prefer a single enriched
  `GET /api/project-queue` payload over client-side N+1 title requests.
- Use cache-first session-index reads for target session titles. Direct reader
  calls are only the fallback on cache miss, stale file stats, or a reader that
  cannot expose a concrete file path.
- Preserve project queue order in client projections. Any client sorting by
  `createdAt` must not mask server-side reorder.

## First Slice

The first implementation slice is the server service primitive:

- add `ISessionIndexService.getSessionSummaryWithCache(...)`;
- make `SessionIndexService.getSessionTitle(...)` delegate to that primitive;
- route cache misses through the existing summary parse queue when the reader
  exposes a concrete file path;
- make `findSessionSummaryAcrossProviders(...)` use the session index service
  when available.

This gives queue API enrichment an easy, cache-first interface for both
`title` and `fullTitle`, without teaching route code or client hooks how the
session-index cache is structured.

Implementation status:

- [x] Cache-first single-session summary primitive.
- [x] Title lookup delegates to the summary primitive.
- [x] Provider summary resolution uses the index service when available.
- [x] Project Queue API title enrichment.
- [x] Project-local move-to-top mutation.
- [x] Client hook and manager UI controls.

## Follow-up fault: rich reads on a per-component poll

The cache-first title slice removed a direct guaranteed full parse, but the
global queue response still resolves every existing-session target on every
request. `globalQueueResponse()` lists all items, sequentially recomputes each
project's scheduler status, then `Promise.all`s item enrichment through
`findSessionListSummaryAcrossProviders()`. A stale/missing index can therefore
enter provider discovery and summary parsing merely to decorate the same queue
row again.

The client compounds this. Every `useProjectQueues()` hook starts a five-second
forced-refetch interval whenever a relevant queue or recovered-session row
exists. Sidebar plus New Session, Session, Projects, Inbox, or Global Sessions
can mount several consumers of the same source/global query. In-flight sharing
coalesces only overlapping calls; different mount offsets can issue several
rich queue responses per interval. The poll is inactive when the queue is
empty, which is why the ordinary empty live route is cheap after warmup, but it
activates exactly when durable backlog makes session titles/statuses nonempty.

Project Queue already emits `project-queue-changed` for item transitions and
the client subscribes to process/session persistence events. The missing
invariant is one retained server projection plus one source/query revalidation
owner, not another cache around per-request provider resolution.

## Follow-up target

Queue response assembly performs no provider transcript discovery. Existing
session target titles come from the retained session-catalog/summary generation
in tactical 093 plus immediate custom-title metadata. A catalog miss may return
the existing nullable title and schedule one coalesced exact background
projection; it cannot block every queue read on a transcript parse. Catalog and
metadata events update the row/version in place.

Scheduler status is likewise a retained server fact. Item, dispatch,
process/session, external-ownership, quiet-timer, and retry transitions update
the affected project status and emit a versioned delta. The client renders
countdowns from server timestamps. If it needs a missed-event safeguard, one
source-level timer wakes at the earliest `nextAttemptAt` and revalidates once;
there is no five-second timer per component.

Project Queue events must not downgrade an enriched row by replacing its known
title with an un-enriched service item. Either emit the complete retained row
or merge the item event with the catalog-backed session entity under the client
summary store's partial-observation rules.

## Follow-up implementation

### 1 — measure queue response owners with nonempty fixtures

Instrument item count, status-project count, catalog/index hits, provider
summary reads, bytes, and duration. Exercise multiple existing-session targets,
one stale/missing index, recovered patient rows, blocked quiet state, and two
mounted client consumers.

### 2 — retain target-title projections

Join queue items to tactical 093's compact session catalog and
`SessionMetadataService`. Keep target title/full-title nullable for unresolved
old rows, schedule one exact background repair, and publish a versioned delta
when it resolves. Do not persist transcript content in Project Queue state.

### 3 — retain project scheduler statuses

Update one server-owned status projection from scheduler and liveness events.
Arm exact quiet/retry deadlines and publish transitions so reads do not rerun
the project idle predicate for every consumer.

### 4 — remove component polling

Apply tactical 031's query-entry revalidation owner and delete the
`useProjectQueues()` five-second interval. Preserve reconnect/refresh and one
deadline/missed-event fallback when the server contract requires it.

### 5 — verify old-server behavior

Removing polling depends on complete status/item delta semantics that older
Project Queue-capable servers may not provide. Inspect the required stable
release corpus before changing the client. If necessary, add a new capability
for retained queue snapshots/deltas; without it, keep one source-level legacy
poll fallback and make no unsupported request. Do not broaden the existing
`projectQueue` capability.

## Follow-up acceptance

- Repeated global queue reads with unchanged backlog perform zero provider,
  session-index miss, transcript, or project-corpus reads.
- One stale target title schedules at most one exact background resolution and
  never delays queue items/statuses that are already known.
- One source has one retained queue acquisition/revalidation owner regardless
  of Sidebar/page/component count.
- No component owns a fixed five-second queue poll; countdowns use server
  timestamps and one exact source-level deadline backstop when needed.
- Every item/dispatch/quiet/blocker/recovery transition becomes visible through
  a complete event/snapshot generation, including reconnect and server restart.
- New clients retain a source-level legacy fallback against older servers until
  an approved capability proves complete retained queue deltas.

## Remaining Implementation

1. Enrich queue read models with target-session display metadata. (Complete)
   Existing-session items should include nullable target title fields resolved
   through `findSessionSummaryAcrossProviders(...)` or an equivalent helper
   that uses the cache-first summary path.

2. Add a project-local move-to-top service method. (Complete)
   It should move only queued/failed items if dispatching items are already
   claimed, preserve item contents, update `updatedAt`, persist atomically, and
   emit a reorder-specific project-queue event.

3. Add an API mutation for move-to-top. (Complete)
   Keep it under the existing project queue route family, for example
   `POST /api/projects/:projectId/queue/:itemId/move-to-top`.

4. Add client API and hook support. (Complete)
   `useProjectQueues` should expose the mutation and refresh from the
   reorder-specific event reason without sorting away the server order.

5. Add the Project Queue manager button. (Complete)
   Use a compact action button consistent with existing queue controls. The
   button should be disabled or hidden when the item is already first among
   movable items for that project, and should not appear for claimed
   dispatching work.

## Verification Plan

- [x] Server service tests for cache hit, stale/missing summary fallback, and
  provider-resolution index use.
- [x] ProjectQueueService tests for project-local reorder and persistence.
- [x] Route tests for the new move-to-top endpoint and enriched title response.
- [x] Client hook/component tests for preserved order, button enablement, and title
  rendering.
- [ ] A narrow viewport check of the Project Queue card so the title, prompt text,
  and action buttons do not overlap.

Commands run:

- `pnpm --filter @yep-anywhere/server test -- test/services/ProjectQueueService.test.ts test/routes/project-queue.test.ts`
- `pnpm --filter @yep-anywhere/client test -- src/hooks/__tests__/useProjectQueues.test.ts src/components/__tests__/ProjectQueueSection.test.tsx`
- `pnpm typecheck`
