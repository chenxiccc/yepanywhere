# Performance-regression survey findings

The independent, configuration-driven workload found the concerns and
trade-offs below across the 2026-08-03 through 2026-08-08 performance and
harsh-review arc. One checkout-independent harness generates Claude projects,
sessions, initial and appended turns, and concurrent clients. Its server driver
uses public HTTP routes plus forced-GC maintenance samples. Its optional real
browser driver uses the same scenario parameters, enables glossary hints, sets
browser transcript-cache budgets before app load, and records readable-tail
latency, live appended text, browser heap/DOM counts, YA transcript-cache
statistics, and server memory. Every accepted sample first proves exact
project, session, capability-gated glossary, and message counts.

## Cold project enumeration exceeds one second before and after the arc

At both pre-sprint `adaa804b` and current `2f5e403e`, the first concurrent
per-project session-list pass at `fleet-small` takes about 1.33 s p95. An
immediate replay takes only 4–6 ms p95. Forced-GC pre-sprint memory is 92.2 MiB
settled heap with 8.6 MiB retained over startup, not the much larger uncollected
figures from the exploratory runs.

The delay is first-index construction over previously unseen transcript files,
not sustained route latency and not a regression introduced by this arc. It
still crosses the one-second user-facing threshold when a data directory has no
usable session indexes. Current ratchets must distinguish this cold-index leg
from the ordinary warm list path rather than accepting 1.3 s for both.

## Browser live append crossed one second until the measured perf arc

With four real browser clients at `fleet-small`, file-observed appended text
reached the rendered tail in 1.29 s p95 at C0 `adaa804b` and C1 `3c0f70df`.
That fell to 387 ms at C2 `61cb5f35` and remained 378–403 ms through C3, C4,
C5, and current HEAD. This concerning pre-arc behavior was repaired during the
measured performance sequence and was not reintroduced by harsh-review work.

A fresh dev-client boot plus first session render remains about 4.2–5.1 s at
every checkpoint. This includes Vite/module startup and is not a production
bundle or session-route-only number; warm in-app reopen is 494–569 ms. Keep the
cold browser observation separate from production user-facing ratchets until a
built-client driver isolates application boot from development transforms.

## Parsed-server cache exchanges retained heap for repeat-read latency

At the `large-session-cache` scale point (2 projects × 4 sessions × 16 final
turns, 3 concurrent clients, 64 KiB per message), commit `6024cff1` changes the
forced-GC server results as follows:

- retained heap: 8.4 MiB before to 32.8 MiB after;
- settled heap: 94.1 MiB before to 118.6 MiB after;
- cold readable-tail p95: 263 ms before to 268 ms after;
- warm readable-tail p95: 145 ms before to 125 ms after; and
- appended readable-tail p95: 200 ms before to 189 ms after.

The roughly 24.4 MiB retained-heap increase buys about 14% faster warm detail
and 5% faster appended detail at this scale. This matches the cache's purpose;
it is a measured memory/latency trade-off, not a confirmed regression.

## Browser transcript caching is also an explicit memory/latency trade-off

At current HEAD with `large-session-cache`, a 24 MiB browser transcript-cache
budget versus zero changed warm in-app readable-tail p95 from 847 ms to 677 ms
(about 20% faster) and retained one approximately 4.75 MiB transcript in YA's
warm-cache accounting. The maximum observed browser JS heap was 130.9 MiB with
the cache versus 112.3 MiB without it; browser heap has higher run-to-run noise
than forced-GC server heap, so use the YA byte accounting as the cache-specific
ratchet. Appended live-tail p95 was 785 ms with caching and 827 ms without.

## Specialized black-box coverage remains open

Automatic project-file linking is default-off and is not enabled or ratcheted
by the landed browser driver. An exploratory inline-code fixture proved ordinary
project-file link rendering at C1 and HEAD, but that always-on inline-code path
is not evidence for the optional automatic linker. Historical comparison needs
a checkout-independent way to preseed the saved setting, or a dedicated test
environment override, before this feature can join the shared scenario family.

The shared family also cannot yet synthesize an owned provider process, create
a public-share record without operator relay settings, or hold owned sessions
through long idle-reap deadlines. It therefore must not be cited as direct
performance evidence for raw-provider-versus-enriched replacement ordering,
public-share serialization herds, or long-idle owned-session retention. Add
focused black-box fixtures before those paths receive ratchets; the existing
correctness and relay tests remain the current evidence.

Found and reconciled 2026-08-08 while running the independent
performance-regression survey.
