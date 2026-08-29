# Abandoned provider installation lease records are never swept

`ProviderInstallationCoordinator` writes one `read-*.json` / `runtime-*.json`
file per lease under `~/.yep-anywhere/provider-installations/<family>/` and
removes it in `release()`. A YA process that is killed while holding a lease
leaves its record behind forever, because the only sweep of abandoned records
is `collectActiveLeases`
(`packages/server/src/services/ProviderInstallationCoordinator.ts:636`), and
its two callers are `runExclusiveUpdate` — a real Codex npm update, which is
rare — and `getSnapshot`, which no server code calls at all (only tests). The
hot paths, `acquireLease` and `withReadLease`, check for an active writer and
never look at lease records.

Observed on this host: 198 records dating back 8 days, roughly 24/day, all but
three naming a PID that no longer exists.

Two consequences. The directory grows without bound in app data. And the next
real update pays a `stat`, a read, and a process-liveness probe per
accumulated record while holding the admission gate, whose wait is 10s — a
large enough backlog turns an ordinary update into gate-admission timeouts for
every concurrent provider read and launch.

Not fixed in place because the incident being repaired was the unrecoverable
gate directory, and a sweep belongs on a different schedule than either hot
path: adding it to `acquireLease` puts O(records) filesystem work on every
session launch and catalog probe. The cheap fix is a once-per-process sweep —
run `collectActiveLeases` inside the gate the first time a family directory is
prepared, and discard the count.

Found 2026-08-29 while fixing the wedged `codex-cli` admission gate.
