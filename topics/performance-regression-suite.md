# Performance regression suite

> The performance regression suite is YA's configuration-driven black-box test family for comparing server and real-browser latency, retained memory, and correctness across project, session, turn, payload, cache-budget, and concurrent-client scales.

Topic: performance-regression-suite

## Contract

`scripts/perf-suite/run.mjs` imports no YA modules from the measured checkout.
It creates detached project worktrees from the immutable fixture revision,
generates deterministic provider files whose `cwd` values use those worktrees,
starts an isolated execution checkout on non-production ports and app-data
paths, verifies fixture-derived API and rendering invariants, then records one
JSON result. Execution, fixture, and harness identities remain distinct. The
harness identity is content-addressed and path-scoped so unrelated shared-
worktree commits or edits cannot relabel a measurement.

The server driver uses public HTTP routes and the maintenance listener. Heap
ratchets use an inspector-requested full garbage collection followed by the
minimum of seven heap samples; RSS uses their median. Current execution source
also emits additive session-detail clocks and bounded cache/V8 gauges. Older
checkpoints retain black-box totals and explicitly report unavailable owner
telemetry rather than synthetic zeros.

The browser driver adds the measured checkout's React dev client and one real
page per configured client. It enables glossary hints in browser storage;
automatic bare project-path linking has no saved enable switch. Each cache mode
warms and revisits a three-session ring, then proves under a held refresh that a
cached final transcript is usable before network completion while a zero budget
remains blank. The artificial hold is excluded from ordinary timings. Cold,
warm, and append results separately record readable text, glossary annotation,
project-path anchors, and the latest supported final display. Server and
browser measurements are distinct ratchet universes.

Scale points and repetition counts live in `scripts/perf-suite/config.json`.
Targets live in `scripts/perf-suite/ratchets.json`; code contains no scenario-
specific thresholds. Generated work and raw results are local artifacts under
the suite directory and are not committed.

## Host capacity and CI history

Every suite result carries a `host.capacity.capacityKey` derived from platform,
architecture, CPU model, visible and effective CPU counts, cgroup quota/cpuset,
and 256 MiB-bucketed physical and effective memory. Exact capacity fields,
Node/V8 versions, CI runner metadata, and start/end host samples remain beside
the key. Host samples include load averages, host and cgroup-available memory,
swap, Linux pressure-stall data where available, and whole-run CPU occupancy.
Each repetition records the same start/end window so one noisy repetition can
be separated from a stable batch.

A benchmark host does not need to be otherwise idle. It needs enough effective
CPU and memory headroom for the selected scenario, without material load,
available-memory, swap, or pressure drift across the batch. A questionable run
remains exploratory evidence: rerun a small sample before expanding the matrix
or changing a baseline.

Capacity-keyed history uses the tuple in `historyKey`: capacity key, driver,
and scenario. Historical baselines and tightened machine-specific ratchets
must not cross that boundary. The broad checked-in maxima remain portable
safety ceilings; passing one on a different capacity key does not establish a
same-machine improvement or recovery.

For CI collection, the harness emits one-line `YA_PERF_HOST_JSON` before work
and `YA_PERF_RESULT_JSON` after writing the result. A CI job can scrape those
lines and upload the named JSON artifact without hard-coding its runner class.
Capacity-keyed trend storage is a prerequisite for a scheduled or blocking
performance job; adding such a job remains a separate CI policy decision.

## 2026-08-08 historical survey

The final comparable survey used three repetitions per non-smoke point on one
host with harness `79fbeeb2d245672a471986c18be26ab580e2dc64` and fixture
`2f5e403e20fc5b96d5634a4b8f5a57704023d8da`. C0 is pre-sprint
`adaa804b`; C1 is pre-measured-arc `3c0f70df`; C2 is end-of-arc `61cb5f35`;
C3 is end-of-harsh-review `d0131298`; C4 is parsed-transcript cache `6024cff1`;
C5 is enrichment-ordering `13d6e794`; surveyed source is `2f5e403e`; profiled
source with forward-looking clocks is `cab8184a`.

At `fleet-small` (4 projects, 6 sessions/project, 12 final turns/session, 4
clients, 8 KiB/message), forced-GC server results were:

| checkpoint | cold project-list p95 | warm project-list p95 | collection p95 | cold readable tail p95 | warm readable tail p95 | appended readable tail p95 | retained heap | settled heap |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| C0 | 1435 ms | 5 ms | 22 ms | 140 ms | 23 ms | 35 ms | 8.6 MiB | 92.4 MiB |
| C1 | 1471 ms | 5 ms | 16 ms | 141 ms | 22 ms | 32 ms | 15.6 MiB | 99.8 MiB |
| C2 | 1398 ms | 5 ms | 15 ms | 156 ms | 30 ms | 51 ms | 11.3 MiB | 96.1 MiB |
| C3 | 1412 ms | 4 ms | 14 ms | 168 ms | 31 ms | 52 ms | 11.0 MiB | 96.9 MiB |
| C4 | 1396 ms | 4 ms | 16 ms | 168 ms | 26 ms | 47 ms | 20.9 MiB | 106.9 MiB |
| C5 | 1388 ms | 4 ms | 16 ms | 166 ms | 27 ms | 46 ms | 20.8 MiB | 106.9 MiB |
| surveyed | 1439 ms | 4 ms | 14 ms | 177 ms | 29 ms | 51 ms | 20.9 MiB | 106.9 MiB |
| profiled | 1402 ms | 5 ms | 15 ms | 169 ms | 29 ms | 48 ms | 20.9 MiB | 106.9 MiB |

The cold per-project session list is first-index construction. Immediate replay
is 4–5 ms at every checkpoint, so the greater-than-one-second result predates
and survives the arc without affecting the ordinary warm path. Collection-herd
p95 improved from 22 ms at C0 to about 15 ms at the profiled revision.

Session detail did lose ground relative to the C1 floor. At the profiled
revision cold is 28 ms / 20% slower, warm 8 ms / 34% slower, and appended 16 ms
/ 50% slower. C4 partially recovers C3 warm/append latency, but it does not
recover the C1 floor and adds about 9.9 MiB retained heap at this scale. These
are persistent losses behind broad passing limits, not evidence that review
left performance unchanged.

With real browsers at the same scale, file-observed appended final display
crossed the one-second concern threshold at C0 and C1, then improved during the
measured arc and stayed below 421 ms. The surveyed row is the range across two
independent three-repetition batches:

| checkpoint | cache off: warm / append final p95 | 24 MiB cache: warm / append final p95 |
|---|---:|---:|
| C0 | 483 / 1176 ms | 456 / 1201 ms |
| C1 | 588 / 1218 ms | 478 / 1230 ms |
| C2 | 506 / 394 ms | 543 / 401 ms |
| C3 | 766 / 417 ms | 561 / 421 ms |
| C4 | 497 / 406 ms | 498 / 420 ms |
| C5 | 538 / 391 ms | 529 / 391 ms |
| surveyed | 503–504 / 382–396 ms | 525–538 / 387–392 ms |
| profiled | 510 / 391 ms | 518 / 393 ms |

A fresh browser plus dev-client module boot took about 4.2–5.1 seconds at every
checkpoint. That observational number includes Vite transforms, so it is not a
production startup ratchet. Warm in-app navigation and appended final display
are ratcheted.

## Cache trade-offs

At `large-session-cache` (2 projects, 4 sessions/project, 16 final
turns/session, 3 clients, 64 KiB/message), forced-GC server results were:

| checkpoint | cold detail p95 | warm detail p95 | appended detail p95 | retained heap |
|---|---:|---:|---:|---:|
| C1 | 272 ms | 123 ms | 169 ms | 11.8 MiB |
| C2 | 526 ms | 260 ms | 329 ms | 9.4 MiB |
| C3 | 308 ms | 157 ms | 204 ms | 9.2 MiB |
| C4 | 324 ms | 149 ms | 208 ms | 41.1 MiB |
| C5 | 325 ms | 155 ms | 214 ms | 41.5 MiB |
| surveyed | 312 ms | 164 ms | 203 ms | 41.5 MiB |
| profiled | 317 ms | 146 ms | 211 ms | 41.2 MiB |

C2 introduced a large transient regression and C3 repaired most of it. The C4
parsed-transcript cache then added 31.8 MiB retained heap relative to C3. It
improved warm detail by 5.4%, while cold worsened 5.2% and append worsened 2.0%.
Relative to the C1 floor, profiled cold, warm, and append are still respectively
16.7%, 18.7%, and 24.4% slower. This supersedes the initial one-session result
that made the cache trade-off look substantially more favorable.

Two independent surveyed-revision browser batches bounded same-SHA variation:

| budget | warm final p95 range | append final p95 range | maximum JS heap range | warm cache |
|---|---:|---:|---:|---:|
| 0 MiB | 882–903 ms | 675–685 ms | 124–188 MiB | 0 entries / 0 bytes |
| 24 MiB | 773–798 ms | 682–693 ms | 133–157 MiB | 3 entries / about 14.34 MB |

At the profiled revision, 24 MiB caching improves large-session warm final
return from 896 ms to 780 ms (13%) but changes appended final display from 689
ms to 696 ms. Fleet-scale warm return does not materially improve. Browser heap
is much noisier than forced-GC server heap, so YA's entry/byte accounting is the
cache-specific limit; the heap residual retains a broad independent ratchet.

### Transcript-cache source identity

A retained Claude transcript is a cache hit only when device, inode, ctime,
mtime, and size all match. Incremental parsing is reserved for strict growth
of that same file identity and still verifies the 1 KiB boundary immediately
before the previous parse offset. A changed same-size file, shrink, or replaced
inode receives a full parse, so an atomic provider rewrite cannot extend stale
cached state.

The bounded boundary probe does not prove that an arbitrary writer left every
earlier byte unchanged. A same-inode prefix rewrite followed by growth can
evade it when the final probe still matches. Current provider transcript
writers are treated as append-only; detecting a writer that violates that
contract would require a stronger source revision or full-file hashing before
incremental reuse.

## Current phase ownership

Every profiled sample explains at least 80% of each important total with named,
non-overlapping phases. Historical checkpoints have totals but no retrospective
owner clocks.

| total | smallest recurring 80% owner set | phases individually reaching 10% |
|---|---|---|
| fleet cold detail | augmentation, transcript read, framework/serialization/loopback | the same three |
| fleet warm detail | framework/serialization/loopback, augmentation; read joins in some repetitions | framework/serialization/loopback, augmentation, and sometimes read |
| fleet appended detail | augmentation, framework/serialization/loopback | the same two |
| large cold detail | augmentation, framework/serialization/loopback, transcript read | the same three |
| large warm detail | framework/serialization/loopback, augmentation | the same two |
| large appended detail | framework/serialization/loopback, augmentation | the same two |
| browser warm return | React commit to readable text, state queued to commit; response transfer or navigation residual where needed | commit to readable, state to commit, and large cache-off response transfer |
| browser append | append trigger to preprocess, group to commit | those two; commit to readable is near 10% at fleet scale |

Augmentation consumes normalized persisted messages and project context and
produces Markdown/media/project-path-enriched response messages. Its shared
path index is reused, but Markdown and path traversal reran per returned text
block and request at the profiled revision. Framework/serialization/loopback
carries those response bytes through Hono and the direct WebSocket relay; at the
profiled revision the relay decoded, parsed, wrapped, re-encoded, chunked,
reassembled, and parsed JSON. Browser append trigger-to-preprocess includes file
observation, focused refresh, state merge, and scheduling. The profiled revision
had a fixed 200 ms watcher debounce; current source checks on the leading edge
and keeps the delayed check as validation. React commit-to-readable covers the
rendered transcript projection after state is queued.

The significant phases, their cache/invalidation contracts, and concrete
recovery seams are maintained in `gaps/perf-regressions-survey.md`. Ratchets
cover the current major phase values without treating nested MessageList spans
as additive peers of their queued-to-commit parent.

### 2026-08-08 augmentation recovery

The first recovery slice detaches the selected response window before any
context-specific HTML, tool, media, or pruning mutation. Claude task state is
still folded over the complete transcript, but only task-bearing messages are
copied before pagination. Persisted Markdown HTML then uses a 32 MiB
source-versioned single-flight cache keyed by exact content and render scope.
Project-path membership supplies the monotonic admission fence; unwatchable or
synchronous-stat fallback answers may coalesce in flight but are not retained.
Inline local images remain outside retained HTML because their file bytes have
no content revision.

A clean same-host `fleet-small` comparison against `a16b6c4a` reduced warm
augmentation p95 from 14.7 ms to 1.3 ms and appended augmentation from 27.1 ms
to 6.1 ms. Warm readable-tail p95 fell from 28.105 ms to 13.244 ms and appended
tail from 46.033 ms to 20.013 ms. Forced-GC retained heap rose from 21.293 MiB
to 23.733 MiB. The cache retained 5,196,384 bytes across 288 entries, with
1,744–1,768 hits and 56–80 joined calls per repetition.

The larger speculative sample retained 17,007,616 Markdown bytes across 128
entries. Warm augmentation was 9.0 ms and appended augmentation 39.2 ms, versus
89.9 ms and 126.1 ms in the historical profiled row. Retained heap was 49.544
MiB versus 41.163 MiB historically. That sample used capacity key
`host-v1-linux-x64-16cpu-126720mib-ecfa1407f7322835`; its 45.4-second window
observed 6% whole-host CPU occupancy, load/effective-CPU at or below 0.049,
at least 121,322,082,304 effective available bytes, and no swap-use change.
This supports the improvement and exposes its bounded memory price without
reclassifying the immutable historical rows.

### 2026-08-08 relay serialization recovery

Valid UTF-8 JSON responses now keep their original body bytes through the
existing `RelayResponse` envelope. The adapter still performs one syntax parse
to enforce the established invalid/empty `body: null` behavior, and it still
buffers a complete response. It no longer serializes the parsed body a second
time. The internal send capability preserves the public message shape and the
existing text/binary, compression, encryption, transport-chunk, sequence, and
pre-auth frame-mode contracts. `Server-Timing` now crosses the relay.

Maintenance and suite output report eligible JSON responses, raw fast-path
hits, preserved body bytes, invalid/unsupported fallbacks, and raw-send
failures. These are fixed-cost process counters. A zero eligible count means a
driver did not exercise this path; compare hit and fallback rates only within
an execution whose eligible count is nonzero.

The focused seven-sample benchmark used a 4,143,404-byte JSON body and alternated
the parsed/re-encoded and validated/raw arms. Median plaintext serialization
fell from 7.96 ms to 3.67 ms (2.17x); gzip-plus-NaCl serialization fell from
21.49 ms to 16.05 ms (1.34x). Capacity key
`host-v1-linux-x64-16cpu-126720mib-ecfa1407f7322835` recorded 12% whole-host CPU
occupancy, maximum load/effective-CPU 0.044, at least 121,307,148,288 effective
available bytes, and no swap-use change during the 0.5-second comparison.
Removing the remaining validation parse would require a separately proven typed
producer boundary; this recovery does not assume one.

### 2026-08-08 focused append observation recovery

The focused `fs.watch` path now requests a stat check immediately and retains
the 200 ms debounced check as trailing validation. Polling remains the fallback.
If a check is already running, one pending check is preserved rather than
dropped, with an observed filesystem event taking priority over a poll. Each
focused change carries a process-monotonic version, observation source and
wall-clock timestamp, emission timestamp, and exact path/mtime/size fact.
Direct global file events carry the same optional fact; fallback rescans and
deletes may omit it.

The client deduplicates only an exact path/mtime/size fact reported through the
broad and focused routes within one second. A missing fact or a repeat from the
same route keeps the existing leading/trailing fetch behavior, preserving a
bounded recovery opportunity. Older servers omit the additive fields and keep
that same pre-deduplication behavior. Browser profiles now split receipt,
request launch, data readiness, state queueing, and MessageList preprocessing
on the browser's `performance.now()` clock. Server wall-clock timestamps are
retained as source facts and are never subtracted from browser marks.

In a final three-repetition `fleet-small` browser run, append-start to
preprocess was 59.3 ms p95 with both zero and 24 MiB transcript-cache budgets,
down from the earlier 261.8–262.2 ms fixed-floor observation. Final display was
187.5 and 188.4 ms p95. The browser-clock path was at most 0.1 ms from receipt
to fetch request, 0.2 ms to request start, 47.1 ms to data readiness, 1.4 ms to
state queueing, and 7.5 ms to preprocess. The capacity-keyed 99.2-second window
used 25.1% whole-host CPU, reached load/effective-CPU 0.293, retained at least
117,738,115,072 effective available bytes, and had no swap-use change. The
earlier three-repetition large-session sample improved append-start to
preprocess from the historical 396–397 ms to 175.9–181.6 ms. Ratchets now cap
this phase at 200 ms for `fleet-small` and 300 ms for
`large-session-cache`.

## Ratchet interpretation

The current maximums use broad margins over the three-repetition survey and the
second surveyed-revision browser batch. They are estimated to pass unchanged
code with at least 99.9% probability; this is an engineering estimate, not a
claim based on 1,000 trials. Browser warm and appended final-display targets
remain at or below the one-second user-concern threshold. Independent targets
cover significant server/browser phases, response volume, named cache charges,
heap residuals, transcript entries/bytes, DOM nodes, and rendered message rows.

Working-set identity, held-refresh behavior, zero-budget behavior, exact fixture
counts, negative link controls, and the configured browser-cache byte budget
remain hard correctness failures rather than probabilistic thresholds. The
ratchets intentionally do not redefine a historical floor as acceptable merely
because it fits below a broad current maximum.

## Coverage boundary

This family covers static provider-file discovery, public project/session and
collection reads, file-observed live append, glossary artifacts and hints,
automatic generalized bare project-path links where supported, browser
transcript retention, and server/browser memory. The pinned fixture requires
exact positive path anchors and absent-path, MIME-type, and version-shaped
negative controls. Automatic path linking has no saved enable switch; C0/C1
lack generalized bare-prose support and C2 onward provide it automatically.

The family also does not synthesize an owned provider process, so it does not
isolate raw provider activity from its later enriched same-id replacement in
`createSessionSubscription`. It does not create public-share records or hold
owned sessions through long idle-reap deadlines. Those specialized paths
retain their focused correctness and relay tests; claims about their token-rate,
share-herd, or long-idle performance require dedicated black-box fixtures
rather than being inferred from this suite.
