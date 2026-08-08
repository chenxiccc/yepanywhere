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

## Immutable lost-ground ledger

The comparable survey used harness
`79fbeeb2d245672a471986c18be26ab580e2dc64`, fixture and surveyed source
`2f5e403e20fc5b96d5634a4b8f5a57704023d8da`, and profiled source
`cab8184a01d4ce737432966e8e4b4730e00720a5`. Historical rows report black-box
totals; only the profiled source has owner clocks. “Surveyed” below means the
immutable `2f5e403e` result, not a mutable checkout tip.

| scenario / metric | baseline → first worse | surveyed / profiled vs baseline | recovery and classification | countermetric / variance | ratchet |
|---|---|---|---|---|---|
| fleet server cold detail | C1 141 ms → C2 156 ms (+15 ms, +11%) | 177 / 169 ms (+26% / +20%) | C4–C5 do not recover C1: persistent | response volume +4.8%; augmentation is the current dominant owner | 300 ms total; owner and response limits |
| fleet server warm detail | C1 21.8 ms → C2 29.7 ms (+7.9 ms, +36%) | 29.1 / 29.3 ms (+34% / +34%) | C4 partially recovers C3 but not C1: persistent | C4 adds about 9.9 MiB retained heap versus C3 | 75 ms total; owner limits |
| fleet server appended detail | C1 32.3 ms → C2 51.4 ms (+19.1 ms, +59%) | 50.8 / 48.4 ms (+57% / +50%) | C4–C5 partially recover C3 but not C1: persistent | append response volume +5.1%; current owners are augmentation and transport | 100 ms total; owner and response limits |
| large server cold detail | C1 272 ms → C2 526 ms (+254 ms, +94%) | 312 / 317 ms (+15% / +17%) | C3 repairs most of C2; C1 floor remains lost: partial recovery | C4 cache worsens cold 5.2% versus C3 while retaining 31.8 MiB more heap | 500 ms total; owner and response limits |
| large server warm detail | C1 123 ms → C2 260 ms (+137 ms, +112%) | 164 / 146 ms (+33% / +19%) | C3 repairs most of C2; C4 gains 5.4% versus C3 but not C1: partial recovery / trade-off | retained heap is 41.2 MiB profiled versus 9.2 MiB at C3 | 300 ms total; owner limits |
| large server appended detail | C1 169 ms → C2 329 ms (+160 ms, +94%) | 203 / 211 ms (+20% / +24%) | C3 repairs most of C2; C4 is 2.0% slower than C3: partial recovery | retained heap rises sharply at C4 without an append gain | 400 ms total; owner limits |
| large browser cached warm final | C2 670 ms → C3 781 ms (+111 ms, +17%) | 773–798 / 780 ms (+15–19% / +17%) | no later recovery to C2: persistent | cache still improves profiled cache-off warm return by 13%; same-SHA range is 25 ms | 1,000 ms final; warm phase limits |
| large browser append final | C3 751 ms → C4 696 ms (−56 ms, −7%) | 682–693 / 696 ms | the C4 gain survives; the proposed “gain lost” finding is rejected | cache on/off differ by at most about 11 ms in the repeated surveyed batches | 1,000 ms final; append phase limits |
| fleet browser append final | C1 1,218–1,230 ms → C2 394–401 ms | 382–396 / 391–393 ms | concerning pre-arc latency repaired at C2 and retained | both cache modes tell the same trajectory | 800 ms final |
| fleet DOM nodes | C0 873 → C1 921 → C2 939 (+7.6% from C0) | 939 / 939 | persistent capability/rendering change, not unbounded growth | message rows remain 16; response volume rises about 4.8% at C2 | 960 nodes / 16 rows |
| large browser JS heap | surveyed batch 1 → batch 2 | cache off 124–188 MiB; cache on 133–157 MiB | same-SHA variance, not a revision claim | YA cache accounting is stable at 0 or 3 entries / about 14.34 MB | broad heap residual plus exact cache invariants |

The broad total limits are stability tripwires, not declarations that the
persistent losses are acceptable. Recovery work should compare against the
historical floor in this ledger and use the owner-phase ratchets to prevent an
improvement in one component from hiding growth in another.

## Cold project enumeration exceeds one second before and after the arc

At both pre-sprint `adaa804b` and surveyed `2f5e403e`, the first concurrent
per-project session-list pass at `fleet-small` takes about 1.44 s p95. An
immediate replay takes only 4–5 ms p95. Forced-GC pre-sprint memory is 92.4 MiB
settled heap with 8.6 MiB retained over startup, not the much larger uncollected
figures from the exploratory runs.

The delay is first-index construction over previously unseen transcript files,
not sustained route latency and not a regression introduced by this arc. It
still crosses the one-second user-facing threshold when a data directory has no
usable session indexes. Current ratchets must distinguish this cold-index leg
from the ordinary warm list path rather than accepting 1.3 s for both.

## Browser live append crossed one second until the measured perf arc

With four real browser clients at `fleet-small`, file-observed appended final
display took 1.18–1.23 s p95 at C0 `adaa804b` and C1 `3c0f70df`. That fell to
394–401 ms at C2 `61cb5f35` and remained 382–421 ms through C3, C4, C5,
surveyed `2f5e403e`, and profiled `cab8184a`. This concerning pre-arc behavior
was repaired during the measured performance sequence and was not reintroduced
by harsh-review work.

A fresh dev-client boot plus first session render remains about 4.2–5.1 s at
every checkpoint. This includes Vite/module startup and is not a production
bundle or session-route-only number; warm in-app final display is 456–766 ms
across the historical checkpoints. Keep the cold browser observation separate
from production user-facing ratchets until a built-client driver isolates
application boot from development transforms.

## Parsed-server cache exchanges retained heap for repeat-read latency

At the `large-session-cache` scale point (2 projects × 4 sessions × 16 final
turns, 3 concurrent clients, 64 KiB per message), commit `6024cff1` changes the
forced-GC server results relative to C3 as follows:

- retained heap: 9.2 MiB before to 41.1 MiB after;
- settled heap: 95.2 MiB before to 127.0 MiB after;
- cold readable-tail p95: 308 ms before to 324 ms after;
- warm readable-tail p95: 157 ms before to 149 ms after; and
- appended readable-tail p95: 204 ms before to 208 ms after.

The 31.8 MiB retained-heap increase buys about 5.4% faster warm detail while
cold worsens 5.2% and append worsens 2.0%. The cache is an intentional
memory/repeat-read trade-off, but the complete working set provides materially
less benefit than the earlier one-session fixture suggested. Retained source
bytes, files, total heap, residual heap, and the three detail legs now have
independent ratchets.

## Browser transcript caching is also an explicit memory/latency trade-off

At surveyed `2f5e403e` with `large-session-cache`, two independent browser
batches measured 24 MiB caching versus zero at 773–798 ms versus 882–903 ms
warm final-display p95. The cache retains the complete three-session ring:
three entries totaling about 14.34 MB, rather than one transcript. Appended
final-display ranges overlap at 682–693 ms cached and 675–685 ms uncached.

Maximum observed browser JS heap varied from 124 to 188 MiB uncached and 133 to
157 MiB cached, so it does not support a directional memory claim. Use YA's
stable cache entry/byte accounting as the cache-specific ratchet and keep the
noisy JS heap plus heap-minus-transcript approximation as broad independent
limits.

## Current phase ownership exposes recovery targets

The profiled execution revision is immutable `cab8184a01d4ce737432966e8e4b4730e00720a5`.
Its additive server and browser phase trees identify the following important
owners; historical checkpoints retain comparable totals but cannot provide
retrospective owner clocks.

| phase | service and boundary | reuse / size shape | concern and recovery target |
|---|---|---|---|
| Session-detail augmentation | Converts sliced persisted messages into client-ready Markdown, media, recap, and project-path output. It consumes normalized messages plus project context and returns augmented response messages. Glossary highlighting is client-side and is not an input to this server phase. | At the profiled revision, the project-path index was shared but Markdown/path traversal still ran for each returned text block and concurrent request. Cost grew with returned text bytes and block complexity. | Recovered by caching/coalescing only immutable Markdown results by exact content/scope and a fenced project-index revision; the mutating finalized-message operation stays outside the cache. |
| Framework / serialization / loopback | Carries the Hono response through the direct WebSocket relay and back to the browser-facing request abstraction. | At the profiled revision, the relay accumulated the body, decoded and parsed JSON, wrapped it, serialized it again, chunked large frames, then the browser reassembled and parsed it. Cost grew with augmented response bytes. | Partially recovered by preserving validated response bytes and forwarding `Server-Timing`; the validation parse and full-response buffering remain. |
| Append trigger to MessageList preprocess | Detects an external JSONL append, publishes a focused session-watch event, performs the incremental detail request, merges client state, and schedules React. | The focused watcher now checks on the leading edge and retains the 200 ms delayed validation; parsing scales with appended bytes, augmentation/transport with response bytes, and client merge with the loaded window. | Recovered 2026-08-08: exact change facts deduplicate only cross-route duplicates, and browser-clock marks expose receipt through preprocess. Fleet p95 is 59.3 ms; the earlier large sample is 175.9–181.6 ms. |
| React commit to readable text | Commits the merged transcript and exposes the final assistant text in the DOM. | Projection has array-identity caching, but an append creates a new message array; grouping and commit work scale with the loaded window and rendered rows. | Keep this separate from the later glossary/path milestones and from browser first paint. Ratchet the final supported display rather than treating commit as completion. |

The append benchmark now generates every transcript body before setting the
browser marker. The marker is set immediately before bulk write submission, so
fixture generation and its CPU contention no longer masquerade as application
latency. A separate single-target append measurement would further distinguish
focused-session critical path from bulk-fanout stress; the current scale points
deliberately retain the latter.

### Recovery seams and decisions

**Markdown/project-path augmentation.** The implemented cacheable seam is the
immutable HTML returned by `renderMarkdownToHtml` in
`packages/server/src/augments/markdown-augments.ts`, with `augmentTextBlocks`
as its caller. Caching `augmentFinalizedMessage` wholesale would be wrong: that
operation mutates messages and combines Edit/Write/Read/ExitPlan transforms with
separate filesystem and failure contracts; media materialization also occurs
outside it. The `SourceVersionedSingleFlight` primitive owns
same-version joins, stale-completion fencing, failure retry, invalidation,
bounded LRU retention, and statistics.

A retained HTML key includes exact Markdown, render scope, project identity and
path, local-file base, and inline-image options. `ProjectPathIndex` now exposes
the process-monotonic membership revision used at admission. Safe-Markdown
fallback may still use unversioned `statSync` results; those results may join in
flight but are never retained. Admission rechecks the revision so a watcher
event during rendering cannot publish stale HTML. Retention is bounded by HTML
output bytes because output can exceed Markdown source size.

**Relay JSON transport.** The public relay wire preserves its existing parsed
`RelayResponse` semantics through an internal pre-encoded JSON send capability,
not a new public relay message type. The handler performs a fatal UTF-8 decode
and syntax parse, then inserts valid Hono JSON body bytes into the envelope
without serializing the parsed value again. Plain text/binary,
encrypted/compressed, and transport-chunked frames retain application JSON
encoding, then compression/encryption, then chunking. Pre-auth requests keep
the frame mode captured at admission.

This optimization does not remove full-response buffering: one relay response
and one authenticated encrypted envelope remain protocol units, with the
existing 64 MiB reassembly boundary. Malformed, empty, and invalid UTF-8 JSON
continues to yield `body: null`. Maintenance and suite diagnostics expose
eligible response, raw-hit, preserved-byte, fallback, and failure counters; the
focused benchmark compares plaintext and encrypted+compressed paths separately.

## Follow-up inventory

This is the single handoff inventory for every possible fix or investigation
surfaced by the survey. Check this list before declaring the survey follow-up
exhausted.

Recovery updates dated 2026-08-08 — Contributing-model: 5.6-Sol.

| ID | item | current evidence | disposition / recovery target |
|---|---|---|---|
| P01 | Correct append-marker semantics | The marker originally preceded synchronous fixture generation and bulk-write preparation, inflating the dominant append phase. | Fixed: every body is precomputed before marking, and the complete content-addressed historical rerun uses the corrected boundary. |
| P02 | Separate focused latency from bulk-fanout stress | Current scale points append every fixture session while several pages are open, so host contention is intentionally part of the result. | Add a single-target append leg if diagnosis needs the selected-session critical path independently of fleet stress. |
| P03 | Remove the focused watcher’s fixed 200 ms floor | The normal `fs.watch` path previously waited for a 200 ms trailing debounce before stat/read; polling fallback remains phase-dependent up to 1.5 s. | Fixed 2026-08-08: `fs.watch` requests an immediate leading check and retains the delayed validation; overlapping checks preserve one pending request. Fleet append-start to preprocess fell from 261.8–262.2 ms to 59.3 ms p95; the earlier large sample fell from 396–397 ms to 175.9–181.6 ms. |
| P04 | Preserve append-path event-source timing | The old browser profile could not distinguish watcher source/observation, client receipt, request launch, data readiness, state queueing, and React preprocessing. | Fixed 2026-08-08: focused events carry source, process-monotonic version, observation/emission timestamps, and exact file facts. Browser-clock marks split receipt→request→data→state→preprocess; server wall-clock facts are retained without unsafe cross-clock subtraction. |
| P05 | Deduplicate broad and focused change signals | The global `file-change` and focused `session-watch-change` paths can report the same append. The first refresh is immediate, while the second could schedule a trailing refresh through the 500 ms throttle. | Fixed 2026-08-08: direct global and focused events expose optional exact path/mtime/size facts, and the client suppresses only cross-route equality within one second. Missing facts, same-route repeats, subsequent growth, and older-server events retain leading/trailing refresh behavior. |
| P06 | Coalesce finalized persisted augmentation | Markdown/project-path rendering dominated server-owned detail time and ran independently for duplicate browser requests. | Fixed 2026-08-08: exact content/render-scope keys now coalesce immutable HTML behind a 32 MiB source-versioned cache. Same-host fleet warm/appended augmentation fell from 14.7/27.1 ms to 1.3/6.1 ms; inline images and every unversioned fallback stay outside retention. |
| P07 | Avoid relay JSON decode/re-encode | The direct WebSocket relay accumulated Hono bytes, parsed JSON, wrapped the value, serialized/chunked it, then the browser parsed it again. Cost rose sharply with augmented response bytes. | Partially fixed 2026-08-08: valid UTF-8 JSON body bytes now enter the existing envelope unchanged, removing the second body serialization. A 4,143,404-byte, seven-sample comparison improved plaintext 7.96→3.67 ms (2.17x) and gzip+NaCl 21.49→16.05 ms (1.34x). One validation parse and full buffering remain; removing that parse requires a proven typed producer boundary. |
| P08 | Preserve server phase headers over WebSocket | The relay response-header allowlist dropped `Server-Timing`, so browser append profiles could not attribute focused requests to server owner phases. | Fixed 2026-08-08: `Server-Timing` is forwarded, and an actual Hono-to-relay response test proves the header and original JSON spelling arrive together. |
| P09 | Bound global file-activity fanout and rescan work | Every activity subscriber receives every changed file and filters client-side. Missing-filename fallback performs a synchronous recursive rescan, and focused targets in one directory each own a watcher. | Filter on the server, share directory watches where appropriate, and replace synchronous fallback traversal with bounded asynchronous batches. |
| P10 | Strengthen transcript-cache rewrite invalidation | The cache previously allowed an incremental refresh whenever size reached the parsed offset, so a changed same-size file or an inode replacement could retain stale array identity. | Fixed for provider rewrite contracts 2026-08-08: hits require device/inode/ctime/mtime/size equality; incremental parsing requires strict growth of the same inode plus the boundary probe. Same-size changes, shrinks, and replacements fully reparse. Arbitrary same-inode prefix mutation plus append remains outside the append-only writer contract and would require a stronger source revision or full hash. |
| P11 | Recover from incremental refresh failures | `packages/client/src/hooks/useSessionMessages.ts` silently discards relay, parse, anchor, and server errors from the incremental `afterMessageId` path, leaving the open view stale. | Emit rate-limited diagnostics and perform one bounded full-tail reconciliation through the existing coordinator without creating an unbounded retry loop. |
| P12 | Watch full-normalization and anchor-search scaling | Claude append parsing is incremental, but normalization rebuilds over the full raw array after append and normalized anchor search is linear. Both are sub-millisecond in current fixtures. | Keep their owner phase ratcheted; investigate incremental normalization/indexed anchors only if a larger scale makes either significant. |
| P13 | Watch client projection cache misses on append | Catch-up merge creates a new message-array identity, so transcript projection recompiles the loaded window. Current preprocess time is under 1 ms. | Keep the child phase visible; optimize only if larger loaded windows make it significant. |
| P14 | Isolate external-summary batch contention | The global watcher starts an external-session summary batch roughly 500 ms after a burst, which can contend with still-running large focused requests. | Add phase/event telemetry before changing scheduling; preserve prompt activity freshness while avoiding duplicate work. |
| P15 | Measure useful cold readiness | Generic startup currently proves maintenance health plus `/api/projects`; cold dev-client final display includes Vite transforms. Neither is a production selected-session useful-ready contract. | Add a built-client cold-start driver and a server startup-to-selected-session-readable leg before making production startup claims. |
| P16 | Expand component memory attribution | Named source charges covered Claude transcripts and project paths, while browser `performance.memory` omits Blink/layout/native allocations. | Partially fixed 2026-08-08: the bounded Markdown cache now reports retained bytes/entries and reuse counters, and the residual subtracts that charge. Browser-native allocation remains intentionally unattributed. |
| P17 | Preserve final-display semantics | Readable completion is DOM text, not first paint. Project-path completion is observed after the glossary wait, so its timestamp is sequential harness observation. | Keep these caveats in suite/topic docs; add independent marks only if separate glossary/path latency becomes a decision metric. |
| P18 | Complete immutable lost-ground and variance evidence | The initial report compressed several worsened server/browser scenarios and used mutable checkout-tip wording. | Complete: the ledger above records C0–C5, surveyed `2f5e403e`, profiled `cab8184a`, a second surveyed browser batch, concrete deltas/recoveries, and broad unchanged-run ratchets. |
| P19 | Add specialized black-box fixtures | Owned provider streaming, public-share herds, and long-idle ownership/reap remain outside this family. | Add focused public-contract fixtures before citing this suite as performance evidence for those paths. |
| P20 | Detach context-specific augmentation from cached normalized messages | `normalizeSession` caches messages by stable raw-array identity, while route augmentation previously mutated those shared blocks. | Fixed 2026-08-08: task snapshots use copy-on-write over the full fold, then the selected response window is deep-detached before route-specific mutation. Public/private ordering and concurrent two-project-context tests prove the source projection remains unchanged. |
| P21 | Expose a fenced project-path membership revision | `ProjectPathIndex` had private watcher/attachment generations but no public source revision; safe-Markdown fallback can use unversioned `statSync`. | Fixed 2026-08-08: a process-monotonic public revision advances on invalidation, uncertainty, membership change, disposal/replacement, and loss of a fact-owning watcher. Admission rechecks it; fallback answers may coalesce but never retain HTML. |
| P22 | Decide malformed-JSON compatibility for raw relay envelopes | Existing relay parsing maps invalid/empty JSON bodies to `body: null`; raw byte splicing would instead invalidate the complete relay frame. | Fixed 2026-08-08: a fatal UTF-8 decode and syntax parse admit the raw path; empty, malformed, and invalid UTF-8 bodies retain `body: null`, with fallback counters and a compatibility test. |
| P23 | Keep relay buffering and frame limits explicit | Raw JSON preservation removes body re-stringification but still buffers the Hono body and one authenticated envelope; chunking occurs only after application encoding/encryption and reassembly is capped at 64 MiB. | Fixed as an explicit contract 2026-08-08: zero-copy/streaming remains a separate protocol project. Text/binary, compression-before-encryption, sequence, chunk ordering, the 64 MiB boundary, and the pre-auth frame-mode snapshot are unchanged and covered by focused framing tests. |
| P24 | Measure augmentation and relay reuse directly | Totals can improve while cache misses, fallback traffic, or encrypted transport regress independently. | Fixed 2026-08-08: augmentation join/hit/work/stale/unretained/retained-byte gauges and relay eligible/hit/raw-byte/fallback/failure counters are in maintenance and suite output. The focused relay benchmark records its host-capacity window and compares plaintext and encrypted+compressed arms separately. |
| P25 | Make harness identity independent of unrelated shared-worktree changes | Whole-repository tip and dirty state changed as peers committed or edited unrelated files even though the harness/config/ratchets were unchanged, giving identical measurements different apparent identities. | Fixed and verified: all 32 comparable results report harness `79fbeeb2`, dirty false, and content SHA-256 `c2f050df…`. |
| P26 | Prevent stale results from masking crashed runs | The ad-hoc sweep reused output paths; one browser crashed before writing, but the wrapper saw an older nonempty result and mislabeled the crash as an expected ratchet failure. | Fixed in the survey wrapper by removing each generated output before invocation; the complete rerun produced every expected fresh result. Keep this precondition in future orchestration. |

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
- P07–P08: `packages/server/src/routes/ws-relay-handlers.ts`,
  `packages/shared/src/binary-framing.ts`, and
  `packages/server/scripts/benchmark-relay-json.ts`.
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
- P25–P26: harness identity in `scripts/perf-suite/run.mjs` and any survey
  orchestration that reuses paths under `scripts/perf-suite/results/`.

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
