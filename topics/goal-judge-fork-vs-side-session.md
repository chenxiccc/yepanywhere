# Goal-Judge Fork vs Side-Session

> Goal-judge fork vs side-session is the open experiment deciding where
> a loop-until-done stop judge should live — a forked same-model turn, a
> side session (small, same-tier, cross-vendor, or tool-running), or
> worker self-declaration — measured on false-complete rate,
> false-continue rate, and real billed cost.

Topic: goal-judge-fork-vs-side-session

Status: proposal drafted 2026-08-07, awaiting maintainer review; no
experiments run. The proposal (question, arms, hypotheses, phase
design, result scaffolds) is
[`research/goal-judge-fork-vs-side-session.md`](../research/goal-judge-fork-vs-side-session.md).
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
   judge-turn templates — see proposal § Cross-cutting factors);
   claim/proof markers recorded so trigger policies score offline.
6. Math-arm pilot + task screening for legitimate
   believed-done-but-wrong states (selection rules in the proposal §
   Task selection).

## Contracts (to be settled by the experiment)

The proposal's hypotheses H1–H6 are the open questions; no observable
product contract exists yet. When results land, the durable contracts
(judge placement, escalation policy, default-off configuration
surface) get recorded here and the proposal's scaffolds become tables.
