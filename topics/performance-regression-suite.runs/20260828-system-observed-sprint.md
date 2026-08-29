# 2026-08-28 System-Observed Performance Sprint

Status: complete with no accepted optimization candidate. The frozen target
remains +25% offered load. The sprint produced a ratchet-grade baseline,
long-transcript and sidebar-switch diagnoses, and two implementation targets,
but the primary 100-point candidate screen was not computable from the
specialized cohort alone and no coherent production edit fit the remaining
60-minute candidate budget.

2026-08-29 follow-up: the ranked pointers below were triaged into an opened
perf sprint and are in progress —
[`gaps/perf-sprint-system-observed-followups.md`](../../gaps/perf-sprint-system-observed-followups.md)
holds the selection, order, and dependency plans.

This is the first report under YA's one-sprint performance guidance. It is
deliberately explicit about missing evidence: the current revision's baseline
is not an optimization win, an endpoint-only comparison is not the weighted
score, and the ordered sidebar phases do not isolate elapsed time from activity.

## Result at a glance

| Decision | Result |
|---|---|
| Frozen goal | At five lanes (+25%), candidate score no worse than baseline at four lanes, with every hard gate passing |
| Baseline revision | `1bc964e640bfb642fcefb5bb32703fc89d4dd959` |
| Candidate | None |
| Baseline score | 100 by definition |
| Candidate score | Not applicable; no candidate and not all weighted qualities were measured by the cohort |
| Winner-only validation | Correctly not run: no candidate cleared the primary screen |
| Principal browser finding | A 360-turn full projection mounted 722 rows, about 19,000 elements, 46,500 nodes, and 26,500 layout objects; full-projection typing reached 235 ms and scroll generated 5.2–5.7 seconds of long-task time |
| Principal navigation finding | Cached 360-turn A/B sidebar switches took 803 ms fresh, 910 ms after 65 seconds idle, and 1,054 ms after one append (pooled medians), but phase order confounds time, repetition, and activity |
| Gap disposition | Close the one-sprint gap; retain render-window virtualization and add cached large-session sidebar remount latency |
| Repeat automatically? | No. First complete one weighted end-to-end screen and add interleaved sidebar phase attribution |

The measured system has useful +25% provider/action headroom, but it does not
have a fast large-transcript browser path. Five-lane human-send visibility was
13.0% slower than four lanes, while message acceptance was flat and settled
server heap did not grow. Separately, browser work grew sharply with mounted
transcript size and cached cross-session navigation remained a 0.6–1.4 second
operation even when the rendered compact view ended with only 42 rows.

## Frozen experiment identity

The immutable local inputs are ignored raw evidence under
`scripts/perf-suite/results/`:

| Artifact | SHA-256 |
|---|---|
| `system-observed-sprint-20260828-manifest.json` | `15ac4944d545d84b87beea39e601d1e4e63d13e6ae3070b751b26e42ccce15f2` |
| `system-observed-sprint-20260828-trace.json` | `56e050a63f7993cdfd1c8e5241694db6331cacf2386128a8c08ebd7706ad0689` |
| `system-observed-sprint-20260828-config.json` | `38cf02658e1518ce71d3e5aca97d1b4dc1df38e0f70279beea344bfbf17a8421` |
| supplemental `system-observed-sprint-20260828-sidebar-switch-trace.json` | `0cca9019dee690b0decd5029ea77bf825cc5de62f43771206731683ce4010c56` |

The fixture revision was
`2f5e403e20fc5b96d5634a4b8f5a57704023d8da`. The capacity key was
`host-v1-linux-x64-16cpu-126720mib-ecfa1407f7322835`: Linux x64, 16 logical
AMD EPYC 7R13 CPUs, 126,720 MiB bucketed memory, and Node 24.14.0.

Current load was four independent lanes and +25% load was five. Each lane
owned one simulated provider session, one browser, one gathered semantic
action, one human composer send, one causal replay, and a 24-delta stream of
2,048-byte chunks scheduled every 2 ms. The scheduled 500 events/second per
lane was a recipe, not an assertion of exact realized throughput.

The trace used the saved 1,000 by 600 viewport and performance-relevant browser
settings: very-dark theme, Conversation View enabled with a 240-turn limit,
themed tooltips with an 80 ms configured delay, DOM linger enabled, active
window trimming disabled, and the transcript cache enabled with a 256 MiB,
72-hour budget. It copied no authentication, private transcript content,
source credentials, or live browser profile.

The score froze weights of 28 for UI/frame health, 24 for leak freedom, 20 for
provider-to-visible latency, 20 for steer delivery, 6 for tooltip/card
response, 1 for startup time, and 1 for startup memory. Missing qualities
invalidate the score instead of changing these weights after observation.
Candidate implementation was limited to 60 minutes, 300 net production lines,
no dependency or public contract additions, and at most one operational state.

## Run validity and provenance

All reported survivor checks were clean. Every accepted result passed automatic
host admission, retained its start/end capacity samples, and used a fresh
isolated server/browser/process group. The user's server on port 3400, browser
profile, selected private session, and `~/draft` were not measurement targets
and were not mutated.

The user warned that a 16-core XMT smoke might be active. No matching process
was identified at manifest freeze. Ambient load rose during some later runs,
including load average 13.5 at the sidebar trace start, but measured CPU busy
fraction was 9.1% during its admission window and 38.8% over the run, with no
swap-growth failure and more than 100 GiB available memory. The automatic
capacity gate therefore admitted it. This report does not infer which process
owned the ambient demand or use cross-run host variation as optimization
evidence.

Raw output and verbatim command records:

- Long-session scale: `system-observed-sprint-20260828-browser-24.json`,
  `-browser-120.json`, and `-browser-360.json`, with adjacent `.meta.md` files.
- Current load: `system-observed-sprint-20260828-current-b1` through `-b3`.
- +25% load: `system-observed-sprint-20260828-plusx-b1` through `-b3`.
- Supplemental navigation: `system-observed-sprint-20260828-sidebar-switch.json`.
- Specialized smoke: `system-observed-sprint-20260828-specialized-smoke.json`.
- Compact history: `system-observed-sprint-20260828-history.jsonl`.

An initial 120-turn diagnostic encountered 99.6% CPU busy admission and is not
used. The replacement reported below passed with 54.6% admission busy fraction
and 7.26 idle logical CPUs. Failed or superseded setup attempts are not folded
into the measurements.

## Current versus +25% offered load

Three current-load batches produced 12 lane samples; three +25% batches
produced 15. Values below are pooled medians, with p95 in parentheses.

| Endpoint, lower is better | 4 lanes | 5 lanes | Median change |
|---|---:|---:|---:|
| Human semantic send to readable display, ms | 889.7 (1,002.1) | 1,005.2 (1,097.8) | +13.0% |
| Causal replay to readable display, ms | 437.0 (512.8) | 463.8 (592.2) | +6.1% |
| Message acceptance round trip, ms | 44.7 (90.6) | 44.5 (96.3) | -0.5% |
| Provider first text, ms | 166.0 (198.8) | 159.7 (227.9) | -3.8% |
| Provider final enriched message, ms | 128.2 (153.0) | 138.4 (171.0) | +7.9% |
| Server useful startup, ms | 3,958.8 (4,160.4) | 4,267.1 (4,568.5) | +7.8% |
| Settled server heap per lane, MiB | 92.15 (92.22) | 92.12 (92.18) | -0.03% |
| Retained server heap per lane, MiB | 3.51 (3.51) | 3.48 (3.51) | -0.8% |

These rows establish endpoint sensitivity, not the 100-point screen. The
specialized lane measures semantic sends, provider timing, server startup, and
server heap. It does not measure composer key frames, scroll distribution,
browser long tasks, forced-quiescent browser/DOM/store slopes, tooltip and
card response, or browser startup memory. The manifest expressly forbids
silently redistributing those missing weights.

## Long-transcript browser scaling

The 24- and 120-turn points are single ratchet-grade diagnostics. The 360-turn
point has three repetitions. The append value is the complete server detail
request headline; the 360 row reports the median of its three samples.

| Loaded turns | Append detail, ms | Settled/retained server heap, MiB | Browser PSS, MiB | Final rows | Elements / nodes / layouts | Final JS heap, MiB |
|---:|---:|---:|---:|---:|---:|---:|
| 24 | 19.1 | 100.7 / 12.3 | 449.6 | 50 | 1,513 / 2,445 / 1,970 | 62.1 |
| 120 | 108.1 | 104.3 / 15.9 | 530.6 | 242 | 6,505 / 15,021 / 8,978 | 83.4 |
| 360 | 196.8 | 113.8 / 25.4 | 751.7 | 722 | 18,985 / 46,508 / 26,498 | 139.8 |

This is a scale curve, not a leak slope: each point starts a fresh browser and
loads a different fixture size. It demonstrates retained cost proportional to
loaded work, but it cannot establish heap growth by elapsed time or completed
turn within one process. The sidebar trace below supplies a short-lived
same-process check only; it also is not a long-duration leak proof.

At 360 turns, Conversation View typing p95 stayed between 18.7 and 20.7 ms,
but scrolling had a 33.3 ms p95, a 3.88–4.15 second maximum frame interval,
and 5.16–5.75 seconds total long-task time. Switching to the full projection
took 271–295 ms to its next paint. Full-projection typing maxima were
229–235 ms. A themed tooltip incurred 445–462 ms of work after its configured
80 ms delay, including a 295–300 ms long task. The hover-card content was
already visible at the sampled reveal boundary and added no measured work.

The full projection was behaviorally exercised, but no winner existed, so the
expensive winner-only complete-scrollback content-equivalence traversal was
correctly skipped.

## Cached sidebar switching

The supplemental trace built two independent 360-turn sessions, warmed the
saved 256 MiB transcript cache, and performed three A-to-B-to-A round trips in
each phase for three repetitions. Each pooled condition therefore contains 18
switches. The endpoint is sidebar activation to the next painted useful
session view.

| Ordered condition | Switch median, ms | p95, ms | Range, ms | Long-task median, ms | Long-task p95, ms |
|---|---:|---:|---:|---:|---:|
| Immediately after warm setup | 802.6 | 1,135.2 | 599.5–1,135.2 | 174.5 | 465 |
| After 65 seconds with no injected activity | 909.5 | 1,081.8 | 607.5–1,081.8 | 270 | 341 |
| After one deterministic append | 1,053.8 | 1,437.4 | 764.4–1,437.4 | 319 | 464 |

The observed ordering directionally resembles the user report that switching
is faster after reload and degrades later, but the synthetic fresh phase was
not an actual reload of the user's private session and it does not show why.
Every repetition ran fresh, then idle, then append in that order. Repetition medians were
792/785/814 ms, 772/970/1,059 ms, and 1,087/1,046/1,086 ms. The third
repetition's fresh phase was already as slow as later phases, so time,
repetition/order, ambient demand, and appended activity remain confounded.

The compact view ended every repetition at 42 rendered rows, 1,307 elements,
2,621 nodes, and 821 listeners. Initial JS heap was 63.1–65.8 MiB and final
heap was about 64.1 MiB. The cache held about 2.3 MiB and the route model kept
one live session plus one warm snapshot. This 65-second experiment therefore
found no monotonic DOM, listener, or JS-heap accumulation sufficient to explain
the slowdown.

The next discriminating trace should use two arms:

1. fresh, 65-second idle, then another no-activity switch phase; and
2. fresh, immediate deterministic append, then switch, with no 65-second idle.

Alternate the arms across repetitions. Mark route click, cache lookup and hit
identity, snapshot hydration, state queue, `MessageList` projection/grouping,
React commit, layout, and readable paint. Count component remounts, actual DOM
reuse, subscriptions, and retained store bytes. A test-only 50 ms delay at
cache lookup/hydration should shift the endpoint by approximately 50 ms if
that boundary is critical; placing the same delay after state queue but before
an unrelated diagnostic should not. This delay probe would validate the clock
path, not claim that removing 50 ms from a different phase produces the same
gain.

## Causal ownership and ranked pointers

### 1. Bound mounted transcript work

Scenario and evidence: the 360-turn full projection mounted 722 rows and about
46,500 nodes, produced 229–235 ms typing delays, and accumulated more than five
seconds of scroll long tasks. The owning path constructs projection rows in
`packages/client/src/components/MessageList.tsx` and maps the complete timeline
into React output.

Predicted marginal value: render-window virtualization should make full-mode
DOM, layout, and interaction cost depend on visible/overscanned chunks rather
than loaded history. It should also reduce full-history remount expense. It
will not by itself explain the 42-row compact sidebar result.

Likely edit: first split older-page prepend into semantic chunks with yields,
then implement measured-height, wakeable turn/activity chunks with stable
anchors. This means browser render-window virtualization. It does not mean
withholding provider activity from the client or sending a permanently
truncated transcript. The exact contract remains in
[`gaps/full-transcript-render-window-virtualization.md`](../../gaps/full-transcript-render-window-virtualization.md).

### 2. Attribute and reduce cached cross-session remount

Scenario and evidence: cached A/B switching remained 0.6–1.4 seconds with
119–465 ms long-task work while the compact destination had 42 rows and stable
heap/DOM counts. `NavigationLayout` currently retains one session only across a
session-to-non-session route; direct A-to-B navigation replaces that route.
`useSessionMessages` hydrates the destination snapshot and `MessageList`
rebuilds its rendered projection.

Predicted marginal value: route-phase marks should separate synchronous cache
read from hydration, commit, and layout in one measurement pass. If remount and
layout dominate, preserving a bounded second DOM could avoid them, but it also
doubles the most expensive retained state and risks duplicate streams, focus,
and liveness ownership. Do not implement two-session keepalive before the
phase and memory evidence. The new
[`gaps/cached-large-session-sidebar-remount-latency.md`](../../gaps/cached-large-session-sidebar-remount-latency.md)
owns this work.

### 3. Reuse or narrow server augmentation work

Scenario and evidence: the 360-turn append headline was 175–203 ms. Server
augmentation used 94–113 ms, or 49–57% of the total; framework,
serialization, and loopback used about 45–46 ms. The cold 360-turn request used
324 of 417 ms in augmentation. The owner is the persisted-message augmentation
call in `packages/server/src/routes/sessions.ts` and the message-wide
`Promise.all` in `packages/server/src/sessions/persisted-augments.ts`.

Predicted marginal value: eliminating half of the measured warm augmentation
would save about 47–57 ms of server detail time, not the entire browser-visible
endpoint. Before editing, instrument cache hit/miss and changed-message counts
to determine whether the delta route is re-augmenting unchanged rows, waiting
on a cold cache, or paying per-message project-context work. A 50 ms test-only
delay inside augmentation should add about 50 ms to server detail; if it does
not, the current phase clock is not on the endpoint path. No gap is opened yet
because the present evidence does not distinguish those owners.

### 4. Measure the client scheduling and commit residual

Scenario and evidence: the final 360-turn append spent about 52–53 ms from
append start to preprocessing, 45–49 ms from grouping to commit, and 14–16 ms
from commit to readable text. Measured preprocessing and grouping computation
were each under one millisecond, so optimizing their loops would target the
wrong owner.

Predicted marginal value: marks around state scheduling, React render start,
commit, layout, and paint can expose whether the roughly 100 ms residual is
intentional scheduling, reconciliation, or browser layout. A manual boundary
or component edit is more plausible than a compiler flag; this TypeScript/React
path has no demonstrated build option that removes the observed work.

### 5. Treat tooltip delay as transcript amplification

Scenario and evidence: tooltip work after the intentional 80 ms delay reached
445–462 ms and included a roughly 300 ms long task only on the large mounted
transcript. The trace establishes user-visible coupling, not that
`TooltipLayer` itself consumed all that time.

Predicted marginal value: repeat the same reveal with bounded mounted rows and
use browser/React phases before changing tooltip code. If virtualization
removes the long task, the tooltip was a trigger for global layout rather than
the owner.

## Candidate and acceptance disposition

No production candidate was implemented. Architecture screening rejected the
available shortcuts within the 60-minute candidate budget:

- Render-window virtualization is the highest-benefit target but crosses
  variable-height placeholders, scroll anchoring, search, selection,
  disclosure identity, and full-history semantics. It is not a safe micro-edit.
- Keeping two full session DOMs would target switching directly, but current
  route-retention and DOM-linger contracts intentionally prohibit that first
  move without stream, focus, memory, and expiry evidence.
- Server augmentation has a credible upper bound but not yet a sufficiently
  narrow owner; caching or skipping work before measuring changed-message and
  hit state would risk stale enriched output.
- The measured client preprocessing/grouping bodies were already sub-millisecond;
  a compiler flag or local loop rewrite would not address the queued-to-commit
  residual.

This is an honest no-winner closure allowed by the frozen sprint contract.
`X=25` was not reduced. No checkpoint commit claims a gain, no candidate is
called accepted, and the full correctness/scale/resource/scrollback suite was
not spent on a losing or nonexistent edit.

## Effort, code growth, and measurement overhead

From the sprint-contract commit at 19:30 UTC through the final qualifying
120-turn replacement at 21:59 UTC was 148 minutes. Report and triage authoring
kept the complete sprint near, but within, the frozen 180-minute agent-wall
budget. The semantic-action prerequisite began earlier and is accounted for by
its own completed work, not charged as candidate implementation.

The measurement facility added 1,290 lines and removed 14 across seven
`scripts/perf-suite` files after the baseline revision: a parent-leased cohort
driver, browser interaction traces, phase aggregation, process-fixture support,
and tests. This is substantial harness growth, not production-candidate growth.
Candidate production growth was zero lines, zero dependencies, zero public
configuration/schema surfaces, and zero new runtime operational states.

Qualifying measured host windows totaled roughly 13 minutes for the three
long-session points, sidebar trace, and six cohort batches, excluding their
three-second admission samples and setup between runs. The browser sidebar
trace was the most expensive single measured window at 5.5 minutes. Raw JSON,
logs, and metadata remain local and ignored; this report is the committed
decision artifact.

For a second sprint, reduce harness overhead before candidate work: make one
scenario collect every frozen weighted quality at both offered loads, emit the
score or a precise missing-quality list, and retain the new route phases. The
current cohort and interaction trace are reusable. Do not schedule a recurring
optimizer until one real candidate completes that end-to-end screen.

## Open-gap cost/benefit triage

These are planning estimates, not implementation measurements. Cost bands are
XS (under half a day), S (roughly half to two days), M (two to five days), L
(one to three weeks), and XL (multi-week or program-scale). Benefit is the
expected payoff if fixed: Critical, High, Medium, or Low. “Now” means a current
correctness, security, or measured user-latency front; “Next” is material but
needs a bounded design/measurement step; “Later” is valuable roadmap work;
“Opportunistic” is narrow cleanup.

The virtualization *gap* has just landed; the virtualization implementation
has not.

| Gap | Cost | Benefit | Triage | Reason |
|---|---:|---:|---|---|
| `unconfirmed-send-loss-across-reload` | L | Critical | Now | User text can disappear across a reload/restart boundary. |
| `remote-session-project-views-use-local-files` | XL | Critical | Now | Remote session views can present the wrong machine's files. |
| `session-transcript-project-from-launch-cwd` | L | Critical | Now | Wrong cwd/project identity can misplace resume work and transcript ownership. |
| `background-relay-reconnect-blank-page` | L | Critical | Now | A live session can become unusably blank after reconnect. |
| `full-transcript-render-window-virtualization` | XL | High | Now | Directly addresses measured 46k-node, multi-second long-task growth; first slice can be smaller. |
| `cached-large-session-sidebar-remount-latency` | M measure / L fix | High | Now | Reproduced 0.6–1.4 second cached cross-session switches; cause still needs separation. |
| `long-session-old-content-motion-recurrence` | M | High | Next | Potential transcript instability is severe, but current reproduction confidence is low. |
| `lower-websocket-message-admission` | L | High | Now | Reduces a large production memory/denial-of-service exposure. |
| `native-server-no-new-privs` | L | High | Next | Meaningful native-host security boundary; needs cross-platform handling. |
| `reactivate-provider-resolution` | M | High | Now | Wrong provider inference can reactivate a session incorrectly. |
| `provider-resume-readiness` | M–L | High | Now | “Started” can precede actual attachment, violating a visible control contract. |
| `server-tests-not-typechecked` | M | High | Next | A broad correctness blind spot affects every server change. |
| `production-dependency-audit-advisories` | M | High | Next | Security debt is known, though current reachability/upgrade trade-offs constrain urgency. |
| `better-sqlite3-prebuild-libstdcxx-floor` | M | High | Next | Blocks SQLite workspaces on a supported enterprise Linux target. |
| `global-activity-stream-file-fanout` | L | High | Next | Work scales with every browser and file event; becomes costly at fleet scale. |
| `public-share-status-rerenders-session` | S–M | High | Next | Periodic status polling wakes the measured expensive session render surface. |
| `isearch-stops-at-loaded-transcript` | M | High | Next | Search silently omits older history beyond the loaded client window. |
| `session-worktree-file-links` | L | High | Next | Missing worktree-aware file identity blocks correct viewers from sessions. |
| `live-full-state-backup` | XL | High | Later | High recovery value, but consistency and restore semantics are program-scale. |
| `provider-neutral-remote-executors` | XL | High | Later | Large reach benefit; multiple provider/runtime contracts make it roadmap work. |
| `provider-session-side-effect-controls` | M–L | High | Next | Remaining unverified controls can allow unintended provider-side effects. |
| `public-frozen-file-revision-shares` | XL | Medium | Later | Useful share semantics, but broad storage/auth/version surface. |
| `full-stack-degradation-injection` | XL | Medium | Later | Strong future diagnosis facility; not needed to act on today's measured owners. |
| `cache-miss-boot-baseline` | L | Medium | Next | Missing accounting hides cold boot cost and weakens later cache decisions. |
| `committed-change-session-attribution` | L | Medium | Later | Improves provenance but does not block current correctness. |
| `agent-facing-env-markers` | M | Medium | Later | Clarifies launcher contracts and reduces integration ambiguity. |
| `nested-harness-session-not-linked-to-launcher` | M–L | Medium | Later | Useful causal navigation for nested work, with identity plumbing cost. |
| `oversized-hub-modules` | XL | Medium | Later | Structural debt raises future change cost; split only along proven owners. |
| `confusing-settings` | XL | Medium | Later | Broad UX bundle should be split into bounded surfaces before implementation. |
| `server-synced-session-scroll-memory` | M–L | Medium | Later | Cross-device continuity value, but synchronization/conflict semantics are nontrivial. |
| `quarto-aware-document-view` | XL | Medium | Later | Preserves publication semantics for a narrower document workflow. |
| `reload-banner-overlaps-delivery-during-width-transition` | S–M | Medium | Next | Can obscure delivery controls at a critical moment; bounded UI fix. |
| `source-projection-upgrade-notice-misclassifies-errors` | S | Medium | Next | Incorrect error classification sends users toward the wrong remedy. |
| `settings-search-confirmation-and-row-navigation` | S | Medium | Opportunistic | Bounded discoverability/navigation improvement. |
| `virgin-new-session-option` | M | Medium | Later | Useful explicit startup mode but adds a novel option and harness semantics. |
| `yacron-scheduler` | XL | High | Later | High automation value, but requires a generally running scheduler and lifecycle contract. |
| `blocked-service-worker-registration-noise` | XS | Low | Opportunistic | Removes misleading console noise without changing core behavior. |
| `detached-process-session-detail-missing-started-at` | XS | Low | Opportunistic | Small fixture/test fidelity repair. |

This table restates every open root gap after replacing the completed sprint
entry with the sidebar-remount entry. It does not authorize expanding a future
task beyond the selected gap.

## Final disposition

Pursue render-window virtualization and route-switch phase attribution as the
two measured browser fronts. Hold augmentation optimization until hit/change
counts identify a safe owner. Park automatic recurring performance sprints
until a single scenario can compute the full frozen weighted score. Preserve
the semantic action, cohort, and interaction-trace facilities for the next
candidate rather than rebuilding the measurement seam.
