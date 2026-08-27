# Source projection upgrade notice misclassifies request failures

Source Control says to update or restart the server whenever
`GitStatusPage.tsx`'s `handleProjectionUnavailable` runs. That callback covers
both genuinely absent capabilities and ordinary request failures routed through
`useCommitBrowserModel.ts`'s `handleProjectionRequestFailure`.

The running server advertised both `git-source-review-projections` and
`git-inclusive-to-head`, yet the upgrade notice still appeared. A failed
projection request can therefore be misreported as an outdated server and hide
the actionable failure cause.

This was not fixed inside the keyboard-navigation and splitter work because it
requires a separate error-classification and copy contract. Keep the upgrade
notice only for an absent capability; a failed capable request should retain
ordinary Source Control and report a retryable request error.

Found 2026-08-27 while verifying Source Control commit-review navigation.
