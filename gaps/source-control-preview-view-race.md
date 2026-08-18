# Source Control preview selection can lose to a later diff reset

`packages/client/e2e/source-control-markdown-preview.spec.ts:30` selects a changed
Quarto file and immediately chooses **Preview**. In two consecutive isolated
runs, the final page had **Diff** active and rendered diff-line text inside the
Markdown preview region instead of the expected `Updated Quarto report`
heading. The other 110 end-to-end tests passed in the full run.

This is outside the archive/title command change. Investigate which delayed
file-detail update resets the user-selected view mode after the Preview click;
the fix should make the user's later choice win rather than add a test-only
retry.

Found 2026-08-18 while verifying local `/archive` and `/title` composer commands.
