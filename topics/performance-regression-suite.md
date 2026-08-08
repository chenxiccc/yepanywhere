# Performance regression suite

> The performance regression suite is YA's configuration-driven black-box test family for comparing server and real-browser latency, retained memory, and correctness across project, session, turn, payload, cache-budget, and concurrent-client scales.

Topic: performance-regression-suite

## Contract

`scripts/perf-suite/run.mjs` imports no YA modules from the measured checkout.
It generates provider files, starts an isolated checkout on non-production
ports and app-data paths, verifies fixture-derived response and rendered-text
invariants, then records one JSON result. This lets the same suite revision run
unchanged against current or historical YA source.

The server driver uses public HTTP routes and the maintenance listener. Heap
ratchets use an inspector-requested full garbage collection followed by the
minimum of seven heap samples; RSS uses their median. The browser driver adds
the measured checkout's React dev client and one real page per configured
client. It preseeds browser storage to enable glossary hints and select each
transcript-cache budget, with cache budgets isolated in separate contexts.
Server and browser measurements are distinct ratchet universes.

Scale points and repetition counts live in `scripts/perf-suite/config.json`.
Targets live in `scripts/perf-suite/ratchets.json`; code contains no scenario-
specific thresholds. Generated work and raw results are local artifacts under
the suite directory and are not committed.

## 2026-08-08 historical survey

The initial survey used three repetitions per non-smoke point on one host. C0
is pre-sprint `adaa804b`; C1 is pre-measured-arc `3c0f70df`; C2 is end-of-arc
`61cb5f35`; C3 is end-of-harsh-review `d0131298`; C4 is parsed-transcript cache
`6024cff1`; C5 is enrichment-ordering `13d6e794`; HEAD is `2f5e403e`.

At `fleet-small` (4 projects, 6 sessions/project, 12 final turns/session, 4
clients, 8 KiB/message), forced-GC server results were:

| checkpoint | cold project-list p95 | warm project-list p95 | collection p95 | cold readable tail p95 | warm readable tail p95 | appended readable tail p95 | retained heap | settled heap |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| C0 | 1321 ms | 5 ms | 24 ms | 132 ms | 21 ms | 34 ms | 8.6 MiB | 92.2 MiB |
| C1 | 1346 ms | — | 22 ms | 125 ms | 20 ms | 30 ms | 8.7 MiB | 92.7 MiB |
| C2 | 1327 ms | — | 21 ms | 133 ms | 24 ms | 39 ms | 8.5 MiB | 93.1 MiB |
| C3 | 1369 ms | — | 16 ms | 135 ms | 25 ms | 37 ms | 8.6 MiB | 94.3 MiB |
| C4 | 1351 ms | — | 15 ms | 137 ms | 21 ms | 40 ms | 16.3 MiB | 102.0 MiB |
| C5 | 1337 ms | — | 16 ms | 134 ms | 21 ms | 40 ms | 16.3 MiB | 102.0 MiB |
| HEAD | 1338 ms | 4 ms | 15 ms | 136 ms | 23 ms | 40 ms | 16.3 MiB | 102.1 MiB |

The cold per-project session list is first-index construction. Immediate replay
is 4–6 ms at C0 and HEAD, so the greater-than-one-second result predates and
survives the arc without affecting the ordinary warm path. Collection-herd
p95 improved from 22–24 ms before the measured arc to 15–16 ms after review.
No harsh-review checkpoint reintroduced a persistent latency regression.

With real browsers at the same scale, file-observed appended text crossed the
one-second concern threshold at C0 and C1, then improved during the measured
arc and stayed below 410 ms:

| checkpoint | cache off: warm / append p95 | 24 MiB cache: warm / append p95 |
|---|---:|---:|
| C0 | 569 / 1287 ms | 550 / 1421 ms |
| C1 | 554 / 1295 ms | 494 / 1279 ms |
| C2 | 520 / 387 ms | 531 / 392 ms |
| C3 | 546 / 400 ms | 515 / 403 ms |
| C4 | 541 / 385 ms | 559 / 388 ms |
| C5 | 555 / 378 ms | 509 / 382 ms |
| HEAD | 465 / 383 ms | 503 / 378 ms |

A fresh browser plus dev-client module boot took about 4.2–5.1 seconds at every
checkpoint. That observational number includes Vite transforms, so it is not a
production startup ratchet. Warm in-app navigation and appended readable text
are ratcheted.

## Cache trade-offs

At `large-session-cache` (2 projects, 4 sessions/project, 16 final
turns/session, 3 clients, 64 KiB/message), `6024cff1` raised forced-GC retained
server heap from 8.4 MiB to 32.8 MiB and settled heap from 94.1 MiB to 118.6
MiB. Warm readable-tail p95 improved from 145 ms to 125 ms, appended from 200
ms to 189 ms, and cold remained about 263–268 ms. The roughly 24.4 MiB retained
increase is the intended process-wide parsed-transcript cache buying repeat-
read latency, not an unexplained leak.

At HEAD, enabling a 24 MiB browser transcript-cache budget improved large-
session warm in-app readable-tail p95 from 847 ms to 677 ms and appended live
tail from 827 ms to 785 ms. YA reported one warm entry of about 4.75 MiB.
Maximum observed browser JS heap was 131 MiB with caching versus 112 MiB
without it; this metric is noisier than forced-GC server heap, so YA's own cache
byte accounting is the cache-specific limit.

## Ratchet interpretation

The initial maximums use broad margins over the three-repetition survey,
estimated to pass an unchanged implementation with at least 99.9% probability.
This is an engineering estimate, not a claim based on 1,000 trials. Browser
warm and appended readable-tail targets remain at or below the one-second
user-concern threshold. Correctness assertions, including zero warm entries at
a zero browser-cache budget and positive retention at a nonzero budget, are
hard failures rather than performance thresholds.

## Coverage boundary

This family covers static provider-file discovery, public project/session and
collection reads, file-observed live append, glossary artifacts and hints,
browser transcript retention, and server/browser memory. It does not enable or
ratchet the default-off automatic project-file linker. That feature needs a
checkout-independent way to preseed its saved setting, or a dedicated test
environment override, before historical browser comparisons can claim it.

The family also does not synthesize an owned provider process, so it does not
isolate raw provider activity from its later enriched same-id replacement in
`createSessionSubscription`. It does not create public-share records or hold
owned sessions through long idle-reap deadlines. Those specialized paths
retain their focused correctness and relay tests; claims about their token-rate,
share-herd, or long-idle performance require dedicated black-box fixtures
rather than being inferred from this suite.
