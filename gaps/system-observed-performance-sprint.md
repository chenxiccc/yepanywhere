# YA has no bounded system-observed performance sprint

YA has an end-to-end performance suite and several focused benchmarks, but no
executable one-sprint contract that asks an agent or person to improve the
user-visible system by a declared amount and then judges the result across
client and server costs. The prerequisite [semantic UI action stream](../topics/semantic-ui-actions.md)
is implemented with gather/replay acceptance evidence, so this sprint may now
begin.

Run exactly one improvement-targeting sprint. Do not turn the procedure into
an automatic generate-measure-retain loop, recurring job, or standing agent
goal yet. The sprint's final report must compare performance gain with human
and agent effort, measurement cost, code growth, and confidence so a separate
decision can be made about whether repetition or automation is worthwhile.

## Freeze the sprint specification

Before profiling or editing, record one immutable sprint manifest under the
existing `scripts/perf-suite/` result convention:

- choose `X` and define the primary offered-load recipe. The default goal is
  that the candidate at `+X%` offered load matches or beats the baseline at
  current load on the frozen weighted score while passing every hard gate;
- define how `+X%` changes the recipe's active provider sessions, browser
  clients, semantic actions, and provider-stream event rate. Do not change
  that interpretation after seeing a candidate;
- snapshot the baseline revision, capacity key, fixture and causal trace,
  repetitions, time budget, production-code growth budget, and client/server
  memory ceilings;
- seed the harness-owned browser from the user's exported, performance-relevant
  YA browser settings. Do not copy a live browser profile, authentication,
  source credentials, or private transcript content into the fixture; and
- freeze the selected scale points and scoring transforms before candidate
  generation. Use at least three baseline repetitions at one representative
  point and retain raw samples so variance remains visible.

Use this initial 100-point loss weighting unless the manifest records a better
pre-run reason to change it:

| Weight | Quality | Primary measurement |
|---:|---|---|
| 28 | UI responsiveness and frame health | semantic-action-to-next-paint, scroll frame-time/missed-frame distribution, long-task time |
| 24 | leak freedom | forced-quiescent JavaScript heap slope by elapsed time and completed streamed turns, corroborated by browser process-tree memory and retained DOM/store state |
| 20 | provider activity to visible stream | provider-emission anchor to the next readable incremental display, with final display secondary |
| 20 | steer delivery | composer Enter/semantic submit to the provider-runtime fixture observing the steer |
| 6 | themed tooltip and rich-card response | configured delay reported separately from work after the delay; include current tooltip and session/model-card surfaces |
| 1 | startup time | process launch to usable browser/server readiness |
| 1 | startup memory | peak startup and resident memory at readiness |

Normalize every term against its baseline and state the direction and clipping
rule in the manifest. The primary screening score decides whether an
improvement meets the threshold and is worth expensive validation. A favorable
average cannot erase a hard failure in the final accepted result.

## Acceptance gates and anti-cheats

- Candidate edits receive the focused unit or integration tests they need,
  written and run during implementation as usual. During search, also keep
  cheap scenario-validity and obvious correctness tripwires. Do not run the
  full expensive correctness suite, the full scale matrix, or exhaustive
  acceptance checks until a candidate first meets `X` on the primary
  performance screen. A knowingly incorrect candidate is still rejected
  immediately rather than benchmarked further.
- After that threshold, provider/session semantics, event ordering, error
  behavior, and the visible result of every replayed action must pass the full
  relevant correctness validation before the candidate is accepted.
- History preservation is a hard correctness constraint, but the expensive
  scroll-content comparison is a post-victory gate rather than work repeated
  for every candidate. During search, do not knowingly shorten the fixture,
  truncate history, or reduce prescribed loaded scrollback; cheap message,
  cursor, and retained-content counts may catch gross drift. Once a candidate
  otherwise wins, launch equivalent baseline and candidate browsers, traverse
  the same scroll anchors, and verify that sampled old turns remain loadable,
  scrollable, displayable, ordered, and content-identical. This is compatible
  with YA's bounded-window production path only when that final comparison
  explicitly loads and verifies the required history.
- A sustained JavaScript-heap growth slope after forced quiescence that exceeds
  the frozen tolerance fails. If the baseline already leaks, the candidate
  must materially reduce that slope; if the baseline is indistinguishable
  from zero, the candidate must remain bounded within the frozen tolerance.
  Also record browser process-tree PSS/private bytes, DOM/listener/layout
  counts, session-detail store bytes, and quiescent memory so moving retention
  outside the JS heap does not masquerade as leak freedom.
- Enforce hard server and browser process-tree memory ceilings throughout
  startup, service, recovery, and quiescence, using a cgroup/container or an
  isolated worker when available. Do not manufacture host-wide memory
  pressure on a shared machine. Per-request accounting does not classify
  memory retained after requests as low-weight startup cost.
- Current-load performance may not regress beyond frozen variance-derived
  tolerances. Rejecting excess work with an explicit retry-later outcome is
  allowed when the workload contract permits it; count accepted goodput,
  success latency, rejection latency, retry outcome, and abandoned work rather
  than rewarding a slow low-success state.
- Apply the code-growth cost model from
  `~/agents/topics/perf.sketches.md`: charge production growth, dependencies,
  public/config/schema surface, duplicated mechanisms, branches, coupling,
  and new operational states. Tests, documentation, and evidence remain
  required rather than becoming score-reduction opportunities.

## Scale matrix

Do not run the full Cartesian product. Use existing results and bounded
baseline sweeps to locate likely response knees. Candidate search runs only
the frozen primary screening point; after a candidate meets `X`, validate it
at the selected scale points plus one combined stress point chosen from the
observed knees:

- concurrent active provider sessions and simultaneous browser clients;
- project population and a large untracked-file burden comparable in file
  count, byte distribution, directory depth, and change activity to `~/draft`.
  A read-only metadata inventory or synthetic equivalent is sufficient; never
  copy its private contents or let the suite mutate that project;
- session length: a short control, a substantially longer geometric step, and
  the representative captured long-session trace, with the full-scrollback
  equivalence leg reserved for the provisional winner;
- Conversation View using the saved setting as the primary configuration and
  an explicit paired on/off contrast, because both projection paths matter;
- direct incremental provider streaming as the primary display workload, with
  final completion, non-conversation surfaces, navigation, scrolling, composer
  use, and themed tooltip/rich-card reveals represented in the action mix; and
- provider chunk/event rate, message size, tool/activity density, and server
  queue pressure sufficient to expose a client bottleneck that is actually
  gated by server work.

The existing small perf-suite scenarios remain controls, not evidence that
these long-session, large-project, or high-concurrency dimensions are covered.

## Causal latency paths

Carry one event/action identity through both directions where the current
protocol permits it and record each phase independently.

For provider-to-browser latency, measure provider-fixture emission, provider
worker/Hono receipt and processing, `Process`/`EventBus` fan-out, WebSocket
send/receive, client stream reconciliation, streaming-content/markdown work,
`MessageList` commit or DOM mutation, and next readable paint. Streaming
increments are the primary endpoint; final settled display is secondary.

For browser-to-provider latency, measure semantic composer submit or Enter,
client request dispatch, server route/queue time, session `Process` delivery,
provider-runtime dequeue, and fixture observation of the steer. Report the
phase that gates each endpoint rather than assigning every visible delay to the
browser.

For themed tooltips and rich cards, include the current `TooltipLayer` and
`SessionHoverCard` paths and locate any model-card owner by its actual symbol
before instrumenting it. Separate the configured intentional reveal delay from
handler, data-fetch, render, layout, and paint time.

## Data-gathering options

Use the smallest combination that answers the active theory; the sprint does
not require building every instrument below.

Existing YA signals should be reused first:

- `scripts/perf-suite/` real-browser timings, host-capacity evidence, CDP
  process-tree accounting, DOM/listener/layout snapshots, correctness checks,
  and teardown/survivor verification;
- `browserDebugPerformance` key/action-to-frame, frame-gap, long-task, JS-heap,
  element-count, and named app metrics;
- `[ClientTelemetry]` heap, DOM/row, session-detail retained/cache-byte, and
  route snapshot records;
- `logSessionUiTrace()` send, server-stream, and dispatch observations, kept as
  an observation log rather than converted into the semantic command bus;
- `profileRenderWork` and the existing metrics in `MessageList`, `useSession`,
  `useStreamingContent`, and `useStreamingMarkdown`;
- server phase clocks and subsystem logs, including batch queue wait/service,
  event/fan-out backlog, watcher/index expense, provider parse/cache timings,
  and maintenance RSS/heap/V8 status; and
- the completed semantic-action gather/replay stream, message/event anchors,
  visible-state predicates, match coverage, and first-divergence record.

Additional opt-in evidence may include Chrome DevTools Protocol Performance or
Tracing captures, React Profiler data, heap snapshots and allocation sampling,
forced-GC heap series, Node CPU/heap profiles and event-loop delay/utilization,
and Linux `perf`/flamegraphs on an appropriate isolated host. Ordinary
profiling and already-available per-subsystem expense logs are fully valid
discovery methods.

External resource-pressure drivers are also valid source-independent knobs. A
helper may occupy and continually touch a declared amount of physical memory
or consume a declared CPU/core share. Prefer cgroup/container controls such as
`memory.high`/`memory.max`, `cpu.max`, and `cpuset.cpus` when they can constrain
the server and harness-launched browser process trees independently. Treat
server pressure as the primary sweep and client pressure as a separately
declared axis. If the client cannot be isolated safely on the server host, run
it on another host through an SSH tunnel/remote forward and record both host
capacity keys. For every pressure leg, record the configured limit or helper
demand plus realized available RAM, reclaim/swap/pressure evidence, CPU
occupancy, and throttling. A shared-host helper is allowed only when it cannot
interfere with unowned workloads; ambient or unmeasured contention remains
diagnostic rather than acceptance-grade evidence.

Slowdown injection from `gaps/full-stack-degradation-injection.md` is optional
and is not a prerequisite for this sprint. If used, follow
`~/agents/topics/perf.md`: read the architecture and owning code first, state a
theory connecting the proposed injection site to an overall-UX symptom, and
permit a speculative test-only site to validate or falsify that theory. Record
realized dose, useful work, injection, recovery, and residual phases. A
slowdown-sensitive boundary is a candidate pointer, not proof that speeding it
up will help; measure the actual optimization on/off.

When the input space becomes too large for one-at-a-time plots, use a bounded
space-filling or factorial screening design over declared settings, retain
pairwise interactions around observed knees, and fit an interpretable response
surface only as a discovery aid. Validate every important relationship and
selected candidate with held-out paired runs; feature importance from the same
runs that selected a theory is not confirmation.

## One-sprint execution and result

1. Freeze the manifest, sanitized settings fixture, semantic trace, hard gates,
   score, `X`, code-growth budget, and selected scale points.
2. Record repeated baseline runs and decompose both causal latency directions.
3. Use architecture/code reading, existing logs, ordinary profiling, and
   optional slowdown probes to emit ranked system-observed code hotspot
   pointers. Each pointer names the scenario, external metric, phase evidence,
   owning code region, predicted marginal value, and likely manual edit.
4. Timebox candidate implementation. Prefer the smallest coherent edits; do
   not add instrumentation or caching merely because the score does not yet
   charge its maintenance cost. Write and run focused tests for each edit.
5. Run the cheap paired primary performance screen at current and `+X%` load,
   with cheap correctness and history invariants. Drop candidates with no
   useful gain. A notable but sub-`X` gain may remain as a checkpoint to build
   on within the sprint; do not spend the full suite on it yet.
6. After a coherent edit passes its focused tests and records a notable
   primary-screen gain, make a scoped checkpoint commit before expensive
   validation. Its message names the measured scenario and gain and states
   that the full suite and acceptance gates have not run. Do not commit every
   losing micro-experiment merely to preserve chronology.
7. Select a provisional winner after code cost. Only after it meets `X`, run
   the full relevant correctness suite, selected scale and combined-stress
   legs, leak/resource gates, and equivalent-browser scroll comparison. Reject
   it if any hard gate fails; do not rerun these expensive checks for
   already-losing edits.
8. Publish one result artifact containing the manifest, raw-run locators,
   variance, phase attribution, hotspot pointers, accepted/rejected edits,
   before/after score, load headroom, memory slopes, code cost, elapsed human
   and agent effort, and measurement overhead. An honest result that no
   candidate met `X` completes the experiment; it must not silently lower `X`.

Acceptance:

- the [semantic UI action stream](../topics/semantic-ui-actions.md) retains its
  disabled-path overhead and causal replay acceptance evidence;
- the owned harness leaves the live YA server, user browser, and `~/draft`
  untouched and passes process-survivor checks on every path;
- one frozen trace exercises both Conversation View modes, incremental
  streaming, both latency directions, and the named scale dimensions without
  a full Cartesian explosion, followed by the winner-only full-scrollback
  equivalence check;
- candidate edits run their focused tests, while the full expensive
  correctness/scale/resource validation is deferred until the primary weighted
  screen meets `X`; final acceptance requires both stages;
- notable measured intermediate gains receive honest scoped checkpoint commits
  that disclose the still-unrun full validation; and
- the result records effectiveness versus effort and makes no automatic
  recurrence, automation, or perpetual optimization loop part of closure.

Grounding and adjacent work: `~/agents/topics/perf.md`,
`~/agents/topics/perf.sketches.md`,
`~/agents/surveys/slow-fault-injection/survey.md`,
`topics/performance-regression-suite.md`, `topics/memory-growth.md`,
`topics/conversation-view.md`, and `gaps/full-stack-degradation-injection.md`.

Found 2026-08-28 while turning the system-observed performance synthesis into
one bounded YA optimization experiment.
