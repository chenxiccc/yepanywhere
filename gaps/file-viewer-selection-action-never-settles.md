# File-viewer selection action never settles

The forward highlighted-file scenario in
`packages/client/e2e/source-selection.spec.ts` reaches a visible **Quote reply**
button, but Playwright cannot click it because the button remains unstable and
is repeatedly detached from the DOM. The cold isolated scenario reproduced
twice on 2026-08-29; the complete source-selection file otherwise passed five
of six scenarios, including the activity-detail placement and backward-drag
cases.

The action presentation or its placement updates appear to keep publishing an
equivalent state after a programmatic file-viewer selection. Trace the
selection-action timer/viewport inputs and preserve the action cluster's DOM
identity when its range and placement have not changed.

This was not fixed with the activity-detail repair because it belongs to the
file viewer's post-selection action presentation, not selection anchoring
inside a managed activity panel.

Found 2026-08-29 while verifying expanded activity-detail selection stability.
