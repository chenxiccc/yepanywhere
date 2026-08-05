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
- [`client-global-store.md`](client-global-store.md)
- [`inbox.md`](inbox.md)
- [`architecture-mandates.md`](architecture-mandates.md)

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
the epoch; restart over valid persisted state preserves it. Each accepted row,
membership, count, and delta identifies the catalog generation and provider
source version from which it was derived.

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
token with no replacement rows.

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
- A late computation for an obsolete source version cannot overwrite a newer
  row or mark the newer generation fresh.
- Loss/eviction of browser persistence changes only cold-fetch cost, not visible
  correctness or the ability to reconnect.
