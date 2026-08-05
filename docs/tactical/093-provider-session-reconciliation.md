# Add Install-Scoped Provider Catalogs and Boot Reconciliation

> Enumerate each historically used provider store once, reconcile Inbox from a
> retained snapshot in the background, and identify external harness processes
> without multiplying storage scans by project count or guessing ownership.

Status: Implementation handoff, not yet implemented. The provider/storage and
process-discovery contracts are accepted in the linked topics. This plan makes
the durable eligibility source, provider interfaces, boot ordering, and
compatibility checkpoint explicit.

Related contracts:

- [`topics/provider-abstraction.md`](../../topics/provider-abstraction.md)
- [`topics/inbox.md`](../../topics/inbox.md)
- [`topics/agents-process-observability.md`](../../topics/agents-process-observability.md)
- [`topics/session-ownership.md`](../../topics/session-ownership.md)
- [`topics/architecture-mandates.md`](../../topics/architecture-mandates.md)
- [`topics/server-performance-observability.md`](../../topics/server-performance-observability.md)
- [`089-main-thread-startup-cpu-investigation.md`](089-main-thread-startup-cpu-investigation.md)

## Current fault and measured cost

Collection routes build a provider candidate list per project.
`mayHaveGrokSessions()`, `mayHavePiSessions()`, and
`mayHaveOpenCodeSessions()` return true for every project, then their readers
rescan provider-global storage and filter by cwd. The cold `/api/inbox` probe
took 4.108 seconds and launched all-project/all-provider enumeration; at the
accepted 10,000-project scale this Cartesian shape is untenable.

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
   snapshot and classify known harness roots;
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

## Source map

| Concern | Current owner | Change |
|---|---|---|
| Install identity/history | `packages/server/src/services/InstallService.ts` | Persist eligible catalog families with atomic version migration/save |
| Successful launch boundary | `packages/server/src/supervisor/Supervisor.ts` and provider runtime proxies | Record eligibility once at the central successful start/resume boundary; avoid route-only coverage |
| YA metadata migration | `packages/server/src/metadata/SessionMetadataService.ts` | Supply existing YA-owned provider evidence after initialization; do not scan native stores |
| Project Cartesian resolution | `packages/server/src/sessions/provider-resolution.ts` | Keep explicit per-session/project reads, but replace global collection fan-out with provider catalog shards |
| Provider readers | `packages/server/src/sessions/*-reader.ts` | Implement provider-global complete/recent bounded catalog projections without full transcript detail |
| Process recognition | `packages/server/src/services/HostAgentProcessService.ts` | Keep one minimized `ps` snapshot and move provider command/id recognition behind classifier adapters |
| Early file watchers | `packages/server/src/index.ts`, `packages/server/src/watcher/FileWatcher.ts` | Activate only eligible families after state load; remove synchronous recursive boot indexing |
| Inbox route | `packages/server/src/routes/inbox.ts` | Read retained reconciled state; never own `Promise.all(project × provider)` |
| Global session lists | `packages/server/src/routes/global-sessions.ts`, `packages/server/src/routes/projects.ts` | Reuse catalog grouping for collection routes while preserving explicit detail lookup |
| Ownership | `packages/server/src/supervisor/ExternalSessionTracker.ts` | Consume exact joins; keep uncorrelated process roots separate from session ownership |

## Recommended implementation order

### 1 — persist successful-use eligibility

Define catalog-family normalization and migrate install state from YA session
metadata. Add tests for empty history, each provider alias family, failed
launch, successful first launch, repeated launch, restart, and corrupted/older
install state. Do not infer eligibility from directory existence.

### 2 — introduce provider catalog and process-classifier adapters

Define complete/recent catalog modes and a bounded row schema. Implement the
existing provider readers one family at a time, beginning with Pi, Grok, and
OpenCode because they currently multiply a global scan by every project.
Move executable/entrypoint recognition out of the generic service while
preserving transient argv minimization and current false-positive tests.

### 3 — build the disk-backed catalog coordinator

Run each eligible provider once, group rows by canonical project, coalesce an
identical store generation, and retain only bounded hot shards in memory.
Persist versioned snapshots atomically in YA app data. Make interruption and
restart idempotent; a partial generation never replaces the last complete
snapshot.

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

### 6 — reconcile exact process ownership

After runtime reattachment, take one boot process snapshot when host process
observability is enabled. Subtract exact owned trees, expose unmatched
recognized roots as read-only external agents, and join a session only on exact
provider-native evidence. Initial samples may report RSS/tree metrics but no
CPU percentage until a later delta exists.

### 7 — add pressure and lifecycle tests

Prove bounded concurrency, no duplicate provider scans, watcher teardown,
snapshot recovery after interruption, byte/age eviction, and zero repeating
work after reconciliation. Test 10,000 projects with sparse sessions and an
unused provider whose native directory exists but must never be touched.

## Compatibility review checkpoint

Changing Inbox from request-complete enumeration to a progressive retained
snapshot is an observable client/server semantic. Before editing that contract,
inspect the core 60-day stable-release corpus required by
`topics/server-capabilities.md` and present the exact field/event gate. A likely
shape is a permanent `progressive-inbox-reconciliation` capability plus an
additive snapshot version/progress field. Without the capability, a new client
must keep the old request behavior and make no request for a new route/event;
an old client talking to a new server must still receive valid tier arrays.

Approval prompt to settle at implementation time:

> Compatibility review for progressive Inbox reconciliation: releases
> `<60-day corpus>` lack `<snapshot version/progress fields and delta event>`.
> Add permanent capability `progressive-inbox-reconciliation`; without it the
> client keeps the existing complete-request behavior and makes no unsupported
> request. Existing provider/session capabilities and explicit session-detail
> reads remain unchanged. Approve?

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
- With host process observability enabled, one same-user boot snapshot may
  recognize any known provider, but an external process names a session only
  through exact native-id evidence.
- At 10,000 projects, dormant catalog state is disk-backed and live memory,
  watcher count, and work queues remain within explicit byte/concurrency
  budgets.
- Advancing a daily recent/auto-archive cutoff replaces or evicts the old range
  generation; it does not add a permanent per-project/provider cache key.
- The process-to-listener metric covers module evaluation, eligibility load,
  watcher activation, and all other pre-timer work; the old 42 ms internal
  timer is not presented as full cold boot.
