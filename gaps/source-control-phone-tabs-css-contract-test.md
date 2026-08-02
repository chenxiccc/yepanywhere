# Pre-existing failing test: phone-width Changes tab grid contract

`packages/client/src/styles/__tests__/sourceControlLayout.test.ts` ("keeps
the unified Changes revision control usable at phone width") asserts the
mobile tab row declares
`grid-template-columns: repeat(3, minmax(0, 1fr));`. The rule it reads now
declares `grid-auto-columns: minmax(0, 1fr)` with `grid-auto-flow: column`
instead, so the regex never matches.

Pre-existing: reproduced at `6b3b7aad` with no CSS and no test-file
changes in the worktree (checked 2026-08-02 during the Source Control diff
latency work, which touched no styles).

Both forms give equal-width columns, but they differ in what happens as the
mode count changes: the fixed `repeat(3, …)` encodes three modes, while
`grid-auto-flow: column` adapts. `topics/source-control.md` § *Product
boundary* now lists four modes (Changes, Files, Pending Comments, Reviews),
so the test's `3` looks like the stale side. Confirm the intended contract
before choosing a fix site — either the CSS regressed away from a
deliberate three-column rule, or the test was never updated when the
fourth mode landed.

Out of scope for the diff-latency work that surfaced it.
