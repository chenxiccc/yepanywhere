# Session boot cost is invisible to cache miss accounting

`CacheMissBillingMonitor` never judges a fresh non-forked session's first turn.
It has no previous observation to size the turn's expected new content against,
and no fork lineage to expect a warm prefix from, so it forms no expectation and
records nothing. See
[`topics/cache-miss-accounting.md`](../topics/cache-miss-accounting.md)
§ Session boot for the contract this follows from.

That leaves out the recurring cost most worth watching: every new session
re-reads its project instructions, skills, and tool schemas at full price. The
maintainer's observation that opened this work — "I have never seen any
logs/events for uncached e.g. project boot activity" — is still true after the
2026-08-17 extraction and contract fix, for this separate reason.

## What judging it needs

A per-combination baseline rather than a fixed expectation. If a YA session was
created for the same (project, provider, model, effort) within a
provider-specific recency window, compare this session's initial
(pre-user-request) uncached input against that history and flag only an excess
over the norm. Absolute size means nothing here — a large boot is normal for a
large project — so only the deviation is informative.

Legitimate reasons for the baseline to rise, which the analysis must expect
rather than flag:

- revised `AGENTS.md` / `CLAUDE.md` instructions, or changed skills;
- a date rollover, for harnesses that put the date in the prompt;
- a changed tree commit, for harnesses that include git state.

These are discoverable from the recorded series — a step change that persists
across subsequent sessions is a new baseline, a one-off spike is not — rather
than by trying to enumerate every harness's prompt inputs up front.

## Why not fixed in place

The storage this needs does not exist yet. Records live per session in
`session-metadata.json`
(`SessionMetadataService.addCacheMissBillingEvent`, capped at 100 per session),
which is the wrong shape for a cross-session baseline keyed by project,
provider, model, and effort. Deciding that store — and whether the baseline is
a rolling median, a trimmed mean, or the recent minimum — is its own piece of
work, and the distribution the 2026-08-17 change now records is the evidence
that should inform it.

Found 2026-08-17 while fixing the cache-miss extraction and expected-cost
contract; carried forward from the diagnosis in
`gaps/cache-billing-records-nothing.md`, which that commit closed.
