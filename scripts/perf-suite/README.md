# YA performance regression suite

This checkout-independent harness imports no measured-tree code. Each run
creates detached project worktrees from an immutable repository revision,
generates a deterministic Claude store whose sessions use those worktrees,
starts one isolated YA instance from the named execution checkout, drives
public interfaces, proves fixture-derived correctness, and records raw JSON
results. Every result distinguishes the measured execution revision, fixture
revision, and exact harness inputs. Harness identity includes the latest commit
touching the runner, browser-memory helper, host profiler, ratchet selector,
config, or ratchets, path-scoped dirty state, and a content SHA-256, so
unrelated shared-worktree changes do not relabel the measurement.

Results also include an automatic host capacity key. The key covers platform,
architecture, CPU model, visible/effective CPU capacity, and bucketed physical
and effective RAM; exact capacity, runtime, CI identity, and start/end resource
samples remain in the result. Historical series use `historyKey` (capacity key,
driver, scenario), so CI or cloud results never silently join a different
runner class. A three-second pre-run baseline classifies CPU, load, effective
available memory, and swap headroom against `config.json`. Diagnostic-grade
runs still produce evidence but cannot pass the ratchet. CPU checks require
both the configured total capacity and at least one idle logical CPU
equivalent; missing CPU or swap samples are diagnostic rather than implicitly
clean. The portable baseline tolerates a decaying one-minute load average up to
two tasks per effective CPU and up to 16 MiB of swap growth, while current CPU,
idle-core, and available-memory checks remain independent hard gates. The
checked-in ratchets are portable safety ceilings, not a license to compare
historical timing across capacity keys.

The JSON scenario dimensions are:

- projects and sessions per project;
- initial and newly appended turns;
- concurrent clients;
- deterministic per-message payload bytes;
- named scale points, repetitions, and settling time;
- browser transcript-cache budgets; and
- the browser working-set session count.

The default server driver uses public HTTP routes plus the maintenance
listener. It measures server startup, cold and warm project/session lists,
collection herds, cold/warm/appended session detail, response bytes, and
forced-GC heap/RSS. Current execution revisions also expose an additive request
profile: project resolution, transcript read, normalization, route work,
augmentation, server residual, framework/serialization/loopback, body transfer,
JSON parsing, and harness residual. Forced GC uses the isolated server's
inspector endpoint; the suite never attaches to another process.

Server memory samples include process gauges, fixed V8 heap-space gauges,
Claude parsed-transcript retained source bytes/files, Markdown-render cache
bytes/entries/reuse counters, and project-path retained bytes/projects/watchers.
Named cache bytes are accountable source charges, not an additive decomposition
of V8 object memory; the heap-minus-known-source value is labelled as a residual
rather than exact cache overhead.

The optional browser driver starts the measured checkout's real React dev
client and performs the same server workload plus one browser page per
concurrent client. Before loading the app, it enables glossary hints and sets
the transcript-cache budget in browser storage; cache budgets run in separate
browser contexts. It records cold, warm-working-set, and file-observed append
latency through readable text, glossary annotation, automatic project-path
anchors, and the latest supported final display. It also records
`performance.memory`, YA's own live and warm transcript-retention accounting,
and contemporaneous server memory. Per-page Chrome DevTools Protocol (CDP)
snapshots add live-plus-detached DOM nodes, documents, event listeners, and
layout objects. Browser-wide CDP process inventories are sampled at startup,
after each cache mode loads, and after append. On Linux, `/proc` adds resident
set size (RSS), proportional set size (PSS), and private bytes for each process
and process type. A byte total is omitted unless every process in that sample
was readable, so a vanished PID cannot become a partial total. Non-Linux
results retain the process inventory without native byte totals. Server,
browser-page, and browser-process measurements are separate ratchet universes.

The `focused-append` scale point reduces that browser workload to one project,
one session, one page, one cache-disabled mode, and one newly appended turn.
It reports the same server detail and browser event/DOM phase clocks under a
separate capacity/driver/scenario history key, so selected-session critical-
path latency can be compared with the intentionally contended fleet result.

The `built-client` driver builds the measured checkout once before host
sampling, records that preparation and its cleanup, and excludes it from every
timed leg. Each repetition then uses two fresh production-server processes.
The first measures process spawn through `/api/projects` readiness to the
expected selected-session transcript needle on the public detail route. The
second serves `packages/client/dist` and measures a cold page navigation to
selected-session readable text, with glossary and project-path completion kept
as independently mutation-marked correctness milestones. Browser-process
launch is excluded. Separate server processes prevent the direct readiness
probe from warming the client leg's YA caches.

Every driver uses YA's in-process mock for any session launch, and browser
drivers additionally suppress provider discovery. This is an explicit post-
provider mock boundary: the drivers exercise provider-neutral client/server/
session paths, but make no claim about provider startup, protocol parsing,
transcript production, or provider teardown. The real provider catalog is not
queried during routine browser ratchets.

Every accepted sample checks project, session, message, and capability-gated
rendering invariants against the pinned fixture. Browser runs warm the
configured working-set ring, leave the session route, verify the expected cache
entries, and revisit the ring. The default is three sessions; a scenario may
set a smaller explicit count when it also supplies enough fixture sessions. A
held-refresh proof separately establishes that cached final content is usable
before a slow refresh completes, while a zero budget remains blank until the
request is released. The proof explicitly leaves the selected route first and
never enters ordinary latency measurements. A zero cache budget must retain no
warm entries or bytes; a fitting nonzero budget must retain the complete ring
within its configured byte limit.

Glossary hints are the only feature pre-enabled through saved browser settings.
Generalized bare project-path linking has no saved enable switch and is expected
automatically where the measured revision supports it. The semantic payload
also includes absent-path, MIME-type, and version-shaped negative controls that
must remain unlinked.

Current browser profiles derive non-overlapping cold/warm navigation and append
phase trees from Resource Timing and MessageList marks. Appended transcript
bodies are generated before the browser append marker; that marker is set
immediately before write submission, so fixture payload generation is excluded.
Current clients also expose an append event path from accepted file-change
receipt through incremental request, data readiness, state queueing, and
MessageList preprocessing. Those durations share the browser's
`performance.now()` clock. Focused watcher source/version/path/mtime/size and
server observation/emission timestamps remain alongside the phases as source
facts; server wall-clock timestamps must not be subtracted from browser marks.
Older checkpoints report this event path as unavailable.
For each important total, output ranks phases, names every phase contributing
at least 10%, and reports the smallest set explaining at least 80%. Historical
revisions without these clocks retain black-box totals and explicitly report
profiling as unavailable.

```bash
node scripts/perf-suite/run.mjs \
  --checkout /path/to/measured-yepanywhere \
  --fixture-repository /path/to/fixture-yepanywhere \
  --scenario fleet-small \
  --driver server \
  --label measured-sha

node scripts/perf-suite/run.mjs \
  --checkout /path/to/measured-yepanywhere \
  --fixture-repository /path/to/fixture-yepanywhere \
  --scenario large-session-cache \
  --driver browser \
  --label measured-sha

node scripts/perf-suite/run.mjs \
  --checkout /path/to/measured-yepanywhere \
  --fixture-repository /path/to/fixture-yepanywhere \
  --scenario focused-append \
  --driver browser \
  --label measured-sha

node scripts/perf-suite/run.mjs \
  --checkout /path/to/measured-yepanywhere \
  --fixture-repository /path/to/fixture-yepanywhere \
  --scenario fleet-small \
  --driver built-client \
  --label measured-sha
```

`config.json` owns scale points. `ratchets.json` owns independent per-driver,
per-scenario maximums. `capacityOverrides` registers measured host classes and
may replace individual targets without dropping the portable checks it omits.
An unregistered class uses `portable-default`; a registered class is keyed to
its capacity even while inheriting every portable ceiling. Native process-byte
targets belong to exact capacity overrides; portable browser targets may cover
CDP object counts. Targets use
deliberately broad margins over repeated observations, estimated to pass an
unchanged implementation with at least 99.9% probability. That is an
engineering estimate, not a claim of 1,000-run statistical verification.
Browser warm and appended final-display ratchets remain at or below the
one-second user-concern threshold. Working-set identity, zero-budget behavior,
delayed-refresh behavior, and the configured cache byte budget remain hard
correctness checks rather than probabilistic ratchets.

The suite never uses port 3400 and never restarts the shared YA server.
Generated fixtures and isolated app data live under `work/` only for a run.
Raw result JSON is written under `results/`; both directories are ignored when
the suite is landed.

`perf-sweep` is a run precondition and the authoritative post-run survivor
check. Local runs resolve it from `PATH` or `YA_PERF_SWEEP`. The GitHub
performance workflow checks out `github.com/graehl/agents` at full commit
`496159563aafd1f5abd15e4315bf502187d2e9d1` and points `YA_PERF_SWEEP` at
`scripts/perf-sweep`. The harness refuses to start while another
`ya-perf-suite-` marker exists. Every isolated server has a unique marker in
argv and `PERF_RUN_ID`, a PID/PGID/port manifest, and a detached process group;
Chromium inherits the environment marker. Each repetition and failure path
uses `perf-sweep --kill --kill-group`, verifies a second clean scan, and marks
the run failed if debris existed even when it was successfully reaped. A
`built-client` preparation build uses its own marker and the same report/reap/
verify contract before host sampling.

Settled server memory diagnostics account separately for retained transcript
source, rendered Markdown HTML, and project-path indexes. The residual heap
metric subtracts all three known source charges; Markdown cache hit, join,
retention, stale-completion, and unretained-completion counters remain in both
raw repetitions and the aggregate.

Current execution revisions also expose cumulative relay JSON serialization
counters: eligible responses, validated raw-body fast-path hits and bytes,
invalid or unsupported fallbacks, and send failures. A zero eligible count means
the selected driver did not traverse that relay path; compare hit/fallback rates
only when the eligible count is nonzero. For a focused plaintext and encrypted
comparison with the same automatic host record, run:

```bash
pnpm --filter @yep-anywhere/server benchmark:relay-json
```

Every run appends a compact record to `results/history.jsonl` (or `--history`)
under its capacity/driver/scenario tuple. CI log collectors may scrape
`YA_PERF_HOST_JSON` before the run and `YA_PERF_HISTORY_JSON`,
`YA_PERF_CAPACITY_RATCHET_JSON`, and `YA_PERF_RESULT_JSON` after it. The result
marker names the complete JSON artifact and pass/fail outcome; the history
marker names the accumulator; the capacity marker is a pasteable registration
for a previously unseen runner class. A host need not be fully idle, but its
baseline must show the configured CPU and effective-memory headroom. Treat a
diagnostic-grade result as a sampling lead and rerun before changing history or
a ratchet.

The GitHub workflow runs server and built-client `fleet-small` arms plus a
browser `focused-append` arm on relevant client/server/shared/suite changes.
Browser-capable arms install Chromium; every matrix arm receives a fresh runner
and its own driver/scenario-keyed history. It uploads `result.json`,
`history.jsonl`, and the complete run log on success or failure, and copies the
four `YA_PERF_*_JSON` records into the job summary. The checkout uses full
history because the deterministic fixture is pinned to an older revision.

Provider-backed drivers should prefer a simulated harness process over the
browser drivers' post-provider mock so process startup, adapter protocol,
transcript writes, controls, thinking blocks, and teardown still cross YA's
real boundary. A post-provider mock must identify the omitted boundary.
Calibrate either mock with a small live sample that records the provider-
execution share. Live runs use the tested provider's lowest-cost model and
effort that still emits thinking blocks, and record provider/model/effort with
the capacity-keyed result. Shared YA defects are often provider-agnostic, but a
result is labelled provider-specific or unresolved until its owning path is
known to be shared or the behavior is reproduced across adapters.

The `browser` driver intentionally uses the measured checkout's dev client
so one suite revision can run against old source checkouts. Its cold final-
display value includes Vite/module boot and is observational, not a production-
bundle ratchet. Warm in-app navigation and appended live final display remain
that driver's user-facing browser ratchets. The `built-client` driver's cold
selected-session value is the production-bundle contract. “Readable” is DOM-
text availability, not a browser first-paint timestamp. Append milestones and
built-client cold milestones use independent mutation-time marks; dev-client
cold and warm navigation retain sequential Playwright observation semantics.
