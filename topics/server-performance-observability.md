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

Eviction is containment. Identical snapshot reads must still share one
in-flight parse; growing transcripts need incremental or otherwise bounded
read work; abandoned generations must become collectible. Pressure events
should make those defects visible instead of normalizing continual eviction.

## Cache-event distinctions

The existing Cache Billing feature observes provider prompt-cache accounting.
It is not a detector for YA's transcript, session-detail, summary-index, or
projection caches. The 2026-08-04 logs contain profuse Codex entry-cache misses
even though the operator reports that Cache Billing has effectively never
surfaced an outcome.

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
  order, settles below the low watermark, and does not oscillate; and
- an older capable/uncapable server receives no unsupported client request.
