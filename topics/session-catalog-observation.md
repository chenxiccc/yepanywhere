# Session Catalog Observation And Freshness

> YA treats the server as the continuous observer of session summary state.
> It maintains one durable compact catalog, spends foreground work according
> to live/provider and client interest, and never turns broad list or stale
> offscreen state into repeated full-transcript scans.

Topic: session-catalog-observation

Status: Accepted architecture contract; implementation is handed off in
[`docs/tactical/093-provider-session-reconciliation.md`](../docs/tactical/093-provider-session-reconciliation.md).

See also:

- [`session-summary-fidelity.md`](session-summary-fidelity.md)
- [`session-index-validation.md`](session-index-validation.md)
- [`session-hovercard-recent-activity.md`](session-hovercard-recent-activity.md)
- [`all-session-content-search.md`](all-session-content-search.md)
- [`client-global-store.md`](client-global-store.md)
- [`inbox.md`](inbox.md)
- [`architecture-mandates.md`](architecture-mandates.md)
- [`server-cache-publication.md`](server-cache-publication.md)

## Continuous-observer model

Design session discovery as though one YA server remains alive and watches the
installation continuously, with brief restart intervals. This is a consistency
model, not a promise of process uptime: durable catalog state and bounded boot
reconciliation let a replacement server resume observation without making the
first client request rediscover the corpus.

The server owns a compact global catalog of every session it knows. Broad
client list snapshots may continue to contain many or all compact rows needed
by their surfaces; viewport interest does not make the browser the only copy of
a session and does not require the server to mirror pixel scroll coordinates.
Interest changes freshness priority and permitted derivation cost. It does not
define whether the session exists.

Make a continuing effort to keep the catalog fresh:

- provider/runtime events and exact YA ownership update live rows immediately;
- eligible provider file events update or invalidate the touched row;
- one bounded same-user process inventory at boot, followed by one
  process-wide periodic inventory when needed, detects external harness roots;
- background reconciliation repairs events missed during downtime or watcher
  uncertainty; and
- client interest promotes exact rows and projections for prompt refresh.

Provider storage observation is install-eligible, not directory-discovered.
Runtime aliases that share one native store collapse to one durable catalog
family. Migration uses existing YA session metadata only and performs no native
store probe. A durable completion marker makes that metadata pass a one-time
migration rather than restart work. A newly successful provider boundary
persists the actual session provider and catalog family before Supervisor
registration; persistence failure aborts that process instead of reporting an
untracked success. Repeated writes of an unchanged provider or catalog family
are no-ops.

Native file watchers use the same gate. The listener binds before eligible
watcher activation is queued, never-used families receive no directory
existence check, and families with no file-watcher adapter receive no probe.
The one registry staggers eligible watcher attachment after listener readiness
and owns shutdown teardown. Each attached watcher takes its initial
file-mtime-and-size baseline asynchronously; changes observed during that
baseline win over the baseline snapshot, and a fallback rescan requested
during the build runs once after publication. Direct callbacks and rescans
compare the same `(mtime, size)` fingerprint. A size change with a fixed
`mtime` is a modify; only an identical pair is a duplicate. This is required
on Windows, where an append-only writer may hold a handle open while the
last-write timestamp stays unchanged.

Fallback and periodic tree rescans use asynchronous directory reads and stat
files in bounded batches. One rescan runs per watcher; overlapping requests
coalesce into one trailing fallback pass. Exact file events observed during a
scan own their paths, so a completed snapshot cannot overwrite newer state.
Focused session targets in the same directory share one native watch while
retaining per-target polling and trailing validation. Removing the final target
closes that native watch, and an asynchronous file-resolution result arriving
after the final unsubscribe must not recreate it.

Cache publication follows the same ordering rule as watcher reconciliation.
One mutable discovery or summary index scope has one process-local cold-load
owner, and scans acknowledge only the invalidation revision they observed at
start. A file event that arrives during a scan or summary parse remains pending
even if the older request returns a coherent pre-event result. Derived disk
snapshots publish through serialized atomic replacement; Gemini's durable
project mapping additionally serializes its complete load/mutate/save cycle.

Staleness is nevertheless an allowed state. An old, offscreen, unowned session
may remain at its last durable compact observation until a file/process event,
bounded reconciliation, hover, viewport promotion, or click makes it relevant.
Staleness must be represented by observation/source versions, not hidden by a
fresh HTTP response timestamp.

## One catalog, several fidelity levels

The global catalog stores bounded facts needed for collection membership and
cheap rendering: identity, provider/project mapping, title, recency, metadata,
ownership/liveness hints, and explicitly typed optional projections. It is not
a process-wide transcript store.

Use a disk/RAM hierarchy:

- YA app-data storage holds the durable compact catalog, shard metadata,
  generation lineage, and cold rows needed after restart;
- RAM holds bounded hot rows, query memberships/counts, current indexes,
  in-flight work, and live/interest state under byte and age budgets;
- bounded head/tail projections may be retained with the exact provider source
  version that established them; and
- complete transcript summaries and parsed messages stay in their dedicated
  byte-bounded caches or explicit session-detail path.

A compact collection request must never become permission to populate every
complete-summary field. Absence from an incomplete or unreconciled shard is
unknown, not authoritative nonexistence.

A row's fidelity states what the adapter actually observed, not what its family
could in principle supply. `head` means the provider keeps its own title where
the scan already looks — Grok's `summary.json`, OpenCode's session row.
`identity` means id and times only, which is where pi stays: it has no native
summary, and a title would mean parsing a transcript, which belongs to explicit
per-session work. An adapter must not promote its own rows by doing that parse.

## What a catalog adapter owes the coordinator

An adapter enumerates one native store for the whole install; the coordinator
owns grouping, sharding, and persistence. Three rules keep families joinable:

- **Project membership is a canonical host path**, never the provider's own
  encoding of one. Grok percent-encodes a cwd into a directory name, pi flattens
  separators (lossy, so the path comes from each transcript header's `cwd`), and
  OpenCode hides the worktree behind an opaque project id. Only the decoded path
  joins rows across families, so adapters derive `projectId`/`projectIdentityKey`
  through the shared helper rather than each inventing a key.
- **`sourceVersion` is exact provider identity**, moving on every append,
  truncation, or replacement — a file's mtime and size, or the store's own
  updated timestamp. It is what a retained projection of that row stays valid
  for; a coarser value silently serves stale derived work.
- **Recency may use a narrower provider/platform activity clock.** Plain Codex
  rollouts on Windows use the later of file modification and change time,
  because Windows can defer the last-write timestamp until Codex closes its
  session-long append handle. Other platforms and immutable compressed Codex
  rollouts keep modification time. This activity clock orders compact rows;
  it does not replace `(mtime, size)` as exact content/source identity.
- **Recent mode is a filter on rows, not a cache key.** It is applied before the
  adapter opens anything, so a store outside the window costs no read, and the
  same store scanned in complete mode yields a superset. A later complete pass
  therefore repairs whatever a recent pass skipped, and no range generation
  accumulates per store.

A never-created store is not an error: the adapter reports zero rows, because
eligibility — not directory existence — decides whether a family is scanned at
all.

## Freshness priorities

Scheduling uses these priorities while preserving bounded global progress:

1. **Explicit detail.** A clicked/open session and its live turn receive the
   exact detail work their surface requires.
2. **Live ownership.** YA-owned and exactly recognized external harness
   sessions keep current liveness and compact tail facts without waiting for a
   browser.
3. **Visible interest.** Visible list windows and a specifically requested
   hovercard receive prompt row/projection refresh. Hover opens immediately
   from compact state and fills reserved detail in place.
4. **Global baseline.** Inbox membership, navigation counts, recent/changed
   rows, and uncertain watcher shards reconcile asynchronously so they tend
   toward fresh even without a foreground reader.
5. **Cold history.** Old, offscreen, unowned rows remain durable and may be
   stale until targeted evidence or interest promotes them.

Client interest is a short-lived lease keyed by source plus stable session or
query/window identity. It is debounced and uses overscan/hysteresis rather than
reporting every scroll event. Disconnect, source switch, or TTL expiry releases
it. The server unions identical leases from tabs and devices, so twenty viewers
raise priority once rather than creating twenty refresh loops. Pointer-velocity
and adjacency prefetch remain optional optimizations justified by measured
hover latency, not baseline corpus work.

## Polling and subscription policy

Prefer source events when they are reliable. Polling is appropriate when the
source has no dependable event stream only if it has one process-wide owner,
fixed/bounded cost per pass, explicit cadence and teardown, and changed-result
targeting.

External-session file activity updates ownership promptly. Complete summary
derivation remains lower-priority batched work: equal session keys coalesce for
300 ms, at most five summaries run concurrently, and results publish only
changed fields. Maintenance diagnostics for that batch processor are fixed-cost
snapshots with cumulative queue/outcome counters and the latest 16 timing
events. Scheduling changes require mutation-time foreground evidence; a
headless polling wake-up correlated with a summary event is not such evidence.

A same-user operating-system process inventory satisfies that shape: its cost
is bounded by the host process table, it can be diffed against the prior
snapshot, and only changed recognized harness roots need catalog work. It is a
reasonable backstop for reliable external-session indication.

A periodic sweep of every provider transcript does not satisfy it. No external
or YA-owned process, file event, client interest, or changed source version
means an old session log is not reparsed merely because a timer fired. Provider
catalog enumeration may refresh bounded native metadata, but it must not use
that name/mtime inventory as a reason to parse unchanged cold transcripts.

## Generations and coherent projections

Every durable catalog lineage has a random `catalogEpoch` and a monotonic
`catalogGeneration`. Resetting/rebuilding incompatible catalog state changes
the epoch; restart over valid persisted state preserves it. Durable state is a
cache and must never keep the server from starting: state that cannot be read
or that no longer matches the current shard layout ends its lineage at a fresh
epoch and generation 0, and reconciliation refills it. Each accepted row,
membership, count, and delta identifies the catalog generation and provider
source version from which it was derived.

The global generation is one component of a vector, not the whole clock. Each
shard carries a digest of its rows plus the generation in which that digest
last changed, so a caller holding a shard's generation is unaffected by writes
landing in other shards. Publication compares digests: an unchanged shard keeps
its generation, is never re-read to compute a delta, and lets its retained rows
survive into the new generation. Split the clock further — per projection kind
— only when measurement shows the shard component is too coarse.

Unfiltered, starred, project/search, Inbox, queue-title, hover, and stats
projections read one accepted generation plus ordered overlay deltas. A client
may ask conditionally from its known `(catalogEpoch, catalogGeneration)` and
receive no-change, bounded deltas, or a replacement snapshot. A partial build
never replaces the last complete accepted generation, and a response cannot
mix an absence from a newer incomplete shard into an otherwise older complete
snapshot.

Retain only a byte/time-bounded delta window. A client generation outside that
window receives a compact replacement snapshot; the server does not preserve
an unbounded event history merely to satisfy a very old browser cache. An
unrelated row change may advance the global generation without changing a
given query membership, in which case conditional reconciliation advances the
token with no replacement rows — and where that query maps to one shard, its
shard generation answers no-change without consulting the delta window at all.

### The session-collection generation is a different clock

`GET /api/sessions` has its own revision, in
`packages/server/src/sessions/sessionCollectionGeneration.ts`, and it is
deliberately not the catalog's. The catalog generation covers *rows*; the
global list also renders session metadata, notification read state, supervisor
ownership, external-process tracking, and workstream membership, none of which
the catalog owns. Answering a conditional read from a rows-only clock would
serve a stale star, unread badge, or ownership state while reporting no change
— an error a conditional response makes invisible, which is why the collection
clock advances on any bus event not proven unable to change a rendered row.

The conditional read only helps a client that already holds a generation, so
the collection walk is also single-flighted by `(query, generation)` through
`SourceVersionedSingleFlight`. That covers the cold herd — twenty tabs
reconnecting at once, none holding a token — and it is what keeps the ungated
fallback a performance floor rather than a penalty: a client without
`progressive-session-catalog` cannot send a token, so its repeat reads land on
the retained walk instead of running their own.

`GET /api/inbox` shares that clock for its own walk, which is the same
enumeration over every project. It has no conditional read — that would need
its own gate — so the herd fix is the whole of it there. Inbox retains only the
*walk*: its tiers are wall-clock windows, so tier membership is recomputed per
request. A response whose shape depends on time, or on state the deny-list does
not cover, cannot be retained against this generation.

The client that sends the token is `useGlobalSessionsFeed`, and it does so only
on automatic revalidation. What makes that safe alongside the local patching
this feed does from `session-created` and `session-metadata-changed` is that
those same events advance the collection generation, so a patched client is
told `changed` on its next conditional read and re-reads the rows it guessed
at. A deny-list clock is what buys that: an event nobody thought about still
advances the generation, so the guess is still corrected.

It is also deliberately coarse where the catalog's is a vector: the unfiltered
global list genuinely depends on every project, so a single counter is the
right shape for it. A `project=`-filtered read is the case a vector component
would serve, and it waits for measurement rather than being added
speculatively. Wire contract and the caller's obligations:
[`server-capabilities.md`](server-capabilities.md) § Session-catalog gate.

The global generation orders server catalog publication; it does not replace
field fidelity or provider source versions. A newer compact title observation
still cannot masquerade as a complete transcript summary, and a pending-tool
tail fact is valid only for the file/database version that established it.

## Herd avoidance

All expensive refresh and derivation paths use server-side single-flight
ownership. A work key includes the catalog epoch, session or projection key,
required fidelity, and observed source version. The first caller admits one
asynchronous computation; later requests, events, tabs, devices, and background
reconciliation join it.

Admission and publication take only short state locks. Filesystem/provider work
runs outside the lock. Completion publishes once only if its source version is
still current; otherwise it is discarded or schedules the newest exact work.
Failure clears the in-flight owner, preserves last-known data, and applies one
bounded retry/backoff policy rather than allowing each waiter to retry.

Global concurrency and byte budgets prioritize live/visible work over cold
repair and yield between main-thread units. A slow provider shard cannot make
unrelated catalog reads wait behind one serialized request/transport queue.

### What a cold restart actually costs, measured

Each collection route has its own retention, so two routes reading the same
cold store could plausibly parse every transcript twice. They do not:
`SessionIndexService.getSessionsWithCache` joins in flight per
`(sessionDir, project, options)` and its index answers the second read, so a
fresh browser's opening burst across `GET /api/sessions` and `GET /api/inbox`
parses each transcript exactly once, and a second burst parses nothing. A
filtered read enumerates only the requested project's storage.
`test/routes/cold-start-collection-reads.test.ts` pins all three against the
real service over a real store with no persisted index, which is the actual
cold state rather than a stub of it.

That bounds the restart cost to one parse per transcript, not one per route
per transcript — and names what is left. Removing that remaining parse is what
the durable catalog is for, and it has no production caller, so a restart still
costs the routes a first read of every project.

## Client and browser reuse

Within one tab, retained client queries have one `(sourceKey, queryKey)`
acquisition/revalidation owner. Component count must not multiply event
subscriptions, timers, invalidations, or requests. Query responses retain the
server catalog epoch/generation so later consumers can reuse accepted state or
conditionally reconcile it.

Browser persistence is an optional accelerator, never a correctness
precondition. A source/auth-scoped, schema-versioned compact snapshot may live
in IndexedDB; a small `localStorage`/`BroadcastChannel` notice may advertise the
newest stored generation to sibling tabs. Where supported, Web Locks or a short
lease may elect one same-origin acquisition owner. Unsupported, private,
evicted, or crashed browser storage falls back to ordinary server requests.

Persist no provider transcript, credentials, pending tool arguments, or
unbounded catalog in this layer. Enforce byte/age eviction and revalidate any
restored snapshot against the server epoch/generation. Cross-tab coordination
does not remove server-side single-flight: different browsers/devices and lease
failover can still request the same work concurrently.

An explicit `session-metadata-changed` project transition and a full session
snapshot are authoritative for a known row's working-project membership.
`session-created`, `session-status-changed`, and `process-state-changed` may
seed a project on a row that does not have one yet, but their process launch
project cannot move a known row back after reclassification. Sidebar project
copy resolves the current project name from the project collection by that
authoritative id, so an older name carried by the session row cannot leave a
relocated session visibly grouped under its former project.

## Tests that should fail on contract regressions

- Twenty simultaneous clients requesting one stale projection cause one
  provider/filesystem computation and one catalog publication.
- Unfiltered and starred list requests from several tabs reuse one catalog
  generation and start no provider corpus scans.
- An old offscreen session with unchanged source version performs no periodic
  transcript read; hover or click promotes only that session.
- An unresolved open-session watch uses exact catalog location repair and does
  not enumerate every provider session in its project on a fixed retry loop.
- A process inventory detects a newly launched external harness without
  sweeping unrelated session logs or manufacturing a session-id join.
- Server restart serves the last durable generation, then repairs changed or
  uncertain shards asynchronously without blocking the first list response.
- A never-used provider with an existing native directory receives zero
  directory probes or watcher starts; eligible watcher attachment and baseline
  work begin only after the server listener is ready.
- Missing-filename and periodic rescans never recurse synchronously, overlapping
  rescans produce at most one trailing pass, and a stop during a scan publishes
  neither events nor completed-scan metrics.
- Two focused sessions stored in one directory own one native directory watch;
  removing both subscriptions closes it, including when file resolution
  completes after the final unsubscribe.
- A late computation for an obsolete source version cannot overwrite a newer
  row or mark the newer generation fresh.
- Moving an active session from project A to B updates its sidebar project
  immediately, and a later lifecycle event carrying launch project A cannot
  move it back.
- A write to one project leaves every other shard's generation, retained rows,
  and delta comparison untouched.
- One adapter pass over a provider-global store yields the same rows every
  per-project reader would, grouped by canonical host path, without the store
  being walked once per project.
- A row whose provider directory name encodes a path is still keyed by the
  decoded canonical path, so two families in one project land in one shard.
- A recent-mode pass skips a stale entry before reading it, and a later
  complete pass over the same store still produces that entry.
- Unreadable or layout-incompatible durable catalog state starts a new epoch
  and still serves requests, rather than failing initialization.
- Loss/eviction of browser persistence changes only cold-fetch cost, not visible
  correctness or the ability to reconnect.
