# Codex effort/model changes still wait for a turn boundary

Codex 0.151 added an experimental `turn/settings/update` request that publishes
`model`, `effort`, `summary`, and `serviceTier` into an *already running* turn,
answering `applied` or `targetUnavailable`. It is gated behind the experimental
capability YA already negotiates (`#[experimental("turn/settings/update")]`
upstream), so no new capability handshake is needed.

YA does not use it. `setEffort` only records the selection for the next turn
(`packages/server/src/sdk/providers/codex.ts:1736` writes
`runtimeState.turnEffortOverride`, consumed at `:2717` and `:2796` when the next
`turn/start` is built). That matches the contract written for the providers YA
had at the time — "changing effort during an ordinary active turn is a next-turn
setting … never interrupts the current turn"
(`topics/provider-runtime-status.md:52`), whose stated reason is that treating a
configuration change as a stop can discard nearly complete, already-paid-for
reasoning.

Codex now offers a third option that contract did not anticipate: apply the new
setting to the live turn without interrupting it. Adopting it is a deliberate
product change, not a compatibility fix — it would make Codex behave unlike the
other providers unless the contract is restated per provider, and upstream is
explicit that already-captured steps keep their old settings, so "applied" does
not mean the whole remaining turn honors the change. Whoever picks this up
should decide the cross-provider story and update
`topics/provider-runtime-status.md` before wiring the request; the types are not
in YA's checked-in protocol subset yet
(`scripts/update-codex-protocol.mjs` `SUBSET_EXPORTS`).

Found 2026-08-29 while refreshing Codex compatibility to 0.151.0
(`topics/provider-refresh.md`).
