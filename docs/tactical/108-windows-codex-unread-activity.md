# Restore Windows Codex Unread Activity

> Make an active Codex rollout advance Inbox recency and unread state while
> Codex still holds its append handle open on Windows.

Topic: inbox
Topic: session-catalog-observation

Status: Implemented and validated on the reproducing Windows host on
2026-08-12. The evidence below isolates the server-side observation and
timestamp failure; the client revalidation path is covered separately.

Related contracts:

- [`topics/inbox.md`](../../topics/inbox.md)
- [`topics/session-catalog-observation.md`](../../topics/session-catalog-observation.md)
- [`topics/session-summary-fidelity.md`](../../topics/session-summary-fidelity.md)
- [`topics/architecture-mandates.md`](../../topics/architecture-mandates.md)

## Reported behavior

On Windows, an Inbox row for a currently active Codex session could remain
read while the agent produced many new events. The same workflow had been
reliable on macOS. Activity state still placed the row in the active tier, but
the row's durable `updatedAt` stayed behind its last-seen marker, so
`NotificationService.hasUnread()` correctly returned false for the stale
input it received.

One screenshot initially appeared to show the defect but was a useful control:
the decorated row had last provider activity at 15:17, was seen at 15:21, and
only had Project Queue work created at 15:22. It was active because of queued
work, not unread because of provider output. The defect was then reproduced on
three genuinely in-turn Codex sessions:

| YA session suffix | Provider activity | Catalog `updatedAt` | Last seen | Result |
|---|---:|---:|---:|---|
| `019ff4ef-d360` | 15:48 | 09:46 | 15:32 | read, incorrect |
| `019ff5d3-fce5` | 15:48 | 13:55 | 15:42 | read, incorrect |
| `019ff5ff-89ff` | 15:48 | 14:43 | 15:39 | read, incorrect |

The machine wall clock and Europe/Berlin timezone were correct. Clock skew was
not part of the failure.

## Root-cause evidence

A live Codex rollout was sampled while the agent continued writing. Each event
increased file size and produced a Windows `fs.watch` `change` notification,
but `mtime` stayed equal to the file-open time. `ctime` advanced with every
append. Once a completed session's writer handle closed, `mtime` advanced to
the final write.

That is permitted Windows behavior: the last-write timestamp may remain
uncommitted until all write handles close. Codex's pinned `rust-v0.147.0`
rollout recorder retains one `tokio::fs::File` for the session and flushes it
after appends; it does not close and reopen for each record. Comparison with
the preceding pinned source showed no new writer-lifecycle change, so this is
a latent Windows assumption exposed as a regression, not evidence of a Codex
0.147-specific format change.

YA then loses the valid operating-system signal in two places:

1. `FileWatcher` records only `mtime`. Its direct event path drops a callback
   when the current `mtime` equals the baseline, and its periodic/fallback
   rescan also compares only `mtime`. The observed Windows `change` event is
   therefore discarded even though size advanced.
2. Codex list summaries use `stats.mtime` as `updatedAt`. Even if the append is
   admitted, a list refresh can publish the same stale timestamp, leaving the
   notification comparison unchanged.

This violates the accepted catalog contract that a file-backed
`sourceVersion` moves on every append through `(mtime, size)`. It also explains
why an open session page can look healthier than Inbox: the focused watcher
already compares `mtime` **or size**, while the global watcher and collection
summary path do not.

## Fix boundary

The repair has three deliberately narrow parts:

- Global file observation compares `(mtime, size)` for direct callbacks,
  initial baselines, and fallback/periodic rescans. A same-`mtime` size change
  is a modify event; an identical pair remains a duplicate.
- A plain Windows Codex rollout uses `max(mtime, ctime)` as its filesystem
  activity timestamp. `mtime` remains the portable and compressed-file clock;
  Windows `ctime` is a bounded fallback for the append-handle behavior proven
  above. Cache/source identity continues to include size and does not substitute
  this timestamp for exact content versioning.
- For a YA-owned live process, collection surfaces compare unread against the
  later of the transcript summary and `Process.lastMessageTime`. The live
  process is the stronger recency source and avoids making owned-session unread
  depend solely on platform filesystem timestamp semantics.

`ctime` is not treated as a cross-platform content clock. On Windows it can
also move for a metadata operation, so it may conservatively make a Codex row
unread after such a touch. That bounded false-positive risk is preferable to
silently suppressing all output from an open active rollout, and the owned
process clock remains authoritative where available.

No new polling loop, per-session timer, or transcript tail read is introduced.
The existing event-driven watcher and bounded rescan paths keep their lifecycle
and backoff rules.

## Implementation order

### 1 — retain exact file append fingerprints

Replace the global watcher's mtime-only index with `(mtime, size)` fingerprints
in its baseline, direct-event, and rescan paths. Preserve touched-path merge
semantics across an in-flight baseline or rescan and include the observed
fingerprint on synthesized modify events.

### 2 — derive Windows Codex rollout recency

Centralize the plain-rollout activity-time rule and use it for Codex discovery
windows, project last activity, and list/full summary `updatedAt`. Keep
compressed rollouts and non-Windows behavior on `mtime`, and keep cache keys on
their existing exact file fingerprints.

### 3 — overlay owned-process activity on collections

Before unread comparison and response sorting, overlay a YA-owned process's
later `lastMessageTime` onto the provider summary recency used by Inbox and the
global Sessions collection. Do not allow recap-only timestamps to create
provider unread state.

### 4 — lock the cross-platform behavior with tests

Cover direct watcher and rescan size-only modifications, both branches of the
Codex timestamp rule without relying on the test host OS, and an active Inbox
session whose provider summary predates last-seen while its process activity
postdates it. Keep all test runs warning-free.

### 5 — update contracts and validate the observation path

Record the restored behavior in the Inbox and catalog observation topics. Run
focused watcher, Codex reader/discovery, Inbox, and global Sessions tests;
server typecheck; repository lint/format checks; and a bounded watcher
performance sample with the required host-capacity evidence.

## Acceptance

- Appending bytes while preserving `mtime` emits one global modify event and
  advances the watcher fingerprint in both direct and rescan paths.
- An identical `(mtime, size)` callback remains suppressed as a duplicate.
- On Windows, a growing open plain Codex rollout advances collection
  `updatedAt` before its writer closes; macOS/Linux and compressed-rollout
  timestamp behavior remain unchanged.
- New messages from a YA-owned in-turn process after last-seen make the Inbox
  row unread even if its on-disk summary timestamp is temporarily stale.
- Inbox and global Sessions sort and expose the same effective provider
  recency they use for unread comparison.
- No browser connection is required, and no watcher, rescan, or provider
  process remains alive beyond its existing teardown contract.

## Landed evidence

The implementation follows the three-part boundary above:

- `FileWatcher` retains `(mtime, size)` fingerprints in baseline, direct-event,
  and rescan state and attaches the observed pair to synthesized events.
- Codex discovery, reader summaries, and external-session creation share one
  Windows/plain-rollout activity-time helper. A Windows integration test holds
  `mtime` at 2026-01-01, appends another valid event, and proves list recency
  advances to the new `ctime` before close.
- Inbox and global Sessions overlay later owned-process message activity before
  unread comparison, response sorting, and global unread counts. Recap-only
  timestamps remain outside the notification comparison.

The focused validation run covered watcher, Codex utility/reader/scanner,
external tracking, Inbox, global Sessions, and cold collection reads: 141
tests passed and two unrelated capability cases were skipped. Server source
typechecking, repository lint, exact-file formatting, and `git diff --check`
also passed. The repository-wide formatter remains unusable as a Windows
working-tree gate because it reports the checkout's existing CRLF baseline;
the 13 touched TypeScript files pass the formatter directly.

A full server-suite attempt exposed existing Windows-only harness failures
outside this change: ACL setup through `icacls`, unsupported directory
`fsync`, and locked SQLite cleanup. None occurred in the touched-area run, so
the focused warning-free suites are the behavior gate for this change.

The five-sample provider-watcher startup benchmark indexed 2,000 eligible
files per sample (8,000 fixture files overall). Median asynchronous baseline
was 17.00 ms; eligible watcher attachment was 4.15 ms. Host capacity was
`host-v1-win32-x64-24cpu-98048mib-fbc8db3a4d453c47`; start/end CPU busy was
11%/17%, processor queue length 0/0, available physical memory 76.79/76.91 GiB,
and pagefile use 0/0 bytes. This is a bounded same-revision smoke result, not a
cross-revision performance claim.
