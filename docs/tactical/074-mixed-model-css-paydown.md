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
- First worker launch: pending
- Wall-clock deadline: pending first launch
- Workers launched: 0 / 50
- Accepted slices: 0
- Stopped slices: 0
- Current interval: 0 / 5 accepted
- Current worker: none
- Current clean base: protocol commit pending

## Completed slices

| Run | Surface | Route | Result | Commit | Ratchet | Supervision evidence |
|---:|---|---|---|---|---|---|
| — | No campaign slice launched yet | — | — | — | — | — |

## Audit interval notes

No interval has completed yet. At each five-slice checkpoint, replace this note
or append a dated section with aggregate inventory movement, model outcomes,
fixture/check evidence, steering events, routing changes, and the pushed base.
