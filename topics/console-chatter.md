# Console Chatter Budget

> The client should be quiet on production consoles: warn/error are
> reserved for actionable conditions, chatty levels are dev-gated or
> removed at the source, and `pnpm console:scan` / `pnpm console:volume`
> measure the budget with a ratcheting baseline.

Topic: console-chatter

## Policy

`console.warn` / `console.error` are reserved for actionable conditions.
`console.log` / `info` / `debug` on production paths belong behind
`import.meta.env.DEV` or a developer-mode/debug flag, or routed through
`lib/diagnostics`.

Remediation preference, in order:

1. Do not emit — delete the log or fix the condition it reports.
2. Use the emitting library's own options (verbosity/log-level
   arguments, logger callbacks) so the message is never produced.
3. Gate our own emit behind dev mode.

Intercepting or monkey-patching `console` to silence output is allowed
but dispreferred; interception is for measurement infrastructure
(ClientLogCollector), not suppression.

ClientLogCollector must not amplify the failure it is observing. Its IndexedDB
schema upgrade repairs a missing `entries` store, and a current-version database
that is still malformed falls back to the existing bounded in-memory buffer.
Every asynchronous write and flush handles storage rejection internally; an
unhandled-rejection listener never reports its own failed persistence as a new
unhandled rejection.

## Measurement and ratchet

- `pnpm console:scan` (`scripts/find-console-chatter.mjs`): advisory
  AST scan of `packages/client/src`, same contract as `pnpm i18n:scan`.
  Ungated chatty call sites are warnings; `--max-warnings <n>` is the
  ratchet toward a CI gate. Gate detection is textual and deliberately
  approximate.
- `pnpm console:volume` (`scripts/report-client-log-volume.mjs`):
  per-device runtime volume from ClientLogCollector jsonl (Developer
  Mode -> Remote Log Collection): lines by level, top prefixes, average
  and peak lines/minute. Use it to judge actual chattiness outside dev
  mode before and after gating a hot path.

Both tools always print the current numbers, never a bare pass/fail:
run `pnpm console:scan` with the pre-commit checks when a change
touches `packages/client`, notice the delta your own change caused
against the baseline below, and state it in the summary or commit when
it moved in either direction.

## Baseline

The enforced bounds live in the `limits` map of
`scripts/console-chatter-baseline.json`: each key names a scan metric
(`warnings`, `info`, `total`, `method.log`, `method.warn`, ...) with
its own maximum, so a failure names exactly which kind regressed.
`pnpm console:scan` reads it, prints each bounded metric as
`value/limit (delta)`, and exits 1 when any metric exceeds its limit —
locally and in the CI lint job. `--limit <metric>=<n>` overrides one
limit for experimentation.

Seeded limits bound `warnings` (ungated chatty sites) and
`method.warn`/`method.error` (total warn/error sites — reserved for
actionable conditions, so their growth is also ratcheted). `info` and
`total` stay unbounded on purpose: dev-gating a site — the preferred
remediation — moves it from warnings into info and must never fail the
check. When a batch is gated or removed, lower the affected limits in
the same change (the scan prints the ratchet reminder when a metric
drops below its limit); raise one only with justification in the
commit that does so.

The baseline also records `observed`, the full metric numbers from the
last recorded run. Limits are ceilings and need not equal current
reality; `observed` is what the scan diffs against to say exactly what
grew or shrank ("Drift since last recording: ..."). When your change
moves the numbers, run `pnpm console:scan --record` and commit the
baseline update with the change; a change with no suspected console
impact need not re-record.

Initial baseline 2026-07-03: warnings 117 (dominated by connection
lifecycle logs: `lib/connection/`, `useEmulatorStream`, `activityBus`),
method.warn 63, method.error 93.

## When a limit trips

To find the offending call sites: the scan's default output lists
every warning as `file:line` — start with files your change touched.
For the exact regression set, diff `pnpm console:scan --json` output
between your branch and `main` (`--include-info` adds warn/error and
gated sites when a `method.*` limit is the one that tripped).

To see the actual console output at runtime:

- Local dev: the browser DevTools console on the Vite/dev URL; app
  logs are prefixed (`[SecureConnection]`, `[SessionDetailStore]`, ...)
  so the scan's file list greps back to prefixes.
- Real devices (the "not in dev mode" case): enable Developer Mode ->
  Remote Log Collection on the device, then read
  `{dataDir}/logs/client-logs/*.jsonl` — `pnpm console:volume`
  summarizes per-device lines/minute by level and prefix.
- Test runs: vitest prints app console output inline per test
  (stderr blocks), so a chatty path usually shows up in focused test
  output before it ships.
