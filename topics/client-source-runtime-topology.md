# Client Source Runtime Topology

> YA client state should be organized around explicit source runtimes: one
> runtime per YA server/source, each owning its transport, source-scoped stores,
> activity feed, and session-detail lifecycle services without relying on a
> hidden global "current source".

Topic: client-source-runtime-topology

Status: Vision. Use this document before reshaping client source selection,
remote/direct API access, client summary store ownership, session-detail cache
ownership, or the `useSessionMessages` lifecycle. The tactical implementation
plan starts in
[`docs/tactical/051-client-source-runtime-topology.md`](../docs/tactical/051-client-source-runtime-topology.md).

## Problem

The client has been moving from scattered hook-local state and hidden globals
toward explicit stores. The session-detail work already replaced a
`globalThis` route-snapshot cache and random transcript mirrors with a
source-keyed detail cache, reducer, and per-entry store. That was the right
direction, but the next architectural boundary is one layer higher.

Many client subsystems still assume there is one current source for the app:

- `clientSummaryStore` has per-source stores, but also a module-level current
  source key;
- remote mode uses a global connection for ordinary API calls;
- hooks such as `useSessionMessages` derive the source from ambient context
  rather than receiving an explicit source runtime;
- session-detail loading, warm reveal, cache write/delete, and stream buffering
  are coordinated inside a React hook rather than a normal runtime object;
- source-scoped caches and retained queries are keyed correctly in many places,
  but their ownership is not visible as one source-level object.

That shape is workable while the UI shows one source at a time. It becomes
harder to reason about if a page ever renders sessions from more than one YA
server, or if a future persistence adapter needs to know which source/auth
scope owns a cached snapshot.

The goal is not to ship a multi-host UI immediately. The goal is to make the
architecture honest enough that two YA source runtimes could exist in one app
without state, transport, cache, or activity-feed collisions.

## Target Shape

The desired topology is:

```text
App / route shell
  -> SourceRuntimeRegistry
    -> YaSourceRuntime per YA server/source
      -> SourceTransport
      -> client summary/query stores
      -> session detail runtime
        -> SessionDetailMemoryCache
          -> SessionDetailEntry
            -> SessionDetailEntryStore
        -> SessionDetailCoordinator per mounted session window
```

### YaSourceRuntime

`YaSourceRuntime` is the explicit owner of one YA server/source from the
client's point of view. It should carry:

- `sourceKey`, the stable source identity used in caches and UI state;
- a source transport bound to that source, including API calls, uploads,
  streams, activity, and visible status/debug snapshots;
- per-session live stream subscriptions (session stream, watch stream), which
  today read the global connection directly;
- connection readiness, reconnect, and backoff state for that source's
  transport, which today live in process-wide singletons;
- per-source auth state, so one host's expired login does not present as an
  app-wide login-required condition;
- source-scoped summary/query stores, including provider runtime status;
- source-scoped route-retention and session-detail services;
- source-scoped clear/dispose behavior for auth changes, disconnects, or host
  removal. This is new behavior: today host switching swaps the current source
  key and abandons the previous source's stores in memory rather than clearing
  them.

The runtime is the boundary between "this client source" and the rest of the
app. Code consuming session data should not need to know whether the source is
local, direct remote, relay remote, or a future embedded host.

### Source Identity Versus Connection Route

Today's source keys are connection-route identities, not server identities:
`host:<savedHostId>` binds to one saved-host record with a single
relay-or-direct mode, and `direct:<normalizedWsUrl>` binds to one URL string.
The same YA server reachable both directly and through the relay therefore
resolves to two different source keys. Under this topology that would become
two runtimes with disjoint session-detail caches, split unread/summary state,
and duplicate activity subscriptions — and a direct-to-relay failover would
lose every source-scoped cache because the key changes.

Before the runtime interfaces freeze, this design must decide what a source
is:

- **Source = saved connection route (status quo):** simplest, but the
  transport mode leaks into cache identity, contradicting the goal that
  consumers not know how a source is reached.
- **Source = logical YA server:** one runtime may own multiple transports
  (direct preferred, relay fallback) behind one `SourceApiClient`, and caches,
  unread state, and activity survive transport failover.

The second shape is the honest one for this document's goals, but it needs a
server identity that is stable across routes (for example a server-generated
instance id surfaced during auth/pairing), which does not exist yet. The
tactical plan may proceed with route-scoped keys, provided no new interface
treats a route-scoped key as a server identity.

The concept has a thin code seam already:
`packages/client/src/lib/sourceIdentity.ts` is the single place that answers
"what is a source's identity," and `SavedHost.serverInstanceId` is the field
a future auth/pairing flow would populate. When present, identity resolves to
`server:<instanceId>` and survives transport failover; nothing populates it
yet, so all keys remain route-scoped in practice.

### SourceRuntimeRegistry

The registry owns construction, lookup, and disposal of `YaSourceRuntime`
instances. The current route-driven source selection can remain a consumer of
the registry:

```text
current route / selected host -> current YaSourceRuntime
```

but the registry model should not require exactly one runtime to exist. A
future tabbed source sidebar or merged inbox should be able to ask for more
than one runtime.

### SourceTransport

The source transport is the transport-facing contract used by data and stream
code. It should expose YA API operations, uploads, subscriptions, activity, and
visible connection/channel status for one source without consulting a global
connection. Its implementation may wrap:

- ordinary local HTTP fetches;
- local WebSocket subscriptions for default localhost mode;
- plain multiplexed `WebSocketConnection`;
- direct remote `SecureConnection`;
- relay-backed `SecureConnection`;
- test or embedded transports.

The concrete boundary is proposed in
[`source-transport.md`](source-transport.md). Relay, SRP, NaCl, reconnect, and
WebSocket framing remain transport-layer details, but status and channel
snapshots should remain visible for debugging. Session-detail code may continue
to depend on a narrower API subset while the broader source transport lands.

### SessionDetailRuntime

Session-detail services should be nested under a source runtime because every
session-detail key is source-scoped. This runtime contains:

- the synchronous memory cache for retained session windows;
- optional async snapshot persistence later;
- coordinator factories for session windows;
- source-scoped retention stats and clear behavior.

This keeps the lower
[`session-detail-data-layer`](session-detail-data-layer.md) focused on
canonical transcript state and render selection, while this topic owns the
source/runtime layer above it.

### SessionDetailCoordinator

A `SessionDetailCoordinator` owns the lifecycle for one mounted session window:

```text
sourceKey + projectId + sessionId + tailTurns/tailFrom
```

It coordinates:

- retain/release of the memory cache entry;
- warm snapshot read and reveal;
- initial REST load;
- delta refresh after a retained cursor;
- stream buffering until initial reveal;
- catch-up and older-page requests;
- snapshot write/delete on release;
- load/progress state;
- action methods consumed by the React page.

The coordinator is a normal TypeScript object/state machine. A React hook may
bind it to component lifetime and subscribe to its view, but the protocol
should be understandable and testable without mounting React.

### SessionDetailMemoryCache

The memory cache is the synchronous hot path for immediate route return. It
owns keyed entries, TTL, byte budget, LRU eviction, mounted retain counts,
stats, and source-scoped clearing.

It should not own transport or REST loading. It may optionally call a
persistence adapter later, but the core contract stays:

- sync memory read for instant warm reveal;
- async persistence only as a seed after reload/reopen;
- server refresh remains authoritative.

### SessionDetailEntryStore

The entry store is the lower data store for one source/project/session/window.
It owns reducer state, selected subscriptions, and notification equality. It
does not own source lookup, transport, cache budgets, persistence, or React
lifecycle.

## Current UI Compatibility

The existing UI can keep using one current source at a time:

- route binding resolves the current source;
- current pages read the current runtime;
- host switching remains the visible remote-client flow;
- existing source-keyed caches continue to isolate data.

The architecture should still stop treating "current source" as the only
possible source. Current-source helpers become convenience APIs over a runtime
registry, not the root model.

## Multi-Host UI Direction

Rendering multiple YA servers side by side is desirable, but it is not the
first implementation milestone. The data topology should make it possible; the
UI contract can come later.

Likely UI shapes:

- **Tabbed source sidebar:** each host/source keeps familiar first-party-like
  navigation and session lists, with explicit source tabs.
- **Merged inbox:** pending-input and attention surfaces can combine multiple
  sources comparatively easily, as long as rows show source identity.
- **Merged global sessions/projects:** possible, but product-heavy. Sorting,
  duplicate project names, unread state, provider availability, archive/star
  behavior, and source badges all become user-visible choices.

The first architectural bar is simpler: no subsystem should make side-by-side
sources impossible by hiding source or connection identity in a singleton.

The first concrete product/E2E probe is now planned in
[`docs/tactical/066-multi-host-monitor-coexistence-harness.md`](../docs/tactical/066-multi-host-monitor-coexistence-harness.md):
a hidden/default-off monitor backed by three real secure relay sources. It must
first pass over today's independent relay sockets. A later relay mux may reduce
the client-side socket count, but it is an optional transport optimization and
must preserve the independent-socket fallback.

## Concurrent Runtime Cost

This is a mobile-first client. Every live remote runtime is a WebSocket, a
ping loop, and an activity stream, and every session-detail memory cache
carries a byte budget. Before more than one runtime is ever live at once, the
topology needs an explicit resource policy:

- non-current runtimes should be suspendable — activity paused or downgraded —
  rather than always-on;
- session-detail byte budgets should be one shared pool across runtimes, not
  one full budget per source, or total memory scales with source count;
- the relay must tolerate multiple concurrent `SecureConnection`s from one
  client, which has not been exercised.

## Persistence Compatibility

IndexedDB or other browser persistence should be a source-scoped snapshot
adapter, not a replacement for the live entry store.

Future persistence should store versioned, serializable snapshots:

- schema/cache version;
- source/auth scope;
- project id and YA-visible session id;
- tail/window params;
- session metadata;
- transcript window and pagination;
- retained cursor/watermark;
- timestamps and approximate byte charge.

The persistence adapter is async. It can seed the memory cache on reload or
host revisit, but the coordinator must still revalidate through the source API.
Persisted transcript cache changes privacy and staleness behavior, so it should
remain configurable and default-off unless a later product decision promotes
it.

## Invariants

- Source identity is explicit at every stateful boundary.
- Source runtimes can coexist without sharing transport, activity, summary
  store, retained query, route retention, or session-detail cache state.
- Session-detail entry keys remain source/project/session/window scoped until a
  separate canonical-per-session design deliberately changes that.
- The memory cache remains synchronous for instant reveal.
- Async persistence is an adapter behind source-scoped cache policy, never the
  canonical live store.
- React hooks bind runtime objects to component lifetime and expose selected
  state; they should not be the only place where session-detail protocol logic
  lives.
- Transport internals remain behind a source transport contract with explicit
  source status and channel snapshots.
- Coexistence claims are exercised, not merely typed: if the architecture says
  two runtimes can coexist, some test or development surface actually runs two
  against real servers before the claim is recorded as supported.

## Non-Goals

- Do not implement multi-host UI as part of the first topology cleanup.
- Do not merge default, `tailTurns`, and `tailFrom` session windows into one
  canonical session store in this pass.
- Do not move token-sized streaming DOM patches into broad React state.
- Do not persist session transcripts by default.
- Do not rework SRP, NaCl, relay pairing, or reconnect semantics merely to
  introduce source runtimes.
- Do not rename every existing source-keyed helper in one churn-heavy pass.

## Relationship To Existing Documents

- [`session-detail-data-layer.md`](session-detail-data-layer.md) remains the
  lower transcript/reducer/render architecture. This topic sits above it.
- [`client-global-store.md`](client-global-store.md) covers normalized summary
  state and deliberately excludes heavy transcript state. Source runtimes should
  own or reference those per-source summary stores.
- [`client-route-retention.md`](client-route-retention.md) covers retained
  route data. Source runtimes should be the natural owner of source-scoped
  retention policy.
- [`source-transport.md`](source-transport.md) defines the proposed
  source-level transport facade and the localhost / plain WebSocket / secure
  mode semantics.
- [`docs/project/connection-matrix.md`](../docs/project/connection-matrix.md)
  explains the historical transport modes that `SourceTransport`
  implementations can wrap.
- [`docs/project/ws-auth-state-model.md`](../docs/project/ws-auth-state-model.md)
  and [`docs/project/relay-design.md`](../docs/project/relay-design.md)
  remain the detailed auth/relay transport references.
