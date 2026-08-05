# Choose the New-Session Project Without Resolving Recent Transcripts

> Select the user's recent project from the durable visit list directly,
> without loading a provider-aware session summary for every recent visit.

Status: Implementation handoff, not yet implemented. The 2026-08-05 New
Session latency pass triggered the recent-visits follow-up previously parked in
the client summary-store plans.

Related contracts and plans:

- [`topics/client-global-store.md`](../../topics/client-global-store.md)
- [`031-client-query-controller.md`](031-client-query-controller.md)
- [`030-client-summary-store-closeout.md`](030-client-summary-store-closeout.md)
- [`089-main-thread-startup-cpu-investigation.md`](089-main-thread-startup-cpu-investigation.md)
- [`094-new-session-provider-catalog-readiness.md`](094-new-session-provider-catalog-readiness.md)

## Current fault and measured scale

`NewSessionPage` calls `useRecentSessions({ limit: 30 })`, then consumes only
`recentSessions.map(session => session.projectId)` to choose a fallback project.
The server already has exactly that raw information in the in-memory,
restart-durable `RecentsService` visit list: session id, project id, and visit
time.

`GET /api/recents` nevertheless performs the following work before returning:

1. lists every known project and builds a lookup map;
2. walks the requested recent visits sequentially;
3. calls `findSessionListSummaryAcrossProviders()` for each visit; and
4. discards the resolved session title/provider in the New Session caller after
   using only its project id.

Live localhost timings after the earlier provider probes were:

| Limit | Total time | Response purpose |
|---:|---:|---|
| 0 | 0.9 ms | Project listing plus empty enrichment loop |
| 1 | 5.9 ms | One recent summary happened to be warm/cheap |
| 10 | 3.770 s | Sequential provider/session summary resolution |
| 30 | 6.496 s | The New Session request shape |

The nonlinear values depend on which recent summaries and provider indexes are
warm. The ownership conclusion does not: the durable raw list is already in
memory, while the enriched route may enter provider readers, indexes, and
transcript summaries once per visit. This work starts concurrently with
provider/model readiness and can contend for the same Hono event loop and V8
heap even though it is not a logical prerequisite for those controls.

The client-local `recentProject` preference avoids the wait when its one global
localStorage id is valid in the current project list. It is not source-scoped,
however; the same encoded path on two hosts can transfer a preference between
sources. When the stored id is missing or invalid, the page explicitly waits
for the enriched recents request before selecting its fallback project.

## Target selection contract

Resolve New Session's project in this order:

1. explicit `projectId` URL choice;
2. explicit detached mode;
3. source-scoped browser recent-project id, if it exists in the current project
   collection;
4. the first still-existing project in the server's raw recent-project order;
   and
5. the first available project.

The provider/model/composer surface renders independently while project data
settles. Once the user edits the project field, expands the project chooser, or
otherwise makes an explicit project decision, a later history response cannot
replace it. The selected project region keeps stable geometry; a fast history
answer fills it rather than causing the rest of New Session to wait.

Recent-visit membership is source-scoped summary state. It contains bounded
session id, project id, and visit timestamp records, not transcript contents.
`recordSessionVisit()` updates the captured source optimistically after the
server accepts a visit; clear/remove operations update the same source. Session
and project titles remain normalized summary facts composed by selectors only
on a surface that actually displays them.

## Server boundary

Add a narrow retained read over `RecentsService`, for example
`GET /api/recents/projects?limit=30`, returning distinct project ids in visit
order plus timestamps when useful. The exact route is settled during the
compatibility review. It performs no project scan, provider resolution,
session-index lookup, transcript read, or session-summary parse. The client
filters ids against its already-retained project collection.

Keep the existing enriched `/api/recents` contract for compatible older
clients and any future surface that genuinely displays recent session rows.
That route should eventually compose its rows from retained normalized
summaries or a bounded bulk projection, not run sequential on-demand provider
resolution. This tactical does not require solving that broader presentation
route before New Session can use the narrow history.

The browser recent-project key migrates to the existing client source-key
namespace. A legacy unscoped value may seed the local source once when it
matches a current project, then normal writes remain source-specific.

## Source map

| Concern | Current owner | Change |
|---|---|---|
| Project fallback | `pages/NewSessionPage.tsx`, `useRecentProject.ts` | Resolve explicit, source-local, raw server history, then first project without awaiting enriched session rows |
| Client recent feed | `hooks/useRecentSessions.ts` | Add a source-scoped lightweight visit/project membership query and accepted-mutation reporting |
| Summary store | `lib/clientSummaryStore.ts` and state/selectors | Retain bounded recent-visit membership per source; compose names from existing session/project records only where displayed |
| Durable raw visits | `recents/RecentsService.ts` | Reuse the already-loaded bounded list; no new canonical store |
| Narrow server read | `routes/recents.ts` | Return raw/distinct recent projects without project/provider/session enrichment |
| Enriched legacy route | `routes/recents.ts`, provider resolution | Preserve compatibility; separately replace sequential on-demand enrichment when a displaying consumer justifies it |
| Tests | New Session page, recent hooks/store, recents route | Prove I/O breadth, source isolation, ordering, user-choice stability, and fallback behavior |

## Recommended implementation order

### 1 — freeze project-choice priority and noninterference

Add page tests for explicit project, detached mode, valid/invalid source-local
recent id, delayed server history, history error, deleted projects, and user
interaction before a late response. Keep provider/model/composer rendering
independent of the history promise.

### 2 — expose the raw recent-project projection

Read the bounded `RecentsService` array, deduplicate project ids in visit order,
and return it without calling the scanner or any provider/session service. Add
a route test whose scanner/reader dependencies throw if touched.

### 3 — retain recent membership by source

Use the query controller for readiness, in-flight coalescing, reconnect, and
source transitions. Report visit/clear/remove mutations to the captured source.
Migrate the browser's single recent-project key without making it a global
cross-host preference.

### 4 — switch New Session to the narrow projection

Remove `useRecentSessions()` from `NewSessionPage`. Compose only the ordered
project ids it needs and preserve the current URL replacement semantics after
the chosen project is known.

### 5 — measure cold and warm request breadth

Compare first New Session paint, project selection, provider/model readiness,
and server transcript/index events before and after. A 100-entry recent list
must remain O(entries) over a small in-memory array and perform zero filesystem
or provider reads.

## Compatibility review checkpoint

New Session's project default is core behavior. Before requesting a new route,
inspect the latest two stable releases and every stable release in the preceding
60 days. A likely transitional `recent-project-history` capability covers the
narrow route. Without it, a new client may retain the existing enriched-recents
fallback and must make no unsupported request. Old clients continue using the
legacy route on new servers. Do not expand an existing capability.

Approval prompt to settle at implementation time:

> Compatibility review for lightweight recent-project history: releases
> `<60-day corpus>` lack `<narrow recent-project route>`. Add transitional
> capability `<final name>`; without it the client keeps the current enriched
> recents fallback and makes no unsupported request. Existing recents and
> project contracts remain unchanged. Approve?

## Acceptance

- New Session project fallback performs zero provider, session-index,
  transcript, or session-summary reads.
- Ten and 100 recent visits differ only by a bounded in-memory projection; one
  cold provider transcript cannot change its latency.
- Provider/model/composer rendering never waits for recent-project history.
- Explicit URL/detached/user choices outrank and cannot be overwritten by a
  late history response.
- Recent project preference is source-scoped; switching hosts cannot reuse
  another host's same-path preference accidentally.
- Visit, clear, deleted-project, and deleted-session behavior stays ordered and
  durable across server restart.
- New clients make no narrow-route request to an older server lacking the
  approved compatibility gate.
