# Oversized hub modules keep absorbing features without a split

Four client/server hubs keep growing because every nearby feature lands
inside them rather than beside them (sizes at 2026-07-25):

- `packages/server/src/supervisor/Process.ts` — 4,650+ lines. Seam
  candidates: effort-control serialization (pendingEffortUpdate /
  effortApplyTail / boundary-blocked transition), deferred-queue
  persistence, and the Codex terminal-status builders are each coherent
  units with narrow surfaces into the rest of the class.
- `packages/client/src/components/MessageInput.tsx` — 3,000+ lines. Seam
  candidates: the bang completion/menu machinery and the recall drawer
  (state + keyboard handler + menu markup) both talk to the composer only
  through text/setText/refs.
- `packages/client/src/lib/clientSummaryState.ts` — 2,000+ lines. Seam
  candidate: the session-id remap machinery (aliases, record merge,
  projection rewrites) around `mergeRemappedSessionRecords`.
- `packages/client/src/pages/SessionPage.tsx` — grew again this range
  (recall wiring, navigation-state consumption).

Each new feature pass (harsh-review 1c157030..4ae53adf and its fix pass)
added to all four without attempting a split; none of those diffs opened a
seam wide enough to force it, so this records the debt instead. Fixing one
file at its named seam is a self-contained commit.

Remove this file in the commit(s) that perform the split(s).
