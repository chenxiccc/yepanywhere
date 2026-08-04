# Attribute and Explain Sustained `MainThread` CPU

> Determine which process a system monitor labels `MainThread`, measure whether
> its high CPU is bounded startup work or a sustained loop, and identify the
> owning YA subsystem before proposing a fix.

Status: Initial incident attribution completed 2026-08-04. The observed
`MainThread` was YA's Node server. It stopped answering before the operator's
manual `reyep --full`, then aborted with `SIGABRT` near V8's measured heap
limit. Heap exhaustion is a strong inference, not a proven fatal string. The
reproducible read amplification, bounded startup curve, owning fix, and future
observability remain open. This task is a handoff; no implementation is part of
the glossary workstream that created it.

Related contracts:

- [`topics/architecture-mandates.md`](../../topics/architecture-mandates.md)
- [`topics/agents-process-observability.md`](../../topics/agents-process-observability.md)
- [`topics/reload-safe-provider-runtimes.md`](../../topics/reload-safe-provider-runtimes.md)
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

## Investigation question

Attribution is now closed. The remaining investigation asks:

1. Does server CPU decay within a complete cold-start observation window, or
   remain high after discovery, cache fill, watcher reconciliation, provider
   reattachment, and client reconnect should have completed?
2. If it remains high, which bounded operation or repeating owner consumes the
   CPU, and which resource-quiescence contract does it violate?
3. Which entry-read key should coalesce the demonstrated identical snapshot
   parses, and what makes completed/abandoned worker generations collectible?

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
