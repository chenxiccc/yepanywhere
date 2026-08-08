# YA performance regression suite

This checkout-independent harness imports no measured-tree code. Each run
creates detached project worktrees from an immutable repository revision,
generates a deterministic Claude store whose sessions use those worktrees,
starts one isolated YA instance from the named execution checkout, drives
public interfaces, proves fixture-derived correctness, and records raw JSON
results. Every result distinguishes the measured execution revision, fixture
revision, and exact harness inputs. Harness identity includes the latest commit
touching runner/config/ratchets, path-scoped dirty state, and a content SHA-256,
so unrelated shared-worktree changes do not relabel the measurement.

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
Claude parsed-transcript retained source bytes/files, and project-path retained
bytes/projects/watchers. Named cache bytes are accountable source charges, not
an additive decomposition of V8 object memory; the heap-minus-known-source
value is labelled as a residual rather than exact cache overhead.

The optional browser driver starts the measured checkout's real React dev
client and performs the same server workload plus one browser page per
concurrent client. Before loading the app, it enables glossary hints and sets
the transcript-cache budget in browser storage; cache budgets run in separate
browser contexts. It records cold, warm-working-set, and file-observed append
latency through readable text, glossary annotation, automatic project-path
anchors, and the latest supported final display. It also records
`performance.memory`, DOM/message/tool/streaming-block counts, YA's own live and
warm transcript-retention accounting, and contemporaneous server memory.
Server-only and browser-driven results are separate ratchet universes.

Every accepted sample checks project, session, message, and capability-gated
rendering invariants against the pinned fixture. Browser runs warm a configured
three-session ring, leave the session route, verify the expected cache entries,
and revisit all three sessions. A held-refresh proof separately establishes
that cached final content is usable before a slow refresh completes, while a
zero budget remains blank until the request is released. That artificial hold
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
```

`config.json` owns scale points. `ratchets.json` owns independent per-driver,
per-scenario maximums. Targets use deliberately broad margins over repeated
observations, estimated to pass an unchanged implementation with at least 99.9%
probability. That is an engineering estimate, not a claim of 1,000-run
statistical verification. Browser warm and appended final-display ratchets
remain at or below the one-second user-concern threshold. Working-set identity,
zero-budget behavior, delayed-refresh behavior, and the configured cache byte
budget remain hard correctness checks rather than probabilistic ratchets.

The suite never uses port 3400 and never restarts the shared YA server.
Generated fixtures and isolated app data live under `work/` only for a run.
Raw result JSON is written under `results/`; both directories are ignored when
the suite is landed.

The real-browser driver intentionally uses the measured checkout's dev client
so one suite revision can run against old source checkouts. Its cold final-
display value includes Vite/module boot and is observational, not a production-
bundle ratchet. Warm in-app navigation and appended live final display are the
user-facing browser ratchets. “Readable” is DOM-text availability, not a browser
first-paint timestamp; project-path completion is observed after the glossary
wait and is therefore a sequential harness milestone rather than an independent
path-link timestamp.
