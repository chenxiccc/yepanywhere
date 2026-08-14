# The copied diagnostic CLI preflight accepts an older CLI as current

The copied instruction says to run `yepanywhere browser-debug --help` and use
the source-checkout CLI only when that reports an unknown command
(`packages/client/src/lib/browserDebugLease.ts:277-281`). On the older installed
CLI used during the first real grant, that invocation silently printed the
top-level help and exited successfully. It neither proved that `browser-debug`
existed nor matched the instruction's stated fallback condition.

Make the probe verify browser-debug-specific output or add a machine-readable
command/version check. The copied prompt should direct the source-checkout
fallback whenever that positive check fails, while still distinguishing a CLI
generation mismatch from rejection of the tab grant.

This was not fixed in place because it was discovered only after the published
diagnostic slice had been exercised by an older YA-launched session.

Found 2026-08-14 while following the first copied per-tab diagnostic instruction.
