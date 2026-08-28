# The perf suite cannot perturb full-stack async boundaries

YA's performance regression suite compares revisions and already records useful
server and browser phases, but it cannot ask the within-revision counterfactual
that identifies cascade-sensitive work: “what changes if this one async/queue
boundary becomes slower, rate-limited, error-prone, or unavailable?” It has no
shared observation/injection aspect, no scenario manifest for a perturbation,
and no explicit injection/recovery/residual phases. As a result, a profile can
name an expensive phase without showing whether degrading or improving that
owner changes final user-visible latency, goodput, correctness, or recovery.

The existing harness in `scripts/perf-suite/` is the right owner. It already
provides isolated worktrees, disposable app data and ports, deterministic
fixtures, host-capacity evidence, real-browser drivers, hard correctness
checks, and clean process teardown. Extend it with controlled perturbations;
do not create a second benchmark system or activate faults in production.

Start with representative application-owned seams rather than instrumenting
every async operation immediately:

- provider/runtime output into `Process.processMessages()` in
  `packages/server/src/supervisor/Process.ts`;
- `Process.emit()` / `EventBus.emit()` in
  `packages/server/src/watcher/EventBus.ts` through `createSendFn()` in
  `packages/server/src/routes/ws-relay-handlers.ts`;
- client receipt and stream reconciliation in
  `packages/client/src/hooks/useSession.ts` and `useStreamingContent.ts`; and
- the existing `useStreamingMarkdown.ts` and
  `packages/client/src/components/MessageList.tsx` commit phase boundaries.

One test-only interface should give each point a stable name, report count,
wait/service time, queue depth or in-flight work where meaningful, and accept a
typed perturbation. Keep wait-before-service, service-time inflation,
throughput release/cap, injected I/O error, worker crash, and explicit reorder
as distinct semantics. Delay must preserve normal ordering unless reordering
is the named fault.

Add a seeded scenario record with revision, workload, capacity key, warmup,
injection interval, recovery interval, boundary settings, and correctness
oracle. The first experiment matrix should perturb one point at a time and
sweep severity finely around response knees. Measure goodput, phase-specific
latency, queue/backlog state, resource pressure, recovery time, and residual
memory/work after the perturbation ends; aggregate p99 alone can hide an
interval that completes too little work to contribute samples. Add compound,
random, or adversarial scenarios only after the single-point map can guide
them.

Treat slowdown sensitivity as candidate selection, not a numeric speedup
prediction. Thresholds, failover, batching, queue state, and ordering can make
slowing one point unlike speeding it up. Every optimization credited from the
map needs the actual change measured on/off under the same seeded scenario, or
another explicit opposing intervention.

Acceptance for the first vertical slice:

- one shared test-only hook records an unperturbed metric and applies a seeded
  delay/rate perturbation at at least one server and one browser boundary;
- one existing real-browser scenario spans provider simulation through final
  display and records baseline, injection, recovery, and residual phases;
- the run proves normal event ordering/correctness, leaves the live server
  untouched, and passes the suite's survivor check;
- a severity sweep retains non-monotonic results rather than reducing them to
  one “worst” setting; and
- one candidate optimization or opposing intervention receives a paired on/off
  comparison under the identical scenario.

The method pieces are established prior art. *One-Size-Fits-None* already maps
slow-fault severity, location, workload, hardware limits, and recovery;
Sieve/Chronos target fine-grained delay points; Filibuster and LDFI reduce
fault-space search; FoundationDB supplies seeded delay/error/crash simulation;
Coz uses perturbation for optimization attribution; and NACD/EventRacer cover
JavaScript async-delay or browser-event instrumentation. YA's located
difference is the engineering combination: one application-owned aspect from
server internals through browser rendering, tied to the same user-visible
performance and recovery oracle. Do not present it as a new fault-injection
algorithm.

Grounding: `~/agents/surveys/slow-fault-injection/survey.md`, especially its
decision summary, YA comparison, and experimental recipe. Current YA contracts:
`topics/performance-regression-suite.md`,
`docs/project/server-message-routing.md`, and
`packages/client/RENDERING_PERFORMANCE.md`.

Found 2026-08-28 while grounding the degradation-injection performance idea
against primary literature and mapping it onto YA's existing perf suite.
