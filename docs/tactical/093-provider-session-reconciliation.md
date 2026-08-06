# Add Install-Scoped Provider Catalogs and Boot Reconciliation

> Enumerate each historically used provider store once, reconcile Inbox from a
> retained snapshot in the background, and identify external harness processes
> without multiplying storage scans by project count or guessing ownership.

Status: Implementation in progress. Shared source-versioned work ownership,
Codex child projection, install-scoped successful-use eligibility, gated
post-listener file watching, the durable catalog coordinator, and the Pi/Grok/
OpenCode catalog adapters are implemented and measured. Claude, Codex, and
Gemini adapters are ruled out for list amplification (step 2 records why, and
corrects a wrong premise about their storage layouts), and command recognition
is extracted into `services/providerProcessClassifier.ts`. Retained collection
routes, interest leases, native session id recognition, and exact process
reconciliation remain pending; nothing wires the coordinator into a route yet,
which is what the compatibility checkpoint below gates. The provider/storage
and process-discovery contracts are accepted in the linked topics.

Related contracts:

- [`topics/provider-abstraction.md`](../../topics/provider-abstraction.md)
- [`topics/inbox.md`](../../topics/inbox.md)
- [`topics/agents-process-observability.md`](../../topics/agents-process-observability.md)
- [`topics/session-ownership.md`](../../topics/session-ownership.md)
- [`topics/session-catalog-observation.md`](../../topics/session-catalog-observation.md)
- [`topics/architecture-mandates.md`](../../topics/architecture-mandates.md)
- [`topics/server-performance-observability.md`](../../topics/server-performance-observability.md)
- [`089-main-thread-startup-cpu-investigation.md`](089-main-thread-startup-cpu-investigation.md)

## Implementation progress

- **2026-08-05 — Pi, Grok, and OpenCode catalog adapters.** The three families
  whose readers rescan a provider-global store for every project now have
  install-wide `NativeSessionCatalogAdapter` implementations that enumerate
  their store once and let the coordinator group by project. Project membership
  is always a canonical host path, never the provider's own encoding of one:
  Grok percent-encodes a cwd, pi flattens separators (lossy, so the row's path
  comes from each transcript header's `cwd`), and OpenCode hides the worktree
  behind an opaque id read once per pass. `OpenCodeDbReader.listAllSessionRows`
  joins `session` to `project` in one query so the 1.16+ database needs no
  per-project lookup, while the frozen JSON tree still supplies pre-1.16
  history; the database wins where both describe a session, and the `opencode`
  CLI is never spawned. Recent mode is an mtime gate applied before anything is
  opened, so a stale pi transcript costs no header read. Rows carry the
  fidelity they actually have — `head` where the provider keeps its own title
  (Grok's `summary.json`, OpenCode's session row), `identity` for pi, which has
  no native summary and would need a transcript parse.
  On a synthetic store of 200 projects × 5 sessions, the per-project readers
  walked the store 200 times: Grok 330.49 ms and pi 18,916.38 ms, against one
  adapter pass at 165.57 ms (2.00x) and 141.02 ms (134.14x), with both arms
  producing the same 1,000 rows. Pi's gap is the larger one because every
  project's reader opens every transcript header in the store to learn its cwd
  — 200,000 header reads against the adapter's 1,000. Grok's per-project reader
  filters on the directory name before opening anything, so its repeated cost
  is the top-level listing; that term is linear per project and quadratic
  across the fleet, which is why 200 projects understates a 10,000-project
  install. Run `pnpm --filter @yep-anywhere/server
  benchmark:provider-catalog-adapters` to repeat the measurement.

- **2026-08-05 — durable catalog coordinator and shard generation vector.**
  One disk-backed lineage now owns a random epoch, monotonic complete
  generations, hash-sharded rows, bounded deltas, and a byte-bounded
  source-versioned project hot set. Publication is atomic: rows stage under a
  temporary directory, rename into place, and only then replace the manifest,
  so an interrupted or failed pass never displaces the last complete
  generation. Each shard carries a digest and the generation in which that
  digest last changed, which makes the global generation one component of a
  vector rather than the whole clock — a write to one project leaves other
  shards' tokens, retained rows, and delta comparisons untouched. Unreadable
  or layout-incompatible state starts a fresh epoch instead of failing
  initialization.
  On a 2,000-project, 10,000-row synthetic corpus, twenty readers asking for
  one project cost 200,000 row parses and a 304.24 ms median through the
  current per-reader store enumeration, versus 130 row parses, one shard read,
  and a 2.14 ms median through a restarted catalog (99.94% of row parses
  avoided, 142.41x). A second generation touching one project read 1 of 64
  shards and skipped 63 by digest (98.44%), producing 5 delta changes, and the
  unchanged project's conditional read answered no-change. Replacing the
  recent-row window's per-row sort and whole-array re-serialization with
  bounded insertion cut that window's cost over 10,000 rows from a 2,067.74 ms
  to a 23.90 ms median (86.51x) with identical retained contents. Run `pnpm
  --filter @yep-anywhere/server benchmark:session-catalog` to repeat the
  measurement.

- **2026-08-05 — source-versioned single-flight infrastructure.** The server
  now has one byte-bounded owner that joins exact-version computations, retains
  only accepted values, passes the prior accepted version to incremental work,
  clears failures for retry, and discards late completions after newer source
  evidence. No native-session collection route uses it yet; the separate
  provider/model routes now reuse the owner for generation-safe forced refresh.
  A synthetic 100-caller, 512 KiB CPU projection performed 100 baseline
  computations versus one coordinated computation (99.00% repeated work
  avoided); across five samples, median wall time was 519.70 ms versus 5.10 ms
  (101.94x). Run `pnpm --filter @yep-anywhere/server
  benchmark:single-flight` to repeat the measurement.

- **2026-08-05 — Codex provider-child projection.** Process snapshots now use
  latest accepted child summaries and start source refresh in the background,
  so a cold decorative projection cannot delay basic process rows. Fresh
  readers share an 8 MiB byte-bounded projection owner, join concurrent work,
  stream only child lifecycle records, read plain-file appends incrementally,
  and rebuild on truncation or replacement. With 20 callers and a 6,289,985
  byte parent rollout, the reproducible benchmark measured 20 legacy full
  parses versus one projection build and 125,799,700 versus 6,289,985 logical
  source bytes (95.00% avoided). Median wall time fell from 183.08 ms to 9.07
  ms across five samples (20.18x); cold accepted lookup returned in 0.535 ms,
  the retained projection estimated 611 bytes, and the full-entry cache stayed
  empty. Run `pnpm --filter @yep-anywhere/server
  benchmark:codex-child-projection` to repeat the measurement.

- **2026-08-05 — successful-use ledger and provider watcher gate.** Install
  state now atomically persists alias-normalized native catalog families.
  Existing YA provider metadata seeds migration without probing native stores;
  a durable completion marker prevents that metadata pass from repeating on
  later restarts. A successful live boundary records actual provider metadata
  and eligibility before process registration, and aborts if that boundary
  cannot become durable. Unchanged records perform no second write. Never-used
  families receive no existence probe or watcher. Eligible activation is queued
  only after listener readiness, staggered under one registry, and torn down at
  shutdown; each watcher builds its initial mtime baseline asynchronously while
  preserving events observed during the build.
  On four synthetic provider trees totaling 164 directories and 8,000 files,
  five-sample median pre-listener synchronous traversal cost 26.76 ms. The new
  unused-family request returned in 0.004 ms with zero directory probes and
  zero watcher starts (100.00% probes avoided); an eligible request returned in
  0.034 ms while its one 2,000-file watcher attached later (23.45 ms median)
  and completed the asynchronous baseline in an 18.00 ms median. Run `pnpm
  --filter @yep-anywhere/server benchmark:provider-watch-startup` to repeat the
  measurement.

Design decision: use a source-versioned, byte-bounded latest-value owner rather
than a request-only in-flight map or TTL cache. Request-only coalescing does not
stop sequential unchanged reads; TTL freshness can publish obsolete work and
retain source generations after the source has moved.

## Current fault and measured cost

Collection routes build a provider candidate list per project.
`mayHaveGrokSessions()`, `mayHavePiSessions()`, and
`mayHaveOpenCodeSessions()` return true for every project, then their readers
rescan provider-global storage and filter by cwd. The cold `/api/inbox` probe
took 4.108 seconds and launched all-project/all-provider enumeration; at the
accepted 10,000-project scale this Cartesian shape is untenable.

The global session list repeats the same corpus work for each projection. Every
`GET /api/sessions` lists all projects, builds a provider/project catalog,
sequentially lists each project's providers, materializes/enriches every
matching session, and only then sorts/paginates to the requested 50 rows. The
Sidebar starts unfiltered and starred projections independently; in the cold
New Session census both requests took about 3.56 seconds. A separate global
stats route runs another full project/provider scan whenever its five-second
cache was dirtied by ordinary session/file events.

These routes may share lower index reads in flight, but they still own separate
project loops, row enrichment, filtering, and allocations. `limit=50` therefore
does not bound server work, and adding another filter consumer adds another
corpus projection pass. The retained catalog must be the one global collection
generation from which Inbox, unfiltered/starred session lists, project filters,
and stats derive compact views.

The current range caches also treat a moving time threshold as permanent
identity. `getActiveSessionIndexOptions()` rounds the auto-archive cutoff to UTC
midnight. That value enters `SessionIndexService.lastFullValidationAt` keys and
the process-global Codex shared-scan key. Repeated requests within one day
reuse/overwrite their generation, but old daily generations are never trimmed;
the Codex entries retain provider-wide `CodexSessionFile[]` arrays. The catalog
must replace or evict obsolete range generations rather than accumulating one
per scope/provider/day.

Provider file watching is also started too early and too broadly. Before the
server's startup timer is created, `index.ts` calls `FileWatcher.start()` for
every existing Claude, Gemini, Codex, and Pi root. `start()` recursively and
synchronously builds `knownFileMtimes`, then installs a recursive native watch.
The measured process-to-first-static-response time was 1.859 seconds while the
later internal startup timer reported only 42 ms (47 ms to listener `onReady`).
A direct repeat of the four initial watcher scans/attachments took about 0.46
seconds on warm host caches. This is a material pre-timer phase, not the whole
remaining gap.

Focused session watching has the inverse fault after explicit interest. A
`session-watch` target is correctly reference-counted by project/session, but
an unresolved file retries every three seconds by default. Each retry probes
Claude paths and may enumerate every Codex and Gemini session in the project,
even when the provider hint is known or the target no longer exists. Exact
interest justifies an exact refresh, not an indefinite project/provider scan.
The catalog location row should resolve the watch; unresolved targets await a
catalog/file/process change plus bounded backoff.

The current project-scoped reader API is still appropriate for explicit
session detail. It is the wrong owner for a provider-wide inventory. Likewise,
`HostAgentProcessService` currently owns a central executable-name table, but
provider command evolution and exact native session-id extraction belong to
provider-specific discovery code.

## Three separate projections

Do not overload one interface with incompatible lifetimes:

1. **Runtime provider (`AgentProvider`).** Starts/resumes a provider session
   and owns live protocol capabilities.
2. **Native session catalog adapter.** Enumerates one provider storage family
   in complete or recent-window mode and yields native session id, canonical
   project identity, updated time, and the cheapest bounded activity summary.
   Full transcript detail remains an explicit per-session reader operation.
3. **Native process classifier.** Examines a transient, minimized same-user
   process snapshot and recognizes exact harness/entrypoint forms. It returns a
   native session id only when a documented argv flag, pid/lock record, or
   provider protocol exposes one. Raw command text is not retained.

The generic coordinator owns eligibility, scheduling, concurrency, persistent
snapshots, and project grouping. Catalog and process rows join only by exact
native session id or exact YA Supervisor/runtime-host ownership. Cwd, mtime
proximity, CPU, and a single candidate never prove a join.

## Install-scoped eligibility ledger

Extend `InstallService` state with a durable set of successfully used **catalog
families**. This state changes only a handful of times per install and belongs
with the installation identity rather than session metadata or settings. Exact
runtime names map to their shared native store: for example Codex/Codex OSS,
Gemini/Gemini ACP, and Claude-family launch variants should not cause duplicate
scans of one storage family. The version migration and save must use atomic
replacement so a first-use write cannot corrupt the installation identity.

The gate changes only after `startSession` has successfully returned a live YA
session boundary. Merely selecting a provider, checking installation/auth,
finding its binary, observing its native directory, or recognizing an external
process does not make it eligible. After a provider session exists but before
YA reports first-use launch success, persist its YA session-provider metadata
and catalog family. If that durable boundary fails, do not report a successful
first use while leaving an untracked runtime; close the just-created runtime or
surface an explicit recoverable launch failure. A committed first success
activates its file watcher and schedules the first complete catalog pass.

Migration runs after `SessionMetadataService` is loaded and seeds families from
existing YA-owned metadata with a persisted provider. It does not inspect
native provider stores. An install with no YA evidence for a provider never
asks that catalog adapter whether it may have sessions and never starts that
provider's storage watcher. The one same-user process snapshot is intentionally
different: it may recognize a known never-used provider as an uncorrelated
external harness without opening its store.

The eligibility set is install/app-data state. It does not vary by selected
project or source checkout and is not stored inside either.

## Boot ordering and retained Inbox state

The startup sequence becomes:

1. load install state and session metadata;
2. migrate/persist the eligible catalog-family set from YA-owned metadata;
3. initialize file watches only for eligible storage families, without a
   synchronous recursive initial corpus scan on the main thread;
4. reattach retained YA provider runtimes;
5. when host process observability is enabled, take one same-user process
   snapshot, classify known harness roots, and arm one bounded process-wide
   reconciliation cadence;
6. serve the last persisted Inbox/catalog snapshot immediately; and
7. run eligible recent/complete catalog reconciliation at bounded concurrency,
   publishing versioned project/provider deltas as shards complete.

The ordinary Inbox route only reads the retained projection; it never starts
or waits for a corpus pass. Provider file events update touched rows after the
baseline. A bounded reconciliation handles downtime, watch uncertainty, and
provider stores whose event substrate is incomplete. Completed work leaves no
per-session or per-project polling loop.

Complete dormant catalog shards remain disk-backed. Live memory retains recent
or changed rows plus compact Inbox tiers/counts, subject to byte/age bounds.
Recent-window cutoffs are query parameters over those rows, not unbounded cache
keys; only current/in-flight range generations may remain resident.
The coordinator exposes bytes/files/shards scanned, queue depth, coalescing,
duration, and snapshot version without scanning again to answer diagnostics.

Global list pagination, starred/archive/project/search projections, project
options, and aggregate stats read the same completed catalog generation.
Changing a filter or asking for 50 versus 100 rows performs bounded index/view
work and no provider transcript discovery. Provider/file/metadata events update
the affected row and incrementally repair memberships/counts. Cold server boot
may serve the last durable generation with explicit freshness/progress while
reconciliation fills newer shards; it does not make the first Sidebar request
the discovery owner.

## Observer model, freshness, and client interest

The server is the continuous observer described in
[`topics/session-catalog-observation.md`](../../topics/session-catalog-observation.md).
Its disk-backed compact catalog remains the install-wide source of truth across
ordinary client disconnects and brief server restarts. Clients may still
receive broad compact list snapshots; they do not need to reconstruct session
existence from the current viewport.

Schedule derivation work by fidelity and interest:

1. clicked/open detail and live owned sessions;
2. exactly recognized external harness sessions;
3. specifically visible or hover-requested rows;
4. Inbox/navigation/recent and uncertain-shard reconciliation; then
5. old, offscreen, unowned history.

Old rows remain durable and explicitly stale until changed source evidence or
a short-lived client interest lease promotes them. Interest leases carry a
source plus stable session/query/window identity, use overscan and hysteresis,
expire on disconnect/source switch/TTL, and are unioned across clients. They do
not mirror pixel scroll state and do not create a per-client watcher or timer.
Hover refresh is exact-row work; it never starts a neighboring or global
transcript pass.

The process inventory is the permitted periodic backstop for external-session
freshness. One same-user snapshot is classified and diffed against its previous
generation; only changed recognized harness roots trigger exact catalog work.
Its cadence has one process-wide owner and its cost is bounded by the process
table. It must not open every provider store or sweep old transcripts. File
watchers and bounded provider reconciliation cover eligible session stores.

Every accepted catalog lineage carries a durable random epoch and monotonic
generation. List, Inbox, stats, queue-title, hover, and other projections report
that lineage plus their source/fidelity versions. A client with the same
generation can receive no-change or bounded deltas rather than causing another
projection build. Partial reconciliation never replaces the last complete
accepted generation.

All provider/filesystem derivation is single-flight under a key containing the
catalog epoch, session/projection, requested fidelity, and source version.
Admission/publication use short state locks; asynchronous I/O runs outside the
lock. Requests, events, background repair, tabs, and devices join the same work.
Only a result for the still-current source version publishes, and one bounded
failure/backoff policy serves all waiters.

## Source map

| Concern | Current owner | Change |
|---|---|---|
| Install identity/history | `packages/server/src/services/InstallService.ts` | Persist eligible catalog families with atomic version migration/save |
| Successful launch boundary | `packages/server/src/supervisor/Supervisor.ts` and provider runtime proxies | Record eligibility once at the central successful start/resume boundary; avoid route-only coverage |
| YA metadata migration | `packages/server/src/metadata/SessionMetadataService.ts` | Supply existing YA-owned provider evidence after initialization; do not scan native stores |
| Project Cartesian resolution | `packages/server/src/sessions/provider-resolution.ts` | Keep explicit per-session/project reads, but replace global collection fan-out with provider catalog shards |
| Provider readers | `packages/server/src/sessions/*-reader.ts` | Implement provider-global complete/recent bounded catalog projections without full transcript detail |
| Process recognition | `packages/server/src/services/HostAgentProcessService.ts`, `providerProcessClassifier.ts` | Keep one minimized boot/periodic `ps` owner and diff snapshots; command recognition is extracted, native session id recognition is not built |
| Early file watchers | `packages/server/src/index.ts`, `packages/server/src/watcher/FileWatcher.ts` | Activate only eligible families after state load; remove synchronous recursive boot indexing |
| Focused session watch resolution | `packages/server/src/watcher/FocusedSessionWatchManager.ts` | Resolve exact catalog locations; replace three-second unresolved project/provider enumeration with event-driven repair and bounded backoff |
| Inbox route | `packages/server/src/routes/inbox.ts` | Read retained reconciled state; never own `Promise.all(project × provider)` |
| Global session lists | `packages/server/src/routes/global-sessions.ts`, `packages/server/src/routes/projects.ts` | Reuse catalog grouping for collection routes while preserving explicit detail lookup |
| Ownership | `packages/server/src/supervisor/ExternalSessionTracker.ts` | Consume exact joins; keep uncorrelated process roots separate from session ownership |
| Client interest/generations | collection routes, activity subscriptions, client query controller | Accept expiring exact/window interest, publish epoch/generation snapshots or deltas, and union duplicate clients |

## Recommended implementation order

### 1 — persist successful-use eligibility

Define catalog-family normalization and migrate install state from YA session
metadata. Add tests for empty history, each provider alias family, failed
launch, successful first launch, repeated launch, restart, and corrupted/older
install state. Do not infer eligibility from directory existence.

### 2 — introduce provider catalog and process-classifier adapters

Catalog modes, the bounded row schema, and the Pi, Grok, and OpenCode adapters
are done — those three multiplied a global scan by every project.

**Claude, Codex, and Gemini adapters are not justified by list amplification.**
Checked 2026-08-05, against the readers rather than by assumption, because this
plan previously recorded that all three were "already project-keyed on disk"
and that is only true of one:

- **Claude** is genuinely project-keyed. `sessions/reader.ts` takes a
  `sessionDir` per project and reads only that directory, so per-project cost
  scales with that project's own sessions, not the fleet's.
- **Codex is not project-keyed** — it stores
  `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, a date tree. It avoids the
  amplification a different way: `codex-reader.ts` scans through the
  module-level `codexSharedScanCache`, keyed by `sessionsDir::activeAfter`,
  with a TTL and in-flight joining, so every project's reader shares one store
  scan.
- **Gemini** is hash-keyed, and `buildProviderProjectCatalog` resolves
  `hashToCwd` once per request and hands the same map to every reader, so the
  store is enumerated once per request rather than once per project.

None of the three repeats a whole-store walk per project the way pi and Grok
did, so the 134x-shaped win is not available. An adapter for them may still be
justified later by what the *durable* catalog needs — cheap cold rows after
restart, which is a different argument from list amplification and should be
made on its own evidence, not inherited from this step.

**The process classifier is extracted.** `classifyProviderProcess` and its
three helpers now live in `services/providerProcessClassifier.ts`, so step 8's
process reconciliation can reuse recognition without depending on
`HostAgentProcessService`, its `ps` ownership, or its caching. Behavior is
unchanged and the move carries no performance claim; the false-positive cases
moved with it into `test/services/providerProcessClassifier.test.ts`, plus
coverage of the `.exe` and `gemini-cli` names and of the entrypoint window that
keeps a provider name in a later argument from classifying an unrelated
process.

### 3 — build the disk-backed catalog coordinator

Run each eligible provider once, group rows by canonical project, coalesce an
identical store generation, and retain only bounded hot shards in memory.
Persist versioned snapshots atomically in YA app data. Make interruption and
restart idempotent; a partial generation never replaces the last complete
snapshot. Give one catalog lineage a durable epoch plus monotonic generation,
and single-flight every exact row/projection derivation by source version.

### 4 — gate and deblock provider file watching

Move watcher creation after eligibility migration. Replace the synchronous
recursive initial `knownFileMtimes` build with an async/bounded baseline or a
provider catalog generation that the watcher can adopt. Never-used providers
receive neither watcher nor storage probe. Measure process spawn-to-listener,
event-loop delay, directories/files visited, and first useful catalog delta.

### 5 — serve Inbox from retained state

Replace the route's project-wide `Promise.all` with a snapshot read and
version. Publish in-place deltas as provider/project shards complete; preserve
tier ordering, notification/unread semantics, archived filtering, and the
20-row tier caps. Opening projects and sessions remains independent of Inbox
completion.

### 6 — serve global lists and stats from one retained generation

Replace per-request project/provider loops in unfiltered, starred, filtered,
and stats routes with indexed projections over the catalog generation. Apply
metadata/recap/unread/ownership deltas incrementally and preserve current sort,
pagination, project options, auto-archive, and search semantics. Two Sidebar
queries may request different memberships but cannot start two corpus scans.

### 7 — publish generations and accept interest leases

Add conditional snapshot/delta reads keyed by catalog epoch/generation. Accept
debounced, expiring session/query-window interest from capable clients; union it
across connections and prioritize exact row/hover work without making interest
the source of existence. Old clients keep the existing collection routes and
do not need to publish interest. Bound retained deltas by bytes/time; a client
older than that window receives a compact replacement snapshot.

Route focused `session-watch` acquisition through the same exact location row.
Keep its resolved-file watch/stat fallback reference-counted, but stop an
unresolved target from enumerating project provider stores every three seconds.
Catalog/file/process events retry immediately; repeated failure follows one
bounded source-level backoff and remains explicit.

### 8 — reconcile exact process ownership

After runtime reattachment, take one boot process snapshot when host process
observability is enabled, then retain one bounded periodic process-inventory
owner. Diff snapshots, subtract exact owned trees, expose unmatched recognized
roots as read-only external agents, and join a session only on exact
provider-native evidence. Initial samples may report RSS/tree metrics but no
CPU percentage until a later delta exists; later samples compute deltas without
opening unrelated provider stores.

### 9 — add pressure and lifecycle tests

Prove bounded concurrency, no duplicate provider scans, watcher teardown,
snapshot recovery after interruption, byte/age eviction, and zero repeating
transcript work after reconciliation. Test 10,000 projects with sparse sessions,
many simultaneous interest leases, and an unused provider whose native
directory exists but must never be touched.

## Compatibility review checkpoint

Changing Inbox/global lists from request-complete enumeration to a progressive
retained snapshot is an observable client/server semantic. Before editing that
contract, inspect the core 60-day stable-release corpus required by
`topics/server-capabilities.md` and present the exact field/event gate. A likely
shape is a permanent `progressive-session-catalog` capability plus additive
catalog epoch/generation/progress fields, delta events, and optional interest
leases shared by Inbox and global collections.
Without the capability, a new client must keep the old request behavior and
make no request for a new route/event; an old client talking to a new server
must still receive valid tier and session arrays from the existing routes.

Approval prompt to settle at implementation time:

> Compatibility review for progressive session-catalog reconciliation:
> releases `<60-day corpus>` lack `<catalog epoch/generation/progress fields,
> delta events, and interest leases>`. Add permanent capability
> `progressive-session-catalog`; without it
> the client keeps the existing complete-request behavior and makes no
> unsupported request. Existing provider/session capabilities and explicit
> session-detail reads remain unchanged. Approve?

## Acceptance

- A provider storage family that this YA install has never successfully used
  receives no catalog query, directory existence probe, native file watcher,
  or reconciliation work.
- Existing YA-owned provider metadata seeds migration without reading any
  provider-native store.
- Each eligible provider store is enumerated at most once per reconciliation
  generation, independent of project count.
- A first successful provider launch durably enables that family and triggers
  its first complete catalog pass; failed/auth-only probes do not.
- Inbox returns its retained snapshot without starting or awaiting global
  discovery, then updates in place as versioned shards arrive.
- Unfiltered, starred, project/search, pagination, and stats requests reuse one
  retained catalog generation; changing a filter or row limit performs zero
  provider transcript discovery and never starts a second corpus scan.
- Catalog snapshots/deltas expose a coherent epoch/generation. Identical
  requests and interest from many tabs/devices join one source-versioned
  computation; stale completion cannot overwrite newer evidence.
- Old offscreen/unowned rows may remain explicitly stale and perform no
  periodic transcript parse. Hover, viewport, or click promotes only the exact
  requested row/window.
- One unresolved focused session watch performs no fixed-interval Codex/Gemini
  project enumeration; exact catalog/file/process evidence drives repair under
  one bounded backoff.
- With host process observability enabled, one same-user boot snapshot may
  recognize any known provider and one bounded periodic owner keeps that
  inventory current, but an external process names a session only through
  exact native-id evidence and never triggers unrelated transcript scans.
- At 10,000 projects, dormant catalog state is disk-backed and live memory,
  watcher count, and work queues remain within explicit byte/concurrency
  budgets.
- Advancing a daily recent/auto-archive cutoff replaces or evicts the old range
  generation; it does not add a permanent per-project/provider cache key.
- The process-to-listener metric covers module evaluation, eligibility load,
  watcher activation, and all other pre-timer work; the old 42 ms internal
  timer is not presented as full cold boot.

### Measured adjacent concern: provider/model catalog readiness

This measurement concerns New Session's provider installation, authentication,
and model rows. It does not measure or share persisted state with this
tactical's provider-native **session-store catalog**.

Run the privacy-safe benchmark:

`pnpm --filter @yep-anywhere/server benchmark:provider-model-route`

It reads persisted provider settings and the provider marker needed for
production visibility without running settings migration or metadata restart
recovery, then drives the real aggregate and named provider routes. Missing
files mean defaults/no marker; malformed or unreadable files fail the
measurement. Configured Gateway autostart is disabled; an already-running
Gateway may be probed, but the benchmark cannot start the operator command or
inherit its output. Provider logs are suppressed; output contains only provider
names, timings, model/probe counts, and the number of suppressed diagnostics. A
post-fix smoke confirmed both persisted files remained byte-for-byte unchanged.
Five samples on 2026-08-05
measured the aggregate at 2.180 s median and 2.485 s p90 for nine providers
(236 models in the final sample), down from the earlier 6.211 s one-off result.
OpenCode remained the owner at 2.093 s median / 2.148 s p90, down from 4.407 s.
The other named medians were Claude 321 ms, Gateway 2 ms, Codex 148 ms, Codex
OSS 155 ms, Gemini 6 ms, Gemini ACP 6 ms, Grok 2 ms, and Pi 6 ms.

The result crosses tactical 094's 2 s median stop condition for reconsidering a
descriptor/refresh protocol split, but it does not by itself authorize a new
wire contract. New Session now resolves the selected provider independently,
uses a versioned stale browser snapshot for opening display, and keeps the
aggregate for the full provider-card view. Tactical 094 must therefore pair any
protocol proposal with clean-browser paint measurements and its required stable
release compatibility review rather than infer pressure from this tactical's
native-session catalog.
