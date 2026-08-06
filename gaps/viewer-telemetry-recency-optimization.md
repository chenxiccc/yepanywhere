# Viewer telemetry spends CPU to save a small amount of heap

`packages/server/src/services/PublicShareService.ts` tracks global viewer
recency with an insertion-ordered `Set<ViewerTelemetryRecord>`. Refreshing a
record deletes and re-adds it; expiry and capacity eviction create an iterator
to retrieve the oldest live record. This is considerably slower than an
intrusive doubly linked list on the deployed V8, and a tombstoned prefix can
make a fresh oldest-entry iterator scan internal deleted slots. No portable
constant-time claim should be made for that lookup.

A local microbenchmark on Node v24.14.0 / V8 13.6.233.17-node.41 measured:

| operation | current Set | intrusive links |
|---|---:|---:|
| refresh + oldest, 100 retained | 57.9 ns | 8.2 ns |
| refresh + oldest, 4,096 retained | 104.7 ns | 14.5 ns |
| oldest only, fresh 4,096-entry Set | 4.0 ns | direct pointer |
| oldest only after tombstone-heavy churn | 1.72 microseconds | direct pointer |
| rebuild + expire all 4,096 entries | about 2.5 ms | about 0.22 ms |

The faster structure is not free. A separate retained-heap benchmark used
500,000 modeled telemetry records, one identity map, and either the Set or two
intrusive links. The Set variant retained 170.34 bytes per record; the linked
variant retained 189.37 bytes per record. On that model, links cost about 19
additional bytes per record, or roughly 76 KiB at the current 4,096-record
process cap. They would also add explicit unlink, append, oldest/newest, count,
and clear invariants to every removal path. Those operations are straightforward
and the benchmark exercised their core behavior; this is ordinary testable code,
not a correctness barrier.

The final structure is deliberately undecided. The current Set wastes CPU to
save a little heap, but even its constructed tombstone-heavy lookup is small in
absolute terms and there is no evidence that viewer telemetry consumes a
meaningful percentage of total server compute at the intended roughly
100-session workload. Keep the simpler bounded Set for now. Re-raise this only
in a systematic optimization pass that profiles overall server cost and can
compare this facility's share, or after a workload change makes viewer
heartbeats materially hotter. If it matters then, replace the Set with an
intrusive doubly linked list and retain the per-share identity maps.

Found 2026-08-06 while closing the harsh-review viewer-telemetry cardinality
and maintenance finding.
