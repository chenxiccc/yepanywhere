# Client Source Runtime Topology

Topic: client-source-runtime-topology

Status: Draft tactical plan. This follows the architectural vision in
[`topics/client-source-runtime-topology.md`](../../topics/client-source-runtime-topology.md)
and the transport-boundary proposal in
[`topics/source-transport.md`](../../topics/source-transport.md),
and builds on the completed session-detail boundary work in
[`046-session-detail-store-boundary-refactor.md`](046-session-detail-store-boundary-refactor.md).

## Goal

Move the client toward explicit source runtimes and session-detail
coordinators without changing ordinary single-source behavior.

The target shape is:

```text
SourceRuntimeRegistry
  YaSourceRuntime
    SourceTransport
    client summary/query stores
    SessionDetailRuntime
      SessionDetailMemoryCache
      SessionDetailCoordinator
        SessionDetailEntryStore
```

The first implementation should make the architecture true enough that two
`YaSourceRuntime` instances could coexist in one React app, even if the product
UI still exposes one current source at a time.

## Current Constraints

This plan starts from the current post-refactor state:

- `defaultSessionDetailMemoryCache` is the public module singleton facade over
  an explicit `SessionDetailCache`; the older `defaultSessionDetailStore` /
  `SessionDetailStore` exports remain as compatibility aliases.
- `SessionDetailCache`, exported publicly as `SessionDetailMemoryCache`, owns
  source/project/session/window keyed entries, retain/release, TTL, byte
  budget, LRU eviction, and stats.
- `SessionDetailEntryStore` owns per-entry reducer state and selected
  subscriptions.
- `useSessionMessages` still coordinates initial load, warm reveal, stream
  buffering, incremental catch-up, older-page loads, cache write/delete, and
  load progress.
- `clientSummaryStore` has per-source stores, but it also has one ambient
  current source and one activity-bus subscription source.
- `api.fetchJSON` routes through a global remote connection when remote mode is
  active.
- The global remote connection is consumed by more than `api.fetchJSON`:
  uploads, `useSessionStream` / `useSessionWatchStream`, remote media loading
  (`useRemoteImage`, `LocalMediaModal`), the emulator stream, and
  `useConnection` all read it directly. The early narrow `SourceApiClient`
  subset below does not cover these; the broader `SourceTransport` proposal is
  the intended follow-on boundary for replacing those global consumers.
- Reconnect, backoff, and readiness are process-wide singletons
  (`connectionManager`, `whenConnectionReady`, `isRemoteMode`), shared between
  the remote connection context and the activity bus.
- `clearClientSummarySource` currently has no callers. Switching hosts swaps
  the current source key and abandons the previous source's stores in memory.
  Source disposal is new behavior to build, not existing behavior to relocate.
- Source keys are connection-route identities (`host:<savedHostId>`,
  `direct:<normalizedWsUrl>`); the same server reached via direct and relay
  yields two keys. See the source-identity section of the vision topic. The
  seam for server-scoped identity exists (`lib/sourceIdentity.ts`,
  `SavedHost.serverInstanceId` resolving to `server:<instanceId>`), but no
  flow populates it yet — new interfaces must treat keys as opaque either
  way.
- `useSessionMessages` also reports provider runtime status keyed by the
  ambient source key (`reportProviderRuntimeStatusSnapshot`).

Those constraints are acceptable today. The refactor should first make source
and runtime dependencies explicit, then gradually move coordination logic out
of React hooks.

## Working Terms

- **Source runtime:** one YA server/source as seen by the client.
- **Source transport:** source-bound transport facade for API calls, uploads,
  session/watch/activity subscriptions, source status, and channel snapshots.
- **Source API client:** source-bound API methods. It never consults a global
  "current connection".
- **Source activity stream:** source-bound event subscription/fan-in.
- **Session detail runtime:** source-bound owner of session detail cache,
  coordinators, and optional persistence.
- **Session detail coordinator:** normal-code state machine for one mounted
  source/project/session/window.
- **Session detail memory cache:** synchronous, source-scoped warm-return
  cache.
- **Session detail entry:** cache-side wrapper owning retain counts, TTL, byte
  accounting, and the scroll snapshot for one key; it holds the entry store.
- **Session detail entry store:** reducer/selectors/subscriptions for one
  source/project/session/window.

## Implementer Notes

For whoever picks this up first:

- **First slice:** Phase 1 and Phase 2 together are one reviewable unit —
  introduce the interfaces and inject the runtime into `useSessionMessages`.
  Do not start Phase 3 (coordinator extraction) until that lands green.
- **Plumbing:** provide the current-source runtime through React context,
  alongside the existing `ClientSummarySourceBinding` — the hook already
  derives its source key from context, so this is the least-surprising path.
  A module-level getter mirroring `defaultSessionDetailMemoryCache` is acceptable
  as an interim, but there must be exactly one construction path either way.
- **Treat `sourceKey` as opaque** in every new interface. The
  source-identity question (route vs. logical server) is undecided; new code
  must not parse, compare prefixes of, or derive transport facts from the key.
- **Verification:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, plus the
  focused tests listed under "Tests To Preserve Or Add". Phase 2's acceptance
  includes a new two-fake-runtimes isolation test — write it in the same
  slice, not later.
- **Phase 3 slicing:** move one concern at a time out of the hook (stream
  buffer and initial-load flag first; reveal gating and load progress last —
  they have the subtlest timing). Keep the hook's behavior tests passing
  between each slice.

## Phase 0: Document And Name The Boundary

Status: Drafted by this document.

Intent:

- Make `client-source-runtime-topology` the high-level topic.
- Keep `session-detail-data-layer` as the lower transcript/reducer/render doc.
- Name the difference between source runtime, coordinator, memory cache, and
  entry store.
- Record that multi-host UI is a later product feature, not the first coding
  milestone.

Acceptance:

- `ARCHITECTURE.md` points to the new topic.
- The glossary includes the topic.
- The session-detail topic points upward to the source runtime topology.

## Phase 1: Introduce Source Runtime Interfaces

Status: Implemented for the session-detail-consuming subset. Activity stream
ownership and coordinator factories remain in their later phases.

Intent:

- Add small interfaces/types before moving behavior:

```ts
interface YaSourceRuntime {
  sourceKey: ClientSummarySourceKey;
  api: SourceApiClient;
  activity: SourceActivityStream;
  sessionDetails: SessionDetailRuntime;
}

interface SourceApiClient {
  getSession(input: GetSessionInput): Promise<GetSessionResult>;
  getSessionMetadata(
    input: GetSessionMetadataInput,
  ): Promise<GetSessionMetadataResult>;
  // expand with only methods needed by the first consumer
}

interface SessionDetailRuntime {
  cache: SessionDetailMemoryCache;
  getCoordinator(input: SessionDetailCoordinatorInput): SessionDetailCoordinator;
}
```

- Provide a current-source runtime adapter that wraps existing global behavior.
- Do not make the whole client use the new runtime yet.

Acceptance:

- Existing routes and tests behave the same.
- There is one construction path for the current source runtime.
- The new interfaces can be implemented by local/direct/relay sources without
  encoding transport details in session-detail code.

Notes:

- Keep the initial `SourceApiClient` surface narrow. Start with the methods
  needed by session detail.
- Avoid renaming all existing `api` callers in this phase.
- Decide the source-identity question from the vision topic before freezing
  `sourceKey` in these interfaces. Route-scoped keys are acceptable for the
  first pass only if no new interface treats them as server identities.

Implementation note:

- Added a `YaSourceRuntime` contract with source-bound session-detail API and
  cache access, plus a current-source adapter that wraps the existing global
  API transport and `defaultSessionDetailMemoryCache`.
- Added `CurrentSourceRuntimeProvider` next to `ClientSummarySourceBinding` so
  app shells construct the current runtime from the existing route-derived
  source key. The adapter keeps route-scoped keys opaque and does not parse
  transport facts from them.
- Left `SourceActivityStream` and `SessionDetailCoordinator` out of the first
  runtime surface because no Phase 1/2 consumer uses them yet; Phase 3 and
  Phase 6 still own those moves.

## Phase 2: Pass Runtime Into Session Messages

Status: Implemented.

Intent:

- Let `useSessionMessages` receive or derive a `YaSourceRuntime`.
- Replace direct reads of `useClientSummarySourceKey()` inside the session
  detail path with `runtime.sourceKey`.
- Replace direct default-cache access in the hook with
  `runtime.sessionDetails.cache`, while preserving the existing singleton as
  the current-source runtime's cache.
- Replace direct `api.getSession` / `api.getSessionMetadata` calls in the hook
  with `runtime.api`.
- Route `reportProviderRuntimeStatusSnapshot` through `runtime.sourceKey`
  rather than the ambient hook.

Acceptance:

- Warm route restore behavior is unchanged.
- Source-scoped cache tests still pass.
- Remote/direct/local behavior is unchanged.
- A focused test can instantiate two fake runtimes and verify session-detail
  keys/API calls do not cross sources.

Non-goal:

- Do not extract the coordinator in the same patch unless the diff stays small.
  The first win is explicit dependency injection.
- The live session stream (`useSessionStream` / `useSessionWatchStream`) still
  reads the global connection in this phase; the hook keeps handing stream
  messages to session detail. Moving stream subscriptions under the runtime is
  Phase 6 scope. Until then, "session detail no longer depends on the global
  connection" is true of REST and cache access, not of streaming.

Implementation note:

- `useSessionMessages` now derives `sourceKey`, REST session reads, and the
  session-detail cache from `useCurrentSourceRuntime()`.
- The current-source adapter preserves existing `api.getSession` call shapes
  so direct/local/remote behavior and existing tests remain unchanged.
- Added focused coverage proving two fake source runtimes can load the same
  project/session ids without crossing API calls or cache entries.
- Provider runtime status reporting in `useSessionMessages` now goes through
  `runtime.summary`, so this first summary writer no longer carries a separate
  source-key argument.

## Phase 3: Extract SessionDetailCoordinator Skeleton

Status: Started. The coordinator skeleton owns entry/runtime references,
stream buffering, the initial-load-complete gate, and incremental refresh
coalescing. It also owns entry-scoped store/cache operations such as
dispatch, selector reads/subscriptions, route snapshot read/write/replace,
retention, deletion, and scroll snapshot patching. Initial REST load, reveal
gating, scroll memory policy, older-page loading, metadata refresh, and progress
update timing remain hook-owned, but the stream-gate part of initial-load lifecycle
now starts through `beginInitialLoad`, and cold initial-load reducer dispatch,
warm-refresh reducer action selection, reveal-snapshot construction, and
initial-load callback payload construction run through the coordinator.
Cacheable reveal snapshot selection is also coordinator-owned, and initial
route snapshot reads/writes now pass through coordinator policy wrappers.
Initial-load progress and perf detail value construction are also
coordinator-owned, as is the initial reveal completion value bundle. User
preference and browser-environment decisions remain hook-owned. Initial-load
reveal input shaping is coordinator-owned while cursor and scroll reads remain
hook-owned, and reveal cache-write orchestration is coordinator-owned while
cache enablement and scroll-retention decisions remain hook-owned. Current
route snapshot persistence is coordinator-owned with explicit hook-supplied
cache and scroll policy. The route-exit persist-vs-delete cleanup decision is
also coordinator-owned while byte telemetry remains hook-owned. Provider
runtime-status notification payload shaping is coordinator-owned while the
reporting side effect remains hook-owned. Incremental refresh reducer-action
selection is coordinator-owned while the fetch, status-reporting side effect,
metadata update, and diagnostics timing remain hook-owned.
Older-page request gating/input construction and reducer dispatch are
coordinator-owned while React loading state, REST, status reporting,
diagnostics, and error handling remain hook-owned.

Cleanup note: identity-only coordinator wrappers are intentionally pruned
rather than kept as speculative seams. `buildRevealInput`,
`buildWarmHydrationRevealInput`, and `buildInitialLoadStartPerfDetail` were
removed after they failed to grow real shaping behavior.

Intent:

- Move the non-React session lifecycle logic out of `useSessionMessages` into a
  coordinator object.
- Start with a thin object that owns:
  - entry key;
  - runtime API/cache references;
  - stream buffer;
  - initial-load-complete flag;
  - current load/progress state;
  - reveal key/state;
  - in-flight incremental refresh promise.
- Keep the hook as the owner of React subscription binding and effect
  start/stop.

Possible shape:

```ts
interface SessionDetailCoordinator {
  getSnapshot(): UseSessionMessagesResultLike;
  subscribe(listener: () => void): () => void;
  start(): void;
  stop(): void;
  handleStreamMessage(message: Message): void;
  handleStreamingUpdate(message: Message, agentId?: string): void;
  fetchNewMessages(): Promise<void>;
  loadOlderMessages(): Promise<void>;
  updateScrollSnapshot(snapshot: SessionRouteScrollSnapshot): void;
}
```

Acceptance:

- The hook is visibly smaller and mostly performs:
  - runtime lookup;
  - coordinator lookup/construction;
  - `useSyncExternalStore`;
  - `useEffect` start/stop;
  - return of selected view/actions.
- Coordinator unit tests can cover warm/cold load paths with fake API/cache.
- Existing hook/cache tests still pass.

Risk:

- `useSessionMessages` currently has subtle reveal gating and progress timing.
  Move this in small slices, preserving tests around warm hydration before and
  after REST data arrival.

Implementation note:

- Added `SessionDetailCoordinator` as a normal TypeScript object with the
  current entry key, source runtime, session-detail cache/API accessors,
  stream buffer, initial-load-complete flag, and in-flight incremental refresh
  promise.
- `useSessionMessages` now delegates stream-event buffering/replay and
  `fetchNewMessages` coalescing to the coordinator while keeping the existing
  hook-owned REST load/reveal/progress behavior intact.
- Added coordinator unit tests for stream buffering, reset behavior, and
  refresh coalescing. The next Phase 3 slice should move one additional
  concern, not the whole load protocol.
- Moved entry-scoped store operations behind `SessionDetailCoordinator`:
  `useSessionMessages` still decides React timing and cache/scroll policy, but
  it no longer reaches through the entry key into the store for ordinary
  dispatch, selector, retention, route snapshot, deletion, or scroll patch
  work. Added coordinator coverage for those wrappers.
- The next Phase 3 slice should move initial-load lifecycle bookkeeping one
  step inward, likely a small `beginInitialLoad`/`completeInitialReveal`
  helper that owns the coordinator reset and stream-gate transition while the
  hook still performs the REST request and React state updates.
- Added a generation-aware `beginInitialLoad` lifecycle object. The hook still
  owns REST work and React reveal/progress updates, but coordinator-owned
  lifecycle completion now opens the stream gate and flushes buffered stream
  events only for the current initial load; stale reveal completions return
  `false` and leave the current buffer gated.
- The next Phase 3 slice should move a similarly narrow non-React concern out
  of the hook, such as the warm-refresh action decision (`loadPersistedTranscript`
  vs `replaceTailWindow` vs `applyCatchupMessages`) or a read-only
  reveal-snapshot builder wrapper.
- Moved the warm-refresh action decision into `SessionDetailCoordinator`.
  `useSessionMessages` still owns fetch/progress/reveal timing, but the
  coordinator now chooses and dispatches `loadPersistedTranscript`,
  `replaceTailWindow`, or `applyCatchupMessages` and returns the applied
  message counts/pagination. Added branch coverage for the full-reload,
  tail-window replacement, and catch-up paths.
- The next Phase 3 slice should likely extract a read-only reveal-snapshot
  helper around `buildSessionDetailRevealSnapshot`, keeping warnings and React
  state updates in the hook.
- Moved reveal-snapshot construction into `SessionDetailCoordinator`. The hook
  still owns the warning boundary, scroll fallback policy, reveal state update,
  perf marks, and cache write, while the coordinator now reads the
  store-backed runtime snapshot and calls `buildSessionDetailRevealSnapshot`.
  Added coordinator coverage for store-backed and fallback reveal snapshots.
- The next Phase 3 slice should move another bounded non-React helper, likely
  the initial load result notification/runtime-status reporting shape or the
  cacheable reveal snapshot write helper.
- Moved initial-load callback payload construction into
  `SessionDetailCoordinator`. `useSessionMessages` still owns runtime-status
  reporting and callback invocation, while the coordinator now turns
  `GetSessionResult` into the exported `SessionLoadResult` shape. Added
  coordinator coverage for that payload.
- The next Phase 3 slice should likely move cacheable reveal snapshot handling
  closer to the coordinator without moving cache/scroll policy out of the hook.
- Moved cacheable reveal snapshot selection into `SessionDetailCoordinator`.
  The hook still owns transcript-cache enablement, scroll-retention policy,
  and the actual warm-cache write, while the coordinator now decides that only
  store-backed reveal snapshots are eligible to cache.
- Moved initial route snapshot read/write wrappers into
  `SessionDetailCoordinator`. The hook still computes transcript-cache
  enablement, browser availability, and scroll-retention policy, then passes
  those explicit decisions into the coordinator for the storage operation.
- Moved cold initial-load transcript dispatch into
  `SessionDetailCoordinator`. The hook still owns the REST request,
  render-yield/progress timing, reveal warning boundary, cache write, and
  completion callbacks, while the coordinator now applies the cold
  `loadPersistedTranscript` action and returns the applied counts/pagination.
- Moved initial-load progress value construction into
  `SessionDetailCoordinator`. The hook still owns when progress state changes
  and when render-yield delays occur, but the coordinator now builds fetching,
  rendering, completion, and error progress objects from loaded data, applied
  results, or route snapshots.
- Moved initial-load reload-perf detail construction into
  `SessionDetailCoordinator`. The hook still owns when
  `markReloadPerfPhase(...)` is called, while the coordinator now builds the
  start, data-ready, queued, complete, and error detail records.
- Moved initial reveal completion value bundling into
  `SessionDetailCoordinator`. The hook still owns applying the reveal snapshot,
  opening the stream gate, setting React loading/progress state, and marking
  perf phases, while the coordinator now derives the queued perf detail,
  completion progress, and completion perf detail from one input.
- Moved warm-hydration reveal input shaping into `SessionDetailCoordinator`.
  The hook still owns reading the current store cursor and scroll snapshot,
  warning on missing store-backed reveal state, and applying/cache-writing the
  reveal, while the coordinator now turns hook-supplied loaded session,
  pagination, cursor, and scroll values into the reveal fallback input.
- Moved warm-delta and cold-load reveal input shaping into
  `SessionDetailCoordinator`. The hook still owns reading the current store
  cursor and scroll snapshot, warning on missing store-backed reveal state,
  and applying/cache-writing reveals, while the coordinator now shapes the
  fallback input for the remaining initial-load reveal paths.
- Moved reveal cache-write orchestration into `SessionDetailCoordinator`.
  The hook still owns cache enablement, browser availability, and
  scroll-retention decisions, but the coordinator now filters reveal snapshots
  to cacheable store-backed snapshots and applies the explicit route snapshot
  write policy.
- Moved current route snapshot persistence into `SessionDetailCoordinator`.
  The hook still owns cache enablement, browser availability, and the current
  scroll snapshot ref, while the coordinator now reads the current route
  snapshot, attaches the hook-supplied scroll snapshot, and applies the
  explicit write policy.
- Moved the route-exit persist-vs-delete cleanup decision into
  `SessionDetailCoordinator`. The hook still records entry byte telemetry and
  supplies cache/scroll policy, while the coordinator now attempts to persist
  the current route snapshot and deletes the entry when persistence is not
  allowed or no snapshot is available.
- Moved provider runtime-status notification payload shaping into
  `SessionDetailCoordinator`. The hook still owns the
  `reportProviderRuntimeStatusSnapshot(...)` side effect and source-key
  routing, while the coordinator now builds the session/project/status payload
  from provider response data for initial load, incremental fetch, older-page
  load, and metadata refresh paths.
- Moved the incremental refresh reducer-action decision into
  `SessionDetailCoordinator`. The hook still owns the REST request,
  runtime-status reporting side effect, metadata update, and diagnostics
  timing, while the coordinator now no-ops empty refreshes and dispatches
  `replaceTailWindow` or `applyCatchupMessages` for non-empty responses.
- Moved older-page request gating/input construction and reducer dispatch into
  `SessionDetailCoordinator`. The hook still owns `loadingOlder` React state,
  the REST call, runtime-status reporting, diagnostics, and error handling,
  while the coordinator now reads pagination, decides whether an older page is
  requestable, builds the `beforeMessageId` request, and applies
  `prependOlderMessages`.
  Impact: `useSessionMessages` no longer imports the pagination selector or
  directly dispatches transcript pagination actions; older-page behavior is now
  covered in coordinator unit tests.
- Pruned identity-only coordinator helpers that were acting as speculative
  seams rather than behavior owners: reveal fallback input wrappers and the
  initial-load-start perf-detail wrapper. Hook call sites now pass those
  literals directly, and tests for pure identity mapping were removed.
  Impact: coordinator public API and tests now better reflect behavior
  ownership rather than object-literal relocation.
- The next Phase 3 slice should be a genuinely larger boundary move, such as
  consolidating the remaining initial-load effect orchestration into named
  hook/coordinator phases; otherwise Phase 3 is a reasonable stopping point
  before Phase 4 naming work.

## Phase 4: Rename Public Cache Facade

Status: Started. Public memory-cache names are now available and production
runtime/settings imports use them; older store exports remain for staged
migration.

Intent:

- Make the cache/store distinction visible in public names once call sites are
  less tangled.
- Prefer names like:
  - `SessionDetailMemoryCache`
  - `defaultSessionDetailMemoryCache`
  - `SessionDetailEntryStore`
  - `SessionDetailCoordinator`

Acceptance:

- Compatibility exports remain for staged migration.
- `sessionRouteSnapshots.ts` (`packages/client/src/lib/sessionRouteSnapshots.ts`)
  becomes DTO/conversion compatibility only, or its runtime helper functions
  are retired.
- Stats and clear APIs read as cache-manager operations, not entry-store
  operations.

Non-goal:

- Do not rename every internal file solely for cosmetics if the facade already
  makes ownership clear.

Implementation note:

- Added `SessionDetailMemoryCache`, `createSessionDetailMemoryCache`, and
  `defaultSessionDetailMemoryCache` as the public facade names while preserving
  `SessionDetailStore`, `createSessionDetailStore`, and
  `defaultSessionDetailStore` as compatibility aliases. Cache aggregate stats
  are now named `SessionDetailMemoryCacheStats` /
  `SessionDetailMemoryCacheEntryStats`, with the old type aliases retained.
  Impact: new runtime and settings code now reads as memory-cache ownership,
  while staged migration remains source-compatible for older imports.
- Added default-cache helper functions for clear, scroll-snapshot clear, and
  TTL eviction so settings code calls cache-manager operations instead of
  reaching through the singleton and invoking store-shaped methods directly.

## Phase 5: Source Runtime Registry

Status: Started. The current-source runtime map now lives behind an explicit
registry; activity and query ownership are still later-phase work.

Intent:

- Introduce a registry that can return runtimes by source key.
- Make current-source routing a consumer of the registry.
- Prepare activity and summary ownership to become per-runtime instead of
  ambient singleton state.

Possible shape:

```ts
interface SourceRuntimeRegistry {
  getOrCreateSourceRuntime(sourceKey: ClientSummarySourceKey): YaSourceRuntime;
  getCurrentSourceRuntime(): YaSourceRuntime;
  setCurrentSourceKey(sourceKey: ClientSummarySourceKey): void;
  disposeSource(sourceKey: ClientSummarySourceKey): void;
}
```

Acceptance:

- Single-source route behavior is unchanged.
- Existing per-source summary stores are still reused.
- Current-source helpers still exist for current UI code.
- New code can ask for a runtime by explicit source key.

Risk:

- Activity subscriptions currently behave as one source at a time. Avoid
  widening them to multi-source subscriptions until a consumer needs it.
- Reconnect/readiness state (`connectionManager`, `whenConnectionReady`,
  `isRemoteMode`) is a process-wide singleton shared by the remote connection
  context and the activity bus. Two coexisting remote runtimes cannot share one
  backoff state machine; this phase (or a dedicated follow-on) must make those
  services runtime-scoped, or facades over per-runtime instances. This is
  likely the hardest hidden chunk of making `SourceApiClient` real for remote
  sources.

Implementation note:

- Added a `SourceRuntimeRegistry` facade with explicit
  `getOrCreateSourceRuntime`, `getCurrentSourceRuntime`, `setCurrentSourceKey`,
  and `disposeSource` methods. The default registry still wraps the existing
  global API transport and default session-detail memory cache, so
  single-source behavior is unchanged.
  Impact: current-source runtime construction no longer depends on a hidden
  module-level map, and new code can request a runtime by explicit source key.
- Switched `CurrentSourceRuntimeProvider` and fallback hook reads to consume the
  registry path while keeping `getOrCreateCurrentSourceRuntime` as a
  compatibility helper. Added tests for stable per-source runtime identity,
  current-source routing, source-key cache isolation, and runtime wrapper
  disposal.

## Phase 6: Per-Source Activity And Query Ownership

Status: In progress for source-bound summary ownership. Non-test summary
writes, summary selector reads, summary activity leases, and draft-decoration
leases now go through the mounted source runtime when one exists. Per-session
live streams and the transport-level activity stream still use the existing
ambient current-source path. The remaining stream/transport work continues in
[`057-source-transport-boundary.md`](057-source-transport-boundary.md), the
implementation runbook for the accepted contract in
[`topics/source-transport.md`](../../topics/source-transport.md).

Intent:

- Move activity-bus retain/release and draft-decoration subscriptions under
  source runtimes.
- Give the runtime a `SourceTransport` so `useSessionStream` /
  `useSessionWatchStream` stop reading the global connection and singleton
  connection manager directly.
- Ensure retained query and route-retention state is naturally source-owned,
  even where the implementation remains module-level maps keyed by source.

Acceptance:

- One source runtime can retain its activity subscription without switching the
  app's current source.
- Clearing/disconnecting one source does not clear unrelated source state.
- Existing activity update tests still pass.

Non-goal:

- Do not build a merged multi-source sidebar yet.

Near-term implementation slices:

1. Finish non-test summary writers. Move inbox snapshots, process/session
   provider runtime status, and page-specific project-queue mutation writes
   through `runtime.summary`. Also make retained-query request callbacks capture
   their fetch/apply functions at request start so delayed responses keep the
   source binding they launched with.
2. Add runtime-aware summary reads/selectors. Keep compatibility hooks, but make
   the source-owned path able to select records from `runtime.summary` rather
   than the ambient current summary store.
3. Add optional explicit runtime overrides where they reduce test or
   multi-source plumbing, with context as the default:
   `useProjects({ runtime })` / `useProjectQueues({ runtime })`. Avoid naked
   `sourceKey` overrides for operations that also depend on API, summary,
   activity, or cache state.
4. Superseded: slices 4–6 of this list are replaced by the T1–T10 sequence in
   [`057-source-transport-boundary.md`](057-source-transport-boundary.md),
   which carries the transport contract implementation, the stream/activity
   moves, global deletion, and a minimal two-server smoke. The remaining
   secure/relay and auth-isolation proof is recorded as a Phase 8 caveat and
   should stay deferred until product work wants a UI that keeps two remote
   clients/sources mounted at once.

Completed read-side slice:

- Runtime-aware summary reads/selectors. The intended implementation is to keep
  the existing selector hook names stable while making their store selection
  come from the mounted `SourceRuntimeProvider` when one exists, falling back to
  the ambient current-source store for legacy callers. This slice should prove
  source isolation with two mounted runtimes and should not yet move
  activity-bus retain/release, draft-decoration scanning, or live stream/watch
  subscriptions.

Completed activity/draft slice:

- Runtime-owned activity and draft-decoration subscriptions. Summary selector
  hooks now retain activity-bus updates and draft-decoration scans through
  `runtime.summary` when mounted under a `SourceRuntimeProvider`, with legacy
  fallback to the ambient current source. Draft scans are refcounted per source
  and tear down their interval when the final mounted consumer releases.

Likely next slice:

- Slice T1 of
  [`057-source-transport-boundary.md`](057-source-transport-boundary.md)
  (contract types and fakes). The summary layer can bind reads, writes,
  activity leases, and draft scan leases to a mounted runtime, but
  `useSessionStream` / `useSessionWatchStream` still read the process-wide
  connection path directly; 057 owns that migration end to end.

Implementation note:

- Added `SourceSummaryRuntime` on `YaSourceRuntime`, backed by the existing
  per-source client summary stores. It exposes source-bound store access,
  snapshot reads, source clearing, and provider runtime status reporting.
  Impact: new runtime consumers can own summary writes without threading a
  second source-key argument through the call site.
- Added registry coverage proving summary stores and provider runtime status
  writes remain isolated across two source runtimes. The facade intentionally
  reuses the existing store implementation, so retained query selectors and
  activity subscriptions are unchanged until later Phase 6 chunks.
- Expanded `SourceSummaryRuntime` with collection-writer methods and moved
  `useGlobalSessionsFeed`, `useProjectQueues`, and `useProjects` to write
  global-session, project, and project-queue snapshots through the runtime.
  Impact: the main reusable summary-fetch hooks now bind their summary writes
  to the source runtime, while retained-query identity still uses the runtime's
  source key for compatibility with the existing query controller.
- Moved the remaining non-test direct summary writers in `InboxContext`,
  `useProcesses`, legacy `useSession`, `SessionPage`, and `NewSessionForm`
  through `runtime.summary`. `useRetainedClientQuery` now captures its
  fetch/apply callbacks at request start, preserving the source-bound writer for
  delayed in-flight responses.
- Moved summary selector store lookup behind the mounted source runtime. The
  existing selector hook names remain compatible, but when a
  `SourceRuntimeProvider` is mounted they subscribe to `runtime.summary`'s store
  instead of the ambient current-source store. A small raw provider module keeps
  that lookup available to the store layer without depending on the higher-level
  fallback hook. Added two-runtime selector coverage for session records, inbox
  snapshots, queue session ids, and provider runtime status.
- Added source-bound summary leases for activity-bus updates and draft
  decoration scans. Selector hooks now retain those leases through
  `runtime.summary` when mounted under a `SourceRuntimeProvider`, while legacy
  callers still fall back to the ambient current source. Draft-decoration scans
  are refcounted per source and tear down their interval on release. The
  activity bus transport itself remains a singleton until the later runtime
  activity-stream work, so this proves non-current runtime retention but not
  true two-server activity multiplexing.

## Phase 7: Optional Snapshot Persistence Adapter

Intent:

- After the coordinator/cache boundary is clear, define an async persistence
  adapter for source-scoped `SessionRouteSnapshot` records.
- Keep memory cache as the sync hot path.

Possible shape:

```ts
interface SessionDetailSnapshotPersistence {
  readSnapshot(
    key: SessionDetailEntryKeyInput,
  ): Promise<PersistedSnapshot | undefined>;
  writeSnapshot(
    key: SessionDetailEntryKeyInput,
    snapshot: PersistedSnapshot,
  ): Promise<void>;
  deleteSnapshot(key: SessionDetailEntryKeyInput): Promise<void>;
  clearSource(sourceKey: ClientSummarySourceKey): Promise<void>;
}
```

Acceptance:

- Persistence is optional and default-off unless a later product decision says
  otherwise.
- Persisted snapshots are versioned and source/auth scoped.
- Restored persisted snapshots are always revalidated through `SourceApiClient`.

## Phase 8: Full Coexistence Proof

Status: Activated as a separate product/E2E series by
[`066-multi-host-monitor-coexistence-harness.md`](066-multi-host-monitor-coexistence-harness.md).
The current single-source UX remains unchanged; the new proof is a
hidden/default-off monitor rather than an incidental part of this topology
refactor.

The fake-runtime tests in earlier phases prove key isolation, not capability.
T10 in [`057-source-transport-boundary.md`](057-source-transport-boundary.md)
now exercises the cheap real-server path: one localhost source plus one plain
direct WebSocket source, against two temporary-profile servers. That is enough
for the current one-source-at-a-time product surface and for guarding the
source-transport boundary. It does not prove full secure/relay coexistence.

Intent:

- When a two-client or multi-source UI becomes product work, run two YA
  servers locally and connect one client to both through secure/relay-capable
  transports behind a dev-only flag or E2E test.
- Exercise, at minimum: two concurrent `SecureConnection` instances, relay
  reconnect/re-pair behavior on one source while the other stays live,
  independent activity subscriptions, independent session-detail loads for
  identical project/session ids, provider-backed live session streams where a
  deterministic mock provider is enough, disposal of one source while the
  other stays live, and auth failure on one source without an app-wide login
  redirect.

Acceptance:

- Before YA exposes or claims two secure/relay sources in one UI, an
  E2E/integration test or documented dev surface instantiates two real
  runtimes against two real servers and passes the isolation checks.
- Anything that only works with fakes, localhost, or plain direct WebSocket is
  recorded as a known gap in this document, not claimed as full secure/relay
  coexistence support.

Known caveats:

- T10 does not exercise two concurrent relay-backed `SecureConnection`
  instances, slot replacement during relay reconnect, or relay auth/pairing
  failure isolation.
- Auth-required signaling still has global edges (`authEvents`). A per-source
  login-required UX may be needed before one source can fail auth without
  changing the rest of the app.
- T10 covers activity, session-watch, persisted session detail, and independent
  no-active-process session-stream failures. It does not cover two
  provider-owned live session streams running at once.
- Suspension policy for non-current runtimes is still a product/resource-cost
  decision, especially if a future UI keeps multiple remote clients mounted.

Tactical 066 expands this to three isolated real server profiles and requires
the secure/relay proof over existing independent sockets before any relay mux
transport work begins.

## Multi-Host UI Follow-On

Once source runtimes are explicit, product UI can choose among:

- current single-source routing, unchanged;
- tabbed source sidebar;
- merged inbox with source badges;
- merged global sessions/projects with explicit source identity.

The topology refactor should not pick that UI contract. It should only avoid
blocking it.

## Tests To Preserve Or Add

Preserve existing focused coverage:

- `packages/client/src/lib/sessionDetail/__tests__/sessionDetailStore.test.ts`
- `packages/client/src/hooks/__tests__/useSessionMessages.cache.test.tsx`
- `packages/client/src/hooks/__tests__/useSessionPerformanceSettings.test.ts`
- `packages/client/src/lib/sessionDetail/__tests__/transcriptReducer.test.ts`
- `packages/client/src/components/__tests__/MessageList.test.tsx`
- existing client summary/source tests
- connection readiness and remote connection tests where API routing changes

Add focused tests as slices land:

- two fake source runtimes can host same project/session ids without cache/API
  collision;
- a coordinator can cold-load through a fake API and reveal from a fake memory
  cache;
- a coordinator can warm-reveal before and after REST data arrival;
- source runtime disposal clears only that source's session-detail cache;
- current-source helpers remain compatibility wrappers over the registry.

## Open Questions

- Should `SessionDetailCoordinator` be one object per mounted consumer, or can a
  runtime share a coordinator for identical source/project/session/window keys?
  Sharing may reduce duplicate fetches, but mounted routes also carry scroll
  and reveal timing that may be consumer-specific. Current leaning: share one
  coordinator per key (the cache already retain-counts entries per key) and
  keep scroll/reveal timing in per-consumer state outside the coordinator.
  Note the Phase 3 sketch (`updateScrollSnapshot` on the coordinator) implies
  the opposite; revisit when Phase 3 lands.
- Should memory-cache retention live entirely under `SessionDetailRuntime`, or
  should the first pass keep a process-wide singleton cache with explicit
  source keys? The runtime-owned shape is cleaner, but compatibility may favor
  staged movement.
- Should route retention and session detail persistence share one source-level
  storage adapter, or remain separate adapters with shared key conventions?
- How much of load progress belongs in the coordinator versus the hook? Progress
  is user-visible state, but it follows the async protocol more than React
  rendering.

## Definition Of Done For The First Pass

The first useful implementation series is complete when:

- session detail no longer directly depends on ambient current source or the
  global API singleton;
- a current-source `YaSourceRuntime` exists and backs existing behavior;
- the hook is reduced to runtime/coordinator binding for the initial-load path;
- tests prove two fake runtimes do not cross cache or API calls;
- no multi-host UI has been introduced by accident.

After T10, minimal localhost plus plain-WebSocket coexistence is exercised
against two real servers. Full secure/relay multi-client coexistence remains
unsupported until the Phase 8 caveats above are addressed; documents and code
comments must not claim more than the T10 path has proven.
