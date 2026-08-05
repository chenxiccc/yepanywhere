# Schedule Heartbeat Candidates Without Fleet Scans

> Keep server-owned heartbeat turns active without a browser, but derive exact
> session candidates and their next deadlines from retained metadata/catalog
> state instead of searching every project and loading transcripts every 30
> seconds.

Status: Partially implemented. The retained candidate registry (steps 1, 2,
and 4) has landed and is measured below: ownership decides before any storage
work, an exactly located candidate no longer searches the project fleet, and a
source-versioned pending-tool fact keeps an unchanged transcript from being
reparsed on the interval. The deadline scheduler (step 5), catalog-supplied
tail projections (step 3), and the adverse-state matrix (step 6) remain
pending; the 30-second supervisor tick still drives the registry.

## Implementation progress

- **2026-08-05 — retained heartbeat candidate registry.**
  `HeartbeatCandidateRegistry` owns eligibility, exact location, and a
  source-versioned pending-tool fact behind the shared byte-bounded
  single-flight owner. Ownership is checked before `listProjects()`, so a fully
  owned fleet performs no storage work at all. A located candidate resolves
  only its own project; a candidate whose transcript moved falls back to one
  search and relocates; an unlocatable candidate enters exponential backoff
  instead of re-searching the fleet every tick.
  With 10,000 projects, one eligible unowned session, and 20 ticks, the fleet
  search performed 120,020 project probes, 20 project listings, and 20 full
  transcript reads in 57.02 ms, versus 6,020 probes, 1 listing, and 1
  transcript read in 5.58 ms. Excluding the one-time location search, the
  recurring cost fell from 114,019 probes and 53.00 ms to 19 probes and 1.59 ms
  (99.98% of probes avoided, 33.36x). A fully owned fleet cost 0 project probes
  and 0.05 ms across all 20 ticks. Run `pnpm --filter @yep-anywhere/server
  benchmark:heartbeat-candidates` to repeat the measurement.

Related contracts and plans:

- [`topics/heartbeat.md`](../../topics/heartbeat.md)
- [`topics/session-liveness.md`](../../topics/session-liveness.md)
- [`topics/architecture-mandates.md`](../../topics/architecture-mandates.md)
- [`topics/provider-abstraction.md`](../../topics/provider-abstraction.md)
- [`topics/session-catalog-observation.md`](../../topics/session-catalog-observation.md)
- [`089-main-thread-startup-cpu-investigation.md`](089-main-thread-startup-cpu-investigation.md)
- [`093-provider-session-reconciliation.md`](093-provider-session-reconciliation.md)

## Current recurring scan

`Supervisor` runs `queueHeartbeatTurns()` every 30 seconds. Its owned-process
branch walks the bounded live process map, but the unowned branch delegates to
`app.ts:getHeartbeatTurnCandidates()`:

1. `SessionMetadataService.getAllMetadata()` is filtered for enabled,
   non-archived, non-exempt sessions;
2. if any exist, every project is listed before live ownership is checked;
3. for each unowned candidate, projects are searched sequentially with
   `findSessionListSummaryAcrossProviders()` until its transcript is found; and
4. the matched reader loads and normalizes the complete session so
   `hasPendingToolCall()` can inspect the tail.

This repeats on the fixed interval. A heartbeat-enabled transcript that exists
but does not currently end in a pending tool call may therefore be loaded every
30 seconds indefinitely. A deleted/moved/unrecognized candidate can search the
entire project/provider space every tick. Provider metadata narrows only some
rows; project identity is not used by this path even when YA knows it.

The 2026-08-05 install snapshot contained 819 session metadata rows, three with
heartbeat turns enabled and two still eligible after archive/resume exemptions.
Neither eligible row had a durable working or transcript project id; one had a
provider. These counts do not prove both were unowned during every tick, but
they prove the fleet-scan gate is live on this install. Even when all candidates
are currently owned, `listProjects()` still runs before the ownership skip.

This path was not the demonstrated 2026-08-04 sustained CPU owner: process-list
provider-child enrichment has direct hundreds-of-GiB read evidence. It is a
separate structurally repeating transcript path with the same undesirable
shape and becomes especially expensive for a large opted-in transcript or a
missing candidate.

## Candidate projection

Maintain one compact heartbeat-candidate row for each metadata entry whose
`isUnownedHeartbeatResumeEligible()` predicate is true:

- canonical YA session id;
- provider/native catalog family;
- exact transcript project/location identity when known;
- effective working project id for resume;
- configured heartbeat delay/text and resume exemption generation;
- last provider/session activity timestamp;
- whether the latest observed durable tail ends in a pending tool call;
- transcript/catalog version that established the tail fact; and
- current live-process ownership, if any.

The row contains no transcript text, tool arguments, command output, or
credentials. A pending-tool boolean is valid only for the exact observed source
version. An append/file event invalidates or incrementally updates it; it cannot
silently remain authoritative across replacement or truncation.

Session metadata changes create, update, or remove the row immediately.
Supervisor ownership events switch the same row between owned and unowned
without searching storage. Provider catalog reconciliation from tactical 093
supplies exact provider/project location and compact tail facts for unowned
rows. A first migration may resolve old rows missing project identity once at
bounded catalog concurrency; failure remains explicit unresolved state and
uses the catalog's bounded retry/reconciliation policy, never a per-candidate
all-project interval.

If an adapter cannot derive pending-tool state during its ordinary bounded
catalog/tail read, the due candidate may issue one exact, coalesced tail
projection read. Loading and normalizing the entire transcript every tick is
not an acceptable fallback. Full detail remains a last-resort one-time repair
whose source version is then retained in the compact row.

## Deadline scheduler

Replace the fixed candidate scan with one process-wide deadline scheduler. A
priority queue plus one armed timer scales to many candidates without one
interval per session. Candidate metadata, liveness, ownership, and transcript
events recompute that row's deadline from the latest real activity anchor.

At a due deadline:

1. re-check resume exemptions, ownership, queue/liveness state, and the source
   version used by the pending-tool projection;
2. refresh only the exact candidate projection if its source version is stale;
3. apply the existing provider steering and liveness rules; and
4. queue/resume once or schedule the next exact deadline from the resulting
   state.

Delayed timers compare wall-clock time with the stored activity timestamp.
Process restart reconstructs the priority queue from metadata plus the last
catalog snapshot before background catalog reconciliation begins. An
unresolved row cannot authorize a resume; it reports why it awaits catalog
repair without turning every deadline into a fleet scan.

The owned-process heartbeat path may remain under a bounded supervisor sweep in
the first slice, but the preferred end state routes its state changes through
the same deadline owner. Patient/deferred queue backstops retain their separate
delivery contract and must not be accidentally removed while changing the
heartbeat timer.

## Source map

| Concern | Current owner | Change |
|---|---|---|
| Fixed scheduler | `Supervisor` heartbeat interval | One process-wide next-deadline scheduler with event-driven recomputation |
| Candidate discovery | `app.ts:getHeartbeatTurnCandidates()` | Read exact retained candidate rows; remove nested project/provider search |
| Eligibility/exemptions | `SessionMetadataService`, `resume-exemption.ts` | Incrementally maintain candidate membership and durable kill/archive behavior |
| Transcript location | YA metadata plus tactical 093 catalog | Retain exact provider/project mapping; bounded one-time migration for older rows |
| Pending-tool fact | provider catalog/tail adapters | Store a source-versioned boolean without full transcript retention |
| Ownership/liveness | `Supervisor`, provider process events | Update candidate state/deadline on real events rather than discover it on a tick |
| Diagnostics | server performance events/metrics | Count eligible/owned/unresolved/due candidates and exact projection reads |

## Recommended implementation order

### 1 — instrument the current candidate sweep

Record each 30-second generation's eligible, owned-skipped, projects visited,
provider scopes queried, exact summary/tail/full-detail reads, bytes, duration,
and outcome. Do not log candidate transcript text or filesystem paths.

### 2 — build the retained candidate registry

Seed from session metadata and subscribe to metadata, ownership, liveness, and
catalog deltas. Preserve archive and explicit-Kill resume exemptions. Model an
unknown project/provider/pending-tail fact explicitly rather than guessing.

### 3 — add provider tail projections

Teach eligible provider catalog adapters to report source-versioned pending
tool state from bounded tail work. Coalesce identical exact reads and invalidate
on append, replacement, truncation, or watcher uncertainty.

### 4 — replace fleet search with exact lookup

Make the unowned candidate resolver consume registry rows. Migrate missing old
locations once through tactical 093's bounded catalog; delete the nested
candidate × project × provider loop and complete-session read.

### 5 — replace the fixed candidate tick with deadlines

Arm one timer for the earliest candidate. Recompute from events, compare stored
timestamps after sleep, and keep owned-process and patient-queue behavior
covered while the scheduler converges.

### 6 — verify restart and adverse states

Cover source replacement, missing/deleted transcript, unknown provider/project,
catalog interruption, explicit Kill, archive, re-enable, ownership attach/loss,
large pending-tool transcript, background server operation with no client, and
clock/sleep delay.

## Acceptance

- With 10,000 projects and one eligible unowned heartbeat session, a scheduler
  tick/deadline performs zero unrelated project/provider reads.
- A heartbeat-enabled transcript whose tail is unchanged and has no pending
  tool call is not reparsed on a fixed interval.
- A missing or unresolved candidate enters bounded catalog reconciliation and
  never triggers a recurring all-project search.
- Pending-tool state is tied to an observed source version and invalidates on
  append/replacement/truncation without retaining the full transcript.
- Server restart reconstructs eligible deadlines without requiring an open
  client and without authorizing unresolved rows.
- Archive and explicit Kill block automatic resume; deliberate re-enable
  restores the exact candidate according to the existing contract.
- Metrics distinguish candidate count, deadline work, exact projection reads,
  catalog repair, resumes, skips, and errors while recording no transcript
  content.
