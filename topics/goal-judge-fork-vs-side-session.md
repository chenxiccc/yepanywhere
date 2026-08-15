# Goal-Judge Fork vs Side-Session

> Goal-judge fork vs side-session is the open experiment deciding where
> a loop-until-done stop judge should live — a forked same-model turn, a
> side session (small, same-tier, cross-vendor, or tool-running), or
> worker self-declaration — measured on false-complete rate,
> false-continue rate, and real billed cost.

Topic: goal-judge-fork-vs-side-session

Status: proposal drafted 2026-08-07, awaiting maintainer review; no
experiments run. The outward
[`research proposal`](../research/goal-judge-fork-vs-side-session.md) owns the
stable question, hypotheses, evidence gap, and concise method. The candidate
arm grid, detailed protocol, falsifiers, and result scaffolds are retained in
this topic's [`sketches`](goal-judge-fork-vs-side-session.sketches.md)
companion until the design is approved.
A research-advisor pass is due before execution begins (RESEARCH.md §
Research-advisor handoff); none has run yet.

## Why this belongs to YA

YA already ships every building block on both target harnesses, so the
experiment is orchestration plus an oracle runner, and the winning
architecture becomes a YA loop-until feature rather than a lab result:

- `AgentProvider.forkSession` — Claude jsonl-copy fork, Codex
  app-server thread fork, pi fork
  (`packages/server/src/sdk/providers/types.ts`, `claude.ts`,
  `codex.ts`, `sessions/pi-fork.ts`).
- `generateSummary` `strategy: "fork"` — the archived-hidden
  one-helper-turn fork shape used by retitle/fork-after-summary
  ([recaps](recaps.md), [fork-from-turn](fork-from-turn.md)); the
  judge turn is the same shape with a judge instruction.
- Shared helper side session + cumulative catch-up cursor
  ([side-session-config](side-session-config.md)) — the cacheable
  growing-prefix side judge; `Cheapest` / `Same as main session` /
  helper-target registry map to the SIDE-small / SIDE-same /
  SIDE-xvendor arms.
- Prefix-cache telemetry — `expectedCacheSource`,
  `prefixBasis: "provider-fork-byte-identical"`,
  `fork-prefix-cache-hit`/`miss` (`packages/shared/src/types.ts`) —
  gates the fork-is-cache-cheap cost hypothesis.
- Inactivity/away triggering ([recaps](recaps.md) client away timer,
  server last-activity timestamps) — reusable for the trigger-policy
  inactivity backstop (remind a stopped worker instead of invoking a
  judge).
- Product hook — `/wish` emulation and native `/goal` aliasing
  ([emulated-slash-commands](emulated-slash-commands.md)); any shipped
  loop-until feature is configurable default-off per
  [vanilla-defaults](vanilla-defaults.md).

## Maintained experiment contract

The comparison varies one named architecture boundary at a time while holding
the worker trajectory and judgment interface fixed:

- SELF is the zero-marginal-cost worker declaration baseline.
- FORK runs a same-model judge turn on a discarded full-context fork.
- SIDE-small, SIDE-same, and SIDE-xvendor share one excerpt builder and vary
  judge strength or family without changing the evidence projection.
- SIDE-tools may inspect the workspace and rerun visible checks but never sees
  the hidden oracle.
- HYBRID lets a cheap judge continue alone but requires a stronger judge to
  confirm completion.

Every arm returns `{done: yes|no, reason}`. A continuation reason may guide a
later worker turn, but Phase 1 ignores all verdicts while producing the shared
trajectory. This separates paired judgment accuracy from Phase 2's closed-loop
guidance effect.

The frozen factor grid has two pre-implementation goal directives (plain and
proof-demanding) and two judge templates (neutral and adversarial). The goal
directive affects both worker behavior and the rubric seen by every judge; it
is not a judge-only prompt variant. Claim-gated and proof-gated triggering are
scored from the same recorded boundaries. True inactivity without a claim gets
a worker reminder rather than silently counting as completion.

Both testbeds use a per-boundary hidden oracle that never enters provider
context. Visible checks must remain incomplete proxies, and pilot screening
must find both believed-done-but-wrong states and genuinely completable runs.
Report the screening yield so results are explicitly conditioned on this
judge-relevant task population.

Phase 0 verifies provider prefix-cache and billing assumptions. Phase 1 queries
all arms at identical boundaries under a fixed driving policy. Phase 2 lets
SELF plus the two or three Pareto-best candidates drive fresh closed-loop
runs. No smoke-scale run supports a conclusion.

Required outputs are false-complete and false-continue rates over all
boundaries and over worker-believed-done boundaries, true completion at fixed
budget, total cost, time and turns to completion, overshoot after first true
completion, and rejection-induced regression. Raw success alone is not a
winner criterion. Report the quality-cost frontier and each arm's win region
as the relative penalties for visible budget exhaustion and silent false
completion vary. The sketches companion owns the exact statistical thresholds,
symbolic cost model, and table schemas.

## Experiment queue

Phase 0 items, in order; nothing below runs before maintainer sign-off
on the proposal:

1. Research-advisor pass on the proposal (direction commitment gate).
2. Related-work extraction: `research/goal-judge-fork-vs-side-session/
   related-work/` with fetch script + `papers.bib`-style manifest for
   the post-cutoff papers currently cited at abstract level
   (arXiv:2603.12123, 2606.09863, 2604.22891, 2508.06709).
3. Fork prefix-cache verification on Claude and Codex via existing
   telemetry (does a judge turn in a fresh fork actually bill as
   cached prefix read?). This alone is worth having regardless of the
   experiment.
4. Oracle runner: server-side turn-boundary hook running hidden checks
   out-of-band (never entering provider context — recap viewer-state
   separation discipline).
5. Judge-arm plumbing behind an experiment flag; shared excerpt
   builder; frozen instruction grid (2 goal-directive strengths × 2
   judge-turn templates — see the sketches § Cross-cutting factors);
   claim/proof markers recorded so trigger policies score offline.
6. Math-arm pilot + task screening for legitimate
   believed-done-but-wrong states (selection rules in the sketches §
   Task selection).

## Product decision contract

No observable product contract exists yet. When results land, this topic owns
the durable judge-placement, escalation, budget, fallback, and default-off
configuration decisions. Result rows move to a linked result log; the outward
proposal records only publication-facing conclusions supported by those rows.
