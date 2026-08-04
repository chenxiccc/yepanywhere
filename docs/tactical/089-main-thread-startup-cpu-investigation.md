# Attribute and Explain Sustained `MainThread` CPU

> Determine which process a system monitor labels `MainThread`, measure whether
> its high CPU is bounded startup work or a sustained loop, and identify the
> owning YA subsystem before proposing a fix.

Status: Investigation completed 2026-08-04. The observed `MainThread` was YA's
Node server. It stopped answering before the operator's manual `reyep --full`,
then aborted with `SIGABRT` near V8's measured heap limit. Heap exhaustion is a
strong inference, not a proven fatal string. The replacement never reached
quiescence: process-list provider-child enrichment repeatedly full-parsed
unchanged Codex rollouts with caching disabled. The owning production fix is
specified below but not implemented here. The adjacent stale-dev-tree defect
was fixed in `f3efacfa`.

Related contracts:

- [`topics/architecture-mandates.md`](../../topics/architecture-mandates.md)
- [`topics/agents-process-observability.md`](../../topics/agents-process-observability.md)
- [`topics/reload-safe-provider-runtimes.md`](../../topics/reload-safe-provider-runtimes.md)
- [`topics/provider-child-sessions.md`](../../topics/provider-child-sessions.md)
- [`topics/codex-sessions.md`](../../topics/codex-sessions.md)
- [`topics/server-performance-observability.md`](../../topics/server-performance-observability.md)

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
but the ten-minute cumulative deltas are the stable comparison. The sampled
window rejects monotonic VIRT growth during those ten minutes; it does not yet
establish a long-horizon VIRT ceiling under continued session activity.

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

2026-08-04 — investigation complete. Evidence: one 600-second, one-second
resolution `/proc` sample; structured server read/worker logs from the complete
replacement lifetime; source trace through the client query, process route,
and Codex reader; and warning-free focused/lint checks for the adjacent startup
hardening. Implementation checkpoint: `f3efacfa`.

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
