# Attribute and Explain Sustained `MainThread` CPU

> Determine which process a system monitor labels `MainThread`, measure whether
> its high CPU is bounded startup work or a sustained loop, and identify the
> owning YA subsystem before proposing a fix.

Status: Investigation completed 2026-08-05. The observed `MainThread` was YA's
Node server. It stopped answering before the operator's manual `reyep --full`,
then aborted with `SIGABRT` near V8's measured heap limit. Heap exhaustion is a
strong inference, not a proven fatal string. The replacement never reached
quiescence: process-list provider-child enrichment repeatedly full-parsed
unchanged Codex rollouts with caching disabled. A second isolated heap path is
the monolithic public-share store. Cold production measurements also locate
global Inbox reconciliation and recursive glossary watching on the first-page
critical path. A later New Session probe found a 6.21-second all-provider model
barrier dominated by unselected OpenCode discovery and a separate 6.50-second
recent-session enrichment request used only to choose a project. The owning
production corrections are specified below but not implemented here. A final
cold-client/server-graph pass found uncompressed effectively uncached static
assets, eager all-route client bundles, a 305-module pre-bind server graph, and
21 concurrently started New Session requests. The adjacent stale-dev-tree
defect was fixed in `f3efacfa`; the bind-provenance follow-up is included with
this investigation.

Related contracts:

- [`topics/architecture-mandates.md`](../../topics/architecture-mandates.md)
- [`topics/agents-process-observability.md`](../../topics/agents-process-observability.md)
- [`topics/reload-safe-provider-runtimes.md`](../../topics/reload-safe-provider-runtimes.md)
- [`topics/provider-child-sessions.md`](../../topics/provider-child-sessions.md)
- [`topics/codex-sessions.md`](../../topics/codex-sessions.md)
- [`topics/server-performance-observability.md`](../../topics/server-performance-observability.md)
- [`topics/client-asset-delivery.md`](../../topics/client-asset-delivery.md)
- [`topics/ui-architecture.md`](../../topics/ui-architecture.md)
- [`topics/memory-growth.md`](../../topics/memory-growth.md)
- [`topics/inbox.md`](../../topics/inbox.md)
- [`topics/project-path-links.md`](../../topics/project-path-links.md)
- [`topics/glossary-tooltips.md`](../../topics/glossary-tooltips.md)
- [`topics/session-hovercard-recent-activity.md`](../../topics/session-hovercard-recent-activity.md)
- [`topics/session-catalog-observation.md`](../../topics/session-catalog-observation.md)
- [`topics/provider-abstraction.md`](../../topics/provider-abstraction.md)
- [`topics/session-defaults.md`](../../topics/session-defaults.md)
- [`031-client-query-controller.md`](031-client-query-controller.md)
- [`022-api-response-compression.md`](022-api-response-compression.md)
- [`091-project-path-cache.md`](091-project-path-cache.md)
- [`092-demand-driven-glossary-discovery.md`](092-demand-driven-glossary-discovery.md)
- [`093-provider-session-reconciliation.md`](093-provider-session-reconciliation.md)
- [`094-new-session-provider-catalog-readiness.md`](094-new-session-provider-catalog-readiness.md)
- [`095-new-session-recent-project-readiness.md`](095-new-session-recent-project-readiness.md)
- [`096-client-route-module-loading.md`](096-client-route-module-loading.md)
- [`097-server-bootstrap-module-staging.md`](097-server-bootstrap-module-staging.md)
- [`098-heartbeat-candidate-scheduling.md`](098-heartbeat-candidate-scheduling.md)
- [`099-retained-source-review-inbox.md`](099-retained-source-review-inbox.md)

## Evidence already established

| Time / fact | Evidence and conclusion |
|---|---|
| 22:05:43.790 UTC | Last old-process `server.log` record is ordinary file-change forwarding; no graceful shutdown or fatal record follows. |
| 22:05:47–22:05:53 | Old YA PID `4150191`, named `MainThread` by coredump metadata, aborted with `SIGABRT`. Core storage was disabled by resource limits. |
| 22:07:02 | Atuin records the operator's `. ~/local.sh; reyep --full`; this is roughly 69–75 seconds after the abort. The helper sends `SIGTERM`, then at most `SIGKILL`, never `SIGABRT`, so the manual restart did not cause this abort. |
| 22:07:09–22:07:12 | New PID `334450` logged configuration and began serving. |
| Memory | The runtime's measured V8 heap limit is 4.1875 GiB. Old logs reached about 3.815 GiB heap and 5.116 GiB RSS. |
| Host pressure | Kernel journal has no contemporaneous OOM, disk, or stall event; `/proc/vmstat` reported `oom_kill 0`. After restart the host had about 107 GiB available, no active swap-in/out, and YA `VmSwap: 0`. |
| Recurrence | Nine minutes after restart, the replacement had about 4.45 GiB RSS, 116% CPU, and 44.8 GB read characters. |

The exact fatal V8 text is unrecoverable because terminal history had rolled
over and no core was retained. Record the incident as a demonstrated
`SIGABRT`, strong V8-heap-exhaustion inference, and demonstrated read
amplification—not as a kernel OOM or a proven V8 fatal message.

The clearest amplification evidence is server-owned Codex transcript reading:

- the final bounded 50 MB of logs contains 1,154 cache-miss reads of one
  roughly 276.6 MB transcript (about 294.9 logical GiB of input) and 880 misses
  of one roughly 39.7 MB transcript (about 32.0 logical GiB);
- four overlapping read-only misses parsed the exact same unchanged
  39,709,942-byte snapshot while starting around 3.69 GB heap; and
- scanner-level shared work can report `sharedCacheStatus: "in-flight"`, but
  entry reads did not coalesce these identical in-flight parses.

This makes identical-read coalescing and bounded/incremental handling of a
growing transcript the first owning-invariant leads. Cache eviction can contain
pressure but must not replace those fixes.

The out-of-band maintenance endpoint was unavailable by configuration, not a
transient bind failure: `MAINTENANCE_PORT` currently defaults to `0`, and the
server starts the listener only when nonzero. Contributor docs that imply a
default `PORT + 1` / `3401` listener are stale and should be reconciled in the
investigation.

The operator's report that Cache Billing has effectively never fired concerns
provider prompt-cache accounting. It is separate from the profuse
`codex_entry_read` cache misses above. Instrument prompt-cache eligibility
stages before changing its detector: usage observation, expected-warm state,
missing provider usage fields, threshold-unclassified observation, and emitted
outcome.

## Completed investigation result

### Exact process and `top` attribution

The replacement development launch had this stable ownership shape:

```text
scripts/dev.js                         YA wrapper
├─ codex-runtime-host.mjs              YA host: Codex
│  └─ node launcher → codex app-server Codex harness, one subtree/session
├─ provider-runtime-host.mjs           YA host: providers
├─ pnpm → safe-home → tsx → src/index  YA Hono server
│  └─ summary-parser-worker-entry.ts   YA parser worker(s)
└─ pnpm → safe-home → Vite → esbuild   YA client/build tooling
```

PID `334450` was the Hono server throughout the measurement. Linux reported
its short command name as `MainThread`, as it did for the Node wrapper, hosts,
launchers, and parser workers. `MainThread` is therefore not an owner label;
PID, parentage, cwd, socket, and sanitized argv classification supplied the
attribution. The Rust `codex` app-server processes and their helpers were
separate descendants of the Codex host. Unrelated Bun services were sleeping
at the observation point (zero sampled CPU and roughly 32–34 MiB RSS each) and
were not in the YA tree.

[`pstree.sh`](../../pstree.sh) now reconstructs this view after PID-changing
restarts. It prints the exact `COMMAND` name used by `top`, a sanitized owner,
and direct versus descendant-inclusive sampled CPU, VIRT, and RSS. Direct
`RES` in `top` is resident set size (RSS): physical pages currently resident
for that process. VIRT is mapped/reserved address space, not consumed physical
memory. The script's `Σ` tree columns are attribution sums and can double-count
shared pages or mappings.

### Startup-to-repeating-work curve

The replacement started around 22:07 UTC. Bounded discovery and host
reattachment completed, but the process did not enter a quiescent phase:

| Phase / observation | Direct Hono result |
|---|---|
| About nine minutes after restart | 116% CPU, about 4.45 GiB RSS, and 44.8 GB cumulative `rchar`. This `/proc` counter is distinct from the operator's separate observation of roughly 45 GiB VIRT shortly after launch. |
| 22:44–22:54 UTC, 37–47 minutes after restart | 246.6% average CPU: 218.3% user and 28.2% system. Per-minute averages remained 210.2–265.8%; no monotonic decay. |
| Same ten-minute window | 107.3 MiB/s `rchar` but only 0.02 MiB/s physical `read_bytes`; 0.256% host I/O wait, zero process major faults, and no host swap-out. |
| Same ten-minute window | RSS oscillated 3.56–5.01 GiB; VIRT oscillated 46.59–48.03 GiB rather than growing monotonically. Minor faults averaged about 100,500/s. |
| Thread attribution | Four `V8Worker` threads used 152.3% CPU combined, the OS-named `MainThread` 91.0%, and libuv workers 3.2%. |

The oscillating RSS/VIRT and heavy V8-worker CPU are a parse/allocation/GC
sawtooth. Near-zero physical reads and I/O wait reject storage latency as the
CPU owner. A short `top` sample later reached much higher instantaneous CPU,
but the ten-minute cumulative deltas are the stable comparison.

A later 30-minute map census makes the VIRT result stronger. Across 361
samples, direct Hono VIRT ranged from 46.87-48.65 GiB (47.56 GiB first, 47.47
GiB last), RSS ranged from 3.715-5.513 GiB, and `VmSwap` stayed zero. Five
anonymous `PROT_NONE` mappings of exactly 8,589,996,032 bytes remained stable;
together they account for about 40.96 GiB. Source tracing and a bounded
`mmap` trace identify them as V8 WebAssembly backing-store guard reservations.
They reserve address space but do not commit equivalent RAM and are not the
4.19 GiB V8 JavaScript heap. Development `tsx`/module loading instantiates
several such guards; the built production server still reserved about 20 GiB
VIRT but avoided part of that development-loader multiplier.

The operator's observation of roughly 45 GiB VIRT shortly after launch was
therefore accurate but is not evidence of a 45 GiB heap or continuing physical
growth. The 30-minute sample rejects monotonic VIRT growth in that interval.
It does not make the 3.7-5.5 GiB RSS sawtooth safe: RSS and V8 heap headroom are
the relevant exhaustion signals.

The server subtree also contained two Node parser workers. In one operator
snapshot, direct Hono was about 47.4 GiB VIRT / 4.4 GiB RSS while Hono plus the
two workers was about 99.4 GiB `ΣVIRT` / 4.6 GiB `ΣRSS`; each worker reserved
about 26 GiB of virtual address space. Those sums explain why a whole YA tree
looks much larger than Hono's row, but the sustained CPU and `rchar` measured
above belonged directly to Hono.

### Repeating owner and trigger

The surviving falsifiable hypothesis is a concrete request-to-read chain:

1. `useProcesses` revalidates the retained
   `/api/processes?includeTerminated=true` query on `session-updated` as well
   as process, reconnect, creation, metadata, and explicit refresh events.
2. `createProcessesRoutes` enriches every active and recently terminated row.
3. `enrichProcessInfo` calls `reader.listProviderChildSessions` for each row.
4. `CodexSessionReader.listProviderChildSessions` calls `readEntries` with
   `purpose: "agent-mapping"` and `cache: false`, then scans the complete entry
   array for `spawn_agent` calls and outputs.

The scanner's shared cache and the detail-entry cache do not own this call.
The method deliberately bypasses the existing streaming `readAgentMappings`
projection and its instance cache. By 23:04 UTC the replacement had logged
1,707 read-only agent-mapping misses totaling 273.55 logical GiB. The two
large parents contributed 943 reads / 243.29 GiB and 762 reads / 30.01 GiB.
One unchanged 264.27 MiB snapshot was parsed 656 times over 34 minutes. Detail
reads, by contrast, recorded ordinary append/hit behavior and only about 0.44
GiB of logical input.

This arithmetic accounts for the observed `rchar` and predicts the behavior:
generic session progress causes another process query; every eligible process
row causes another full parent parse; parse cost grows with parent rollout
size even when no provider child changed. Removing clients would remove that
request trigger, while keeping the client but replacing provider-child
discovery with a versioned projection would remove the full parses. An
intrusive live CPU profile was unnecessary after the structured counters,
thread deltas, and owning source agreed.

Rejected alternatives:

- **Kernel OOM or swapping:** no OOM event, no process swap, no swap-out during
  the sample, and ample host memory after restart.
- **Disk wait:** physical reads and I/O wait were negligible while CPU and
  logical reads remained high.
- **Codex/Bun harness CPU:** those were different PIDs and their sampled CPU
  was far below Hono's.
- **Bounded startup discovery:** the identical full reads continued 47 minutes
  after startup phases completed.
- **Summary-worker isolation:** workers add tree memory and do other summary
  work, but the 273.55 GiB `agent-mapping` reads and V8 CPU occurred in Hono.

### Owning correction and regression

Process-list enrichment must consume a bounded provider-child summary, never a
full transcript entry array. The located correction is to replace Codex
`listProviderChildSessions` with a shared projection keyed by canonical rollout
identity and observed version. Identical versions share one in-flight build;
completed entries are bounded and retain only spawn/lifecycle facts; appends
resume from the prior byte boundary with partial-line state. Replacement or
truncation invalidates the version. Failure removes the in-flight promise so a
later call may retry. Reader instances and routes that refer to the same
rollout must share this owner rather than manufacturing per-request caches.

The regression seam is the public process route: against one unchanged large
Codex parent, repeated process refreshes may perform at most one initial
child-projection build and zero full-entry parses. An ordinary non-child append
must inspect only the appended range; a new spawn/lifecycle append must update
the child summary without retaining the complete entry array. The same test
should include active and recently terminated rows because both are enriched.

In-flight coalescing alone is an immediate containment but not the complete
fix: it does not stop sequential generic progress events from reparsing the
same unchanged snapshot, and a full-entry cache would retain exactly the large
arrays under pressure. Removing `session-updated` from the whole process query
would also stale legitimate process state. The provider-child projection is
the first owning invariant.

### Second heap-exhaustion path: the public-share aggregate

The live `public-shares.json` was 501,910,755 bytes and held 46 still-valid
links: 28 frozen snapshots and 18 live records. An isolated load of that exact
file retained about 1.66 GiB of V8 heap after parsing. Pretty-stringifying the
unchanged state for a save raised live heap to about 2.66 GiB and the process
peaked near 3.76 GiB RSS. That is enough to collide with a 4.19 GiB heap limit
when the same process also holds transcript caches or a several-hundred-MiB
parse transient.

This establishes a second concrete path to the incident class; it does not
prove a public-share save was the historical abort trigger. The file's mtime
does not place a save in the fatal window, while the transcript amplification
is directly recorded there.

The aggregate is canonical share authorization and frozen content, not a
rebuildable cache, so pressure eviction cannot safely discard it. The owning
correction is the session-sharded, active-link-gated design in
[`topics/public-share-persistence.md`](../../topics/public-share-persistence.md):
load the compact active-link index, then only the requested session/link
record; revoked shares cease authorizing reads and their snapshots become
collectible. Saving one link must never parse and stringify every other
session's frozen transcript.

### Cold production boot and first session display

The original internal startup timer understated full boot because it begins
after module evaluation, provider version probing, and synchronous provider
file-watcher construction. Two built-server runs reported 36-42 ms inside that
late timer and 40-47 ms through localhost listener `onReady`; a valid external
measurement from process spawn to the first successful static response was
1,859 ms. Once listening, the static document response itself took about 4 ms.
Core construction inside the timer is not the bottleneck, but the roughly
1.8-second pre-timer/process-start interval is part of cold-load latency.

One concrete pre-timer owner is `FileWatcher.start()`: for every existing
Claude, Gemini, Codex, and Pi root it synchronously recursively populates
`knownFileMtimes`, then attaches a recursive native watcher. Repeating those
four scans and watcher attachments directly took about 0.46 seconds on
warm host caches. It is a material component, not a complete attribution of the
remaining interval. The startup clock must move to process entry, and provider
watching must become eligible, asynchronous reconciliation rather than hidden
work before the clock.

A second warm probe instrumented the built entrypoint before its imports. The
server module graph and top-level setup took about 566 ms before the first
Codex PATH/version-discovery subprocess began. An isolated built-module call
then took 8 ms to import the CLI detector and 155 ms to find/version Codex. The
`NO_BACKEND_RELOAD` recursive source watcher added about 39 ms in a standalone
attach. Together with provider watching, these figures account for about 1.22
seconds before `startServer()` began in the instrumented warm run. The
remaining difference from the external cold run includes process bootstrap,
cold module I/O, and run-to-run variance.

The static server graph explains why module evaluation is material. `index.ts`
has 55 direct imports, `app.ts` 133, and the provider index 14 while importing
every implementation. An esbuild reachability probe from the built entry found
305 internal modules, including 69 routes and 3.84 MB of input source; an
internal-only bundle was about 2.96 MB before external packages. The graph also
reaches the Claude and Agent Client Protocol SDKs, Shiki, KaTeX/Markdown,
bcrypt, Web Push, and other optional owners before a route selects them.

Root/barrel imports amplify this. `@yep-anywhere/shared` exposes one root that
re-exports almost the whole package; server source contains 188 root imports
across 169 files. The service and provider indexes repeat the pattern.
Production Node's ECMAScript Module runtime evaluates modules reached through
static imports rather than applying browser-bundler tree shaking. Narrow
additive shared subpath exports, side-effect-free provider descriptors, and
demand route/provider groups are the measured handoff in tactical 097.

The immediate cold-bind candidates are therefore separable: start the clock at
process entry; move the advisory Codex version warning and source watching
after bind; eligibility-gate and asynchronously baseline provider watches; and
measure a bundled or lazily imported production server graph. Optional
providers, voice backends, sharing/review support, and other nonessential
routes should not have to evaluate before the selected-session API is useful.
Binding static HTML alone is not success if its session API remains blocked, so
the externally visible readiness metric must include one useful session route.

A fresh browser then opened a 44,026,530-byte Codex session with glossary hints
off:

| Milestone | Time from client hook start |
|---|---:|
| Session API response | 3,075 ms; request duration 2,760 ms |
| Session data ready | 3,158 ms |
| Transcript commit effect | 3,265 ms |

The owning transcript read took 477 ms: 333 ms reading and 133 ms parsing
13,617 entries, adding about 160 MiB heap and 175 MiB RSS during the recorded
operation. Client preprocessing took only 9.3 ms; the observed render commit's
long task was 119 ms. Most of the remaining API delay was contention from a
global Inbox request launched for the sidebar badge.

Route isolation confirmed the owner. On another fresh server,
`GET /api/projects` completed in 0.463 s and produced no session-index or
transcript-read events. `GET /api/inbox` took 4.108 s and immediately launched
all-project/all-provider enumeration, producing 66 session-index, warmup, or
Codex-entry records in the observation window. Representative cold summary
work included 1.67 GB across 368 Codex sessions in the YA project, 1.10 GB
across 86 in `draft`, 563 MB across 43 in `xmt`, and 139 MB across 60 Claude
sessions in YA. The response is complete only after every project promise
settles.

Provider resolution adds a scale multiplier. Pi, Grok, and OpenCode currently
say every project may have their sessions, then readers filter provider-global
storage by project. The production run showed Pi scopes across essentially
every project although only a few contained Pi sessions. This is tolerable at
dozens of projects and structurally wrong at the accepted 10,000-project
planning scale. A provider store must be enumerated once and grouped by
canonical project, not rescanned for every project.

#### Client entry graph and static delivery

The local production build emits one 2,668,843-byte application JavaScript
file and 565,170-byte CSS file; its only other JavaScript chunks are locale
overlays. The remote build similarly emits one 2,753,737-byte application file
and 566,079-byte CSS file. `main.tsx` statically imports 15 page modules,
`remote-main.tsx` about 20 page/gate modules, and `SettingsLayout` all 21
category panes. Public-share/login and lightweight authenticated routes
therefore evaluate substantial unselected page trees.

On the isolated production server with browser cache disabled, warm server data
gave 191-201 ms to document-content-loaded, 249-251 ms to the New Session form,
290-347 ms to provider/model controls, and a 108-116 ms initial long task. A
cold provider-cache sample still showed the form at about 276 ms but controls at
6.22 seconds, so the monolithic client is a real transfer/evaluation cost and
not the owner of the multi-second catalog delay. Slower/mobile clients will
amplify it. The separate Vite development graph fetched 250 modules and about
10.4-10.5 MB decoded in fresh contexts; live server/document contention made
form time vary from 1.36-4.56 seconds, so that is a development-waterfall
diagnostic rather than a production estimate.

Static delivery makes the build cost worse than its gzip report suggests.
`frontend/static.ts` uses whole-file `readFile`; compression covers only API
routes. Its immutable test accepts hexadecimal suffixes, but Vite emitted hash
tokens such as `D3zWbkxu` and `BPXPYV9_`. The 2.67 MB JavaScript response was
therefore sent in full with `max-age=0, must-revalidate` and no
`Content-Encoding`, `ETag`, or `Last-Modified`. Ten repeat GETs added 26.70 MB
of logical reads and new whole-file request work even though the OS page cache
prevented physical reads.

Tactical 022 is reopened for build-proven immutable identity, negotiated
precompressed sidecars, bounded streaming, and deploy-generation retention.
Tactical 096 owns semantic route/Settings splitting. The delivery contract
must land first or with route chunks: a long-lived old entrypoint must still be
able to request its uncached chunk after a deployment. Global KaTeX/font CSS is
still imported by `styles/index.css`, so route JavaScript splitting does not by
itself remove the 565 KB CSS response.

#### App-shell request concurrency

A fresh production New Session issued 21 API fetches in its first roughly 650
ms. They included provider/settings/recents and the selected project, version,
auth/onboarding/share status, global and starred sessions, projects, Inbox,
processes, project queue, incremental sessions, provider usage, and the
development reload-status family. Most are distinct retained owners rather
than duplicates; the fault is that all compete immediately with the selected
page's minimum facts.

In one cold disposable-data sample, `/api/providers` took about 5.21 seconds,
both initial session-list requests about 3.56 seconds, Inbox about 0.50 seconds,
and provider controls appeared at about 5.50 seconds. This is a second sample
from the 6.21-second provider barrier above, not a replacement timing.
Tactical 031 now owns source-level start priority and exact-query coalescing;
the selected page goes first, while Sidebar coverage remains retained and fills
in place.

One duplicate is direct: `useReloadNotifications()` first reads
`/api/dev/status` to choose its mode, then manual synchronization reads the
same route again before workers/safe-restart. Each hook instance also owns a
one-second connection-state interval. That family should become one
source-level snapshot and shared connection signal rather than multiplying
reads/timers across the global app and Settings consumers.

### New-session provider and model readiness

The app shell already primes `useProviders()` on the first authenticated or
connected tab. This only moves the request earlier: on a fresh tab the primer
and `NewSessionForm` join one aggregate `/api/providers` response, and both the
client and route retain results only in memory for five minutes. The form then
waits for providers, settings, and version before assigning `selectedProvider`;
the model control is absent until that selection and its model rows exist.

A live request after the server route cache expired took 6.211 seconds. Warm
repeats took 4-33 ms. Forced provider-detail timings isolated the barrier:
OpenCode took 4.407 seconds, Claude 0.747 seconds, and Codex 0.239 seconds. The
saved default was Codex, so a provider the user was not selecting owned most of
the wait.

OpenCode discovery runs two sequential child processes. `opencode models` took
2.24 seconds and about 437 MB maximum RSS; `opencode models --verbose` took
2.18 seconds and about 436 MB. Both exposed 87 model headers. The provider has
no catalog cache of its own, and the verbose command already carries the ids
needed to build the list plus effort variants. This is child-process CPU/RSS,
not retained Hono V8 heap, but it is avoidable cold-path work and can contend
with useful startup.

The all-provider route also starts auth and model methods independently. Some
model methods repeat auth/install prerequisites; Codex OSS may independently
run `ollama list` for auth and models. A configured Claude Gateway is more
consequential: generic model discovery calls `gatewayLauncher.ensureReady()`,
so startup model-info warming or an unselected tab primer can start and retain
a provider service. `ModelInfoService.warmProvider()` ingests only context
windows and does not fill the provider route cache, leaving multiple warm
owners.

The saved provider/model is already durable in server settings and the live
settings route returned in under a millisecond. It should occupy the final
picker region immediately. Installation/authentication, current alternatives,
and model capabilities then revalidate per provider in place. Unselected model
catalogs cannot gate the selection; a stale model snapshot does not prove auth
or authoritative Gateway validity; generic catalog inspection cannot start a
persistent provider runtime.

Supplementary usage probes are another lower-priority cost. Selecting Codex or
Claude mounts a one-minute cached subscription query; forced live probes took
3.589 and 2.656 seconds respectively. They do not currently block the picker,
but begin optional provider control work during composition startup. Defer them
until the controls paint or direct demand, using one source/provider owner.

The implementation handoff is
[`094-new-session-provider-catalog-readiness.md`](094-new-session-provider-catalog-readiness.md).
The related `useVersion()` audit found 34 call sites, request-only in-flight
coalescing but no retained resolved/source-scoped snapshot, and ordinary live
requests ranging from 45-680 ms. Twenty sequential requests added about 989 kB
of Hono logical reads while the development route reran `git describe` per
request. Tactical 031 now owns the shared version/capability snapshot; this is
independent of provider catalog persistence.

The same page starts another oversized request for project defaulting.
`NewSessionPage` consumes only recent project ids, but `/api/recents` first
lists projects and then sequentially calls provider-aware session-summary
resolution for every visit. Live totals were 0.9 ms for zero entries, 5.9 ms
for one, 3.770 seconds for ten, and 6.496 seconds for the page's 30-entry
request. The raw restart-durable `RecentsService` list already holds project ids
and timestamps. Tactical 095 specifies a source-scoped raw recent-project
projection; defaulting a project must perform no session-index, provider, or
transcript read and must not gate the rest of New Session.

### Inbox, external processes, and hovercards

Inbox legitimately needs global provider activity, including activity that
happened outside YA or while YA was down. The route must not own that scan.
After retained runtime hosts reattach, startup should run these bounded,
server-owned reconciliations:

1. When host process observability is enabled, one same-user host process
   snapshot classifies known provider harness roots, subtracts exact YA
   Supervisor/runtime-host ownership, and records unmatched roots. The
   existing `HostAgentProcessService` supplies the safe classifier; the
   underlying `ps` snapshot measured 0.01 s and about 4.1 MiB maximum RSS on
   this host. A single process-wide periodic diff is a reasonable freshness
   backstop because its cost follows the process table; it may target changed
   roots but must not become a transcript sampler.
2. Each install-eligible provider session store is scanned once, grouped into
   canonical project shards, and reconciled in the background. Eligibility is
   durable evidence that this YA install has successfully started that provider;
   migration seeds the set from existing YA-owned launch/session metadata,
   never from scanning native provider stores. Never-used adapters are not
   queried. Persisted Inbox counts/tiers are immediately displayable; each
   completed shard publishes an in-place delta. File events then update touched
   sessions, and a bounded reconciliation catches changes missed while YA was
   down. First successful use of a provider records eligibility and triggers
   its first catalog pass.

The same install-history gate applies to native session file watchers. The
current server starts watchers before install/session metadata is loaded and
recursively indexes even an unused provider root. After migration, a
never-successfully-used provider receives neither catalog queries nor storage
watches. Process classification remains the deliberate exception because it
does not open the native store. The implementation handoff is
[`093-provider-session-reconciliation.md`](093-provider-session-reconciliation.md).

A known retained YA process gives exact per-session ownership. An unmatched
external harness may name a session only when a provider-native session id,
pid/lock record, or another exact provider contract correlates it. Process
existence, cwd, transcript mtime proximity, or a single candidate cannot prove
the association. Absent that join, YA knows only that the session is not
YA-owned and that an uncorrelated external provider process exists.

Hovercards do not share Inbox's global requirement. Desktop hover and tablet
row adjacency may perform no transcript scan before a specific preview is
requested. The card opens from compact list metadata; its opening request and
metadata occupy stable final coordinates. A reserved reply region below them
then fills asynchronously with the last regular agent excerpt, without
flashing or moving the top region. Pointer-velocity and adjacent-row prefetch
remain deferred until the measured requested-card delay shows a need.

The governing observer/cache philosophy is now
[`topics/session-catalog-observation.md`](../../topics/session-catalog-observation.md).
YA keeps one disk-backed compact session catalog and a byte-bounded RAM hot set.
Live/owned sessions, exact external-process evidence, visible rows, and explicit
hover/detail requests receive progressively stronger freshness. Old offscreen
unowned sessions may be explicitly stale; absent a changed source version or
client interest, no timer reparses their transcripts. Broad compact client
snapshots remain allowed, so viewport interest is a priority hint rather than
the only record of session existence.

The catalog publishes a durable epoch and monotonic generation. Inbox,
unfiltered/starred lists, stats, hover projections, and queue titles read one
accepted generation plus ordered deltas. All filesystem/provider derivation is
single-flight by source version and fidelity, so simultaneous components, tabs,
devices, events, and background repair join one computation. Tactical 093 owns
that server hierarchy and the bounded process/reconciliation owners; tactical
031 owns one per-tab retained query owner plus optional generation-aware
IndexedDB/cross-tab reuse. Browser storage remains an optimization because
server-side herd control must cover unsupported browsers and multiple devices.

### Additional timer and collection amplification

The follow-on source audit found three independent paths with the same
ownership error:

- Global and starred `/api/sessions` requests each enumerate projects/providers
  and materialize all matching rows before applying `limit=50`; `/api/sessions`
  stats performs another invalidation-sensitive corpus pass. Tactical 093 now
  makes all of them projections of one retained generation.
- `NavigationLayout` and the visual Sidebar mount four global-session feed
  hooks for two keys. Their requests can join, but duplicate forced
  invalidation advances the stale generation while the shared request is in
  flight. Each hook also retains its own listeners/debounce state. Tactical 031
  moves revalidation ownership to the `(sourceKey, queryKey)` entry.
- Every mounted `useProjectQueues()` starts a five-second forced poll while
  backlog/recovery rows exist. Each global queue response recomputes statuses
  and may resolve titles through provider/session summary lookup. Tactical 040
  replaces this with retained title/status projections, versioned events, and
  at most one exact source-level deadline.

Heartbeat candidate scheduling adds a fourth recurring path. Every 30 seconds,
eligible unowned metadata can cause all projects to be listed, provider/session
locations searched, and a complete transcript loaded only to ask whether its
tail has a pending tool call. The live metadata store contained two eligible
rows, proving the gate is present but not that both were unowned each tick.
Tactical 098 retains exact candidates and source-versioned tail facts behind
one next-deadline scheduler. This was not the demonstrated incident CPU owner;
it is a structurally repeating risk discovered by the same audit.

The optional Source Review Inbox has the corresponding project-store shape.
Each mount/manual refresh/`review-response-changed` event lists all projects,
loads every `ReviewStoreFile` concurrently, and then leaves every touched
project store in `ReviewCommentService.stores` until reset. The feature is
default-off and was not part of the incident or cold census. Tactical 099 owns
one durable compact unread projection, exact deltas, central-storage alignment,
and byte/age release of clean project stores.

Explicit session interest also has one broad retry seam. A focused
`session-watch` target is reference-counted correctly, but if its file cannot be
resolved it retries every three seconds by default, probing Claude and
enumerating Codex/Gemini sessions in the project. Tactical 093 now routes this
through the exact catalog location row and event/bounded-backoff repair. The
resolved per-session watch/stat fallback remains justified while a client
actually holds the session.

### Glossary and project-path work is demand-driven

With glossary hints on in a warm production server, the glossary artifact
itself completed in 75 ms and the browser committed at 3.944 s. The dominating
new work was subscription startup: Linux recursive `fs.watch(...)`
synchronously walked the selected project for about 2.5 s and blocked the
event loop, delaying unrelated APIs. The artifact request is logically async,
but the watcher made its setup globally blocking.

The accepted correction is a sparse directory-component trie shared by path
links and glossary discovery. Nodes distinguish unknown, present directory,
present file, and absent. A directory listing has a separate complete/current
bit; only that state may answer arbitrary child absence. An exact failed probe
may cache the first missing edge/suffix without listing the directory. Start
with at most the project root listed and children unknown, then hydrate only
directories appearing in distinct path candidates or glossary ancestor/include
walks. No feature must wait for a 50,000-node project warm pass.

On Linux, attach non-recursive filesystem watches only to hydrated directories.
Watcher events or YA-owned edits invalidate the affected edge/subtree; watcher
overflow/error marks the generation uncertain and schedules bounded
reconciliation. Do not `stat` directory mtime on every cache use. A low-rate
validation pass remains a correctness backstop for missed external operations,
not the hot-path truth mechanism. Typical governing glossary closures are below
1,000 entries, so glossary parse/automaton caches are secondary; recursively
discovering unrelated run directories is the avoidable cost.

### Cache audit and pressure order

Cache count is not a memory bound. The current audit found these additional
retention or amplification owners:

| Owner | Current behavior | Required bound/correction |
|---|---|---|
| App session-reader cache | FIFO, 500 readers with no hit retouch; a Codex reader may retain complete entry arrays and mapping/file caches, while `close()` only stops its parser worker | Byte/rebuild-cost budget and access retouch; close and release cold project readers and their data caches |
| Pi parsed transcripts | Keyed by `filePath:mtime`; every append adds a full parsed version and never deletes the old key | One current version per canonical file plus byte-bounded LRU |
| Session summary index | Up to 10,000 project/provider scopes, FIFO by count; each scope retains all summaries. FIFO eviction deletes only `indexCache`, leaving `lastFullValidationAt` and `persistedIndexScopes` entries behind. The UTC-day auto-archive cutoff is part of each validation key, so the auxiliary map can add another generation per scope/day | Keep 10,000-project discovery viable, but evict every scope-owned auxiliary/cutoff record and bound live memory by estimated bytes/rebuild cost, with disk-backed cold scopes |
| Codex shared session scans | Process-global cache keys include the UTC-day `activeAfterMs`; expired same-key entries overwrite, but older daily keys and their provider-wide `CodexSessionFile[]` arrays are never trimmed except by uncommon explicit invalidation | Keep only current/in-flight range generations under a byte/entry LRU; a moving cutoff is query input, not permanent cache identity |
| Session discovery shards | `SessionIndexService.codexDiscoveryIndexes` retains one index per touched Codex source root; each index then retains every loaded date/path shard for its lifetime | Release cold source-root indexes and byte/LRU-release their clean shards; protect dirty or saving shards until persisted |
| Project path indexes | One 50,000-node warmable trie per touched project; global map has no project eviction | Sparse demand hydration plus cold-project byte/LRU eviction |
| Glossary service | 512 parsed files and 128 graphs by count; observed-path maps are unbounded | Byte bounds and project release; low priority at typical <1,000 aggregate terms |
| Git author palettes | Process-global `loaded` retains every touched project's complete author map | Release cold project palettes by byte/LRU; durable app-data copy remains reconstructible |
| Review project stores | `ReviewCommentService.stores` retains every touched project's complete review sites, entries, submissions, and mutation state until a whole-service `reset()` | After pending mutation/save work is durable, release cold project stores by byte/LRU and reload canonical state on demand |
| External-session tracker | `createdSessions` and `sessionStateCache` retain every observed id for process lifetime; expired abort records clean only when that session is checked | Compact generation/age bounds and bulk expiry during boot/event batches |
| Provider/model catalog | Client and server retain one all-provider result for five minutes in memory; an expired request awaits every auth/model probe, while OpenCode launches two high-RSS CLI children and generic Gateway discovery can start a service | Durable bounded last-successful rows per provider; selected-provider priority, provider-local refresh/errors, shared prerequisites, and side-effect-free generic inspection |
| Global collection projections | Unfiltered/starred/stats requests repeat project/provider traversal and row allocation; query hooks duplicate invalidation/listener owners | One disk-backed catalog generation, source-versioned single-flight derivation, and one retained client owner per query key |
| Project Queue reads | Every mounted consumer polls at five seconds while backlog exists; each response can recompute project status and resolve target titles through provider/session readers | Retained catalog-backed titles and scheduler statuses, versioned events, and one exact source deadline |
| Heartbeat candidates | One 30-second supervisor tick may search every project/provider and load a complete transcript per eligible unowned row | Exact retained candidate/tail projection plus one process-wide next-deadline scheduler |
| Source Review Inbox | Each read/event lists every project, loads every review store concurrently, and retains each touched store for process lifetime | One app-data compact unread projection with exact deltas and byte/age release of clean stores |

The process-wide pressure coordinator should shed rebuildable state in this
order, refined by least-recent project/view and observed retained bytes:

1. inactive glossary/path artifacts and cold provider-reader/query caches;
2. parsed transcript detail arrays for inactive sessions, including obsolete Pi
   mtime versions;
3. cold in-memory session-summary scopes whose durable index can be reread;
4. active-session rebuildable detail only at the critical watermark.

Never evict pending writes, active protocol ownership, the only copy of
canonical state, or the currently executing parse. Watermarks need hysteresis
and enough low-water headroom for one largest admissible parse plus garbage
collection. The public-share monolith and duplicate transcript parses must be
redesigned at their owners; continual cache shedding is containment, not their
fix.

### Adjacent stale development roots

The operator process tree found nine live `scripts/dev.js` roots. Only the
port-3400 launch was intentional. Six old roots retained Vite/esbuild only; an
older pair retained separate client-only and server-only branches. None owned
a Codex/provider runtime host or provider harness. Gracefully terminating the
wrappers did not cascade to their already-old descendants, so the verified
orphan branch leaders were terminated separately and all stale listeners were
removed.

Commit `f3efacfa` makes future cleanup routine. Newly spawned descendants carry
YA instance/bind provenance. Only a Hono generation that proves its actual
localhost bind through the authenticated wrapper channel may reap prior YA
processes for that bind. Source/worktree identity never exempts a process; it
only grants different-source work up to 60 seconds after `SIGTERM` before
forceful verified cleanup. [`topics/reload-safe-provider-runtimes.md`](../../topics/reload-safe-provider-runtimes.md)
owns that contract.

### Completion note

2026-08-05 — extended investigation complete. Evidence: a 600-second CPU/I/O
sample; a 30-minute VMA census; structured transcript read/worker logs from the
replacement lifetime; isolated parse/stringify of the 502 MB share store;
fresh built-server/browser timing including an external process-to-response
clock; route-isolated project and Inbox probes; live provider/version endpoint
and CLI timing; production and development client graph/request censuses; static
asset header/read probes; server module-graph reachability; and source traces
through process enrichment, Inbox fan-out, provider caches, project paths,
glossary subscriptions, and external-process discovery.
Implementation/investigation checkpoints before this extension: `f3efacfa`
and `3c0f70df`. The provider-child, public-share, Inbox, cache-pressure, and
sparse-path corrections remain handoffs, not implementations in tactical 089.
The completed investigation, topic contracts, and tacticals 091-093 landed in
`37794b7c`; the primary-bind provenance correction landed in `df2fc628`.
Tacticals 094-099, reopened tactical 022, and the query-controller/queue
follow-ups extend that completed report with the later New Session,
client-delivery, server-module, retained-feed, and timer observations.
The continuous-observer/cache contract and the final collection/timer handoffs
landed in `986daeef`; evidence is the source audit recorded in those tacticals
and a warning-free full `pnpm lint` run.

Primary retained evidence runs:

- `tactical-089-memory-map/20260804T233857Z` — 30-minute VMA/RSS census;
- `tactical-089-bind-provenance/20260805T001119Z` — primary-bind provenance;
- `tactical-089-production-build/20260805T002000Z` — production bundle;
- `tactical-089-production-cold/20260805T002144Z` — fresh browser/session load;
- `tactical-089-route-isolation/20260805T002428Z` — project/Inbox isolation;
  and
- `tactical-089-production-outer-ready/20260805T004510Z` — 1,859 ms external
  process-to-first-response clock versus 42/47 ms internal timer/onReady.

## Investigation method (completed)

The investigation used these three questions:

1. Does server CPU decay within a complete cold-start observation window, or
   remain high after discovery, cache fill, watcher reconciliation, provider
   reattachment, and client reconnect should have completed?
2. If it remains high, which bounded operation or repeating owner consumes the
   CPU, and which resource-quiescence contract does it violate?
3. Which entry-read key should coalesce the demonstrated identical snapshot
   parses, and what makes completed/abandoned worker generations collectible?

The checklist below is retained as the reproducible method and acceptance
boundary, not as open tactical work.

Do not infer activity from a thread name, process title, transcript mtime, or a
single `%CPU` sample. `100%` means roughly one logical core and may be a browser
renderer or provider child rather than the YA HTTP server.

## 1 — reproduce and verify the CPU owner without restarting it

The incident label is attributed, but a controlled reproduction should capture
the system monitor's PID and, if it is a thread view, its thread ID.
Resolve the executable, command line, parent chain, process start time, current
working directory, cgroup/service, listening sockets, and per-thread names.
Cross-check those facts against the current YA wrapper/server/provider process
tree and the runtime registrations described in
`topics/reload-safe-provider-runtimes.md`.

Keep raw command lines, environment values, credentials, and private project
paths out of committed artifacts. A final report may name the executable,
sanitized role, PID/start time, and relevant source owner.

Acceptance for this step: the next high-CPU observation again maps an exact
PID/TID to the YA server or demonstrates that a different owner is responsible.
Do not generalize the first incident's attribution to every future process
shown as `MainThread`.

## 2 — reconstruct the nonresponse and restart window

Find the server, wrapper, lifecycle-host, and kernel/service logs that cover at
least five minutes before and after the restart near 2026-08-04 22:00 UTC.
Build one timeline containing:

- last successful client/API response and first timeout/disconnect;
- process exit, signal, uncaught exception, OOM kill, watchdog action, or
  graceful replacement evidence;
- wrapper replacement and lifecycle-host detach/reattach events;
- memory, swap, major-fault, I/O-wait, and load evidence available for the same
  interval; and
- first successful response after restart.

Do not call a missing exception line a crash, or high RSS an OOM. Classify the
incident as demonstrated crash, demonstrated OOM/resource pressure,
demonstrated live hang/event-loop starvation, graceful/replacement stop, or
indeterminate, with the exact evidence that excludes the nearby alternatives.

## 3 — measure the full startup CPU curve

On the next safe start, sample the attributed PID and its threads at one-second
resolution for at least ten minutes. Record cumulative user/system CPU, recent
CPU rate, RSS, major faults, read/write throughput, run/wait state, and
system-wide load/swap/I/O-wait context. Mark these phases from logs rather than
guessing from elapsed time:

- wrapper and Hono startup;
- provider/lifecycle-host registration and reattachment;
- project/session discovery and metadata/cache fill;
- file-watcher initial scan or reconciliation;
- client reconnect, subscriptions, and first session/project visits; and
- quiescent idle after every bounded startup phase reports completion.

Report a time series or compact phase table, not one peak number. State whether
CPU monotonically subsides, plateaus, oscillates, or grows with client visits.
If the ten-minute window has not reached quiescence, continue until it does or
until a repeating phase is demonstrated.

## 4 — distinguish deferred work from a repeating loop

For each high-CPU phase, correlate source-owned counters and logs before
profiling. Pay particular attention to:

- Codex rollout/project scanning and compressed-session cache fill;
- metadata/session list reconstruction;
- file-watcher rescans, overlap skips, and adaptive backoff;
- glossary compilation only for actually queried project/source contexts;
- reload-safe provider reattachment and viewer-presence reconciliation;
- reconnect/catch-up request duplication; and
- browser-side transcript rendering if attribution points to a renderer.

Bounded startup work must have a finite work count and a completion marker.
Repeating work must name its owner, cadence/trigger, teardown condition, and
why it continues after the server is idle. Test the suspected discriminator:
for example, no client versus one client, empty versus warm caches, or provider
host enabled versus disabled. Do not disable multiple subsystems at once.

## 5 — profile only after the phase is reproducible

If structured phase evidence cannot identify a sustained consumer, reproduce
it with a fresh server on an unused port and disposable app-data directory.
Capture a bounded Node CPU profile for the demonstrated hot interval and a
separate quiescent control. Do not attach an intrusive profiler to the user's
live server or restart it again without explicit approval.

Attribute hot stacks to named source functions and callers. Separate JavaScript
execution from garbage collection, native compression/parsing, filesystem I/O,
and child-process CPU. A profile whose top frame is generic event-loop or
garbage-collector work is not yet a root cause; connect it to the allocation or
callback source.

## 6 — close with an evidence-backed classification

The handoff is complete only when it provides:

- exact process/thread attribution;
- the incident timeline and crash/resource/hang classification;
- a startup-to-idle CPU curve with phase boundaries;
- the first falsifiable root-cause hypothesis that survived comparison against
  at least one alternative;
- a failing regression or measurement that captures any current defect; and
- either a located fix proposal at the owning invariant or a no-change finding
  that identifies the bounded startup work and its measured completion time.

If instrumentation is missing, specify the smallest persistent event/counter
that would distinguish the remaining hypotheses on the next occurrence. Do not
substitute broad always-on debug logging for a bounded, queryable signal.

## Deferred server observability and memory-pressure proposal

The durable draft is
[`topics/server-performance-observability.md`](../../topics/server-performance-observability.md).
Keep this work deferred until deliberately taken up. Its main decisions are:

- one process-wide metrics/pressure owner, never per-session polling;
- current **server metrics** distinct from bounded persisted **performance
  events**, with both explicitly local operator observability rather than
  outbound analytics;
- V8 heap limit/headroom, RSS, external memory, event-loop delay, cache sizes,
  active work, coalescing, and owner-qualified outcomes;
- watermark + hysteresis eviction of registered rebuildable caches, cheapest
  to rebuild first and then least recently viewed/project-local least recently
  used state;
- canonical state, pending writes, and active protocol ownership are never
  cache-eviction candidates;
- a searchable advanced YA panel, authenticated and excluded from public
  shares; and
- a new capability gate before any client calls performance routes, with the
  panel hidden and no request made against older servers.

The proposal deliberately does not choose final thresholds, retention sizes,
or route/capability names. Measure enough headroom for one large parse and a GC
cycle, and obtain the required compatibility approval before client/server
contract edits.
