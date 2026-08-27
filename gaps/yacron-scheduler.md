# YA has no generally running yacron scheduler

YA and its provider host do not currently supply the generally running local
scheduler proposed in [`topics/yacron.md`](../topics/yacron.md). Ordinary
agent sessions no longer probe the existing `~/agents` `at/` queue at startup,
so due work still has no punctual owner unless a user invokes that protocol
explicitly.

Missing feature: implement yacron as the generally running provider host's
cross-project scheduler, with its agent CLI, durable entries/occurrences,
current/existing/fresh-session targets, layered global/project configuration,
and optional YA management surfaces.

The earlier solution sketched here — a YA scanner coupled directly to
`scripts/at-queue` — is superseded. `at/` is prior art and a possible explicit
point-in-time import/export format, not yacron's required state or dispatch
protocol. Exported files stay inert until an explicit import-as-of-now
operation. It may be retired if yacron covers its useful cases.

Why not fixed in place: this needs a durable provider-host service lifecycle,
new control operations, headless session creation, persistence/reconciliation,
and cross-platform supervision rather than a bounded server patch.

Found 2026-08-22 while removing the agents-side session-start `at/` probe
mandate (`~/agents` commit 24a9a3c).
