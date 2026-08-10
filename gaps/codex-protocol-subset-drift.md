# Checked-in Codex protocol subset has drifted from the pinned source

`pnpm codex:protocol:check` against the aligned `rust-v0.146.0` reference exits
nonzero. It reports a new `v2/ThreadSection.ts` plus changes to
`ImageGenerationItem.ts`, `ResponseItem.ts`, `v2/CommandAction.ts`,
`v2/Thread.ts`, `v2/ThreadItem.ts`, and `v2/ToolRequestUserInputParams.ts`.
The generator also warns that one stale `arg0` temporary directory could not be
removed.

This was not regenerated during the Codex sticky-effort repair because the
declared target version did not change and accepting generated protocol drift
requires its own compatibility audit. Re-run the pinned source comparison,
inspect whether the unexpected shapes are additive, then use
`pnpm codex:protocol:update` and update `topics/provider-refresh.md` with the
audit result.

Found 2026-08-10 while checking the Codex effort-selection fix.
