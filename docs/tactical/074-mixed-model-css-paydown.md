# Mixed-Model CSS Module Paydown

Topic: css-architecture

Status: active 2026-08-01.

This is the durable recovery ledger for the explicitly authorized mixed-model
CSS paydown campaign. Candidate selection remains data-driven; this file must
not accumulate a speculative priority queue.

The binding CSS rules are in
[`topics/css-architecture.md`](../../topics/css-architecture.md). Worker routing,
supervision, audit, and stop rules are in the
[`bounded agent process runbook`](../testing/claude-agent-process-runbook.md).

## Authorized bounds

- Start only after the routing protocol update is committed and pushed.
- Launch at most 50 fresh workers; stopped workers count.
- Stop four hours after the first worker launch.
- Stop earlier on provider credit exhaustion or any runbook safety condition.
- Use one worker at a time in the shared checkout.
- Treat five accepted slices as an audit, ledger-update, and push interval.
- Use one-minute authoritative status checks. Apply the additional bounded Luna
  calibration sample described by the runbook until Luna earns alert-only
  supervision.

## Recovery procedure

After compaction or controller restart:

1. Re-read this ledger, the process runbook, and the CSS architecture topic.
2. Check the active goal and reconcile its run/time counters with this ledger.
3. Verify the working tree, `HEAD`, `origin/main`, and any live YA worker before
   launching anything.
4. If a worker is live, resume monitoring its YA session id; never duplicate
   its prompt.
5. If no worker is live, audit any unrecorded commit, regenerate inventory, and
   select one fresh candidate from current data.

## Campaign checkpoint

- Protocol base: `ef2c98ae9b1882d47fc931971881b2f90fba7f08`
- First worker launch: `2026-08-01T07:46:39+02:00`
- Wall-clock deadline: `2026-08-01T11:46:39+02:00`
- Workers launched: 2 / 50
- Accepted slices: 1
- Stopped slices: 1
- Current interval: 1 / 5 accepted
- Current worker: none
- Current clean base: this component-fixture ledger checkpoint (`HEAD`)

## Completed slices

| Run | Surface | Route | Result | Commit | Ratchet | Supervision evidence |
|---:|---|---|---|---|---|---|
| 1 | Thinking indicator | Luna xhigh: shared keyframe boundary | Stopped before edits: phone fixture absent | — | 0 | Main-browser steer; desktop baseline passed; phone failed one retry |
| 2 | Global tooltip portal | Opus high: local literal move | Accepted | `e5fb8e5b` | 33 legacy lines, 2 owned rules | Alert-only monitoring; controller-proven fixture; no steer |

## Audit interval notes

No interval has completed yet. Run 1 validated the stop path but exposed a
harness-routing error: the worker initially opened the maintainer's main browser
and encountered its localhost certificate warning. The runbook now directs
local campaign fixtures straight to repository headless Playwright. The supplied
Agents-page fixture was present at desktop width but absent at phone width, so
the candidate remains unmigrated and is not reserved as the next slice.

Run 2 completed without attention or scope events. Opus preserved the portal
and stacking contracts, passed the full check matrix, and produced a
byte-identical phone target. A one-row desktop element-crop difference was
localized to fractional screenshot rounding; computed layout and the rendered
surface were unchanged.

The next tooling checkpoint added
`packages/client/e2e/css-component-fixture.html`, a test-only Vite page that can
render deterministic component exports from JSON props at real browser widths.
This avoids spending provider sessions manufacturing rare application state.
It remains unsuitable for caller-layout, portal, generated-markup, or other
integration boundaries.

At each five-slice checkpoint, append aggregate inventory movement, model
outcomes, fixture/check evidence, steering events, routing changes, and the
pushed base.
