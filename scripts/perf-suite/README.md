# YA performance regression suite

This checkout-independent harness imports no measured-tree code. Each run
generates a deterministic Claude store, starts one isolated YA instance from
the named checkout, drives public interfaces, proves fixture-derived
correctness, and records raw JSON results.

The JSON scenario dimensions are:

- projects;
- sessions per project;
- initial and newly appended turns;
- concurrent clients;
- deterministic per-message payload bytes;
- repetitions and settling time; and
- browser transcript-cache budgets.

The default server driver uses public HTTP routes plus the maintenance
listener. It measures server startup, cold and warm project/session lists,
collection herds, cold/warm/appended session detail, response bytes, and
forced-GC heap/RSS. Forced GC uses the isolated server's inspector endpoint;
the suite never attaches to another process.

The optional browser driver starts the measured checkout's real React dev
client and performs the same server workload plus one browser page per
concurrent client. Before loading the app, it enables glossary hints and sets
the transcript-cache budget in browser storage; cache budgets run in separate
browser contexts. It records cold and warm readable-tail latency,
file-observed live append latency, `performance.memory`,
DOM/message/tool/streaming-block counts, YA's own transcript-retention
accounting, and contemporaneous server memory. Server-only and browser-driven
results are separate ratchet universes.

Every accepted sample checks project, session, message, and capability-gated
glossary invariants. Browser runs additionally prove that a zero
transcript-cache budget retains no warm entry and each nonzero budget retains
the session used for the warm reopen. The suite does not currently enable or
ratchet the default-off automatic project-file linker.

```bash
node scripts/perf-suite/run.mjs \
  --checkout /path/to/yepanywhere \
  --scenario fleet-small \
  --driver server \
  --label working-tree

node scripts/perf-suite/run.mjs \
  --checkout /path/to/yepanywhere \
  --scenario large-session-cache \
  --driver browser \
  --label working-tree
```

`config.json` owns scale points. `ratchets.json` owns per-driver, per-scenario
maximums. The initial targets use deliberately broad margins over the observed
three-repetition distributions, estimated to pass an unchanged implementation
with at least 99.9% probability. That is an engineering estimate, not a claim
of 1,000-run statistical verification. Browser warm and live readable-tail
ratchets remain at or below the one-second user-concern threshold.

The suite never uses port 3400 and never restarts the shared YA server.
Generated fixtures and isolated app data live under `work/` only for a run.
Raw result JSON is written under `results/`; both directories are ignored when
the suite is landed.

The real-browser driver intentionally uses the measured checkout's dev client
so one suite revision can run against old source checkouts. Its cold readable-
tail value includes Vite/module boot and is observational, not a production-
bundle ratchet. Warm in-app navigation and appended live text are the
user-facing browser ratchets.
