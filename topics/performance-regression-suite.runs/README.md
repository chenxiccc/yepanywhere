# Performance Regression Suite Run Ledger

This ledger holds the dated measurements and recovery chronology behind the
current [performance suite contract](../performance-regression-suite.md). The
complete 2026-08-08 source record is preserved under
[`20260808-recovery/original-topic.md`](20260808-recovery/original-topic.md).
It is historical evidence, not current harness guidance.

## 2026-08-08 survey and recovery series

Source identity: three repetitions per non-smoke point on one host; harness
`79fbeeb2d245672a471986c18be26ab580e2dc64`; fixture
`2f5e403e20fc5b96d5634a4b8f5a57704023d8da`. The source record maps C0 through
C5 plus surveyed/profiled revisions and contains the complete result tables,
capacity evidence, and cleanup notes.

### Historical checkpoint survey

[Full record](20260808-recovery/original-topic.md#2026-08-08-historical-survey).
Fleet-scale cold project indexing remained above one second while immediate
replay stayed 4–5 ms. Session-detail latency lost ground against the C1 floor;
the later cache recovered part of warm/append latency at a retained-memory
cost. These rows remain historical comparison evidence, not checked-in
ceilings.

### Production useful readiness and focused append

[Useful readiness](20260808-recovery/original-topic.md#production-useful-readiness)
measured fresh production-server and cold browser readiness for fleet and
large-session fixtures. An initial run was invalidated by a surviving real
provider process; only clean replacement batches informed the portable
ceilings.

[Focused append](20260808-recovery/original-topic.md#focused-append-critical-path)
isolated one selected-session response and DOM path from fleet fan-out. Its
separate scenario/history identity remains load-bearing.

### Cache trade-off survey

[Full record](20260808-recovery/original-topic.md#cache-trade-offs). A 24 MiB
parsed-transcript cache improved large-session warm return while adding roughly
32 MiB forced-GC retained server heap at the profiled revision and did not
materially improve fleet-scale warm return. Entry/byte accounting therefore
remains the cache-specific limit, with heap/process metrics as independent
residuals.

The transcript source-identity rule derived from this work has moved into the
canonical topic because it remains a current correctness contract.

### Augmentation recovery

[Full record](20260808-recovery/original-topic.md#2026-08-08-augmentation-recovery).
Window detachment plus source-versioned single-flight Markdown caching sharply
reduced augmentation and readable-tail latency, with bounded retained-memory
growth. This remains the evidence behind augmentation as a named phase and
behind separate cache-byte/memory ratchets.

### Relay serialization recovery

[Full record](20260808-recovery/original-topic.md#2026-08-08-relay-serialization-recovery).
Validated raw UTF-8 JSON bytes removed a second serialization across the relay
while preserving envelope and framing behavior. The focused alternation showed
lower plaintext and gzip-plus-NaCl serialization time. Counters must have a
nonzero eligible response count before hit/fallback rates are interpreted.

### Focused append observation recovery

[Full record](20260808-recovery/original-topic.md#2026-08-08-focused-append-observation-recovery).
Leading-edge stat checks, trailing validation, fact-aware deduplication, and
browser-clock instrumentation removed a fixed watcher/observation floor.
Server wall timestamps remain source facts and are never subtracted from
browser performance marks. The phase boundaries remain canonical.

### Watcher work bounding

[Full record](20260808-recovery/original-topic.md#2026-08-08-watcher-work-bounding).
Asynchronous bounded rescans, trailing-pass coalescing, lifecycle cancellation,
and shared focused watches recovered the measured watcher ownership path. The
still-global activity-stream fan-out remains tracked separately in
[`gaps/global-activity-stream-file-fanout.md`](../../gaps/global-activity-stream-file-fanout.md).

### Browser-native memory attribution

[Full record](20260808-recovery/original-topic.md#2026-08-08-browser-native-memory-attribution).
Complete Chrome process inventory plus Linux RSS/PSS/private-byte collection
closed the fleet-total undercount. Native-byte targets remain capacity-specific;
CDP object counts may remain portable. Browser-process bytes cannot be assigned
to individual YA components from this evidence.

### Specialized contract baseline

[Full record](20260808-recovery/original-topic.md#2026-08-08-specialized-contract-baseline).
The deterministic runtime worker and frozen-share herd established correctness
and timing ceilings for streamed thinking/final/enriched ordering, verified
idle release, share metadata/full responses, memory, and teardown. This is a
runtime-host/public-share baseline, not provider adapter or internet-relay
evidence.

## Current use

The canonical topic retains only conclusions that still govern driver design,
host eligibility, phase naming, cache identity, ratchet interpretation, and
coverage. When a newer run supersedes one of the conclusions above, add the new
entry here and mark the older subsection with the superseding run and reason;
do not restore chronology to the topic.
