# Server performance observability

> Server performance observability gives an authenticated operator bounded
> current metrics and searchable diagnostic events, and gives YA enough
> process-local memory-pressure awareness to shed rebuildable caches before
> V8 exhaustion without treating eviction as a substitute for fixing
> duplicated or unbounded work.

Topic: server-performance-observability

Status: Draft proposal. No route, recorder, monitor, cache registry, or client
panel described here is implemented or approved for implementation yet.

## Vocabulary

Use two exact names rather than bare *telemetry*:

- **Server metrics** are query-time counters and gauges describing current
  process and subsystem state. They are not retained samples.
- **Performance events** are bounded, timestamped diagnostic records for
  significant work, pressure transitions, evictions, and failures. They are
  local operator observability, not outbound analytics.

Qualify cache and liveness names by their owner. `codex_entry_cache_miss`,
`prompt_cache_expected_hit`, `session_detail_cache_hit`, and
`provider_runtime_idle` remain meaningful in a mixed event stream; bare
`cache_miss` and `idle` do not.

## Motivation from the 2026-08-04 incident

YA's Node server stopped answering and then aborted with `SIGABRT`. The old
process had recently reached about 3.82 GiB V8 heap and 5.12 GiB resident set
size against a measured 4.19 GiB V8 heap limit. The kernel recorded neither an
OOM kill nor contemporaneous swapping. V8 heap exhaustion is therefore a
strong inference, not a proven fatal string: core storage was disabled and the
terminal history containing fatal stderr was gone.

The same interval also demonstrated work amplification. Multiple overlapping
requests parsed the same unchanged roughly 40 MB Codex transcript, while a
growing roughly 277 MB transcript was parsed repeatedly. A bounded tail of the
server log represented hundreds of logical GiB of transcript input. This is a
fix lead at the read/coalescing owner, independent of memory-pressure cache
eviction.

The completed live measurement makes the owner exact. From 22:44–22:54 UTC,
37–47 minutes after restart, the Hono PID averaged 246.6% CPU (218.3% user,
28.2% system) and 107.3 MiB/s of `rchar`, while physical storage reads averaged
only 0.02 MiB/s. RSS oscillated from 3.56–5.01 GiB and VIRT from 46.59–48.03
GiB; the process incurred about 100,500 minor faults/s, zero major faults, no
swap-out, and 0.256% host I/O wait. Its four V8 workers used 152.3% CPU
combined and the OS-named `MainThread` 91.0%, identifying allocation, parsing,
and garbage collection rather than disk wait.

Source and structured logs locate the repeating call chain. The retained
process query revalidates on `session-updated`; `createProcessesRoutes` enriches
each active and recently terminated process with provider children; and
`CodexSessionReader.listProviderChildSessions` full-parses the parent rollout
with `cache: false`. By 23:04 UTC that generation had recorded 1,707 such
agent-mapping misses and 273.55 logical GiB of input. One unchanged 264.27 MiB
snapshot alone was parsed 656 times over 34 minutes. The process-list child
projection is therefore the first owning invariant. Scanner coalescing,
summary-worker isolation, and pressure eviction do not correct that call site.

The full incident evidence and completed investigation are kept in
[`docs/tactical/089-main-thread-startup-cpu-investigation.md`](../docs/tactical/089-main-thread-startup-cpu-investigation.md).

### Address space is not heap

The development Hono process's roughly 47 GiB VIRT is mostly stable V8
WebAssembly guard reservation, not live JavaScript objects or committed RAM.
A 30-minute census found five anonymous `PROT_NONE` mappings of exactly
8,589,996,032 bytes, totaling about 40.96 GiB. Direct VIRT began at 47.56 GiB,
ended at 47.47 GiB, and stayed within 46.87-48.65 GiB while `VmSwap` remained
zero. Development module loading creates several backing stores; a built server
had fewer and still reserved roughly 20 GiB.

Server metrics must therefore show at least V8 heap used/limit, RSS, external
memory, and VIRT as separate facts. A large stable VIRT reservation is not a
heap-pressure alarm. A rising heap near the measured 4.19 GiB limit or RSS
growth is.

### Canonical public-share state is not a cache

The 502 MB aggregate public-share file retained about 1.66 GiB V8 heap after
parsing in isolation. Pretty-stringifying the unchanged state raised live heap
to about 2.66 GiB and peak RSS near 3.76 GiB. This is a demonstrated
heap-exhaustion path when combined with transcript caches or parse transients.

Frozen share content and active-link authorization are canonical state. A
pressure coordinator may not discard them as if they were a cache. Persistence
must instead be sharded and gated by active, unrevoked links so loading or
saving one session/link never materializes the aggregate. See
[Public Share Persistence](public-share-persistence.md).

### Cold display is a server scheduling contract

The built server's late internal timer reported 36-42 ms and listener `onReady`
at 40-47 ms, but that timer begins after module evaluation and synchronous
provider-watcher setup. An external clock measured 1,859 ms from process spawn
to first successful static response; static HTML itself took about 4 ms after
the listener was ready. The four current provider-root initial scans plus
recursive watcher attachments directly took about 0.46 seconds on warm
host caches. Full cold-start instrumentation must begin at process entry and
include this pre-timer work.

A warm built-entrypoint probe located the rest of the pre-timer shape. The
server module graph and top-level setup took about 566 ms before the first
Codex discovery subprocess; the CLI detector then took about 155 ms in
isolation. The `NO_BACKEND_RELOAD` source watcher added about 39 ms. Move
advisory CLI probing and source watching after bind, activate provider watches
asynchronously only for install-eligible families, and compare a bundled or
lazily imported production server graph. A useful-ready metric includes the
selected-session API, not only static HTML.

The statically reachable built entry contains 305 internal server modules,
including 69 route modules and about 3.84 MB of input source; an internal-only
bundle was about 2.96 MB before external packages. `index.ts`, `app.ts`, the
provider index, the service barrel, and the root `@yep-anywhere/shared` export
make optional provider SDKs, rendering, sharing/review, speech, push, and
diagnostic modules reachable before a route selects them. Production Node ESM
evaluates modules reached through these static barrels; it does not run the
browser bundler's unused-export elimination at startup.

Useful readiness therefore needs module-owner evidence as well as a timer:
evaluated module count, module-graph heap/resident delta, secured-bind time, and
first useful projects/New Session/selected-session route. Narrow shared subpath
exports and demand-loaded provider/route groups must preserve authentication
and middleware before accepting traffic. Background imports cannot simply move
the same main-thread spike just after bind. The implementation handoff is
[`docs/tactical/097-server-bootstrap-module-staging.md`](../docs/tactical/097-server-bootstrap-module-staging.md).

A fresh browser's selected 44 MB Codex session did not commit until 3.27 s
because its 477 ms transcript read competed with global Inbox work. Route
isolation found `/api/projects` caused no transcript work, while `/api/inbox`
took 4.108 s and launched all-project/all-provider summary enumeration.

Opening an ordinary page must not become the trigger that discovers the global
session corpus. Startup owns an eager but asynchronous reconciliation: scan
each install-eligible provider store once, group results into canonical project
shards, and publish each completed shard into the retained Inbox snapshot.
Eligibility means this YA install has successfully started that provider;
never-used adapters are not queried until first successful use. Routes read the
best completed snapshot and must not await unfinished shards. Main-thread JSON
parsing in the reconciler must yield between bounded units or run in the parser
worker.

Provider-global stores must not be rescanned per project. At a supported
10,000-project scale, live memory is bounded by measured bytes and rebuild cost;
project count is a discovery/navigation requirement, not permission for a
project-by-provider Cartesian scan.

A fresh production New Session also issued 21 API fetches in its first roughly
650 ms. Most represented distinct retained owners, but selected provider,
settings, project, and version work immediately competed with global/starred
sessions, Inbox, processes, queue, usage, and development-reload status. Cold
provider and both initial session-list requests took about 5.21 and 3.56
seconds respectively in that disposable-data run. Client observability should
therefore record request start priority and exact query identity, not only
completion duration. Tactical 031 owns the source-level coordinator and its
located duplicate reload-status read; tactical 093 owns server-side global
session reconciliation.

## Server metrics

One process-wide collector should expose a cheap current snapshot. At minimum:

- process uptime, CPU, resident set size, and event-loop delay;
- V8 used/total heap, `heap_size_limit`, external memory, array-buffer memory,
  and allocator/native figures available from Node;
- registered cache entry counts and estimated retained bytes, split by cache
  owner and project where safe;
- active and queued work counts for transcript reads, project/session scans,
  file-watcher reconciliation, glossary compilation, and provider lifecycle
  work; and
- cumulative owner-qualified outcomes such as requests, cache hits/misses,
  in-flight coalescing, evictions, failures, and abandoned work.

The snapshot must not scan projects or sessions in order to answer. Owners
maintain their counters as work occurs. Reading metrics must remain useful when
the ordinary HTTP server is impaired; the maintenance listener and its default
configuration therefore belong to the implementation investigation.

## Performance events

Events should answer *what expensive work happened, for whom, for how long,
and with what outcome* without retaining transcript content. A common record
needs:

- timestamp, monotonic duration, owner-qualified event name, and outcome;
- a correlation identifier for overlapping work and coalesced callers;
- bounded numeric dimensions such as bytes read, entries visited, cache mode,
  heap before/after, and estimated bytes reclaimed; and
- optional stable project/session identifiers only when necessary for an
  authenticated operator to locate the workload.

Do not persist command lines, environment values, credentials, prompt or
transcript text, or arbitrary filesystem paths. Storage belongs in bounded
YA app data, never in a selected project or its Git metadata. Retention needs a
fixed byte/age budget and rotation so the recorder cannot become the next
resource problem. A small persisted tail is justified because a process-local
buffer disappears in the crash it is meant to explain.

Search should filter by time, owner, event name, outcome, minimum duration,
project/session identity when recorded, and free text over the bounded
structured fields. Query limits and pagination protect both server and client;
they must not impose arbitrary limits on unrelated product APIs.

## Memory-pressure containment

V8 offers a queryable heap limit and current heap statistics, but YA should not
depend on a last-moment JavaScript callback at allocation failure. A single
process-wide monitor may sample heap headroom, resident set size, and external
memory. It must not create a timer per session, project, cache, or client.

Pressure handling uses watermarks and hysteresis:

1. Crossing a high watermark emits one transition event and starts eviction.
2. The coordinator asks registered rebuildable caches to reclaim enough
   estimated bytes to return below a lower watermark.
3. It does not repeat notifications or thrash entries while remaining within
   the same pressure state.
4. A critical watermark may use a more aggressive eligible set, but it still
   must not discard canonical provider state, pending writes, active protocol
   ownership, or the only copy of user data.

The exact watermarks require a controlled measurement. They must leave room
for one large in-flight parse and garbage collection rather than aiming at the
V8 hard limit.

## Cache registration and eviction order

An evictable cache registers one small descriptor with the process-wide
coordinator:

- owner and scope (global, project, session, or file);
- estimated retained bytes and entry count;
- last access or most recent project view;
- rebuild-cost class and whether rebuilding is currently in flight;
- protected current work, if any; and
- a bounded eviction operation that reports estimated and observed reclaim.

Evict the cheapest state to rebuild first. Within the same rebuild-cost class,
prefer the least recently viewed project and least recently used entries.
Active-session state should lose to cold project state only at the critical
watermark. A cache without a defensible byte estimate or safe eviction
contract does not silently register as evictable.

The 2026-08-05 audit supplies the initial registry backlog:

| Owner | Current risk | Required pressure contract |
|---|---|---|
| App session readers | 500-entry FIFO without hit retouch; individual Codex readers may retain full parsed transcripts and mapping/file caches. Codex detail updates added per-session in-flight ownership, bounded plain-file reads, and invalidation-fenced publication on 2026-08-24 | Byte/rebuild-cost bound and access retouch; close and release cold project readers without interrupting active owners |
| Claude parsed transcripts | Added 2026-08-07 (`claude-transcript-cache.ts`): process-wide, source-byte LRU (default 192 MB, `YEP_CLAUDE_PARSE_CACHE_MB`), in-flight coalescing, incremental append parsing; a file over the whole budget is never retained | Register with a future pressure coordinator as rebuildable; entries plus WeakMap-linked normalized copies release together |
| Pi parsed transcripts | Resolved 2026-08-07: one current version per file, 64-file LRU with access retouch | One current version per canonical file plus byte-bounded LRU |
| Session summary index | 10,000 scopes by FIFO count, each holding all summaries; FIFO eviction leaves validation/persisted-scope metadata behind, including another UTC-day cutoff key per scope/day | Evict the complete scope/cutoff record, preserve 10,000-project discovery, and cap live bytes; release disk-rebuildable cold scopes |
| Codex shared session scans | Every UTC-day auto-archive cutoff can leave a provider-wide file array in the process-global scan cache | Retain only current/in-flight range generations under an entry/byte LRU |
| Session discovery shards | A source-root index is retained per touched Codex root, and each loaded shard stays in memory for that index's lifetime | Release cold root indexes and byte/LRU-release clean shards; retain dirty/saving shards until durable |
| Project path indexes | Resolved 2026-08-05: demand hydration, refcounted project claims, and 4 MiB per-project / 32 MiB process byte LRU (`project-path-links.md`) | Sparse demand hydration plus project byte/LRU release |
| Glossary service | 512 parsed files, 128 graphs, and unbounded observed-path maps | Project/byte release; lower priority at typical sub-1,000-entry closure |
| Git author palettes | Every touched project's author map remains process-global | Byte/LRU-release cold projects; reload durable app-data state on demand |
| Review project stores | Full canonical review state remains resident for every touched project until whole-service reset | Flush pending work, then release cold project stores by byte/LRU and reload on demand |
| External-session tracker | Process-lifetime `createdSessions` and state maps | Age/generation bounds and bulk expiry |

Shedding order begins with inactive glossary/path/query state and cold provider
readers, continues to parsed detail arrays for inactive sessions and then
disk-backed summary scopes, and touches active-session rebuildable detail only
at the critical watermark. Never evict the current parse, pending writes,
active protocol ownership, or canonical share/session state.

Eviction is containment. Identical snapshot reads must still share one
in-flight parse; growing transcripts need incremental or otherwise bounded
read work; abandoned generations must become collectible. Pressure events
should make those defects visible instead of normalizing continual eviction.

For the Codex detail entry cache, cache-miss ownership is now process-local to
each reader and session. Equivalent overlapping detail requests share the
physical append read, waiters recheck the accepted byte boundary, and cache
invalidation prevents an older completion from repopulating retained entries.
This correctness owner does not resolve the remaining FIFO/byte-pressure work
in the table above or the distinct read-only summary/projection coordination
tracked by tacticals 038 and 056.

## Cache-event distinctions

The existing Cache Billing feature observes provider prompt-cache accounting.
It is not a detector for YA's transcript, session-detail, summary-index, or
projection caches. The 2026-08-04 logs contain profuse Codex entry-cache misses
even though the operator reports that Cache Billing has effectively never
surfaced an outcome.

That report was confirmed on 2026-08-17 and traced to two shape mismatches in
`extractCacheMissBillingObservation`, which rejected every real Claude and
Codex message before classification. The setting had in fact been enabled on
that host, with an aggressive 500-token threshold, and still recorded nothing.
Both mismatches and the expected-cost contract behind the classifier were
fixed the same day; the contract now lives in
[`cache-miss-accounting.md`](cache-miss-accounting.md).

The stage counters proposed below remain unbuilt, and would have named that
defect in one session instead of by code reading.

A prompt-cache investigation needs stage counters rather than only final
hit/miss records: usage-bearing provider message observed, expected-warm state
entered, provider usage fields absent, threshold left the observation
unclassified, and final record emitted. This distinguishes an eligibility or
normalization gap from a genuine provider cache miss.

## Proposed operator surface and compatibility boundary

An advanced YA panel may show the current server-metrics snapshot and a
searchable performance-event table. It should re-query on demand and may
subscribe to new events while open; it must not keep a sampling loop alive
solely because a client once visited it. Public shares cannot access it.

This would be an optional client/server feature. The inspected stable releases
`0.7.0` and `0.6.2` have no performance routes or capability metadata for
them. A future implementation should advertise a new transitional
`server-performance-events` capability before a client calls proposed
`GET /api/performance/summary` or `GET /api/performance/events`. Without the
capability, the client hides the panel and sends no unsupported request.
Existing capability meanings and the remote-compatibility level remain
unchanged. Route names, capability name, client visibility, and retention
defaults remain proposals pending maintainer approval.

## Implementation acceptance

Before this draft becomes a shipped contract, demonstrate:

- a controlled duplicate server on disposable app data can reproduce and then
  eliminate identical overlapping transcript parses;
- server-metrics reads remain bounded and do not recursively discover state;
- performance-event retention survives a server restart within its byte/age
  budget and exposes no transcript or credential content;
- synthetic pressure evicts only registered rebuildable state in documented
  order, settles below the low watermark, and does not oscillate;
- a fresh session route remains responsive while boot Inbox shards reconcile,
  and reading Inbox never starts a second global scan; and
- an older capable/uncapable server receives no unsupported client request.
