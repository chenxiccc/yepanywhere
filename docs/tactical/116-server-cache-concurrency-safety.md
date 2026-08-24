# Make Server Caches Safe Under Concurrent Async Work

Status: Codex detail plus mutable index/scanner/Gemini-store correctness slices
implemented and verified; broader server cache audit follow-ups remain planned
(2026-08-24)

## Goal

Make every retained server cache preserve one coherent source version when
requests, invalidations, file growth, eviction, and persistence overlap. Fix
the demonstrated Codex transcript double-append race first, then apply the
same ownership and publication rules to the other server caches for which the
source audit found a comparable failure mode.

This is a correctness plan, not just a cache-efficiency pass. A cache hit may
be stale within its declared contract, but concurrent cache work must never:

- append or publish the same source range twice;
- label data from one source snapshot with another snapshot's version;
- replace newer accepted state with an older completion;
- erase an invalidation or a write that arrived while work was in flight;
- let two independently loaded mutable objects both act as canonical state;
- return a mixed snapshot assembled by interleaved scans; or
- persist an older derived snapshot after a newer one.

The implementation should leave one reusable vocabulary and audit checklist,
not a different ad hoc lock in every service.

## Scope

The immediate product failure and this audit concern caches retained by the
YA server process, including derived cache files written under app data. The
plan covers:

- incremental transcript caches and sibling transcript projections;
- scan, index, statistics, and source-version memoization caches;
- mutable derived stores whose load/mutate/save sequence crosses an `await`;
- invalidation, forced refresh, eviction, reader close, and failure paths; and
- diagnostics and deterministic concurrency tests for those behaviors.

Request-local maps, synchronous memoization, and content-addressed caches with
immutable inputs are out of scope unless their publication or byte accounting
is independently unsafe. Client query and session-detail state is also out of
scope: it has a different event/reducer ownership model covered by tacticals
[`043`](043-session-detail-data-layer-plan.md),
[`046`](046-session-detail-store-boundary-refactor.md),
[`048`](048-session-detail-loaded-window-state.md), and
[`052`](052-session-detail-cache-admission.md), plus
[`topics/session-detail-data-layer.md`](../../topics/session-detail-data-layer.md).

This tactical does not authorize project-local cache storage. Any new retained
state remains app-data-only under
[`topics/project-directory-storage.md`](../../topics/project-directory-storage.md).

## Related work and contracts

- [`topics/architecture-mandates.md`](../../topics/architecture-mandates.md)
  already requires one in-flight owner per source version/key, shared waiters,
  stale-completion fencing, and owner-level failure/backoff behavior.
- [`topics/server-performance-observability.md`](../../topics/server-performance-observability.md)
  owns cache inventory and operational cache metrics.
- [`topics/server-cache-publication.md`](../../topics/server-cache-publication.md)
  owns the durable publication, invalidation, and mutable-store contracts
  established by the implemented slices.
- [`topics/codex-sessions.md`](../../topics/codex-sessions.md) owns Codex
  transcript interpretation and should receive the durable detail-cache
  contract when this work lands.
- [`038-codex-session-index-memory.md`](038-codex-session-index-memory.md)
  owns memory bounds for `CodexSessionReader.entryCache`; bounded retention
  does not make publication correct.
- [`056-summary-parser-coordination-and-session-detail-load.md`](056-summary-parser-coordination-and-session-detail-load.md)
  owns same-version full-summary parse sharing and caller coordination. Its
  promise coalescing is adjacent to, but does not serialize, entry-cache
  mutation.
- [`089-main-thread-startup-cpu-investigation.md`](089-main-thread-startup-cpu-investigation.md)
  previously observed four overlapping full parses of an identical unchanged
  Codex transcript. That is independent evidence that entry reads lack a
  shared physical-work owner; eviction alone cannot correct it.
- [`gaps/long-session-old-content-motion-recurrence.md`](../../gaps/long-session-old-content-motion-recurrence.md)
  concerns client viewport motion after old data is reinserted. It is related
  to long-session symptoms but is not this server cache race and should not be
  closed by this work.

The two commits at the head of `main` when this plan was written do not address
the server race. `751366f95` recovers client history loading from stale
pagination cursors after reload; `ed7562075` keeps a scroll-memory setting
discoverable. Current `main` still mutates the shared Codex entry array after
an unowned async range read.

## Demonstrated incident

The report concerned YA session
`01a02daf-2f75-7941-a2a7-7e63cc6c2125`. The investigation compared the
provider transcript, multiple responses from the long-lived server, its
`codex_entry_read` records, and a fresh `CodexSessionReader`. No transcript
message content is retained here.

### Provider source was complete

The durable provider file was:

```text
~/.codex/sessions/2026/08/23/
  rollout-2026-08-23T10-14-10-01a02daf-2f75-7941-a2a7-7e63cc6c2125.jsonl
```

- Raw line 17,529 was the final assistant `response_item`, timestamped
  `2026-08-24T11:44:14.872Z`.
- Raw line 17,531 was `task_complete`, timestamped
  `2026-08-24T11:44:14.911Z`.

The provider had therefore persisted both the final response and completion.

### The retained server returned a corrupt projection

- The ordinary local detail response returned 408 normalized messages and
  ended at the preceding reasoning item. The final response was absent.
- Asking for messages after that reasoning item returned zero rows.
- The compact-tail path also omitted the final response.
- A full-history response from the same process returned 9,659 normalized
  messages. It contained the final response at normalized position 9,248,
  then jumped backward in source time at position 9,249 and replayed a suffix.
- The old runtime's content/timestamp deduplication suppressed rows from the
  replayed suffix. That transformed the duplicated source range into the
  especially confusing visible shape: tools and reasoning without the final
  assistant response.

This long-running process was build `0.7.0-1039-g18716c16`, started before
commit `882e286ba` removed that content/timestamp deduplication. On current
`main`, the same underlying race is more likely to show duplicate or replayed
rows than exactly the same missing-final symptom. Removing deduplication did
not make the cache mutation safe.

### Overlapping reads explain the corrupt state

Two consecutive detail records from the affected process reported:

| Normalized messages | Returned | Read time | Total time |
|---:|---:|---:|---:|
| 9,659 | 408 | 279.4 ms | 916.1 ms |
| 9,249 | 672 | 76.1 ms | 2,080.8 ms |

Deriving request start from each record's end time and total duration puts the
starts about 12.7 ms apart near `2026-08-24T11:46:07Z`. One long-lived process
therefore observed and served two different normalized counts for overlapping
reads of the same session. The count and backward timestamp jump are direct
evidence that shared retained state changed incompatibly between the reads.

A fresh current-main `CodexSessionReader` over the same file returned all
17,531 raw entries and 9,263 normalized messages, including the final response
and completion. That separates provider persistence and current normalization
from the corrupt retained server cache. Restarting the old server would discard
the bad object, but it would not fix the race that created it.

## Direct cause on current `main`

[`app.ts`](../../packages/server/src/app.ts) retains `CodexSessionReader`
instances in a process-wide reader cache. Within one reader,
[`CodexSessionReader.readEntries`](../../packages/server/src/sessions/codex-reader.ts)
follows this incremental path:

1. `stat(filePath)` and read the shared cache record.
2. If the file grew from cached size `S` to observed size `T`, await a read of
   byte range `[S, T)`.
3. Parse that range.
4. Run `cached.entries.push(...entries)` and mutate the shared record's tail,
   size, and modification time in place.

There is no detail-read in-flight owner, per-session mutation tail, generation,
or compare-and-swap publication check around that path. Two requests can both
observe the same record at `S`, both read `[S, T)`, then both append the same
entries. The JavaScript event loop prevents simultaneous instructions; it does
not make state read before an `await` current when the continuation resumes.

The existing `inFlight` state in `codex-reader.ts` belongs to the shared
session-file scan, not `readEntries`. The exact-version full-summary promise
cache coalesces summary callers but consumes the same transcript source and
does not repair entry-cache ownership.

Two neighboring source-snapshot bugs compound the risk:

- The cold path captures `stat`, reads the JSONL file to its live end, and then
  tags all returned entries with the earlier size and modification time. If the
  provider appends between the stat and read completion, entries beyond the
  tagged byte boundary can be read again by the next incremental pass.
- `readAgentMappings` similarly captures source metadata, streams to live EOF,
  and publishes under the earlier version. A summary version check can also be
  separated by an unbounded read from the source it claims to describe.

These are source-snapshot and publication problems, not a reason to serialize
all server work globally.

## Safety model

One primitive does not fit all cache shapes. Implement three explicit ownership
patterns behind shared terminology and small reusable helpers where that
reduces mistakes.

### Immutable snapshot memoization

Use this for computations whose result is a complete immutable projection of a
source version, such as scans, statistics, and model or provider catalogs.

- The key includes the logical subject, projection options, and exact source
  version needed for correctness.
- One promise owns physical work for that key/version; equivalent waiters join
  it.
- A monotonic generation or current-source predicate gates publication. An old
  completion may satisfy a waiter that explicitly requested its version, but
  it cannot replace retained newer state.
- Cleanup removes an in-flight promise only if it is still the registered
  owner. One failed caller cannot clear a newer owner.
- Invalidation advances a generation; deleting a map entry alone is not a
  publication fence.
- A force refresh either becomes the new generation owner or records trailing
  demand. It must not merely race an older ordinary request.

The existing `SourceVersionedSingleFlight`, provider-info owner,
`ProjectPathIndex`, and `HostAgentProcessService` are reference implementations
for variants of this pattern.

### Serialized incremental derivation

Use this for the Codex append-derived transcript cache. Newer versions depend
on an accepted prefix, so independent exact-version promises are insufficient.

- One owner exists per canonical session/file identity, never one global owner.
- A request registers its target source version. Equal targets join. A newer
  target arriving during work becomes one coalesced trailing pass; demand is
  monotonic and cannot be cleared by the earlier pass.
- Source observation uses an open file handle and a portable identity/version
  record. Size and timestamps participate; device/inode can strengthen
  identity where meaningful, but correctness cannot depend on Unix inode
  semantics. A boundary probe covers replacement and coarse timestamp cases.
- Every read has a fixed byte interval from the accepted read-through boundary
  to the target observed for that pass. It never reads to live EOF under an
  earlier stat.
- Parsing builds a private candidate, and the retained record is never mutated
  during I/O. The one owner verifies that the base record and cache revision
  remain current, then publishes the transition synchronously.
- Accepted reads cover non-overlapping contiguous byte intervals. Preserve a
  provisional unterminated line separately and reparse it with the next chunk.
- A flat retained array is an acceptable first implementation when it remains
  private, only the owner mutates it, and every caller receives a copy. If a
  later consumer needs shared snapshots or profiling exposes copy costs at the
  response boundary, replace it with immutable chunks or a persistent append
  structure; do not require that abstraction for the correctness fix.
- If source growth from target `T` to `U` happens during a valid `[S, T)` read,
  the owner may accept the verified `T` prefix and immediately run `[T, U)`.
  It must not make progress depend on the source becoming quiescent.
- Truncation, replacement, representation changes, and uncertain identity
  advance the generation and trigger a fixed-boundary full parse. Compressed
  transcripts use exact-version full parses rather than append derivation.
- A `cache: false` caller may join equivalent physical work. Retention is an
  admission decision, not justification for a duplicate parse. If any joined
  waiter requests retention, the accepted result may be retained.
- Eviction and reader close respect active leases. They remove future admission
  immediately but defer destructive close until current owners and consumers
  release the reader.

The Claude transcript cache already demonstrates fixed-range reads, per-file
single-flight, provisional-tail handling, and byte-aware LRU. It is a useful
partial reference, not a direct implementation to copy: its invalidate path
also needs a generation fence, and it currently mutates retained arrays during
incremental publication.

### Serialized mutable stores

Use this when a cache owns a mutable index or durable derived mapping.

- Load has one per-key owner and publishes one canonical mutable object.
- All mutations for that key run through a mutation tail or operate on immutable
  revisions. No caller mutates an object that can lose canonical ownership.
- Dirty work is a monotonic revision, not a boolean or a `Set` that a long task
  clears wholesale. A completion acknowledges only the revision it observed;
  newer dirtiness remains pending.
- Persistence is serialized per key, writes a unique temporary file, and
  atomically renames where the platform supports the repository's existing
  cache-file contract. A write during an active write schedules one trailing
  flush of the newest revision.
- Failure preserves the last accepted in-memory and on-disk state and leaves
  current dirty demand retryable.

`SessionIndexService`'s save tail and `BatchProcessor`'s preserved trailing
demand are partial references. Neither makes the service's entire load and
invalidation lifecycle safe by itself.

## Server cache audit

The following table records source-inspection candidates, not a claim that
every row has reproduced in production. “Demonstrated” is reserved for the
Codex entry cache incident. Priorities reflect possible visible corruption,
lost updates, or indefinite staleness rather than raw CPU cost.

The audit searched server source for retained `Map`/LRU objects, cached values,
dirty flags, in-flight promises, TTLs, and persistence tails, then followed
each candidate across every `await`, invalidate/force path, and disk write. It
also inspected the client/shared matches to classify them: request-local and
client reducer/query state are excluded above, while server-owned provider and
filesystem state appears below. This is a point-in-time inventory, so step 7's
checklist remains necessary for new caches and for dynamic constructions that
a text search cannot prove exhaustive.

| Surface | Current ownership/publication shape | Failure available under overlap | Planned treatment |
|---|---|---|---|
| [`CodexSessionReader.entryCache`](../../packages/server/src/sessions/codex-reader.ts) | Shared mutable entry array; async range read; in-place append and metadata update | **Demonstrated:** duplicate source suffix, backward replay, and a missing final response on the old dedupe path | Immediate: serialized incremental derivation, immutable chunks, fixed byte bounds, generation/CAS publication |
| [Codex cold entry read](../../packages/server/src/sessions/codex-reader.ts) | Stat before an unbounded live-EOF read; result tagged with earlier stat | Append during read can put later bytes in an earlier-sized record, so the next append rereads them | Immediate with the entry owner: file-handle snapshot and fixed `[0, T)` full read |
| [Codex agent mapping and summary source reads](../../packages/server/src/sessions/codex-reader.ts) | Captured version can be separated from a live-EOF stream | Projection may be cached under a source version it did not actually read | High: consume the accepted transcript snapshot or use the same fixed-boundary owner |
| [`CodexSessionReader` process reader cache](../../packages/server/src/app.ts) | FIFO reader eviction closes without an active-use lease | An evicted reader can be closed while a request is awaiting its work | High: active lease/deferred close; coordinate with tactical 038's byte/LRU bounds |
| [Codex shared session scan](../../packages/server/src/sessions/codex-reader.ts) | One scan promise, but successful completion publishes unconditionally | TTL expiry or invalidation during a long scan can allow an older scan to repopulate state | High: generation-gated success publication and identity-checked cleanup |
| [Codex](../../packages/server/src/projects/codex-scanner.ts) and [Gemini](../../packages/server/src/projects/gemini-scanner.ts) project session scanners | Retained scan result, no per-version owner/generation | Concurrent scans are last-finish-wins; invalidation during scan can be overwritten | High: immutable snapshot memoization with trailing invalidation demand |
| [Pi](../../packages/server/src/sessions/pi-reader.ts) and [Grok](../../packages/server/src/sessions/grok-reader.ts) session readers | Scan clears and repopulates shared maps across awaits | Concurrent scans can interleave into a mixed map and bless it with a fresh timestamp | High: private scan candidate plus atomic, generation-gated replacement |
| [Gemini session reader](../../packages/server/src/sessions/gemini-reader.ts) | Scan incrementally adds to shared map; cached file hit lacks source revalidation | Concurrent scans can mix; deleted or moved sessions can remain indefinitely | High: private replacement snapshot and explicit source/TTL validation |
| [Pi parsed-session LRU](../../packages/server/src/sessions/pi-reader.ts) | Async versioned parse publishes without an in-flight owner or current-version fence | Older parse can finish after newer parse and overwrite retained value; duplicate work | Medium: exact-version single-flight and current-source publication check |
| [`SessionDiscoveryIndex` shards](../../packages/server/src/indexes/SessionDiscoveryIndex.ts) | One registry owner per process/root, one cold-load promise per shard, serialized atomic saves | **Fixed in mutable-store slice:** concurrent cold upserts share the canonical shard; scanner, reader, and watcher paths no longer write through separate in-process owners | Landed: shared registry plus per-shard load owner; later byte/LRU release remains |
| [`SessionIndexService` load/update](../../packages/server/src/indexes/SessionIndexService.ts) | One cold-load owner per scope; every dirty mark advances a revision | **Fixed in mutable-store slice:** cross-API cold calls share one index, and incremental/full/single validation cannot erase a newer invalidation | Landed: single-owner load and revision-based dirty acknowledgement |
| [`ProjectScanner`](../../packages/server/src/projects/scanner.ts) | One in-flight scan plus monotonic invalidation and accepted revisions | **Fixed in mutable-store slice:** a watch event during scan prevents the older completion from becoming retained fresh state | Landed: revision-gated publication; an original caller may receive its coherent pre-event scan while the next read refreshes |
| [`ProjectScanner` disk snapshot](../../packages/server/src/projects/scanner.ts) | One active writer with one latest trailing snapshot; unique temp plus rename | **Fixed in mutable-store slice:** writes cannot overlap or publish an invalidated revision | Landed: serialized coalesced atomic replacement |
| [Global session statistics](../../packages/server/src/routes/global-sessions.ts) | One in-flight compute, mutable `statsDirty`; completion always clears dirty | Session event during compute is lost until the next TTL expiry | High: generation/revision-owned snapshot compute |
| [`GlossaryIndexService`](../../packages/server/src/projects/glossaryIndexService.ts) | Request and canonical single-flights; invalidate deletes maps but cannot cancel old publication | Pre-invalidation work can repopulate parsed or compiled caches afterward | Medium: governing-source generation on every publication path |
| [`GitUntrackedCacheService`](../../packages/server/src/services/GitUntrackedCacheService.ts) | Shared load/refresh and serialized persist, but selected rechecks replace a common snapshot | Concurrent disjoint selected rechecks can lose each other's removals or `checkedAt` updates; regressed snapshot can persist | High: per-project mutation tail or revision/CAS merge |
| [Gemini project map](../../packages/server/src/projects/gemini-project-map.ts) | One initial-load owner and one candidate-based mutation/write tail with atomic replacement | **Fixed in mutable-store slice:** overlapping process-local mutations cannot finish out of order or lose an accepted durable mapping | Landed: reads wait queued mutations; failed persistence leaves the previous accepted map and later mutations remain runnable |
| [Session sandbox availability](../../packages/server/src/session-sandbox.ts) | Ordinary calls coalesce; forced call starts a second request; both publish unconditionally | Older ordinary completion can overwrite the forced result | Medium: forced generation owner, matching provider-info semantics |
| [Git blame cache](../../packages/server/src/git/blame.ts) | Validator captured before async Git/highlight work; completion always inserts | Late result from older working-tree state can replace newer retained blame until next access | Medium: validator/current-source check at publication |
| [Claude transcript cache](../../packages/server/src/sessions/claude-transcript-cache.ts) | Per-file owner and fixed ranges; invalidate only deletes retained entry | In-flight completion can undo invalidate; retained array mutates in place | Medium hardening: generation-fenced invalidate and immutable publication |
| Internal provider model/probe caches | Mixed promise and TTL patterns, often wrapped by a safer outer provider owner | Mostly duplicate work; selected old probes can repopulate internal state after invalidate | Lower: audit at provider refresh boundaries; keep outer source-version owner authoritative |
| [Device](../../packages/server/src/device/DeviceBridgeService.ts), update, and [remote-home](../../packages/server/src/sdk/remote-spawn.ts) TTL caches | Little or no per-key single-flight/generation | Duplicate network/SSH work and short-lived stale display; remote-home values may retain indefinitely | Lower: adopt snapshot owner where operational cost or staleness warrants it |

### Patterns inspected and not currently classed as unsafe

- `SourceVersionedSingleFlight` gates accepted publication by source version and
  checks promise identity when cleaning up.
- `ProjectPathIndex` gates probes and listings on watcher, attachment, registry,
  and request generations.
- `HostAgentProcessService` increments a generation on clear and publishes only
  from the current owner.
- The provider subscription-usage route uses promise identity so an older
  completion cannot overwrite a forced request. Provider-info uses a stronger
  source-versioned owner.
- `ExternalSessionTracker`'s `BatchProcessor` prevents the same key from running
  in overlapping batches and preserves one trailing pending task.
- OpenCode CLI session listing caches a promise by binary path, so callers in
  the same window share the physical CLI request.
- The highlight cache is content-addressed from immutable input. Concurrent
  misses can duplicate CPU, but its replacement byte accounting handles
  same-key publication.
- Bang-command completion's single global slot can thrash between keys, but it
  does not mix the response returned to either caller.

These examples belong in the review corpus so the implementation does not
rewrite already-correct ownership merely for uniformity.

## Implemented correctness slice

The first 2026-08-24 implementation deliberately uses the small mechanism
selected after the audit rather than introducing a universal cache framework:

- `CodexSessionReader` has one in-flight entry-read owner per session id.
- A cache hit remains lock-free. On a miss, one caller owns the complete stat,
  bounded read, parse, and cache update; overlapping callers await that promise
  and recheck the accepted cache afterward.
- The existing flat entry array remains encapsulated and is mutated only by
  that owner. All callers continue to receive a copied array.
- Plain cold reads now consume exactly `[0, observedSize)`, and append reads
  consume exactly `[cachedSize, observedSize)`. The range helper completes the
  requested byte count or fails instead of publishing a mismatched boundary.
- A complete final JSON record is accepted without requiring a newline; an
  incomplete final record remains provisional for the next append.
- `invalidateCache()` advances a revision before clearing entries. An active
  owner from an older revision discards its result and the requesting read
  retries; invalidation does not create a second concurrent writer.

Three barrier-controlled regressions cover the incident shape, growth during a
cold read, and invalidation during an append read. The overlap regression seeds
the cache, appends reasoning/final-assistant/completion records, starts two
detail reads, proves the second joined the first, and observes one physical
range read plus exactly one final response and completion in both results and a
later retained read. No sleeps or reporter transcript data are used.

This slice closes the demonstrated in-reader double append. It does not close
the audit rows for sibling projections, reader eviction, scanners, indexes, or
other cache owners, and it does not claim that non-retaining summary reads join
detail-cache work. Those remain in the work plan below.

## Implemented mutable-store slice

The second 2026-08-24 slice converted the two follow-up areas selected after
the initial audit without introducing a universal cache framework.

Barrier-controlled diagnostics first proved five schedules against the old
implementation:

1. an older Gemini save overwrote a newer map while memory concealed the lost
   durable entry;
2. concurrent cold discovery-shard upserts mutated separate objects and
   persisted only one record;
3. two independent in-process discovery-index owners overwrote each other's
   complete shard state;
4. list and single-summary APIs cold-loaded different mutable summary indexes,
   after which one successful caller's rows disappeared; and
5. invalidation during summary validation or project scanning was cleared by
   the older completion.

The landed mechanisms are intentionally small and surface-specific:

- `SessionDiscoveryIndex` shares one cold-load promise per shard, while a
  startup-owned registry supplies the same logical index to Codex scanners,
  readers, and watcher-side resolution.
- `SessionIndexService` shares one cold load across every API for a scope. Each
  dirty mark advances a scope revision; incremental, full, and single-summary
  work acknowledges dirty state only if that revision remains unchanged.
- `ProjectScanner` publishes a completed scan only under the invalidation
  revision it started with. Its disk writer serializes saves, coalesces the
  latest trailing snapshot, discards invalidated revisions, and uses unique
  temp files plus rename.
- `GeminiProjectMap` shares its initial load and serializes complete
  load/candidate-mutation/atomic-persist operations. Memory changes only after
  durable replacement succeeds, and a failed operation does not poison the
  mutation tail.

Permanent regressions use barriers rather than sleeps. They cover one physical
cold load, cross-API canonical state, invalidation during incremental and full
validation, invalidation during a project scan, ordered project-snapshot
writes, and restarted Gemini state after overlapping updates.

These owners are process-local. Atomic replacement prevents partial files, but
this slice does not claim that independent YA processes sharing one data
directory form a distributed merge protocol. The discovery index is derived
and non-authoritative; the Gemini map rejects failed local persistence instead
of advertising an uncommitted mapping.

## Work plan

### 1 — preserve the Codex double-append failure as a deterministic regression

Add an injected read barrier or controlled file adapter; do not use sleeps.
The focused test should:

1. seed an accepted cache at byte boundary `S`;
2. append a suffix containing representative tool, reasoning, final assistant,
   and completion rows;
3. pause the physical `[S, T)` range read;
4. issue two parallel detail reads through the owning public path;
5. release the read and assert one physical range read, identical ordered
   results, and exactly one copy of every provider row;
6. assert both the normalized final assistant response and completion appear
   in full history, compact tail, and pagination after the preceding item; and
7. make a third read and prove the retained snapshot remains exact.

Keep the production evidence in this tactical, but build the test from a small
synthetic transcript. Do not check in the reporter's transcript or content.

Add companion barriers for a cold read while the provider appends, an
unterminated/torn final line, and growth during an active append pass.

### 2 — establish source snapshots and keyed ownership primitives

Define the small shared concepts before changing call sites:

- portable file snapshot and fixed-range reader;
- monotonic generation/revision token;
- immutable accepted-value publication with current-source/CAS predicate;
- keyed single-flight for independent immutable projections; and
- keyed serialized derivation with coalesced trailing target for dependent
  append work.

Prefer extending `SourceVersionedSingleFlight` only where its independent
snapshot semantics fit. Do not overload it with mutable-prefix behavior that
would obscure either contract. Keep keys explicit and instrumentable.

Unit-test owner identity cleanup, older/newer completion order, failure and
retry, invalidation during work, trailing demand, and eviction while owned.

### 3 — serialize and atomically publish Codex transcript derivation

The implemented detail-cache slice moves retaining `readEntries` calls behind
the per-session incremental owner, keeps in-place append private to that owner,
and preserves a separate provisional tail. Cold and append passes read fixed
byte targets, and cache revision plus base-object identity gate publication.

If later work exposes the retained array outside the reader or needs snapshots
that survive later appends without copying, replace it with immutable accepted
chunks. Do not copy the entire transcript merely to make publication appear
immutable.

Make all detail consumers share equivalent physical work even when their cache
retention choices differ. Preserve bounded admission from tactical 038 and
avoid an O(total transcript size) array copy on each append.

On truncate, replace, boundary mismatch, compressed representation, or unknown
identity, invalidate the generation and run a fixed-target full parse. A stale
completion may return only where its caller explicitly requested that stable
snapshot; it cannot publish over current retained state.

### 4 — align Codex sibling projections and reader lifecycle

Build agent mappings and compatible detail/summary projections from the same
accepted transcript snapshot, or give them an equally strict fixed-source
owner. Ensure an exact-version summary cache never labels a live-EOF read with
an earlier source version.

Add active-use leases to the app's reader cache. Eviction removes admission and
retention but defers close until no owner or request uses that reader. Reconcile
the lifecycle with tactical 038's open byte/LRU work and tactical 056's summary
parser coordination rather than adding another independent queue.

### 5 — make indexes, scans, and statistics generation-safe

Apply immutable snapshot ownership or revision acknowledgement to the
remaining surfaces; the entries marked landed were completed in the mutable
store slice:

- Codex/Gemini provider scanners and Pi/Grok/Gemini session scans;
- `SessionDiscoveryIndex` cold loads — **landed**;
- `SessionIndexService` loads, incremental dirtiness, and full validation —
  **landed**;
- `ProjectScanner` memory and disk snapshots — **landed**; and
- global session statistics.

For every service, define what invalidation during work means, whether an old
snapshot may still be returned to its original waiter, and how newer demand is
preserved. Replace `dirty = false`, `dirty.clear()`, or equivalent broad cleanup
with acknowledgement of the exact observed revision.

### 6 — serialize remaining mutable cache and derived-store writers

Close the confirmed publication gaps in glossary indexes, Git untracked state,
sandbox availability, Git blame, and Claude transcript invalidation. Gemini
project mapping's process-local mutation and persistence owner is **landed**.
Use per-key mutation/write tails where state is mutable and source-version
owners where results are immutable.

Treat Gemini project mapping carefully: it is durable identity state adjacent
to the cache audit, not a disposable projection. Its concurrency tests must
prove entries survive restart after overlapping updates.

Keep lower-risk provider/network TTL work in the same audit checklist, but do
not let it delay the correctness-critical transcript, index, and scanner
changes. Open a narrower follow-up tactical if those low-risk conversions make
this series too broad.

### 7 — expose ownership, stale publication, and trailing demand

Extend `codex_entry_read` and the server cache registry with bounded,
content-free evidence:

- hit, joined, append, full, stale-discarded, trailing-pass, and unretained
  outcomes;
- logical target and accepted source versions or opaque generations;
- source and parsed byte counts;
- owner and waiter counts;
- stale completion and boundary-mismatch counts; and
- retained bytes/chunks plus active and deferred-close readers.

Do not log transcript content or private paths. Session identifiers should
follow the existing diagnostic redaction/hash policy. Add comparable generic
owner metrics to other converted caches rather than unique ad hoc log events
for every service.

Add a code-review checklist to the owning cache/observability topic:

1. Is the key complete for subject, projection, options, and source version?
2. Is source observation the same bounded snapshot the computation consumes?
3. Is there one physical owner and do equivalent callers join it?
4. Can newer demand arriving during work be lost?
5. Is publication immutable or guarded by generation/CAS?
6. Can invalidate, force, clear, or TTL expiry be undone by an old completion?
7. Does cleanup check owner identity?
8. Can eviction or close invalidate active work?
9. Are durable writes serialized and atomically replaced?
10. Can metrics distinguish useful hits, joined work, stale discards, and
    unretained work?

### 8 — publish observable contracts and verify cross-platform behavior

Update the owning `topics/*.md` contracts as each behavior lands. At minimum,
publish the Codex fixed-snapshot/incremental-read contract, general server cache
ownership rules, invalidation semantics, and retained cache observability.

Run focused deterministic concurrency tests plus the owning route/service
suites. The final Codex route regression must exercise parallel HTTP detail
requests, not only private owner methods. Cover:

- equal-target join and one physical read;
- append during read with one trailing pass;
- cold read bounded to its observed target;
- partial-line continuation;
- truncate, replace, and representation change;
- invalidate, force, evict, and close during work;
- stale completion order and failed-owner retry;
- compact tail and cursor pagination containing the final response exactly
  once;
- concurrent cold shard upserts and cross-API index loads;
- invalidation during scan, validation, and stats computation;
- disjoint Git untracked rechecks and concurrent durable mapping writes; and
- restart recovery from every changed derived cache file.

Use portable filesystem APIs and capability-gated assertions on Linux, macOS,
and Windows. Tests may use inode/device identity as an additional observation
where supported but must also exercise the portable size/timestamp/boundary
fallback. Do not assume rename, open-handle replacement, path case, or watcher
delivery behaves identically across platforms.

For performance evidence, follow
[`topics/performance-regression-suite.md`](../../topics/performance-regression-suite.md).
At minimum, compare physical transcript reads, parsed bytes, wall time, and
retained bytes for one caller versus overlapping callers. Correctness must not
come from a global lock or an O(total-history) append copy.

## Acceptance criteria

This tactical is complete when:

- the synthetic form of the reported race fails on the old implementation and
  passes deterministically with exactly one physical append read;
- parallel session-detail requests cannot duplicate, reorder, or omit a final
  Codex response through full history, compact tail, or pagination;
- cold and incremental transcript reads consume and publish one bounded source
  snapshot, including partial-line behavior;
- invalidation, force refresh, truncate/replace, eviction, and reader close
  cannot be undone by a stale completion;
- dirtiness and writes arriving during index/scan/persistence work remain as
  one coalesced trailing obligation rather than being erased;
- every high-priority audit row has either landed ownership tests and a durable
  contract or a concrete scoped follow-up with its deferral reason;
- cache diagnostics show joined work, stale discards, trailing passes, source
  bytes, and retained size without revealing transcript data;
- focused and full affected-area checks pass warning-free; and
- cross-platform coverage or explicit capability gates demonstrate that the
  fix does not depend on the current macOS filesystem model.

## Design questions to resolve during implementation

- Whether the immutable Codex append representation should be a chunk ledger,
  a persistent vector, or another structure. The required property is cheap
  append with immutable published boundaries, not a particular container.
- Whether source snapshot helpers belong in a filesystem utility or beside the
  cache owner. Keep platform-specific identity evidence internal to the helper.
- Whether a stale but internally coherent snapshot can be returned to its
  original caller after invalidation. Decide per surface and document it; it
  must never become retained current state.
- Whether non-retaining callers can promote an in-flight result when a retaining
  waiter arrives. Prefer one owner with aggregate admission demand if it avoids
  duplicate parses without retaining unrequested data.
- Which low-risk TTL caches merit conversion in this series. Correctness and
  durable-state rows take precedence over short-lived version-display staleness.

None of these questions changes the core invariant: a cache continuation must
prove it still owns the source version and publication slot it observed before
its first `await`.
