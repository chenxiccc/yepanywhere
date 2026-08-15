# Goal-Judge Experiment Specification

Status: SPECULATIVE — candidate experiment design. No experiments have run;
every result table is a TBD scaffold and every hypothesis is unverified.
Canonical topic: [`goal-judge-fork-vs-side-session.md`](goal-judge-fork-vs-side-session.md)
(current decision surface and execution queue). Outward proposal:
[`../research/goal-judge-fork-vs-side-session.md`](../research/goal-judge-fork-vs-side-session.md).

## Research question

A loop-until-done agent needs a per-turn stop decision: "is the goal
condition met, or should the agent keep working?" The two shipped
designs put that judgment in opposite places. Claude Code's `/goal`
sends the condition and the transcript to an external small fast model
(default Haiku) after every turn — a disinterested judge that cannot
inspect anything beyond the transcript. Codex CLI's `/goal` (0.128.0+)
lets the worker model itself declare completion via `update_goal` under
an audit prompt — a capable auditor with a conflict of interest.
Neither is obviously right, and a third design point is untested: fork
the worker session at the turn boundary and run one judge turn inside
the fork. The fork sees the complete context (including tool results
the transcript excerpt may lose), gets a clean instruction frame, and —
because a provider-level fork is byte-identical to the parent prefix —
bills mostly at the prompt-cache-read discount rather than fresh input
price.

The question this proposal aims to settle empirically: **for
loop-until-done agent runs, which judge architecture gives the best
trade-off of false-complete rate, false-continue rate, and cost — a
forked same-model judge, a side-session judge (small, same-tier, or
cross-vendor), or worker self-declaration?** No controlled comparison
of these architectures on goal-stop decisions appears to exist
publicly (see Related work). The failure asymmetry makes the answer
matter: a false "complete" silently ships unfinished work, while a
false "continue" burns one bounded extra turn.

The result decides a real product design: YA (Yep Anywhere) already
ships the fork and side-session machinery for other helper features
(recaps, retitle, fork-after-summary) across both Claude and Codex
harnesses, so the winning architecture can become a YA-provided
loop-until mechanism with judge placement chosen by evidence rather
than by which CLI shipped first.

## Background: the two shipped designs

**Claude Code `/goal`** wraps a session-scoped prompt-based Stop hook.
At each turn end the condition plus the conversation so far go to the
configured small fast model (default Haiku; overridable via
`ANTHROPIC_DEFAULT_HAIKU_MODEL`), which returns yes/no plus a short
reason. "No" re-prompts the worker with the reason as guidance; "yes"
clears the goal. The evaluator calls no tools, so it can only judge
what the worker surfaced in the transcript.

**Codex CLI `/goal`** persists one goal per thread (SQLite via
app-server RPCs) with status, optional token budget, and usage
counters. Only `create_goal` and `update_goal(status: "complete")` are
model-facing; pause/resume/budget-limit are system-controlled.
Continuation fires at idle boundaries; budget exhaustion is a soft
stop steering the agent to wrap up. There is no second-model judge:
completion honesty rests on the worker's own audit reasoning.

The architectural crux: Claude Code buys judge independence at the
price of evidence access and a per-turn second-model call; Codex buys
lifecycle robustness and zero judge tax at the price of self-grading.
The fork design buys full evidence fidelity and cache-cheap pricing at
the price of judging inside the worker's own accumulated context —
whose momentum and optimistic status claims may bias the verdict even
under a clean judge instruction.

## The design space

The shipped designs conflate three independent axes. The experiment
separates them:

| Axis | Values |
|---|---|
| Context | worker's full context (fork) / fresh context fed an excerpt (side session) / in-context (self-declared) |
| Judge model | same model as worker / cheap small model / same-tier cross-vendor model |
| Evidence | transcript text only / full forked context / tool-verifying (can run checks) |
| Trigger | every turn end / on worker completion claim / on emitted proof artifact / on inactivity without a claim |

Named arms (used in all tables):

- **SELF** — worker self-declares completion under an audit prompt
  (Codex-native shape). Zero judge cost. Baseline.
- **FORK** — fork the worker session at the turn boundary; one judge
  turn in the fork with a clean judge instruction; fork discarded
  (archived-hidden). Same model as worker. Full context, cache-warm.
- **SIDE-small** — fresh side session on a cheap small model, fed the
  condition + a shared transcript excerpt (Claude Code `/goal` shape).
- **SIDE-same** — as SIDE-small but the worker's own model class:
  isolates context-independence from model strength.
- **SIDE-xvendor** — as SIDE-same but the other vendor's same-tier
  model (Claude worker judged by a GPT-class model and vice versa):
  isolates vendor/family diversity.
- **SIDE-tools** — side-session judge with read/execute tool access to
  the workspace (Agent-as-a-Judge shape): it can re-run the visible
  checks itself and design its own probes, rather than trusting the
  transcript's claims about what checks said (claims that can be
  stale, misread, or fabricated). It never sees the hidden oracle.
  Upper-bound arm for "verification the transcript doesn't contain";
  expensive.
- **HYBRID** — cheap screen, escalated confirm: SIDE-small decides
  "continue" alone; any "complete" verdict must be confirmed by a
  stronger arm (FORK or SIDE-tools). Composable offline from recorded
  Phase 1 verdicts at no extra run cost. Motivated by the error
  asymmetry: spend judge tokens only where the expensive error lives.

All arms produce the same output contract: `{done: yes|no, reason}`,
with "no" reasons available as continuation guidance, so arms differ
only along the axes above and not in interface.

### Cross-cutting factors (moderators)

- **Goal-directive forcefulness (pre-implementation, shared).** The
  goal condition is written before implementation starts and serves
  double duty: it is the worker's working directive *and* every
  judge's rubric (Claude Code's `/goal` makes this literal — the
  condition is both first prompt and evaluation rubric). Varying its
  force — from a plain condition statement to "really achieve this
  state: do not stop until you have produced verifiable proof of the
  goal state" — changes worker behavior (claim rate, premature-stop
  rate) and judge strictness together, so it is an upstream factor
  affecting both sides of every arm, not a judge-side tweak. Two
  levels: plain, forceful/proof-demanding.
- **Judge-turn template.** Every judge invocation inserts something:
  FORK necessarily appends a template after the fork point (there is
  no fork judge without an inserted turn), and SIDE arms wrap the
  condition plus excerpt in an instruction frame. Template
  forcefulness (neutral assessor vs adversarial refuter — "assume
  unfinished until the context contains proof") is varied in parallel
  for FORK and SIDE-same. Managed confound: a more forceful template
  may merely shift the decision threshold, trading false-complete for
  false-continue, rather than improving discrimination — both error
  rates are always reported, and a pure trade is called a threshold
  move, not a win.
- **Moderators generally.** Directive force, judge template, worker
  and judge model choices, and problem type can each change which
  architecture looks best. The design samples a small factorial grid
  rather than one configuration, and the headline conclusion states
  its region of validity — which grid cells it holds in — rather than
  claiming a global winner from one cell.

### Trigger policy: claim-gated and proof-gated judging

The every-turn Stop-hook shape pays the judge tax at every boundary.
The trigger axis explores paying it only where the expensive error can
occur:

- **Claim-gated**: the judge fires only when the worker claims
  completion. The worker's own claim is a free screen — this is
  HYBRID with zero screening cost — and the side session's cumulative
  catch-up cursor advances only at claim points, amortizing catch-up
  tokens across the whole inter-claim span.
- **Proof-gated**: under the forceful directive the worker must output
  proof of the goal state before stopping; the judge fires when a
  proof artifact appears, and judges the proof and its provenance
  rather than a bare assertion.
- **Inactivity backstop**: a worker that stops without a claim gets a
  reminder injection ("keep going until you have proof of the goal
  state") instead of a judge invocation; the judge is reserved for
  claims and proofs. True-inactivity detection reuses YA's existing
  idle/away trigger machinery.

The combination *forceful directive + SELF + inactivity reminder,
with no external judge at all* is this experiment's strongest cheap
baseline (RESEARCH.md § Build the strongest cheap baseline early). If
it closes most of the false-complete gap on its own, the external
judge's marginal value is small and the lifecycle-only Codex trade is
right — that outcome would be a finding, not a failure.

## Hypotheses

Speculative; each names its falsifier. Phase references below.

- **H1 (independence).** Fresh-context judges (SIDE-same) have a lower
  false-complete rate than FORK at equal model strength. Predicted by
  self-preference and same-session-anchoring results (Panickssery et
  al. 2024; Cross-Context Review 2026). Falsified if FORK's
  false-complete rate is statistically indistinguishable from or lower
  than SIDE-same's on Phase 1 paired decisions.
- **H2 (evidence fidelity).** FORK beats SIDE-small on overall verdict
  accuracy: full context including verbatim tool results outweighs the
  small model's independence when the goal turns on details the
  excerpt loses. Falsified if SIDE-small matches FORK's accuracy.
- **H3 (cost crossover).** Per-verdict billed cost of FORK drops below
  SIDE-small beyond a transcript-length threshold, because a
  provider-level fork replays a byte-identical prefix at the
  cache-read discount while the side session pays fresh input on the
  excerpt every time (or maintains its own growing cached prefix).
  Symbolic model in Cost section; Phase 0 measures the actual curves.
  Falsified if measured FORK cost stays above SIDE-small at realistic
  transcript lengths, or if provider fork calls do not actually hit
  the prefix cache (YA telemetry distinguishes hit from miss).
- **H4 (self-grading base rate).** SELF has a materially higher
  false-complete rate than every external arm. The false-success
  literature reports large self-assessed success inflation in agent
  trajectories; this arm calibrates how much an external judge buys at
  all. Falsified if SELF's false-complete rate is within noise of the
  external arms — in which case the whole judge apparatus is insurance
  priced above its actuarial value and the Codex trade is right.
- **H5 (Pareto winner is hybrid).** No single arm dominates; HYBRID
  sits on the quality-cost Pareto frontier ahead of its components.
  Falsified if a single arm dominates the frontier.
- **H6 (vendor diversity, exploratory).** SIDE-xvendor differs from
  SIDE-same mainly on correlated-blind-spot cases (both worker and
  same-vendor judge miss the same defect class). No strong prior;
  treated as exploratory rather than confirmatory.
- **H7 (instructions substitute for architecture).** Forceful
  pre-implementation directives and forceful judge templates shrink
  the between-architecture gaps — much of what judge independence
  buys can be bought upstream with instruction force. Falsified if
  arm rankings and gap sizes are stable across the instruction grid.
- **H8 (gated triggering).** Claim- or proof-gated triggering retains
  most of every-turn judging's false-complete protection at a small
  fraction of the judge cost, because boundaries without a completion
  claim are overwhelmingly easy "continue" agreements. Falsified if
  every-turn judging catches materially more false-completes (wrong
  states the worker never claims), or if gating's savings are eaten
  by longer trajectories.

## Experimental design

### Testbeds

Both testbeds need a machine-checkable oracle that is hidden from the
worker and every judge, so verdicts can be scored against ground truth.

- **Math arm (cheap pilot).** Competition-style problems with exact
  final answers (recent, post-cutoff-selected to reduce memorization).
  Goal condition: "the final answer is written to `answer.txt` and is
  correct." Oracle: exact-match checker run server-side. Cheap turns,
  frequent boundaries, high natural false-complete pressure (models
  assert wrong answers confidently). Used to debug the harness and get
  first-pass effect sizes before spending on the coding arm.
- **Coding arm (headline).** Repository tasks with a visible test
  suite that is a deliberately *incomplete proxy* and a hidden
  acceptance suite as oracle — hand-authored tasks in disposable
  repos, or a recent SWE-bench-Verified-style subset only after
  per-task audit (contamination note, plus a check that the hidden
  tests accept reasonable alternative solutions — SWE-bench-family
  hidden suites are known to falsely fail valid patches that differ
  from the gold one). Goal condition
  text describes required behavior, may include clauses no single
  visible command checks (no regressions elsewhere, docs updated,
  edge-case semantics), and never names the hidden suite. This
  mirrors the real loop-until-done use case and the documented
  "stops at first passing test" failure mode.

The two arms deliberately sit at opposite ends of the
verifier-visibility spectrum: the math arm has *no* visible verifier
(pure judgment), the coding arm has *partial* visible verifiers
(judgment about whether proxies suffice).

### Task selection: the comparison needs legitimate false-done states

Two curation rules keep the comparison from degenerating:

- **No sufficient visible verifier.** If the worker can run a complete
  checker whose pass/fail settles the goal, the judging problem
  collapses to reading that result off the transcript — FORK (which
  sees the verbatim tool output) wins near-automatically, SIDE-tools
  wins by re-running it, and nothing about judgment is measured. Tasks
  where a trivial 100% verifier exists belong to the product's
  programmatic-check path, not this experiment. Visible checks must be
  incomplete proxies, so "done" is a genuine inference from partial
  evidence.
- **Difficulty band with pilot screening.** Tasks must be hard enough
  that the worker reaches *legitimate believed-done-but-wrong states*
  at a useful base rate — a judge is only exercised where the worker's
  own belief is wrong — yet completable within budget, or
  false-continue is unmeasurable. Screen candidates with cheap pilot
  trajectories: keep tasks where SELF declares done prematurely at
  least once across pilot seeds and where at least some pilot
  trajectories truly complete. Report the screening yield, and state
  the resulting conditioning plainly: all conclusions are about the
  judge-relevant task population (where worker belief and truth can
  diverge), which is exactly the population a loop-until product
  feature exists for.

Oracle discipline: the hidden checker runs out-of-band at every turn
boundary and its result never enters any provider context (worker or
judge). Ground truth is evaluated per-boundary, not assumed monotone —
an agent that reached the goal can regress below it in later turns,
and verdicts are scored against the truth at their own boundary.

### Phase 0 — plumbing and cost calibration

Wire the arms through YA (see Implementation), verify fork
prefix-cache behavior with the existing `fork-prefix-cache-hit`/`miss`
telemetry on both providers, record current provider price sheets and
cache-read ratios, and run the result-sanity preview (one aligned
example per arm: boundary context in, verdict out, oracle label) on a
handful of math tasks. No conclusions from Phase 0.

### Phase 1 — paired counterfactual verdicts (judgment quality)

Run worker trajectories under a **fixed driving policy** that ignores
all judge arms: continue to a fixed turn budget T with a neutral
continuation prompt ("continue working toward the goal; verify before
concluding"), regardless of any completion claims. Trajectories are
run under both goal-directive strengths (plain, forceful) since the
directive changes the state distribution — the only factor that
multiplies trajectory count. At every turn boundary, query **all
arms in parallel** on identical inputs (same condition text, same
boundary; SIDE arms share one excerpt builder so excerpt policy never
confounds model identity) and record every verdict, reason, token
bill, and wall time, plus the oracle label. Judge-template variants
are additional paired queries at the same boundaries, and trigger
policies (claim-gated, proof-gated) are scored offline from the
recorded verdicts plus claim/proof markers — neither multiplies
trajectories.

Pairing every arm on every boundary of the same trajectory removes
between-trajectory variance and makes the per-decision comparison a
McNemar-style paired test rather than a between-groups one; it also
prices HYBRID for free by composition. The known cost: the fixed
driving policy, not the judges, chooses which states get sampled, so
Phase 1 measures verdict quality on a shared state distribution, not
closed-loop outcomes — that bias is deliberate and Phase 2's job.

Per-decision scoring: false-complete (judge says done, oracle says
not), false-continue (judge says continue, oracle says done). Report
per-arm rates with bootstrap CIs over decisions and over tasks
(clustered — decisions within a trajectory are not independent).
Report each metric twice: over all boundaries, and over the
**believed-done subset** (boundaries where SELF claims completion) —
the discriminating subset, since boundaries where the worker itself
knows it is unfinished are easy agreements that dilute the comparison.

### Phase 2 — closed loop (does the better judge steer better?)

Take the 2–3 Pareto-best arms from Phase 1 plus SELF as baseline; each
drives the loop for real on a fresh task split: the arm's verdict ends
or continues the run, and its "no" reasons are injected as guidance
(the `/goal` contract). Measure end-to-end: oracle-checked task
success at a fixed token/wall budget, total cost including judge
overhead, turns to true completion, overshoot (turns worked past
first true completion), and rejection-induced regressions (oracle
flips done → not-done in the turns following a false "not accepted"
verdict — a wrong rejection is not just wasted compute, its guidance
can push the worker to break a correct state). This also measures
guidance quality in the positive direction — a judge whose "no"
reasons steer the worker converges in fewer turns — an effect Phase 1
cannot see.

Raw success rate is explicitly not the decision metric. A judge that
falsely rejects often enough will eventually harvest more finished
successes while burning arbitrary compute; unbounded, that degenerate
strategy dominates a success-only leaderboard. Phase 2 arms are
therefore compared only jointly — success at fixed budget, and
position on the success × total-cost Pareto frontier — with
false-continue waste (overshoot plus regression repair) reported as
its own column so a paranoia-bought win is visible as such.

### Metrics and statistics

Following the house rules (RESEARCH.md): every table row carries split
and N; wall time on all run comparisons; one typed column per
quantity; bootstrap significance (10k iterations, two-tailed) with
minimum N=200 decisions (Phase 1) / N≥50 tasks per arm (Phase 2,
paired across arms by task) for any conclusion; smoke-scale runs carry
no conclusions. Headline quality metric: false-complete rate, with
false-continue and total cost as the other axes. Since this compares
3+ systems on quality vs cost, the final writeup includes the mandated
Pareto scatter (`topics/pareto-figures.md`).

Alongside the frontier, arms are scored by a parametric economic
objective that makes the asymmetry explicit instead of implicit. Each
task run under a max-cost budget ends in one of three outcomes, and
an arm's score sums over tasks:

    J(arm) = Σ cost(true successes)
           + X · #(failures to implement: budget exhausted, never done)
           + Y · #(judged successes that fail objective truth)

X prices an honest, visible failure (the user knows the task didn't
finish); Y prices a false-complete shipped as success (the user
doesn't know) — plausibly Y > X, but neither is fixed: sweep the
(X, Y) plane and report each arm's **win region**. A paranoid
high-false-continue loop wins only where Y (and budget headroom)
dwarf compute cost; a credulous cheap judge wins only where Y is
implausibly small; the practically interesting result is which arm —
likely a gated or hybrid one — wins across the middle band.
Fixed-budget success rate is the special case this generalizes.

A companion view of the same data: **tasks completed at fixed budget
Z**, reported as a completion-vs-budget curve per arm rather than one
Z. Because every trace records per-boundary cumulative cost and
oracle state, any Z is replayable offline — truncate each trace at
spend Z, count true completions — so the curve costs nothing beyond
the runs already made, and (X, Y) win regions and the completion
curve are two projections of one recorded dataset.

### Cost model (symbolic; Phase 0 fills the numbers)

Let L = worker context tokens at the boundary, E = excerpt tokens, r =
provider cache-read price ratio (cached-read / fresh-input, order 0.1
on current Anthropic pricing — verify at run time), c_main and c_small
= per-token input prices of the worker and small models, and o = judge
output tokens (small).

- FORK per verdict ≈ r·c_main·L + c_main·(instruction) + c_main·o —
  *if* the fork hits the prefix cache (H3's load-bearing assumption;
  telemetry decides).
- SIDE-small per verdict ≈ c_small·E fresh, or ≈ r·c_small·L with its
  own maintained growing prefix (the side session's cumulative
  catch-up cursor makes its prefix cacheable too — a real optimization
  both for the experiment and the product).
- SELF ≈ 0 marginal.
- SIDE-tools ≈ SIDE-same plus tool-call turns; expected dominant cost.
- Gated triggering divides any arm's judge cost by the claim
  frequency (claims per boundary, typically ≪ 1), and lets the side
  session amortize one catch-up per inter-claim span instead of per
  turn.

Gateway-routed sessions (e.g. Copilot-metered) change the unit of cost
from tokens to requests; the experiment records both so the conclusion
can be restated under either billing model.

## Result scaffolds

Phase 1 — verdict quality per arm (TBD; split/N/model ids recorded at
run time):

| Arm | False-complete % | False-continue % | Cost/verdict (tok) | Cost/verdict (USD) | Wall s/verdict |
|---|---|---|---|---|---|
| SELF | TBD | TBD | TBD | TBD | TBD |
| FORK | TBD | TBD | TBD | TBD | TBD |
| SIDE-small | TBD | TBD | TBD | TBD | TBD |
| SIDE-same | TBD | TBD | TBD | TBD | TBD |
| SIDE-xvendor | TBD | TBD | TBD | TBD | TBD |
| SIDE-tools | TBD | TBD | TBD | TBD | TBD |
| HYBRID | TBD | TBD | TBD | TBD | TBD |

Phase 2 — closed-loop (TBD): task success % at fixed budget, total
cost, turns to true completion, overshoot turns, per arm; paired by
task; both worker harnesses (Claude, Codex) as separate table blocks.

## YA implementation plan

YA already ships, across both harnesses, the abstractions each arm
needs; the experiment is mostly orchestration plus an oracle runner:

- **FORK**: `AgentProvider.forkSession`
  (`packages/server/src/sdk/providers/types.ts`) — Claude forks by
  jsonl copy with remapped UUIDs (`claude.ts`), Codex by app-server
  thread fork (`codex.ts`), pi via `sessions/pi-fork.ts`. The judge
  turn reuses the `generateSummary` `strategy: "fork"` shape already
  used by retitle and fork-after-summary: temporary archived-hidden
  generator fork, one helper turn, emit only the result
  (`topics/recaps.md`, `topics/fork-from-turn.md`). Lineage via
  `forkedFromSessionId`; helper forks stay hidden per
  `topics/session-list-hidden-duplicates.md`.
- **SIDE-***: the shared helper side session with cumulative catch-up
  cursor (`topics/side-session-config.md`), which is exactly the
  growing-cacheable-prefix judge; the `Cheapest` helper-model token
  gives SIDE-small, `Same as main session` gives SIDE-same, and the
  helper-target registry (OpenAI-compatible endpoints, currently
  dormant) is the natural SIDE-xvendor route.
- **Cost measurement**: existing prefix-cache telemetry —
  `expectedCacheSource: "fork" | "warm-session"`, `prefixBasis:
  "provider-fork-byte-identical"`, `fork-prefix-cache-hit`/`miss`
  events (`packages/shared/src/types.ts`) — plus provider usage
  fields per call.
- **Loop driver + oracle**: new, experiment-scoped: a server-side
  turn-boundary hook that (a) runs the hidden checker out-of-band
  (result is YA-side state, never provider context — same separation
  discipline as recap viewer-state), and (b) queries the configured
  judge arms. Codex-native `/goal` covers SELF on that harness.

Controlling both harnesses from one orchestrator is the point of doing
this in YA: neither CLI lets you ablate judge identity and placement
(Claude Code fixes transcript-only-small; Codex fixes self-declared),
and YA's provider layer makes cross-vendor and fork arms configuration
rather than CLI surgery.

## Product payoff

If an external judge earns its cost (H4) and one placement wins, YA
ships a loop-until mechanism (`/wish` per
`topics/emulated-slash-commands.md`, aliasing native `/goal` where the
provider has one) with judge placement set by these measurements —
e.g. HYBRID with a cheap screening judge and fork-confirmed
completion. Per `topics/vanilla-defaults.md` it ships configurable and
default-off. If SELF holds up (H4 falsified), the payoff is the
opposite and equally useful: YA adopts the Codex-style
lifecycle-only design everywhere and skips the judge tax.

Independent of which judge wins, the experiment's budget protocol is
itself a product candidate: a **hard-capped agent** that is literally
blocked from spending past a user-set cost estimate (ending in an
honest wrap-up/failure at the cap — stricter than Codex's soft
budget-limit steer). Predictable worst-case spend has value to some
users even at some cost in success rate; the economic scoring's
X-penalty outcome is exactly this mode's failure case, so the
experiment prices it rather than assuming it.

## Related work and the gap

Verified system prior art: Claude Code `/goal`
([docs](https://code.claude.com/docs/en/goal)); Codex CLI 0.128.0
goals ([Willison 2026-04-30](https://simonwillison.net/2026/Apr/30/codex-goals/),
[implementation notes](https://gist.github.com/patleeman/b1b5768393f9bf2f60865b1defeeb819)).

Research prior art (post-2025 items read at search/abstract level in
this pass — full extraction into a `related-work/` artifact folder with
a `papers.bib`-style manifest is queued in the companion topic before
any claim in this section is load-bearing):

- Panickssery et al., *LLM Evaluators Recognize and Favor Their Own
  Generations*, NeurIPS 2024 (arXiv:2404.13076) — self-recognition
  correlates with self-preference; motivates H1/H6.
- *Quantifying and Mitigating Self-Preference Bias of LLM Judges*
  (arXiv:2604.22891) and *Play Favorites: A Statistical Method to
  Measure Self-Bias in LLM-as-a-Judge* (arXiv:2508.06709) —
  measurement methodology for separating bias from genuine quality.
- *Cross-Context Review: Improving LLM Output Quality by Separating
  Production and Review Sessions* (arXiv:2603.12123) — nearest found
  prior: separate-session review beats same-session self-review.
  Differs from this proposal on an abstract-level read by targeting
  output-quality review rather than goal-stop decisions in agent
  loops, and by not treating prompt-cache economics as the cost axis
  or testing the fork (full-context, clean-frame) middle point.
- Zhuge et al., *Agent-as-a-Judge: Evaluate Agents with Agents*
  (arXiv:2410.10934, ICML 2025) — tool-using judges outperform
  transcript-only LLM judges on agentic tasks; motivates SIDE-tools.
- *From Confident Closing to Silent Failure: Characterizing False
  Success in LLM Agents* (arXiv:2606.09863) — false-success base
  rates in self-assessing agent trajectories; motivates H4 and the
  error-asymmetry framing.
- Huang et al., *Large Language Models Cannot Self-Correct Reasoning
  Yet*, ICLR 2024 (arXiv:2310.01798) — weak intrinsic
  self-verification; background for SELF.
- Datacurve, *DeepSWE: Measuring Frontier Coding Agents on Original,
  Long-Horizon Engineering Tasks* (arXiv:2607.07946) — original tasks
  on 91 OSS repos, never merged upstream; releases the benchmark,
  verifiers, full evaluation trajectories, and the complete judge
  audit (per-rollout trajectory, patch, verifier output, verdict);
  the exact judge prompt is withheld as an internal instrument. Its
  tool-era relevance here: an independent frontier judge disagreed
  with SWE-Bench Pro's verifier on 32.4% of rollouts vs 1.4% for
  DeepSWE's own verifiers — direct evidence that benchmark oracle
  noise is large (supporting this proposal's oracle-noise threat and
  audit mitigation), and that an independent judge's disagreements
  mostly surface verifier weakness rather than worker self-deception.
  No judge-identity or judge-placement ablation arms, so the gap
  below stands; its released rollouts are candidate audit material
  for our coding arm.

**The gap**: none of the found work ablates goal-loop stop-judge
*architecture* — context placement (fork vs fresh vs in-context) ×
judge identity × evidence access — holding worker, task, and stop
boundaries fixed, with cost measured under real prompt-cache
economics. The DeepSWE judge-audit figure from an earlier informal
discussion of this topic has since been verified against
arXiv:2607.07946 and is cited above; the other systems named in that
discussion remain unverified and are deliberately not relied on here.

## Threats to validity

- **Driving-policy sampling bias (Phase 1).** The fixed policy chooses
  which states judges see; a judge that would have steered into
  different states is only assessed closed-loop (Phase 2).
- **Excerpt-policy confound.** SIDE arms share one excerpt builder;
  otherwise excerpt quality masquerades as model quality. FORK vs
  SIDE-same then cleanly isolates context placement.
- **Oracle leakage.** Hidden checks must never enter any provider
  context; goal-condition text must not name them.
- **Oracle noise.** The oracle defines verdict ground truth, so an
  oracle that falsely fails valid solutions (documented in the
  SWE-bench family: hidden tests overfit to the reference patch)
  systematically converts accurate "done" verdicts into recorded
  false-completes — biasing the comparison toward paranoid arms.
  Mitigations: prefer hand-authored oracles; audit any benchmark-
  derived task before inclusion; and treat strong-disagreement
  boundaries (worker and several judges say done, oracle says not)
  as human-audit triggers rather than auto-scored losses, reporting
  the audit yield.
- **Benchmark contamination.** Prefer post-cutoff or hand-authored
  tasks; record per-task provenance.
- **Cache opacity.** H3 assumes fork prefix-cache hits; gateways may
  not preserve caching semantics. Telemetry gates the claim, and
  request-metered billing is reported separately.
- **Judge-prompt sensitivity.** One shared judge instruction across
  arms, frozen before Phase 1; prompt variants are future work, not
  mid-experiment tuning.
- **Truth flapping.** Per-boundary oracle evaluation handles
  regressions past first completion; overshoot is measured, not
  assumed away.

## Future work

- Judge ensembles and adversarial verify (N refuters) beyond HYBRID.
- Check-schema goal conditions: does requiring the condition to name
  executable checks shrink the external-judge advantage to zero?
- Cross-harness generalization: OpenCode/Gemini providers via the same
  YA abstractions.
- Guidance-quality attribution: which judge writes the "no" reasons
  that most accelerate convergence (Phase 2 secondary analysis made
  primary).
