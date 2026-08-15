# Performance Regression Suite

> The performance regression suite is YA's configuration-driven black-box test
> family for comparing server and real-browser latency, retained memory, and
> correctness across project, session, turn, payload, cache-budget, and
> concurrent-client scales.

Topic: performance-regression-suite

Historical surveys and recovery measurements live in the
[`performance-regression-suite.runs`](performance-regression-suite.runs/README.md)
ledger. This document owns only the current harness and interpretation
contract.

## Execution and fixture ownership

`scripts/perf-suite/run.mjs` is a thin CLI/result orchestrator and imports no YA
modules from the measured checkout. Process/fixture ownership, telemetry,
request clients, server/browser/built/specialized drivers, aggregation, and
ratchet evaluation live in independently testable sibling modules. Together
they create detached project worktrees from an immutable fixture revision,
generate deterministic provider files whose cwd values use those worktrees,
start an isolated execution checkout on non-production ports and app-data
paths, check fixture-derived API/rendering invariants, and write one JSON
result.

Execution, fixture, and harness identities remain distinct. Harness identity
hashes every imported implementation module plus config and ratchets and uses
their path-scoped revision/dirty state, so unrelated shared-worktree changes
cannot relabel a measurement and a changed driver dependency cannot preserve an
old identity.

Every spawned process carries a unique `ya-perf-suite-` argv marker and
`PERF_RUN_ID`, starts in its own process group, and enters a run-local
PID/PGID/port manifest. A marker-family sweep must be clean before work.
Every repetition and every failure/signal path runs `perf-sweep --kill
--kill-group` and then a report-only verification. Surviving debris fails the
run. Orchestration removes or rejects a prior output target before starting so
a crash cannot be classified from stale results.

Generated work and raw results remain local under the suite directory. Scale
points and repetition counts live in `scripts/perf-suite/config.json`; targets
live in `scripts/perf-suite/ratchets.json`. Scenario-specific thresholds do not
belong in driver code.

## Driver contracts

### Server

The server driver uses public HTTP routes plus the maintenance listener. Heap
ratchets request full garbage collection and retain the minimum of seven heap
samples; RSS uses their median. Current source emits session-detail clocks and
bounded cache/V8 gauges. Older checkpoints report missing owner telemetry as
unavailable, never as synthetic zero.

### Browser

The browser driver adds the measured checkout's React dev client and one real
page per configured client. Cache modes warm and revisit a three-session ring,
then prove under held refresh that cached final content is usable before the
network completes while zero budget stays blank. The artificial hold is
excluded from ordinary timing.

Cold, warm, and append observations independently mark readable text, glossary
annotation, project-path anchors, and final display. Mutation-time
`performance.now()` marks are authoritative; a Playwright polling wake-up is
not a performance timestamp. Per-page Chrome DevTools Protocol snapshots count
live and detached nodes, documents, listeners, and layout objects. Browser-wide
snapshots inventory processes; Linux additionally reports per-process RSS,
PSS, and private bytes only when every process is readable.

`focused-append` is the one-project, one-session, one-page selected-session
critical path. It has a distinct history key from fleet scenarios because it
excludes deliberate multi-file/multi-page fan-out. Its cache proof leaves the
selected route before refresh so a one-session ring cannot create a false
same-route result.

### Built client

The built-client driver prepares one production build before host sampling and
records its identity, elapsed time, and cleanup without charging build time to
a measured leg. Each repetition uses separate fresh servers for the direct and
browser legs, so the direct probe cannot warm the browser process. Server
useful readiness runs from process spawn through `/api/projects` readiness to
the expected selected-session needle. Browser readiness runs from cold page
navigation to independently observed transcript milestones. These are DOM
readiness clocks, not paint timestamps.

### Specialized contracts

The specialized driver uses two fresh legs. An out-of-process simulated
provider-runtime worker exercises YA's real runtime host, proxy, supervisor,
subscription, augmentation, and idle release. It must produce the configured
thinking-capable stream, raw final message, and same-id enriched replacement,
then release verified-idle ownership after the final viewer unsubscribes.

The public-share leg creates a real frozen share against a local simulated
relay, verifies bounded chunk metadata, drives the configured reader herd
through the legacy full-response route, and samples forced-GC memory. The
provider adapter/SDK, provider transcript writer, and internet relay remain
outside this simulation.

Routine server/browser/built-client runs use an in-process post-provider mock
and disable provider discovery. They cannot support claims about provider
startup, parsing, transcript production, or provider teardown.

## Host capacity and history

Every result carries `host.capacity.capacityKey`, derived from platform,
architecture, CPU model, visible/effective CPU, cgroup quota/cpuset, and
bucketed physical/effective memory. Exact capacity fields, Node/V8 versions,
CI metadata, and start/end host samples remain beside it. Samples include load,
available host/cgroup memory, swap, Linux pressure data where available, and
whole-run CPU occupancy. Each repetition gets its own resource window.

Before fixture work, the suite takes a three-second baseline and requires
sufficient effective CPU, idle CPU equivalents, CPU-busy fraction, load per
effective CPU, available memory, and bounded swap growth. Missing CPU or swap
evidence is not clean. A failed baseline makes the result diagnostic-grade and
prevents a ratchet pass.

History keys combine capacity, driver, and scenario. Historical comparisons
and tightened machine-specific ratchets do not cross capacity keys. Broad
checked-in maxima are portable safety ceilings. Exact classes may override
individual targets in `capacityOverrides`; an unseen class uses portable
targets but does not thereby establish a same-machine improvement. Native
browser-process bytes are capacity-specific; content-addressed CDP object
counts may remain portable.

The manual `.github/workflows/performance.yml` workflow is diagnostic, not a
push/PR gate. It uploads result, history, and logs on failure as well as success
and emits the capacity registration needed for later review. Small cloud hosts
follow the same eligibility, marker, teardown, and deletion rules.

## Provider-backed tiers

Routine ratchets do not execute a live provider. Prefer a deterministic
harness-process simulator when provider startup, protocol events, transcript
writes, controls, thinking blocks, and teardown are under test. A post-provider
mock is acceptable only when its bypassed boundary is named and no claim crosses
that boundary.

Before ratcheting either simulation as provider-representative, compare a small
live sample and record provider-execution share plus event-shape differences.
Live runs use the lowest-cost model/effort that still exercises the required
thinking path and record provider, model, effort, cost, and capacity. The
current specialized worker is a runtime-protocol child, not a first-party
harness simulator.

## Background-work evidence

Maintenance status exposes background summary pending/in-flight counts,
deduplication/outcome counters, and recent batch durations on one monotonic
clock. The suite snapshots this state around append windows and records counter
deltas plus batches newer than the opening sequence. A watcher-enabled run must
show that summary work occurred; a watcher-disabled contrast has a distinct
harness identity and cannot stand in for that contention path.

## Cache and source identity

A retained Claude transcript is a cache hit only when device, inode, ctime,
mtime, and size all match. Incremental parsing is limited to strict growth of
that identity and verifies the 1 KiB boundary before the previous offset. A
same-size change, shrink, or replaced inode receives a full parse.

The boundary probe does not prove that every earlier byte stayed unchanged. A
same-inode prefix rewrite followed by growth can evade it when the final probe
matches. Current provider transcript writers are treated as append-only;
stronger detection would require a source revision or full prefix hash.

Source-byte cache charges, JavaScript heap, browser-process PSS, and CDP object
counts are complementary signals, not an additive component decomposition.
Cache comparisons report entry/byte accounting alongside broad heap residuals.

## Current phase ownership

Profiled samples explain at least 80% of each important total with named,
non-overlapping phases. Historical checkpoints without owner clocks retain
totals only.

| Total | Recurring owner set |
|---|---|
| server detail | augmentation, transcript read where material, framework/serialization/loopback |
| browser warm return | response/navigation residual where material, state queue to commit, React commit to readable text |
| browser append | observed file change through preprocess, grouping through commit |

Augmentation consumes normalized persisted messages plus project context and
produces Markdown/media/path-enriched response messages.
Framework/serialization/loopback carries response bytes through Hono and the
direct relay. Append-to-preprocess includes file observation, focused refresh,
state merge, and scheduling. React commit-to-readable covers rendered
projection after state is queued. Nested MessageList spans do not become
additive peers of their queued-to-commit parent.

The result ledger records the recovery measurements that established these
owners and the current ratchet values. The topic retains the semantic phase
boundaries so later instrumentation does not silently rename or double-count
them.

## Ratchet interpretation

Checked-in maxima are broad ceilings over repeated observations, not claims
that the maximum is desirable or a historical floor is acceptable. Browser
warm and append final-display targets remain at or below the one-second user
concern threshold. Independent ceilings cover significant phases, response
volume, cache charges, memory residuals, transcript entries/bytes, DOM/layout
objects, process PSS on registered capacity, and rendered rows.

Working-set identity, held-refresh behavior, zero-budget behavior, exact
fixture counts, negative link controls, correct event ordering, and clean
process teardown are hard correctness failures rather than probabilistic
timing thresholds. A run with uncertain contention or incomplete host evidence
is diagnostic and cannot move a ratchet.

## Coverage boundary

The suite covers simulated provider-file discovery, project/session and
collection reads, file-observed append, glossary/path rendering, browser
transcript retention, server/browser memory, runtime-hosted simulated
streaming, time-compressed verified-idle release, and concurrent frozen-share
reads.

It does not execute a real provider adapter, SDK/harness, provider transcript
writer, or remote internet relay in routine legs. Simulated token throughput is
not provider speed. A one-second reap scenario does not establish multi-hour
timer stability. Provider-backed timing, adapter parsing, transcript-write
behavior, long-duration timer drift, and remote-relay effects require live
calibration or a lower harness-level simulator.
