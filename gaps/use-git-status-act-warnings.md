# Git-status attention tests emit React act warnings

The aggregate client suite emits repeated React `act(...)` warnings from
`packages/client/src/hooks/__tests__/useGitStatus.test.tsx` in
`defers missing-payload recovery until attention returns` and
`recovers a hidden eviction on attention return without polling`.

The attention-return event triggers asynchronous hook state updates after the
test's current act boundary. Reproduce the two tests in isolation, then wrap or
await the complete recovery update rather than suppressing the diagnostic. The
git-status hook is unrelated to session termination, so the cleanup was not
folded into that behavior change.

Found 2026-08-22 while verifying session-boundary termination with the
aggregate client suite.
