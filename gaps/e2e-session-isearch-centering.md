# Session reverse-search E2E misses its centering threshold

`packages/client/e2e/session-isearch-pointer.spec.ts` consistently leaves the
selected result center about 39 px from the transcript viewport center, beyond
the test's 12 px tolerance. The failure reproduces alone with one Playwright
worker and in the full suite; activation and focus proceed far enough to reach
the geometric assertion.

This is outside the filesystem-delivery change being verified. Reconcile the
scroll target with the current conversation-height and viewport geometry, then
keep a tolerance that distinguishes a wrong target from unavoidable end-of-list
clamping.

Found 2026-08-20 while verifying complete filesystem worktree delivery.
