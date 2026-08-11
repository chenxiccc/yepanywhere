# Oversized hub modules keep absorbing features without a split

Four client/server hubs keep growing because nearby features continue to land
inside them: `Process.ts` (4,650+ lines), `MessageInput.tsx` (3,000+),
`clientSummaryState.ts` (2,000+), and `SessionPage.tsx` (sizes observed
2026-07-25). The issue is mixed ownership, not a line-count threshold.

Each new feature pass (harsh-review 1c157030..4ae53adf and its fix pass)
added to all four without attempting a split; none of those diffs opened a
seam wide enough to force it, so this records the debt instead.

The seam choices, tripwires, and disposition rule are maintained under
[`docs/tactical/058-typescript-module-boundary-refactor.md` § Open seam inventory](../docs/tactical/058-typescript-module-boundary-refactor.md#open-seam-inventory-later-hub-growth).
This gap remains the concise defect ledger; suggested module movement belongs
in that tactical plan.

Remove this file in the commit(s) that perform the split(s).
