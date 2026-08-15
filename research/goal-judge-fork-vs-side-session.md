# Goal Judging: Forked Same-Model vs Side-Session Judges

Status: SPECULATIVE — proposal only. No experiments have run and every
hypothesis is unverified. The maintained experiment protocol and execution
queue live in the canonical
[`goal-judge-fork-vs-side-session`](../topics/goal-judge-fork-vs-side-session.md)
topic; candidate grids and result scaffolds live in its
[`sketches`](../topics/goal-judge-fork-vs-side-session.sketches.md) companion.

## Research question

A loop-until-done agent needs a per-turn stop decision: is the goal condition
met, or should the agent keep working? Claude Code's `/goal` sends the
condition and transcript to an external small model after every turn. Codex
CLI's `/goal` lets the worker model itself declare completion under an audit
prompt. A third design point is to fork the worker session at the turn boundary
and run one same-model judge turn inside the fork. The fork sees the complete
context and may reuse the provider's cached prompt prefix, but it may also
inherit the worker's momentum and optimistic framing.

This proposal asks: **which judge architecture gives the best trade-off of
false-complete rate, false-continue rate, and real billed cost — worker
self-declaration, a forked same-model judge, or a side-session judge?** The
failure asymmetry matters: a false completion silently ships unfinished work;
a false continuation consumes a bounded additional turn and can sometimes
damage a state that was already correct.

The answer would choose a real YA product direction. YA already has fork and
side-session machinery across its Claude and Codex providers, so the comparison
can hold the worker and task fixed while varying judge placement.

## Background and candidate architectures

Claude Code buys judge independence at the price of transcript-only evidence
and a second-model call. Codex buys lifecycle integration and zero marginal
judge cost at the price of self-grading. A fork trades some independence for
full evidence fidelity and potentially cache-discounted input.

The comparison covers these architecture families:

- **SELF:** the worker declares completion under an audit instruction.
- **FORK:** a discarded fork of the worker runs one same-model judge turn with
  the full context.
- **SIDE:** a fresh or incrementally caught-up side session sees a shared
  transcript excerpt. Judge strength varies from a cheap small model through a
  same-tier or cross-vendor model to a tool-running verifier.
- **HYBRID:** a cheap screen accepts continuation, while a stronger arm must
  confirm completion.

Every external arm returns the same `{done, reason}` contract. The maintained
specification freezes the exact arm names, prompts, moderators, trigger
policies, and excerpt rules before runs begin.

## Hypotheses

Each hypothesis is speculative and has an explicit falsifier in the internal
experiment specification.

- **Independence:** a fresh same-strength side judge has fewer false
  completions than a fork judge.
- **Evidence fidelity:** a full-context fork is more accurate than a small
  transcript-only judge when decisive tool evidence is omitted by the excerpt.
- **Cost crossover:** a cache-hit fork becomes cheaper than fresh side-session
  input above some transcript length.
- **Self-grading base rate:** SELF has more false completions than external
  judges; if it does not, external judging is insurance without demonstrated
  value.
- **Hybrid frontier:** selective escalation occupies a better quality-cost
  frontier than paying a strong judge at every turn.
- **Vendor diversity:** cross-vendor judging changes correlated blind spots
  more than aggregate accuracy.
- **Instruction moderation:** proof-demanding work directives and adversarial
  judge prompts may shrink or reorder the architecture gaps.
- **Gated triggering:** claim- or proof-gated judging retains most protection
  against false completion at a fraction of every-turn cost.

## Concise method

Both testbeds use a machine-checkable oracle hidden from the worker and every
judge. A cheap math pilot uses recent exact-answer problems. The headline
coding arm uses tasks with incomplete visible checks and a separately audited
hidden acceptance suite. Candidate tasks must be difficult enough to produce
legitimate believed-done-but-wrong states while remaining completable within
budget; tasks with a sufficient visible verifier are excluded because they
collapse judgment into reading a check result.

The experiment has three phases:

1. **Calibration:** verify fork prefix-cache behavior on both providers, record
   the applicable billing model, and inspect one aligned input/verdict/oracle
   example per arm. Calibration supports no quality conclusion.
2. **Paired verdicts:** drive fixed worker trajectories independently of the
   judges and query every arm at the same turn boundaries. This isolates
   judgment quality on one state distribution. Report false-complete and
   false-continue rates both over all boundaries and over boundaries where the
   worker believed it was done.
3. **Closed loop:** let the best quality-cost candidates plus SELF control
   continuation on a fresh task split. Measure true task success at a fixed
   budget, total cost, turns to true completion, work after first completion,
   and regressions caused by mistaken rejection guidance.

Decisions are paired by task or boundary. Smoke runs carry no conclusions.
Final comparisons include uncertainty intervals and a quality-cost Pareto
view. Raw success alone cannot crown an arm: a judge can buy more eventual
success by rejecting indefinitely. The economic analysis therefore sweeps the
relative costs of visible budget exhaustion and silent false completion and
reports where each architecture wins.

## Evidence and research gap

The shipped system contrast is Claude Code's external transcript judge versus
Codex CLI's worker-declared goal lifecycle. Relevant prior work reports
self-preference in language-model evaluators, benefits from separating
production and review contexts, limits of intrinsic self-correction, and gains
from tool-using agent judges. DeepSWE's released judge audit also demonstrates
that verifier disagreement can be large, which makes oracle auditing a
load-bearing part of this design.

The open gap is narrower than general model-as-judge research: no found work
ablates goal-loop stop-judge **placement** (in-context, fork, fresh side
session), judge identity, and evidence access while holding worker, task, and
stop boundary fixed and measuring actual prompt-cache economics. The complete
prior-art citations and verification status remain in the internal sketches
until the queued related-work extraction makes them publication-ready.

## Product payoff

If an external judge earns its cost, YA can offer a configurable, default-off
loop-until feature whose judge placement and escalation policy follow the
measured frontier. If SELF performs comparably, YA can use the cheaper
lifecycle-only design and avoid a standing judge tax. The same budget protocol
also prices a separate hard-cap feature that stops spending at a user-set bound
and reports an honest incomplete outcome.

## Threats to validity

- A fixed Phase 1 driving policy samples states that a closed-loop judge might
  never create; Phase 2 measures the resulting trajectory differences.
- All SIDE arms must share one excerpt builder so excerpt quality does not
  masquerade as model quality.
- Hidden oracle results must never enter provider context.
- A false-failing hidden suite systematically favors paranoid judges; benchmark
  tasks require audit and strong-disagreement boundaries require human review.
- Fork cache behavior and gateway billing can differ from the assumed token
  model; recorded telemetry gates every cost claim.
- Task screening conditions conclusions on the judge-relevant population and
  must report its selection yield.
- Truth can regress after first completion, so the oracle is evaluated at every
  boundary rather than treated as monotone.

## Future work

- Judge ensembles and multiple adversarial refuters beyond the first hybrid.
- Goal conditions with executable check schemas.
- OpenCode and Gemini provider generalization.
- Attribution of which rejection reasons accelerate later convergence.
