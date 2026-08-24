# Contain Live Worktree Monitoring

> Restore YA's low-resource default after one valid live-worktree lease caused
> macOS watcher exhaustion, retry amplification, 72 GB of Node memory, and an
> operating-system kill.

Topic: live-worktree-resource-safety

Status: implemented and validated 2026-08-21.

Superseded in part on 2026-08-21 after the follow-up harsh review: native
watchers are now Linux-only (every other platform runs enabled monitoring
poll-only with zero native allocation), a registration-churn window feeds the
circuit, and the default became platform-dependent — On only on Linux — after
a recorded Linux bounded-resource validation. macOS remains Off after the
incident, and Windows remains Off pending native measurement. The current
contract lives in
[`topics/source-control.md`](../../topics/source-control.md)
§ Optional live project worktree ownership; this document keeps the original
incident analysis and the original universal default-off decision as history.

Related contracts:

- [`topics/source-control.md`](../../topics/source-control.md)
- [`topics/architecture-mandates.md`](../../topics/architecture-mandates.md)
- [`topics/server-capabilities.md`](../../topics/server-capabilities.md)
- [`topics/vanilla-defaults.md`](../../topics/vanilla-defaults.md)

## Incident

On 2026-08-21 the YA development server monitoring the `mclone` project began
failing worktree reconciliation. At 08:45:24 UTC, repeated
`git ls-files -z --cached` children ended with `SIGPIPE`. At 08:45:31 UTC,
`fs.watch()` failed with `EMFILE`, and the manager switched to its fallback
reconciliation path. The parent development command later reported server exit
137; Vite received `SIGTERM` during wrapper cleanup.

The macOS unified log supplies the terminal cause. At 10:47 local time the
kernel reported `memorystatus: triggering no paging space action`, then killed
Node PID 15390 as the largest compressed process at 72,471 MB. That PID was the
YA server and generated 8,301 FSEvents client registrations between 10:40 and
10:47, including 1,746 registrations in twenty seconds near the failure.

The selected repository had 2,283 tracked files but 14,451 directories outside
`.git`; large ignored `native`, `tools`, and `reference` trees dominated that
directory count. The Git command currently completes in roughly 0.01 seconds,
so its `SIGPIPE` results were secondary distress evidence rather than the
originating cost.

One unusually large Codex transcript was also resident: about 148 MB on disk,
with a 13 MB maximum line, and summary parsing had previously used hundreds of
megabytes. That was secondary pressure. It does not explain the thousands of
new FSEvents registrations or remove the requirement that worktree observation
remain independently bounded.

## Root Cause

`ProjectWorktreeSubscriptionManager` walks every project directory except
`.git` for a Git compatibility subscription and opens one non-recursive
`fs.watch()` handle per directory. It has no watcher budget. A watch failure
marks the set incomplete, enables 30-second full reconciliation, and queues
later watcher synchronization. Under `EMFILE`, that recovery path can repeatedly
allocate and discard native FSEvents clients instead of opening a circuit and
staying degraded.

The triggering lease did not need to come from the Source Control route. File
viewers and inline file-version links in a mounted session transcript use the
same live project corpus to decide whether Worktree and To HEAD links are
available. A passive file link can therefore activate a complete repository
watch set. Multiple links share one project stream, but one stream is enough to
reach the unbounded directory walk.

The ordinary release chain exists: component cleanup releases the client lease,
WebSocket disconnect releases its server subscriptions, and the final server
subscriber closes watchers and timers. The incident does not prove a leaked
final lease. It proves that a legitimate live lease can exhaust the machine
before cleanup matters. Current logs also do not identify which UI surface owns
a worktree lease, making that distinction unnecessarily difficult during an
incident.

## Product Decision

Live worktree monitoring is an experimental Source Control enhancement, not a
core server responsibility. It is server-wide, persisted, configurable, and
platform-dependent when no stored choice exists: On only on measured Linux,
Off on macOS and Windows. An explicit stored choice wins; no migration silently
preserves the former source-ahead default.

Off means exactly:

- no content or Git-metadata `fs.watch()` handles owned by the live worktree
  manager;
- no live-worktree reconciliation, retry, debounce, deadline, or poll timer;
- no accepted direct or relay `worktree` subscription;
- no transcript or file-viewer path that can implicitly enable monitoring; and
- the released static working-tree inventory, cache-backed Git status, legacy
  file projection, explicit refresh, and core session behavior remain usable.

The user-facing control is **Experimental live worktree monitoring** in Source
Control settings. A deployment-level environment override may pin the effective
value Off; a pinned value must be visible rather than silently disagreeing with
the stored setting.

When explicitly enabled, only a visible and focused Source Control route may
own the live lease. Leaving the route, hiding/unfocusing the tab, or pressing
Pause releases it. Transcript file links and standalone file viewers use
bounded one-shot availability paths. Fast resume is not authority to keep
native watchers alive.

Experimental status is not permission to crash. The server enforces a global
native-watcher ceiling independent of client behavior. Reaching that ceiling,
or receiving `EMFILE`, `ENFILE`, or native allocation failure, opens one
process-generation circuit: YA closes its live-worktree watchers, makes no
further watcher allocation attempts, and falls back to bounded reconciliation
until restart or an explicit monitoring-mode reset. Repeated errors do not
create repeated warnings or retry allocation.

## Compatibility Decision

The optional-feature review corpus is `v0.7.0` (2026-07-25) and `v0.6.2`
(2026-07-11); no stable release fell in the preceding fourteen days. Both lack
the worktree subscription, settings field, and IDs 41/42. Their behavior is the
required fallback.

`git-working-tree-sections` (ID 41) and
`git-working-tree-complete-scan` (ID 42) were marked version-implied for
`0.7.2`, but `0.7.2` has not been published. Change both to optional-bit
advertisement and emit them only while monitoring is effectively enabled. A
new permanent, version-implied capability owns the additive server setting so a
client can show the Off control without treating the live protocol as active.

A current client requires both the setting capability and active ID 41 before
opening a subscription. This also makes it fall back when connected to a
source-ahead server that predates the safety setting. An older stable client
already lacks ID 41 and stays on its released static paths. The server rejects
every worktree subscription while Off even if a stale client attempts one; a
client capability decision is never the safety boundary.

No existing capability gains new semantics. ID 38 retains the static
working-tree inventory and cache-backed status contract. With live monitoring
absent, the client makes no subscription and keeps that ID 38 behavior.

## Implementation Order

### 1 — publish the low-resource worktree contract

Record the incident evidence, the original default-off product decision, the
exact Off invariant, the Source-route-only owner, resource circuit behavior,
and the stable-release compatibility corpus in the owning topics before
changing code.

### 2 — make monitoring a server-owned setting

Add the persisted boolean setting with a strict settings parser and the
platform default above when no value is stored. Construct the manager in a
disabled state when Off. A live setting transition to Off cancels pending
acquisitions, clears subscribers, closes every content and metadata watcher,
and clears every timer before the settings request completes. New subscriptions
fail with a typed unavailable response without scanning the project.

The version route and relay compatibility snapshot advertise IDs 41/42 only
when the effective setting is On. Add the permanent setting capability and
refresh the initiating client's version snapshot after a setting change.

### 3 — remove passive worktree owners

Make file-version links and standalone viewers use the existing non-polling
status and static projection paths regardless of experimental monitoring.
Retain the live hook only in Source Control. Teach pause and browser attention
loss to release its lease while preserving the last visible snapshot for a
later resume.

### 4 — cap native watcher acquisition

Add one manager-wide watcher ceiling and stop directory discovery as soon as
that budget cannot cover the desired set. Do not partially churn thousands of
handles. A limit or resource-exhaustion failure opens the circuit, closes every
live-worktree watcher across projects, and leaves bounded polling/manual refresh
as the degraded truth source. Cap concurrently active watched projects as a
second protection against many small repositories.

Expose effective mode, active projects, subscribers, watched directories,
circuit state, and circuit reason through existing diagnostics. Do not include
project paths or transcript data.

### 5 — prove quiescence and graceful degradation

Cover these externally meaningful outcomes:

- default settings create zero worktree watchers and reject a subscription
  before project lookup;
- switching Off with active and pending subscriptions closes all watchers and
  timers immediately;
- transcript file links create no worktree stream;
- Source Pause, unmount, visibility loss, focus loss, and WebSocket disconnect
  release the final lease;
- more directories than the watcher budget never produce more native watcher
  calls than the budget and open the circuit only once;
- injected `EMFILE` closes existing watches and cannot start an allocation
  retry loop;
- static Source Control and per-file diff availability remain functional while
  Off; and
- direct and relay capability advertisements agree with the effective setting.

Run focused client/server tests, capability audit, server and client typechecks,
repository lint, format check, and the warning-sensitive touched suites. Record
that native macOS, Windows, and Linux watcher behavior cannot be inferred from
one host; platform-specific native validation remains explicit.

## Validation

The completed implementation keeps monitoring Off by default, removes passive
file-viewer subscriptions, releases Source Control leases on pause or lost page
attention, and enforces process ceilings of 256 native worktree watchers and
four watched projects. A budget or native resource failure opens the
process-generation circuit before further allocations; explicit Off-to-On
reset or process restart is required to try native watching again.

The full `pnpm test` run passed, including 3,804 client tests. Focused client
and server suites covering settings, capability advertisement, ownership,
pause/resume, attention loss, budget rejection, `EMFILE`, polling fallback,
and circuit reset also passed without runtime warnings. `pnpm lint`,
`pnpm format:check`, `pnpm typecheck`, `pnpm capabilities:audit`,
`pnpm i18n:check`, `pnpm i18n:scan`, `pnpm console:scan`, and
`pnpm css:touched` completed successfully; the advisory i18n and console scans
remained at their existing baselines with no findings introduced by this work.

The Source Control setting was rendered from a fresh isolated dev server and
reviewed at 1000×600 and 375×812. Both captures show the experimental control
grouped with its explanation, visibly Off, without overflow or a stale-runtime
banner. They are archived under
`.artifacts/ui-testing/2026-08-21-live-worktree-setting/`.

Native allocation behavior was exercised on macOS and deterministic injected
failures cover the platform-independent circuit contract. A native runtime pass
was not available on Linux or Windows; their portable fallback paths remain
covered by the shared tests, but host-specific watcher behavior is not claimed
as independently validated here.
