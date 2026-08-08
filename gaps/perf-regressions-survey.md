# Performance-regression survey findings

The independent, configuration-driven workload found the concerns and
trade-offs below across the 2026-08-03 through 2026-08-08 performance and
harsh-review arc. One checkout-independent harness generates Claude projects,
sessions, initial and appended turns, and concurrent clients. Its server driver
uses public HTTP routes plus forced-GC maintenance samples. Its optional real
browser driver uses the same scenario parameters, enables glossary hints, sets
browser transcript-cache budgets before app load, and records readable,
glossary, automatic project-path, and final-display latency plus browser
heap/DOM counts, YA transcript-cache statistics, and server memory. Every
accepted sample first proves exact project, session, message, capability-gated
rendering, and negative-link controls against one pinned repository revision.

## Cold project enumeration exceeds one second before and after the arc

At both pre-sprint `adaa804b` and surveyed `2f5e403e`, the first concurrent
per-project session-list pass at `fleet-small` takes about 1.33 s p95. An
immediate replay takes only 4–6 ms p95. Forced-GC pre-sprint memory is 92.2 MiB
settled heap with 8.6 MiB retained over startup, not the much larger uncollected
figures from the exploratory runs.

The delay is first-index construction over previously unseen transcript files,
not sustained route latency and not a regression introduced by this arc. It
still crosses the one-second user-facing threshold when a data directory has no
usable session indexes. Current ratchets must distinguish this cold-index leg
from the ordinary warm list path rather than accepting 1.3 s for both.

## Browser live append crossed one second until the measured perf arc

With four real browser clients at `fleet-small`, file-observed appended text
reached the rendered tail in 1.29 s p95 at C0 `adaa804b` and C1 `3c0f70df`.
That fell to 387 ms at C2 `61cb5f35` and remained 378–403 ms through C3, C4,
C5, and surveyed `2f5e403e`. This concerning pre-arc behavior was repaired
during the measured performance sequence and was not reintroduced by
harsh-review work.

A fresh dev-client boot plus first session render remains about 4.2–5.1 s at
every checkpoint. This includes Vite/module startup and is not a production
bundle or session-route-only number; warm in-app reopen is 494–569 ms. Keep the
cold browser observation separate from production user-facing ratchets until a
built-client driver isolates application boot from development transforms.

## Parsed-server cache exchanges retained heap for repeat-read latency

At the `large-session-cache` scale point (2 projects × 4 sessions × 16 final
turns, 3 concurrent clients, 64 KiB per message), commit `6024cff1` changes the
forced-GC server results as follows:

- retained heap: 8.4 MiB before to 32.8 MiB after;
- settled heap: 94.1 MiB before to 118.6 MiB after;
- cold readable-tail p95: 263 ms before to 268 ms after;
- warm readable-tail p95: 145 ms before to 125 ms after; and
- appended readable-tail p95: 200 ms before to 189 ms after.

The roughly 24.4 MiB retained-heap increase buys about 14% faster warm detail
and 5% faster appended detail at this scale. This matches the cache's purpose;
it is a measured memory/latency trade-off, not a confirmed regression.

## Browser transcript caching is also an explicit memory/latency trade-off

At surveyed `2f5e403e` with `large-session-cache`, a 24 MiB browser
transcript-cache budget versus zero changed warm in-app readable-tail p95 from
847 ms to 677 ms
(about 20% faster) and retained one approximately 4.75 MiB transcript in YA's
warm-cache accounting. The maximum observed browser JS heap was 130.9 MiB with
the cache versus 112.3 MiB without it; browser heap has higher run-to-run noise
than forced-GC server heap, so use the YA byte accounting as the cache-specific
ratchet. Appended live-tail p95 was 785 ms with caching and 827 ms without.

## Current phase ownership exposes recovery targets

The profiled execution revision is immutable `cab8184a01d4ce737432966e8e4b4730e00720a5`.
Its additive server and browser phase trees identify the following important
owners; historical checkpoints retain comparable totals but cannot provide
retrospective owner clocks.

| phase | service and boundary | reuse / size shape | concern and recovery target |
|---|---|---|---|
| Session-detail augmentation | Converts sliced persisted messages into client-ready Markdown, media, recap, and project-path output. It consumes normalized messages plus project context and returns augmented response messages. Glossary highlighting is client-side and is not an input to this server phase. | The project-path index is shared, but Markdown/path traversal still runs for each returned text block and concurrent request. Cost grows with returned text bytes and block complexity. | This dominates current server-owned detail time. Cache/coalesce only the immutable Markdown result by content/scope and a fenced project-index revision; do not cache the whole mutating finalized-message operation. |
| Framework / serialization / loopback | Carries the Hono response through the direct WebSocket relay and back to the browser-facing request abstraction. | The relay accumulates the body, decodes and parses JSON, wraps it, serializes it again, chunks large frames, then the browser reassembles and parses it. Cost grows with augmented response bytes. | Preserve response bytes or use a typed internal handler rather than decode/re-encode. Forward `Server-Timing` through the relay so browser-driven profiles retain server attribution. |
| Append trigger to MessageList preprocess | Detects an external JSONL append, publishes a focused session-watch event, performs the incremental detail request, merges client state, and schedules React. | The normal focused watcher has a fixed 200 ms trailing debounce; parsing scales with appended bytes, augmentation/transport with response bytes, and client merge with the loaded window. | Measure after precomputing fixture payloads, then reduce the floor with an immediate leading stat/read plus trailing validation. Deduplicate broad and focused change signals to avoid the second throttled refresh. |
| React commit to readable text | Commits the merged transcript and exposes the final assistant text in the DOM. | Projection has array-identity caching, but an append creates a new message array; grouping and commit work scale with the loaded window and rendered rows. | Keep this separate from the later glossary/path milestones and from browser first paint. Ratchet the final supported display rather than treating commit as completion. |

The append benchmark now generates every transcript body before setting the
browser marker. The marker is set immediately before bulk write submission, so
fixture generation and its CPU contention no longer masquerade as application
latency. A separate single-target append measurement would further distinguish
focused-session critical path from bulk-fanout stress; the current scale points
deliberately retain the latter.

### Investigated recovery seams

**Markdown/project-path augmentation.** The narrow cacheable seam is the
immutable HTML returned by `renderMarkdownToHtml` in
`packages/server/src/augments/markdown-augments.ts`, with `augmentTextBlocks`
as its caller. Caching `augmentFinalizedMessage` wholesale would be wrong: that
operation mutates messages and combines Edit/Write/Read/ExitPlan transforms with
separate filesystem and failure contracts; media materialization also occurs
outside it. The existing `SourceVersionedSingleFlight` primitive already owns
same-version joins, stale-completion fencing, failure retry, invalidation,
bounded LRU retention, and statistics.

A retained HTML key needs a collision-safe Markdown identity, render-scope
options, project identity/path, and any local-file-base or inline-image options.
Its source version needs a public monotonic project-path membership revision.
`ProjectPathIndex` does not currently expose one, and safe-Markdown fallback may
use unversioned `statSync` results; those fallback results may be joined in
flight but must not be retained. Observe the revision before work and verify it
again before admission so a watcher event during rendering cannot publish stale
HTML. Bound retention by output bytes because HTML can exceed Markdown source
size.

**Relay JSON transport.** The public relay wire can preserve its existing
parsed `RelayResponse` semantics while avoiding body decode/parse/re-stringify:
construct an internal pre-encoded JSON envelope around the already-valid Hono
JSON bytes. This remains an implementation capability of the send path, not a
new public relay message type. Plain text/binary, encrypted/compressed, and
transport-chunked frames must retain their current ordering: application JSON
encoding, then compression/encryption, then chunking. Pre-auth requests must
also keep the frame mode captured at admission.

This optimization cannot remove full-response buffering: one relay response and
one authenticated encrypted envelope remain protocol units, with the existing
64 MiB reassembly boundary. Malformed or empty JSON also needs an explicit
compatibility decision because raw splicing malformed bytes would invalidate the
whole relay frame, whereas current code yields `body: null`. Start with trusted
internal JSON producers or validate before splicing, expose fast-path hit/bytes-
saved/fallback counters, and benchmark plaintext and encrypted paths separately.

## Follow-up inventory

This is the single handoff inventory for every possible fix or investigation
surfaced by the survey. Check this list before declaring the survey follow-up
exhausted.

| ID | item | current evidence | disposition / recovery target |
|---|---|---|---|
| P01 | Correct append-marker semantics | The marker originally preceded synchronous fixture generation and bulk-write preparation, inflating the dominant append phase. | Fixed in the current harness by precomputing every body before marking; complete the stable historical rerun and commit the correction. |
| P02 | Separate focused latency from bulk-fanout stress | Current scale points append every fixture session while several pages are open, so host contention is intentionally part of the result. | Add a single-target append leg if diagnosis needs the selected-session critical path independently of fleet stress. |
| P03 | Remove the focused watcher’s fixed 200 ms floor | The normal `fs.watch` path uses a 200 ms trailing debounce before stat/read; polling fallback is phase-dependent up to 1.5 s. | Try an immediate leading stat/read with trailing validation for burst or torn-write safety; preserve polling fallback and measure both event sources. |
| P04 | Preserve append-path event-source timing | Browser output begins at write submission and cannot currently distinguish `fs-watch` from poll, watcher event time, client receipt, request send, decode, reducer completion, and queued React state. | Carry a change version/source and timestamp marks through the focused subscription and browser profile. |
| P05 | Deduplicate broad and focused change signals | The global `file-change` and focused `session-watch-change` paths can report the same append. The first refresh is immediate, while the second can schedule a trailing refresh through the 500 ms throttle. | Suppress or version-deduplicate the redundant current-session signal without weakening global activity updates. |
| P06 | Coalesce finalized persisted augmentation | Markdown/project-path rendering dominates current server-owned detail time and runs independently for duplicate browser requests. | Cache/coalesce immutable HTML by content/render scope plus a project-index revision; retain exact invalidation when path context changes and leave media/other mutating augmentation outside this cache. |
| P07 | Avoid relay JSON decode/re-encode | The direct WebSocket relay accumulates Hono bytes, parses JSON, wraps the value, serializes/chunks it, then the browser parses it again. Cost rises sharply with augmented response bytes. | Preserve response bytes or use a typed internal handler; compare response size, serialization time, and memory before/after. |
| P08 | Preserve server phase headers over WebSocket | The relay response-header allowlist drops `Server-Timing`, so browser append profiles cannot attribute focused requests to server owner phases. | Forward the header (or equivalent structured timings) through the relay and add a browser-path contract test. |
| P09 | Bound global file-activity fanout and rescan work | Every activity subscriber receives every changed file and filters client-side. Missing-filename fallback performs a synchronous recursive rescan, and focused targets in one directory each own a watcher. | Filter on the server, share directory watches where appropriate, and replace synchronous fallback traversal with bounded asynchronous batches. |
| P10 | Strengthen transcript-cache rewrite invalidation | `packages/server/src/sessions/claude-transcript-cache.ts` can treat same-size or earlier in-place rewrites as unchanged when the final 1,024-byte boundary probe still matches, returning stale parsed entries. | Require strict growth for incremental parse and full-parse changed same-size files; consider inode/ctime or stronger fingerprints only if real writers replace files in place. |
| P11 | Recover from incremental refresh failures | `packages/client/src/hooks/useSessionMessages.ts` silently discards relay, parse, anchor, and server errors from the incremental `afterMessageId` path, leaving the open view stale. | Emit rate-limited diagnostics and perform one bounded full-tail reconciliation through the existing coordinator without creating an unbounded retry loop. |
| P12 | Watch full-normalization and anchor-search scaling | Claude append parsing is incremental, but normalization rebuilds over the full raw array after append and normalized anchor search is linear. Both are sub-millisecond in current fixtures. | Keep their owner phase ratcheted; investigate incremental normalization/indexed anchors only if a larger scale makes either significant. |
| P13 | Watch client projection cache misses on append | Catch-up merge creates a new message-array identity, so transcript projection recompiles the loaded window. Current preprocess time is under 1 ms. | Keep the child phase visible; optimize only if larger loaded windows make it significant. |
| P14 | Isolate external-summary batch contention | The global watcher starts an external-session summary batch roughly 500 ms after a burst, which can contend with still-running large focused requests. | Add phase/event telemetry before changing scheduling; preserve prompt activity freshness while avoiding duplicate work. |
| P15 | Measure useful cold readiness | Generic startup currently proves maintenance health plus `/api/projects`; cold dev-client final display includes Vite transforms. Neither is a production selected-session useful-ready contract. | Add a built-client cold-start driver and a server startup-to-selected-session-readable leg before making production startup claims. |
| P16 | Expand component memory attribution | Named source charges cover Claude transcripts and project paths, while browser `performance.memory` omits Blink/layout/native allocations. | Add cheap owner gauges only where they are bounded and contract-owned; keep residual labels honest rather than pretending an additive heap decomposition. |
| P17 | Preserve final-display semantics | Readable completion is DOM text, not first paint. Project-path completion is observed after the glossary wait, so its timestamp is sequential harness observation. | Keep these caveats in suite/topic docs; add independent marks only if separate glossary/path latency becomes a decision metric. |
| P18 | Complete immutable lost-ground and variance evidence | The initial report compressed several worsened server/browser scenarios and used mutable `HEAD` wording. | Finish the C0–C5, surveyed `2f5e403e`, and profiled `cab8184a` rerun; add a second surveyed browser batch, concrete deltas/recoveries, and broad unchanged-run ratchets. |
| P19 | Add specialized black-box fixtures | Owned provider streaming, public-share herds, and long-idle ownership/reap remain outside this family. | Add focused public-contract fixtures before citing this suite as performance evidence for those paths. |
| P20 | Detach context-specific augmentation from cached normalized messages | `normalizeSession` caches messages by stable raw-array identity, while private detail augmentation mutates text blocks with working-project `_html`; the public-share branch skips that rendering and may observe prior context-specific fields. Concurrent requests can also race on shared blocks. | Before retained HTML caching, make route augmentation a detached/copy-on-write response projection or store cached HTML outside normalized objects. Add private→public, public→private, concurrent, and two-working-project-context non-leakage tests. |
| P21 | Expose a fenced project-path membership revision | `ProjectPathIndex` has private watcher/attachment generations but no public source revision suitable for `SourceVersionedSingleFlight`; safe-Markdown fallback can use unversioned `statSync`. | Increment a public monotonic revision on named invalidation, uncertain watcher state, disposal/replacement, and membership-changing events. Fence cache admission against it; never retain fallback-stat answers without a version. |
| P22 | Decide malformed-JSON compatibility for raw relay envelopes | Current relay parsing maps invalid/empty JSON bodies to `body: null`; raw byte splicing would instead invalidate the complete relay frame. | Restrict the fast path to trusted internal JSON responses, validate before preserving bytes, or deliberately revise the producer contract with compatibility tests. |
| P23 | Keep relay buffering and frame limits explicit | Raw JSON preservation removes body parse/re-stringify but still buffers the Hono body and one authenticated envelope; chunking occurs only after application encoding/encryption and reassembly is capped at 64 MiB. | Treat zero-copy/streaming as a separate protocol project. Preserve text/binary, compression, encryption, chunk ordering, and the pre-auth frame-mode snapshot. |
| P24 | Measure augmentation and relay reuse directly | Totals can improve while cache misses, fallback traffic, or encrypted transport regress independently. | Add augmentation join/hit/retained-byte/stale-discard gauges plus relay raw-fast-path hits, bytes saved, and fallbacks; benchmark plaintext and encrypted paths separately. |

Primary fix and evidence sites:

- P01, P02, P15, P17, P18:
  `scripts/perf-suite/run.mjs` (`prepareAppendedTurns`, `appendTurns`,
  `waitForFinalDisplay`, and `measureRepetition`) plus
  `scripts/perf-suite/ratchets.json`.
- P03–P05, P09, P14:
  `packages/server/src/watcher/FocusedSessionWatchManager.ts`,
  `packages/server/src/watcher/FileWatcher.ts`,
  `packages/server/src/supervisor/ExternalSessionTracker.ts`,
  `packages/server/src/subscriptions.ts`,
  `packages/client/src/hooks/useSessionWatchStream.ts`, and
  `packages/client/src/hooks/useSession.ts`.
- P06:
  `packages/server/src/sessions/persisted-augments.ts`,
  `packages/server/src/augments/finalized-message-augmenter.ts`,
  `packages/server/src/augments/markdown-augments.ts`, and
  `packages/server/src/lib/sourceVersionedSingleFlight.ts`.
- P07–P08: `packages/server/src/routes/ws-relay-handlers.ts` and
  `packages/shared/src/binary-framing.ts`.
- P10: `packages/server/src/sessions/claude-transcript-cache.ts`.
- P11: `packages/client/src/hooks/useSessionMessages.ts` and
  `packages/client/src/lib/sessionDetail/sessionDetailCoordinator.ts`.
- P12: `packages/server/src/sessions/normalization.ts`,
  `packages/server/src/sessions/claude-messages.ts`, and
  `packages/server/src/sessions/pagination.ts`.
- P13: `packages/client/src/lib/sessionDetail/renderItems.ts` and
  `packages/client/src/lib/transcriptProjection/cache.ts`.
- P16: `packages/server/src/maintenance/server.ts`,
  `packages/server/src/sessions/claude-transcript-cache.ts`, and browser
  `performance.memory` collection in `scripts/perf-suite/run.mjs`.
- P19: `packages/server/src/subscriptions.ts`, public-share routes/services,
  and supervisor idle-reap tests, with a new black-box fixture before code
  optimization.
- P20: `packages/server/src/sessions/normalization.ts` and the augmentation
  branches in `packages/server/src/routes/sessions.ts`.
- P21: `packages/server/src/projects/projectPathIndex.ts`,
  `packages/server/src/augments/safe-markdown.ts`, and
  `packages/server/src/lib/sourceVersionedSingleFlight.ts`.
- P22–P24: `packages/server/src/routes/ws-relay-handlers.ts`,
  `packages/shared/src/relay.ts`, `packages/shared/src/binary-framing.ts`, and
  the relay framing/concurrency/secure-transport tests.

Validation anchors for the two investigated recovery seams:

- augmentation: `packages/server/test/augments/markdown-augments.test.ts`,
  `packages/server/test/augments/project-path-links.test.ts`,
  `packages/server/test/routes/sessions-metadata.test.ts`,
  `packages/server/test/incremental-session.test.ts`, and
  `packages/server/test/render-parity.test.ts`;
- relay: `packages/server/test/routes/ws-send-framing.test.ts`,
  `packages/server/test/routes/ws-relay-request-concurrency.test.ts`,
  `packages/server/test/e2e/ws-transport.e2e.test.ts`,
  `packages/server/test/e2e/ws-secure.e2e.test.ts`, and
  `packages/server/test/routes/ws-relay-local-file.test.ts`.

## Remaining specialized black-box coverage

The revised browser driver now waits for exact automatic bare project-path
anchors and negative controls against the pinned real-project fixture. This
feature has no saved enable switch: C0/C1 lack generalized bare-prose linking,
while C2 `61cb5f35` and descendants support it automatically when project
context is available. Glossary hints remain the separate default-off feature
that the harness explicitly enables in browser storage.

The shared family also cannot yet synthesize an owned provider process, create
a public-share record without operator relay settings, or hold owned sessions
through long idle-reap deadlines. It therefore must not be cited as direct
performance evidence for raw-provider-versus-enriched replacement ordering,
public-share serialization herds, or long-idle owned-session retention. Add
focused black-box fixtures before those paths receive ratchets; the existing
correctness and relay tests remain the current evidence.

Found and reconciled 2026-08-08 while running the independent
performance-regression survey.
