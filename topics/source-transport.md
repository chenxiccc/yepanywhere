# Source Transport Boundary

> Each client source exposes one stable transport facade for talking to one YA
> server, while preserving visible status for the real channels that back it.

Topic: source-transport

Status: Accepted contract. Implementation slices are tracked in
[`docs/tactical/057-source-transport-boundary.md`](../docs/tactical/057-source-transport-boundary.md).
Read this document before moving session streams, activity streams, remote API
routing, upload routing, or reconnect/readiness state under `YaSourceRuntime`.

## Problem

The client currently has three transport shapes that are all real:

- default localhost mode: same-origin browser requests for normal API calls,
  plus WebSocket channels for subscriptions and some uploads;
- plain multiplex WebSocket mode: one unencrypted `WebSocketConnection` carries
  request/response, uploads, session streams, watch streams, activity, ping,
  and reconnect;
- secure or relay mode: one `SecureConnection` carries the same multiplexed
  operations, adding SRP, encryption, and relay support.

Those shapes grew at different times, so consumers choose transport by reaching
into different globals:

- `api.fetchJSON` checks `getGlobalConnection()` and otherwise uses fetch;
- `useConnection` returns a global secure connection or `directConnection`;
- `useSessionStream`, `useSessionWatchStream`, and `activityBus` choose between
  `getGlobalConnection()` and `getWebSocketConnection()`;
- reconnect/backoff/readiness are exposed through the singleton
  `connectionManager` and `whenConnectionReady`.

That is workable with one current source. It is hard to reason about once a
source runtime owns its own API, streams, activity, summaries, and caches.

## Goal

Introduce an explicit `SourceTransport` contract: the boring, source-bound
facade for "how this browser talks to this YA server."

The facade should make the normal localhost mode fit the same outward shape as
the multiplexed modes, but without inventing false localhost lifecycle
semantics. Localhost source-level readiness is always ready; its stream
WebSocket remains visible as a channel in status/debug snapshots.

## Non-Goals

- Do not remove default localhost HTTP behavior.
- Do not make localhost source-level `reconnect()` secretly reconnect the
  stream WebSocket.
- Do not hide channel state in private objects that cannot be inspected.
- Do not claim two real remote sources can coexist until exercised against real
  servers.
- Do not rework SRP, NaCl, relay pairing, or WebSocket framing as part of this
  boundary.
- **Relocate, do not redesign.** No reconnect, backoff, wake, stale-detection,
  or readiness policy changes ride along with ownership moves. Semantic
  improvements are separate, explicitly flagged slices after parity is proven
  (see the Behavior Parity Contract below).
- Do not make demand-traffic callers gate on readiness before requesting. The
  transport is the single readiness arbiter (see Request Semantics).
- `isRemoteClient()` (build-time flag) stays global. It describes the build,
  not a source, and its polling-gate consumers are out of scope.

## Current Code Facts

- [`WebSocketConnection`](../packages/client/src/lib/connection/WebSocketConnection.ts)
  is a single unencrypted WebSocket transport. It delegates request/response,
  upload, subscription, ping/pong, and reconnect behavior to `RelayProtocol`.
- [`SecureConnection`](../packages/client/src/lib/connection/SecureConnection.ts)
  exposes the same multiplexed surface, with SRP, encryption, session resume,
  and relay support layered around it.
- [`DirectConnection`](../packages/client/src/lib/connection/DirectConnection.ts)
  handles same-origin `fetch`/`fetchBlob` and upload helpers. Its subscription
  methods throw because default localhost subscriptions use the local
  `WebSocketConnection` path.
- [`useConnection`](../packages/client/src/hooks/useConnection.ts) returns a
  global secure connection when present, otherwise `directConnection`.
- [`api.fetchJSON`](../packages/client/src/api/client.ts) routes through the
  global secure connection when present, otherwise same-origin fetch.
- **`SecureConnection` instances are replaced, not reused, across auth
  flows.** `RemoteConnectionContext` constructs a fresh instance for connect,
  stored-session resume, relay connect, and relay re-pair, swapping it into
  `setGlobalConnection` each time. A relay drop can replace the instance with
  no user action. The codebase already absorbs this via a mutable slot: the
  activity bus reconnectFn re-reads `getGlobalConnection()` at call time.
- **Requests self-heal the connection.** Every `RelayProtocol.fetch` first
  awaits `ensureConnected()`: concurrent requests coalesce on one in-flight
  `connectionPromise`, and a request against a dead socket triggers an inline
  reconnect + re-auth (direct: connect + SRP resume; relay: re-pair, throwing
  `RelayReconnectRequiredError` on failure). Requests do not wait for the
  connection manager's backoff timer; they are a parallel recovery driver.
- **The activity bus owns app transport health today.** `ActivityBus.connect()`
  is what calls `connectionManager.start(...)` and supplies the reconnectFn.
  Session/watch stream hooks feed `recordEvent`/`recordHeartbeat`/
  `markConnected`/`handleError` from their own handlers. This layering
  violation and its user-visible failure (stale orange bar while same-transport
  API requests succeed) are documented in
  [`docs/tactical/050-remote-activity-bus-secure-lifecycle.md`](../docs/tactical/050-remote-activity-bus-secure-lifecycle.md);
  the landed fix (`onAuthenticated` → `markConnected`) must be preserved, and
  050's explicitly deferred ownership inversion is delivered by this boundary.
- `RelayProtocol` reaches into the singleton `connectionManager` for
  `beginCriticalOperation` around uploads, as does `api/upload.ts`.
- `fetchJSON` and `DirectConnection.fetch` have drifted: `fetchJSON` sends
  `X-Desktop-Token`; `DirectConnection.fetch` does not. The localhost transport
  must match `fetchJSON` behavior and should absorb the drift.

## Proposed Interface

Names are intentionally low-level. This is transport plumbing, not a rich
domain client.

```ts
type SourceTransportKind = "localhost" | "websocket" | "secure";

interface SourceTransport {
  /**
   * Diagnostics and status display only. Feature code must never branch on
   * kind; branch on `capabilities` instead. Branching on kind reintroduces
   * the mode leakage this boundary removes.
   */
  readonly kind: SourceTransportKind;
  readonly status: SourceTransportStatus;
  readonly capabilities: SourceTransportCapabilities;

  fetch<T>(path: string, init?: RequestInit): Promise<T>;
  fetchBlob(path: string): Promise<Blob>;
  upload(
    projectId: string,
    sessionId: string,
    file: File,
    options?: UploadOptions,
  ): Promise<UploadedFile>;
  uploadStagedAttachment(
    file: File,
    options?: UploadOptions & { batchId?: string },
  ): Promise<StagedAttachmentRef>;

  subscribeSession(
    sessionId: string,
    handlers: StreamHandlers,
    lastEventId?: string,
    options?: SessionSubscriptionOptions,
  ): Subscription;
  subscribeSessionWatch(
    sessionId: string,
    handlers: StreamHandlers,
    options?: { projectId?: string; provider?: string },
  ): Subscription;
  subscribeActivity(handlers: StreamHandlers): Subscription;

  /**
   * Source-level reconnect (an action, so it lives here, not on status).
   * For localhost this is a no-op because the source is same-origin HTTP and
   * has no source connection to re-establish.
   */
  reconnect(): Promise<void>;

  /**
   * Release channels this transport instance created. A transport must never
   * close channels it merely borrowed. Disposing a transport with an attached
   * backing connection detaches and closes it.
   */
  dispose(): void;
}

interface SourceTransportCapabilities {
  /**
   * True when same-origin URLs (e.g. <img src="/api/...">) reach this
   * source. Localhost and plain-WebSocket sources are same-origin; the static
   * remote client is not. Media consumers branch on this, never on kind.
   */
  sameOriginUrls: boolean;
  /** Emulator signaling channel; absent when the mode cannot carry it. */
  device?: DeviceSignalingChannel;
  /** Dedicated speech socket; absent when the mode cannot carry it. */
  speech?: SpeechChannelFactory;
}

interface DeviceSignalingChannel {
  send(msg: RemoteClientMessage): void | Promise<void>;
  onMessage(handler: (msg: DeviceServerMessage) => void): () => void;
}

interface SpeechChannelFactory {
  open(): Promise<ConnectionSpeechSocket>;
}
```

Status is deliberately visible and inspectable, and purely observational —
`reconnect()` moved to the transport root:

```ts
type SourceTransportState =
  | "ready"
  | "connecting"
  | "reconnecting"
  | "disconnected";

interface SourceTransportStatus {
  getSnapshot(): SourceTransportStatusSnapshot;

  /**
   * Fires when either the source state or any channel snapshot changes.
   * Localhost can therefore stay source-ready while still publishing stream
   * WebSocket state changes for diagnostics or stream-specific consumers.
   */
  subscribe(listener: () => void): () => void;

  /**
   * Fires when the transport's health manager observes a connected tab
   * becoming visible. Activity refresh listeners use this to refresh in
   * parallel with the wake ping/pong check.
   */
  subscribeVisibilityRestored?(listener: () => void): () => void;
}

interface SourceTransportStatusSnapshot {
  kind: SourceTransportKind;
  state: SourceTransportState;
  channels: SourceTransportChannelSnapshot[];
}

type SourceTransportChannelName =
  | "same-origin-http"
  | "upload-websocket"
  | "stream-websocket"
  | "multiplex-websocket"
  | "secure-websocket"
  | "relay";

type SourceTransportChannelState =
  | "stateless"
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "unsupported";

interface SourceTransportChannelSnapshot {
  name: SourceTransportChannelName;
  state: SourceTransportChannelState;
  activeSubscriptions?: number;
  reconnectAttempts?: number;
  lastError?: string;
}
```

The source-level state answers "can this source be addressed?" Channel
snapshots answer "what is really happening underneath?" They are not private
diagnostics; they are part of the type-level contract for debuggability.
`subscribe` covers the whole snapshot, not only the source-level state.

## Backing Connection Slot

The facade is **stable per source**; the backing connection is **replaceable**.

`RemoteConnectionContext` constructs a fresh `SecureConnection` per connect,
resume, and relay re-pair. If transport identity equaled connection identity,
every re-auth would invalidate `runtime.transport` for every consumer. Instead,
the multiplex transports own a connection slot:

- `SecureSourceTransport.attach(conn: SecureConnection)` /
  `WebSocketSourceTransport.attach(conn: WebSocketConnection)` install or
  replace the backing connection; `detach(reason?)` empties the slot.
- `attach`/`detach` are wiring APIs for connection-establishment flows only.
  They are methods on the concrete classes, not part of `SourceTransport`;
  feature consumers never see them.
- While the slot is empty, source state is `disconnected` and demand fetches
  wait bounded (see Request Semantics). Subscriptions made through the facade
  before/across a swap are reconciled by the managed-stream layer, not by the
  facade re-routing live subscriptions.
- Construction: the source runtime registry mints one facade per source key.
  Because source keys are opaque, the registry must not parse keys to decide
  transport kind — the code that mints a key (route binding, connection flows)
  supplies the transport construction inputs alongside it.
- Login/pairing/SRP orchestration stays where it is. The context keeps
  building `SecureConnection`s exactly as today and attaches them, instead of
  (during migration: in addition to) calling `setGlobalConnection`.

## Source State Mapping

`ConnectionManager` has no "connecting" state (initial-connection progress
lives in React state today), so the facade synthesizes the mapping. Do not
improvise a different one:

| Slot / manager condition                              | Source state   |
| ----------------------------------------------------- | -------------- |
| No backing connection attached (never, or detached)   | `disconnected` |
| Attach accepted, first connect/auth in flight         | `connecting`   |
| Manager state `reconnecting`                          | `reconnecting` |
| Manager state `connected`                             | `ready`        |
| Manager state `disconnected` (gave up / non-retryable)| `disconnected` |
| Localhost, always                                     | `ready`        |

## Request Semantics When Not Ready

The contract splits by traffic type. The transport is the single readiness
arbiter for demand traffic; callers only opt *optional* work out.

- **Demand traffic** (user navigated, tapped, or mounted a screen): call
  `fetch` unconditionally.
  - Backing connection attached and manager ready or reconnecting: the facade
    delegates verbatim to the backing `fetch`, preserving request coalescing on
    the in-flight connect promise and request-driven inline recovery.
  - Backing connection attached but manager terminally `disconnected`: the
    facade rejects immediately with a typed, non-retryable disconnected error
    instead of entering lower transport timeouts.
  - Slot empty (initial connect, teardown, instance being replaced): the
    facade waits bounded (default 15s, matching `whenConnectionReady`) for an
    attach, then delegates; otherwise rejects with a typed, retryable
    not-ready error. This is `whenConnectionReady` made per-source; the
    global waiter is deleted once callers migrate.
- **Elective traffic** (pollers, prefetch, log flushing): gate on
  `transport.status` and pause while not ready, rather than queueing work.
  `ClientLogCollector` already follows this pattern against the singleton
  manager and generalizes to per-source status.
- **UI affordances** (offline banners, composer state, connection bar): read
  `transport.status`. The global diagnostic bar is exceptional-state-only:
  ready renders no full-width success rule, while reconnecting and disconnected
  remain visible. Users see offline-ness; the plumbing does not reject work it
  could complete in under a second.
- **Subscriptions** while not ready: raw `subscribe*` delivers an async
  `onError` (retryable classification). The managed-stream layer is what
  waits for readiness and installs the subscription; raw primitives stay
  dumb.

Why not gate all callers on readiness: it redistributes transport-state
awareness to every call site, each gated caller then needs its own
refire-on-ready loop (the pre-021 mount-race bug class), the reconnect burst
happens at the ready flip regardless, and it forfeits request-driven recovery
(user action would no longer accelerate reconnection during backoff).

## Health And Recovery Ownership

Each multiplex transport owns a **private `ConnectionManager` instance**. The
manager class and all of its policy — backoff curve, attempt cap, ping/pong,
45s stale detection, visibility handling, critical-operation suppression — are
reused unchanged. What moves is the wiring:

- The transport feeds its own manager from protocol-level traffic (an inbound
  frame/event hook on `RelayProtocol`), not from consumer handlers. Today
  health signals flow only through whichever stream hooks happen to be
  mounted; after the move, consumers never call
  `recordEvent`/`recordHeartbeat`/`markConnected`/`handleError`.
- `sendPing`/`receivePong` wiring is internal to the transport.
- `beginCriticalOperation` is injected into `RelayProtocol` and the localhost
  upload path by the owning transport, replacing singleton reach-ups.
- The backing connection's `onAuthenticated`/`onDisconnect` callbacks route to
  the **owning transport's** manager — preserving the 050 fix (out-of-band
  fetch-driven recovery marks the manager connected and cancels the stale,
  destructive backoff reconnect). The nested speech-socket connection must not
  touch any manager (see 050).
- The activity bus stops starting the manager and stops owning the
  reconnectFn. This is 050's deferred ownership inversion, delivered.
- On tab-visible, each attached transport health-checks its own socket. When
  more than one live runtime exists later, suspended (non-current) sources
  skip the wake ping — the suspension policy in the topology topic plugs in
  here.

## Managed Streams

One shared helper above the interface — not resubscription magic inside each
transport implementation, and not three bespoke per-hook copies.

`useSessionStream`, `useSessionWatchStream`, and the activity bus each
hand-roll the same ~80 lines: staleness guards, resubscribe on manager
`stateChange`, `lastEventId` resume, non-retryable terminal handling,
teardown-once semantics. A single `createManagedStream(transport, spec)`
helper owns, once:

- wait-for-ready before first subscribe; resubscribe on ready transitions and
  across backing-connection swaps;
- `lastEventId` capture and resume;
- non-retryable errors terminal, surfaced as stream state;
- teardown exactly once; stale-handler and StrictMode double-mount guards;
- **subscription retry over a healthy transport without transport teardown**
  (050's other deferred item): a subscription-level failure retries the
  subscription with its own small backoff instead of escalating to a full
  transport reconnect. Transport-level failures still flow to the manager via
  the transport's own health feed.

Raw `subscribe*` primitives on the transport stay dumb and return a plain
`Subscription`, so fakes remain trivial.

## Activity Stream Lifecycle

Generalizing the 050 product invariant from "the remote app" to any source:

> For a source runtime with a mounted activity lease: transport `ready`
> implies the source's activity subscription is installed or actively
> converging. Backing-connection swaps, reconnects, and out-of-band recoveries
> converge the subscription without app-level re-wiring.

- The existing `runtime.summary` retain/release leases remain the demand
  signal. The app shell holds a lease for the current source whenever the UI
  is up, so "secure connection established ⇒ activity stream up" falls out of
  lease + ready, encoded in one place instead of React mount timing against a
  mutable global.
- The compatibility `activityBus` facade still owns process-wide `on()` fanout
  for current-source consumers during migration, while source summary reducers
  subscribe to source-keyed fanout from the same retained stream.
- Local and remote follow the identical rule; they differ only in when the
  lease is held. Local gates the lease on auth state (the 401-avoidance in
  `useActivityBusConnection`); the remote shell holds it whenever mounted
  (its gate guarantees auth).
- A retained document suspends its activity streams on `pagehide`, closing the
  raw subscriptions before navigation, discard, or browser caching can leave
  a logical tab registered. If that same document returns through `pageshow`,
  each still-retained source installs one fresh managed stream. The lease
  counts survive suspension; the underlying subscriptions do not.
- `SecureConnection` itself never auto-subscribes to activity (050 non-goal
  stands); the runtime layer owns the invariant.
- Suspension of non-current sources is expressed by releasing or downgrading
  the lease, per the topology topic's resource policy.

## Behavior Parity Contract

The bespoke signals in the current code encode real, user-visible policy —
mobile wake, backoff, coalescing — that must survive relocation. Every row
below is pinned by a test that runs against the facade before any consumer
migrates. **A row may only change with an explicit decision recorded in this
document**, never as a side effect of a move.

| # | Behavior | Mechanism today | Pinned by |
|---|----------|-----------------|-----------|
| 1 | Wake ping/pong: tab-visible sends ping, 2s pong timeout forces reconnect; suppressed during critical ops | `ConnectionManager._handleBecameVisible` | `ConnectionManager.test.ts` |
| 2 | Data refresh fires in parallel with the wake health check, not behind it | `visibilityRestored` event before ping resolution; bus refresh events | `ConnectionManager.integration.test.ts` |
| 3 | Stale detection: 45s without events (heartbeat-gated), 10s check cadence | `_checkStale` | `ConnectionManager.test.ts` |
| 4 | Backoff: 1s base, ×2 per attempt, 0.3 jitter, 30s cap, 10 attempts, then `disconnected` + `reconnectFailed` | `_scheduleReconnect` | `ConnectionManager.test.ts` |
| 5 | Non-retryable errors terminal: close 4001/4003, subscription 4xx, terminal relay causes | `isNonRetryableError` | connection type tests |
| 6 | Reconnect dedup: one in-flight reconnect; superseded outcomes ignored | `_reconnectPromise` guard | `ConnectionManager.test.ts` |
| 7 | Concurrent requests coalesce on one in-flight connect | `ensureConnected` / `connectionPromise` | new parity test |
| 8 | Request-driven recovery: fetch on a dead socket triggers inline reconnect + re-auth, independent of backoff timing | `RelayProtocol.fetch` → `ensureConnected` | new parity test |
| 9 | Out-of-band recovery visible to manager: auth success marks connected, cancels stale backoff (no destructive reconnect of a healthy socket) | `onAuthenticated` → `markConnected` (050 fix) | `ConnectionManager.test.ts` |
| 10 | Detached window: demand fetch waits bounded 15s, then typed rejection | `whenConnectionReady` → facade slot wait | `whenConnectionReady.test.ts`, ported |
| 11 | Uploads suppress health-check reconnects | `beginCriticalOperation` | `ConnectionManager.test.ts` |
| 12 | Relay re-pair replaces the backing connection; consumers keep working through the same facade | context flows + slot | `ReconnectSubscriptions.test.ts` + new slot test |
| 13 | Session/watch resubscribe resumes from `lastEventId` | hooks (moves to managed stream) | `ReconnectSubscriptions.test.ts` |
| 14 | Teardown exactly once; late handler fire from a replaced subscription cannot clear the new one; StrictMode double-mount safe | hook guards (move to managed stream) | hook tests |
| 15 | Activity resubscribes on connected transition; connect is idempotent | `ActivityBus` stateChange listener (moves to managed stream) | `ReconnectSubscriptions.test.ts` |
| 16 | `forceReconnect()` overlapping an in-flight `ensureConnected()` joins the in-flight recovery before deciding whether forced teardown is still needed | `SecureConnection.forceReconnect()` serialization | `SecureConnection.compatibility.test.ts` |
| 17 | Terminal disconnected demand traffic fails fast without blocking reconnecting or empty-slot behavior | multiplex facade demand guard | `MultiplexSourceTransport.test.ts` |
| 18 | Same-server API redirects remain fetch-compatible through relay: `Location` is forwarded and followed within `/api`; missing, external, or excessive redirect chains fail instead of returning a null success body | `ws-relay-handlers` + `RelayProtocol.fetch` | `ws-relay-request-concurrency.test.ts`, `RelayProtocol.hooks.test.ts` |

Explicitly deferred semantic improvements (each its own future slice, opted
into deliberately): per-source auth-required signaling replacing the global
`authEvents` broadcast; transport-owned `lastEventId` tracking.

## Mode Semantics

### Default Localhost Transport

`LocalhostSourceTransport` is the primary local mode.

- `fetch`/`fetchBlob` call same-origin browser fetch with `fetchJSON`-parity
  behavior (desktop token header, 401 → login-required signal,
  `X-Setup-Required`). The drifted `DirectConnection.fetch` is absorbed.
- uploads use the existing upload helper path, with the critical-operation
  guard pointed at this transport's manager.
- `subscribeSession`, `subscribeSessionWatch`, and `subscribeActivity` use a
  **privately owned** `WebSocketConnection` instance (not the process
  singleton), with a private manager for that stream channel.
- `status.getSnapshot().state` is always `ready`; `reconnect()` is a no-op.
- channels include `same-origin-http` as `stateless`, the stream WebSocket
  with its real observable state, and `upload-websocket` reported ephemerally
  (present with an active count while uploads run; no long-lived bookkeeping).
- `capabilities.sameOriginUrls = true`; `device` present via the stream
  WebSocket.

At most one localhost source can exist per app: same-origin fetch is pinned to
`window.location`. This asymmetry is by construction — multi-source means one
optional localhost source plus N websocket/secure sources — and it collapses
the dispose questions the old singletons would otherwise raise.

### Plain Multiplex WebSocket Transport

`WebSocketSourceTransport` wraps one attached `WebSocketConnection` at a time.

- `fetch`, uploads, session streams, watch streams, activity, ping/pong, and
  reconnect all use the same unencrypted WebSocket.
- `reconnect()` delegates to `WebSocketConnection.reconnect()` through the
  manager.
- the channel snapshot exposes one `multiplex-websocket` channel.
- `capabilities.sameOriginUrls` is true only when the WS URL is same-origin.

This is the unencrypted sibling of secure mode, not a variant of the localhost
composite path. It is also the cheapest real second source for coexistence
testing: a second local server (`PORT`/`YEP_PROFILE`) reachable at
`ws://localhost:<port>/api/ws` with no relay or SRP setup.

### Secure Or Relay Transport

`SecureSourceTransport` wraps the source's current `SecureConnection` via the
slot.

- `fetch`, uploads, session streams, watch streams, activity, ping/pong, and
  reconnect all use the attached secure connection.
- `reconnect()` delegates to `SecureConnection.forceReconnect()` through the
  manager.
- relay re-pair failures (`RelayReconnectRequiredError`) still surface to the
  connection-flow owner, which builds and attaches a replacement connection;
  the facade and its consumers are unaffected.
- the channel snapshot exposes `secure-websocket`, plus relay details when the
  connection is relay-backed.
- `capabilities.sameOriginUrls = false`; `speech` and `device` present.

## Relationship To ConnectionManager

`ConnectionManager` remains the reconnect/backoff state machine, unchanged in
policy, but instantiated **per transport** and never exported as an app
singleton. It is an implementation detail used by transport implementations
and surfaced through `SourceTransportStatus` and channel snapshots.

Callers stop importing the singleton `connectionManager` for source-owned
work. They observe `runtime.transport.status` instead. The status surface
exposes reconnect attempts, state, and errors without forcing callers to know
which concrete manager instance exists underneath.

## Runtime Placement

`YaSourceRuntime` carries one transport:

```ts
interface YaSourceRuntime {
  sourceKey: ClientSummarySourceKey;
  transport: SourceTransport;
  api: SourceApiClient;
  summary: SourceSummaryRuntime;
  sessionDetails: SessionDetailRuntime;
}
```

The existing narrow `SourceApiClient` remains as a session-detail-facing
subset while the broader transport boundary lands; over time it delegates to
`runtime.transport.fetch`. The registry mints facades; connection flows attach
backing connections; `fetchJSON` becomes a compatibility shim over the current
runtime's transport until callers migrate.

## Validation

- Unit-test the three transport implementations with fake underlying
  connections.
- Run the Behavior Parity Contract suite against the facade before any
  consumer migrates; every row above maps to a test.
- Prove localhost source status is ready and `reconnect()` is a no-op, while
  channel snapshots still expose stream/upload channel state and snapshot
  subscribers can observe channel changes.
- Prove plain multiplex WebSocket and secure transport both route fetch,
  uploads, activity, session streams, watch streams, ping/pong, and reconnect
  through one backing connection, and that attaching a replacement backing
  connection preserves facade identity and converges managed streams.
- Reproduce the 050 divergence in simulation (fetch-driven recovery during
  manager backoff) and assert the bar/state converges and no destructive
  reconnect fires.
- Add hook tests with two fake source runtimes: reconnect/status changes in
  one runtime must not resubscribe or clear subscriptions in the other.
- Preserve teardown behavior: closing a tab/component releases the session or
  watch subscription exactly once.
- Prove `pagehide` closes every retained activity subscription, `pageshow`
  recreates one per retained source, and repeated reloads never raise the
  server tab count above the actual document count.
- Preserve non-retryable subscription-error behavior.
- Before claiming real coexistence support, run two YA servers with
  independent transports and show that disposing one source does not affect
  the other.

## Resolved Questions

- **Channel-control methods on status?** No. Source-level `reconnect()` plus
  channel snapshots are the surface; add channel control only when a real
  consumer appears.
- **Managed subscriptions inside the transport?** Above it: one shared
  managed-stream helper over (`subscribe*`, `status`). Raw primitives stay
  dumb; implementations stay simple; the resubscribe engine exists exactly
  once.
- **Localhost upload-channel bookkeeping?** Ephemeral: the `upload-websocket`
  channel appears with an active-upload count while uploads run, `idle`/absent
  otherwise. No long-lived per-upload state.
- **Where does "secure connection implies activity bus" live?** In the source
  runtime layer as lease + ready convergence (see Activity Stream Lifecycle),
  not inside `SecureConnection` and not in React mount timing.

## Relationship To Existing Documents

- [`client-source-runtime-topology.md`](client-source-runtime-topology.md) is
  the parent topology vision; this document is its transport boundary.
- [`docs/tactical/057-source-transport-boundary.md`](../docs/tactical/057-source-transport-boundary.md)
  is the implementation runbook for this contract.
- [`docs/tactical/050-remote-activity-bus-secure-lifecycle.md`](../docs/tactical/050-remote-activity-bus-secure-lifecycle.md)
  documents the activity/transport lifecycle divergence, the landed
  `onAuthenticated` fix (parity row 9), and the deferred ownership inversion
  this boundary delivers.
- [`docs/tactical/021-client-connection-readiness-vs-state-consistency.md`](../docs/tactical/021-client-connection-readiness-vs-state-consistency.md)
  explains the bounded-wait readiness behavior preserved by parity row 10.
- [`docs/project/connection-matrix.md`](../docs/project/connection-matrix.md)
  explains the historical transport modes these implementations wrap.
- [`docs/project/ws-auth-state-model.md`](../docs/project/ws-auth-state-model.md)
  and [`docs/project/relay-design.md`](../docs/project/relay-design.md) remain
  the detailed auth/relay transport references.
