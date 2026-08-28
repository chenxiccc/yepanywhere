# Summary Parser Coordination And Long Transcript Load

Status: draft tactical tracker from the 2026-07-04 investigation.

Topic: summary-parser-worker-isolation
Topic: session-detail-data-layer
Topic: session-liveness
Topic: codex-session-index-memory

## Goal

Fix the server-side causes of repeated large Codex transcript parsing, summary
worker restart churn, and unbounded session-detail loads. The target outcome is
not just "make the crash disappear"; it is a system where large live sessions
are parsed once per needed file version, callers share cached or in-flight
work, and unbounded detail requests are visible and intentionally gated.

This tracker covers the tactical work that sits between:

- `docs/tactical/039-summary-parser-worker-isolation.md`
- `docs/tactical/055-session-catchup-unbounded-fetch.md`
- `topics/session-detail-data-layer.md`
- `topics/workstreams.md`

## Incident Evidence

Primary session:

- YA session id: `019f28d9-2dff-7dd2-8326-4b0e6093aed4`
- Title: `textures dressed hewn`
- Provider: Codex
- Project: `/Users/kgraehl/code/mclone`
- Incident window: `2026-07-04 19:43-19:50 CEST`
- Local evidence source: server logs inspected on `2026-07-04`

Specific server events reported for the screenshot session:

- `2026-07-04 19:45:02 CEST`: compact-tail session load returned `1082`
  messages, server time `515ms`.
- `2026-07-04 19:45:05 CEST`: unbounded session-detail request returned
  `6631` messages, `tailCompactions: null`, server time `2032ms`, with
  `1954ms` spent in augmentation.
- The Codex JSONL was about `76 MB`.
- Summary parser workers were stopping and restarting around the same window.
- `2026-07-04 19:47:21 CEST`: relay connection closed.
- No July 4 client-log file was found, so there is no phone-side telemetry for
  JS heap, DOM row count, long tasks, or reconnect-loop behavior.

Session-detail measurements observed in server logs:

| Time, CEST | tailCompactions | returned | normalized | total | augment |
| --- | ---: | ---: | ---: | ---: | ---: |
| `19:43:53` | `2` | `1080` | `6629` | `529.5ms` | `446.2ms` |
| `19:45:02` | `2` | `1082` | `6631` | `515.6ms` | `440.8ms` |
| `19:45:05` | `null` | `6631` | `6631` | `2032.1ms` | `1954.5ms` |
| `19:46:47` | `2` | `1082` | `6631` | `501.5ms` | `434.1ms` |
| `19:49:25` | `2` | `1082` | `6631` | `513.8ms` | `448.6ms` |

Before a `2026-07-04 20:35 CEST` cutoff, chosen to avoid pollution from this
investigation, this same session had:

- `93` slow `session_detail_slow` logs.
- About `675.7ms` total detail `readMs`.
- About `36546.5ms` total detail `augmentMs`.
- One clearly unbounded full-detail slow request before the cutoff.

The detail read time was low even for the full load. That points away from the
session-detail route repeatedly disk-reading the full `76 MB` JSONL during this
window. It is consistent with `CodexSessionReader` serving from its entry cache
or append path. Fast entry reads are not fully observable today unless
`LOG_ENTRY_READS` or a slow threshold fires.

Summary-worker aggregate before the same `20:35 CEST` cutoff:

- Worker mode was effectively required after `09:07:10 CEST`.
- `10,438` summary worker result events.
- `8,643` successful parses.
- `21` empty parses.
- `1,774` crash-status results.
- `835` `summary_parser_worker_stop reason=crash` events.
- `351` `idle_timeout` stops.
- `154` `recycle_byte_budget` stops.
- Crash-stop rate: about `72.8/hour`, or one every `49s`.
- Crash-status results were about `17%` of worker results.
- Crash-status split: `943` active request errors, `831` disconnected errors,
  and `0` exited-before-response errors.

For session `019f28d9-2dff-7dd2-8326-4b0e6093aed4` before the cutoff:

- `2,120` summary worker result events.
- `1,535` successful parses.
- `585` crash-status results.
- Crash-status split: `154` active request errors and `431` disconnected
  errors.
- Successful summary parses alone read `101,984,311,413` bytes from the same
  Codex JSONL, about `102 GB`.
- Max observed file size: `76,985,913` bytes.
- Max observed worker RSS: `546,521,088` bytes.
- Max observed worker heap: `371,079,152` bytes.
- First observed parse: `09:09:17 CEST`.
- Last observed parse before cutoff: `20:34:58 CEST`.

Minute-level examples for this same large file included repeated parses:

- Around `19:50 CEST`: `8` successful summary parses, about `608.7 MB` read.
- Around `20:00 CEST`: `8` successful summary parses, about `613.9 MB` read.

## What The Evidence Separates

Summary parsing and session-detail loading are coupled by load, but they are
not the same failure mode.

Summary parsing:

- The worker repeatedly parsed the same large live file.
- The worker "crash" label is misleading for many events.
- Log evidence shows paired `active request` and `worker disconnected before
  response` failures, with no observed `worker exited before response` failures
  in the measured aggregate.
- That points to parent-side coordination killing the child after overlapping
  parse calls, not primarily to the child process spontaneously crashing.

Session detail:

- The compact-tail route returned about `1080` messages for this session.
- One unbounded detail request returned all `6631` messages and spent almost
  two seconds in augmentation.
- The unbounded request is a separate server and client pressure event tracked
  in `docs/tactical/055-session-catchup-unbounded-fetch.md`.
- Detail read time was low in the observed logs, so the strongest detail-route
  evidence is expensive augmentation and payload size, not repeated disk reads.

Unknown on the client side:

- No July 4 client telemetry was found for the phone.
- We cannot authoritatively claim JS heap exhaustion, DOM row pressure, or a
  reconnect loop from client logs for this incident.
- The server-side unbounded payload and relay close timing are enough to justify
  server guardrails and better client diagnostics.

## Current Code Paths

Summary parsing:

- `packages/server/src/sessions/codex-reader.ts`
  - `CodexSessionReader.getSessionSummary()` sends summary parsing through a
    lazily reused `SummaryParserClient`.
  - The current Codex summary stream reads every JSONL line because it computes
    fields beyond title/head metadata: exact-ish message count, latest model,
    token-count context usage, and dedupe-aware counts.
  - Most routine callers likely only need a cheap head summary: `session_meta`,
    first `turn_context`, first non-system user message, and file stat mtime.
  - `CodexSessionReader.getSession()` reads entries and derives summary from
    entries for full session detail; it does not use the summary worker.
- `packages/server/src/sessions/summary-parser-worker-client.ts`
  - `SummaryParserClient.parseWithWorker()` throws if `activeRequestId` already
    exists.
  - The outer `parse()` catch path treats that non-setup error as a worker crash
    and calls `stopChild("crash")`.
  - The in-flight request then observes child disconnect and logs `worker
    disconnected before response`.

Summary callers that can bypass central coordination:

- `packages/server/src/app.ts`
  - The `ExternalSessionTracker` callback calls
    `findSessionSummaryAcrossProviders`.
  - The callback currently does not pass `sessionIndexService`, so it can bypass
    the index service queue/cache and reach provider readers directly.
- `packages/server/src/supervisor/ExternalSessionTracker.ts`
  - Uses `BatchProcessor` with concurrency `5`.
  - Enqueues summary reads on owned-session file changes.
  - Also parses external existing sessions.
  - The batch processor dedupes pending tasks by key, but not tasks already
    processing.
- `packages/server/src/routes/processes.ts`
  - Calls `reader.getSessionSummary()` directly for model/context usage before
    optional title-cache fallback.
- `packages/server/src/indexes/SessionIndexService.ts`
  - Has a summary parse queue and default summary concurrency `1`.
  - That coordination only protects callers routed through the service.

Session detail:

- `packages/server/src/routes/sessions.ts`
  - `loadProviderSession()` obtains a source reader and calls
    `source.reader.getSession(...)`.
  - Existing compact-tail behavior can keep returned message counts bounded.
  - A caller can still request unbounded detail, producing large payloads and
    expensive augmentation for long sessions.
- `packages/server/src/sessions/codex-reader.ts`
  - `readEntries()` has entry-cache and append-read behavior.
  - `codex_entry_read` logging is slow-threshold or `LOG_ENTRY_READS` gated, so
    fast large-file reads are not always counted.

## Working Theory

The worker restart storm is primarily a coordination bug:

1. Multiple server paths ask the same `CodexSessionReader` or equivalent direct
   summary path to parse the same large JSONL.
2. Some calls bypass `SessionIndexService`, so the existing summary queue does
   not serialize or coalesce them.
3. `SummaryParserClient` itself cannot tolerate overlapping calls. The second
   call sees `activeRequestId`, throws, and the generic error path kills the
   worker.
4. The original in-flight request then fails because the worker was killed.
5. The next summary request restarts a worker and re-reads the same large file.

The unbounded detail request is a separate tactical issue:

1. Compact-tail requests were bounded and around `500ms`.
2. The unbounded request returned all messages and spent almost two seconds in
   augmentation.
3. That payload could plausibly stress a mobile browser, but this incident does
   not have client logs proving heap, DOM, or reconnect behavior.
4. Server-side guardrails are still justified because the server can see the
   unbounded request and message count directly.

Follow-up endpoint measurements on `2026-07-04` strengthened SPC-007. For the
same large session, a clean compact-tail request returned about `7.16 MiB`
inflated JSON and took about `712ms` server-side. A clean no-query
full-history request returned about `39.35 MiB` inflated JSON, took about
`2815ms` server-side, and spent about `2738ms` in augmentation. With browser
gzip, the full response was still about `3.8 MB` on the wire, and the client
still had to inflate and parse the full `39 MiB` JSON body. The route uses
`c.json(...)` and the client uses `res.json()`, so this is not app-level
streaming. See
`docs/tactical/055-session-catchup-unbounded-fetch.md#endpoint-size-evidence`
for the detailed measurements.

## Progress Checklist

- [x] SPC-001: Make `SummaryParserClient` safe under concurrent `parse()` calls.
- [x] SPC-002A: Add cheap Codex head-summary reads for routine callers.
- [ ] SPC-002B: Coalesce same-file-version full summary parses.
- [ ] SPC-003: Route direct summary callers through the coordinated summary
  service path.
- [ ] SPC-004: Reduce `ExternalSessionTracker` parse pressure for large live
  files.
- [ ] SPC-005: Add low-noise observability for summary caller/source, queueing,
  coalescing, and active-request collisions.
- [ ] SPC-006: Add low-noise observability for large detail reads and
  unbounded-detail requests.
- [x] SPC-007: Land server guardrails for unbounded session-detail loads.
- [ ] SPC-008: Add regression tests for worker concurrency, cheap summaries,
  coalescing, and direct caller behavior.
- [ ] SPC-009: Reproduce or instrument client-side large-detail behavior.
- [ ] SPC-010: Re-check production-like logs after fixes for parse rate,
  crash-stop rate, and unbounded-detail frequency.

## Progress Notes

### `2026-07-04`: SPC-001 Worker Client Serialization

Implemented in `packages/server/src/sessions/summary-parser-worker-client.ts`.
Concurrent worker-mode `parse()` calls now enter a per-client serialized slot
that covers the full worker lifecycle, including IPC response handling, recycle
decisions, and crash cleanup. This prevents a second caller from entering
`parseWithWorker()` while another request is active, and it also closes the
launch-time gap where `activeRequestId` was checked before `ensureChild()`
finished.

Regression coverage was added in
`packages/server/test/sessions/summary-parser-worker.test.ts`. The test warms a
worker, fires two concurrent parse calls against the same client, and asserts
both complete on the same worker without a crash-status result.

This does not yet reduce full-file summary reads. It serializes duplicate work
instead of killing the worker. `SPC-002A` is now the next focus because most
routine callers should not need a full-file Codex summary scan at all.

### `2026-07-04`: SPC-007 Session Detail Full-History Guard

Implemented in `packages/server/src/routes/sessions.ts` and the client source
runtime. Session-detail requests now default to a compact tail whenever they
are uncursored and do not explicitly authorize `fullHistory=1`. `tailTurns`
and `tailFrom` may narrow that compact scope but do not replace it; the source
API can combine them with `fullHistory=1` when a named caller intentionally
needs a selector that reaches across older compactions. Client full-history
calls still exist, but the source API sends `fullHistory=1` and a caller
reason.

Regression coverage in `packages/server/test/api/sessions.test.ts` checks that
no-query detail reads are compact-tail bounded, turn selectors cannot broaden
that scope, `fullHistory=1` returns the whole synthetic transcript, and
explicit compact-tail bounds still win.

This does not remove full-history capability. It makes full history explicit
and auditable. Remaining follow-up is to decide whether exports/debug flows
should move to a separate endpoint and whether explicit full-history reads
need hard message or byte caps.

### Next Focus: SPC-002A Cheap Codex Summary Reads

Prioritize cheap Codex summaries before generic same-version coalescing.
Coalescing reduces simultaneous duplicate reads, but it still leaves routine
background callers doing full scans of large live JSONL files. The stronger fix
is to stop using the full summary parser when a caller only needs list/process
metadata.

Cheap Codex summary should be allowed to return from head metadata and file
stats:

- `session_meta` for id, created time, originator, CLI/source metadata, parent
  session id, and provider hints.
- First `turn_context` for early model and sandbox/approval metadata.
- First non-system user message for title/full title.
- File mtime for `updatedAt`.

Full Codex summary should remain available when a caller explicitly needs:

- Message count.
- Latest model after model switches.
- Token-count context usage.
- Dedupe-aware full-file accounting.

Acceptance for this next chunk:

- Add an explicit code path or option that distinguishes cheap Codex summary
  reads from full Codex summary scans.
- Route routine list/index/process/tracker callers to the cheap path where their
  required fields permit it.
- Preserve a full-summary path for callers that need exact message count,
  latest model, or context usage.
- Tests cover a large JSONL where cheap summary stops after the required head
  entries instead of reading the full file.

### `2026-07-04`: SPC-002A Initial Cheap Codex Summary Option

Implemented the first cheap-summary slice in
`packages/server/src/sessions/codex-reader.ts` and
`packages/server/src/sessions/types.ts`.

Codex summaries now accept an optional summary read mode. The default remains
full. `readMode: "head"` bypasses the summary worker and streams only until the
reader has stable head metadata: session metadata plus the first non-system
user title. It preserves the existing `SessionSummary` shape for compatibility,
uses a minimal compatible `messageCount` once content is found, and leaves
tail-derived optional fields such as `contextUsage` unset unless they appeared
before the head read completed.

Initial cheap callers:

- `CodexSessionReader.listSessions(...)`, for direct list reads without an
  index cache.
- `ExternalSessionTracker`, for owned/external file-change summary refreshes.

Callers intentionally left on full summaries for now:

- Supervisor auto-compact checks, because they may need fresh
  `contextUsage.inputTokens`.
- Session detail and metadata routes whose behavior still needs a caller-by-
  caller audit.
- Session index validation, which still owns exact cached summary state.

Regression coverage now verifies that a large Codex JSONL can return a head
summary after the first three lines while a full summary still sees trailing
model/context/message-count data. Tracker coverage verifies owned Codex
file-change refreshes request `readMode: "head"`.

### `2026-07-04`: SPC-002A Direct Cheap Caller Conversion

Converted additional direct summary lookups that only need identity, provider,
or title data to request `readMode: "head"`.

Converted paths:

- Recents enrichment.
- Project Queue existing-session target title enrichment when it bypasses the
  index cache.
- Session reader/provider resolution helpers used by agent-content loading,
  restart-source loading, working-project validation, resume provider fallback,
  fork provider/title fallback, retitle provider fallback, and clone
  title/provider fallback.
- Heartbeat candidate preflight before the subsequent full `getSession()` read.

Callers intentionally left on full summaries:

- Session metadata responses, because they return `messageCount`, `model`,
  `contextUsage`, origin/source fields, and other full-summary fields.
- Process enrichment, because it explicitly populates `model` and
  `contextUsage`.
- Session index validation and single-summary cache misses, because the cache
  schema stores exact summary fields and emits events containing exact
  `messageCount`, `model`, `contextUsage`, and `lastAgentText`.
- Recap preview summary overlay, because it may need `lastAgentText` for
  providers whose summary path supplies it.

Regression coverage now pins head-mode propagation for recents, Project Queue
direct title enrichment, working-project validation, retitle provider
fallback, and Codex clone title/provider fallback.

### `2026-08-28`: Append-Aware Codex Detail Normalization

Codex entry caching already parsed only a file's appended byte range, but it
discarded the normalization identity on every append. Incremental detail reads
therefore converted the complete retained entry array before slicing out a few
new messages. A live 330 MB session reproduced this at roughly 61,770
normalized messages and 3.5 seconds of server-event-loop normalization per
refresh.

The Codex normalized projection now extends the accepted append-only source
version. It carries positional ids, user-turn pairing, open/closed tool state,
and compaction evidence forward, while copy-on-write keeps any earlier response
projection immutable when a later event completes or orphans a tool. A new
compaction record or non-append source change still rebuilds because it can
change historical projection semantics.

Focused regressions cover a 1,001-message prefix plus one append, a user
response/event pair split across appends, and code-mode tool state completed by
a later append. A three-run synthetic comparison at 60,001 prior messages took
1.04-1.08 ms for the append path versus 45-77 ms for forced full conversion.
This closes the incremental-detail normalization defect; full-summary parser
pressure and reader-retention bounds remain separate work in this tracker.

## Fix Tracks

### SPC-001: Worker Client Serialization

Authoritative fix:

- `SummaryParserClient.parse()` must not treat concurrent use as a worker
  crash.
- If a parse is in flight, later calls should wait in a small internal queue or
  share a coalesced promise.
- An `activeRequestId` collision is backpressure or a caller bug, not evidence
  that the child process crashed.

Acceptance:

- Concurrent `parse()` calls against one `SummaryParserClient` do not emit
  `summary_parser_worker_stop reason=crash`.
- The original in-flight request is not killed by a second request.
- Tests cover two concurrent calls and a caller cancellation or timeout if the
  implementation supports either.

### SPC-002A: Cheap Codex Summary Reads

Authoritative fix:

- Split Codex summary reads into cheap head-summary and full-summary modes.
- The cheap mode should stop once it has enough stable head metadata for routine
  list/index/process/tracker surfaces.
- The full mode should continue to scan the whole file when exact message count,
  latest model, context usage, or dedupe accounting is required.
- Caller code should state which summary fidelity it needs instead of silently
  defaulting every summary read to full-file parsing.

Acceptance:

- Routine Codex summary callers can obtain title, created/updated timestamps,
  provider/model hints, origin metadata, approval/sandbox metadata, and parent
  session id without scanning the whole JSONL.
- A fixture with many trailing lines proves cheap mode stops early.
- Full mode still returns existing exact fields for callers that need them.
- The tactical log for future incidents can distinguish cheap summary reads from
  full summary scans.

### SPC-002B: Same-Version Full-Parse Coalescing

Authoritative fix:

- Full summary parsing should coalesce by file identity and version, for example
  `{ provider, sessionId, filePath, mtimeMs, size }`.
- Concurrent callers asking for the same version should share one full-parse
  result.
- A changed file version should get a new parse.

Acceptance:

- Two concurrent full-summary requests for the same file version produce one
  worker request.
- A follow-up request for the same unchanged version reuses cache or in-flight
  work.
- A request after append parses the new version once.

### SPC-003: Direct Summary Caller Routing

Authoritative fix:

- Route `ExternalSessionTracker` summary lookups through `SessionIndexService`
  or a central summary service that provides the same queue/coalescing.
- Route `/api/processes` model/context summary lookups through the coordinated
  path or use cached metadata where possible.
- Audit `providerResolutionDeps()` call sites that are summary-like and should
  receive `sessionIndexService`.

Acceptance:

- Direct summary callers no longer create uncoordinated worker requests.
- Existing behavior for title, model, context-window, and ownership discovery is
  preserved.
- Tests or targeted log assertions show the coordinated path being used.

### SPC-004: External Tracker Parse Pressure

Authoritative fix:

- Prevent the tracker from parsing a large live file repeatedly on noisy file
  changes.
- Prefer cheap summaries first, then shared cache/coalescing for full summaries.
- Add per-session debounce, quiet-period parsing for large files, or cheap
  metadata-only updates only where semantics stay intact.

Acceptance:

- A live large Codex JSONL append burst does not trigger several full summary
  parses per minute for the same version.
- Session-created and session-updated events still fire when needed.
- Model/context/title changes are not silently lost.

### SPC-005: Summary Observability

Authoritative fix:

- Keep existing worker result metrics, but add parent-side context that explains
  why a parse was requested.
- Include caller/source, provider, session id, file path, file size, file
  version, request id, queued/coalesced flags, wait time, and active-request
  collision state.
- Rate-limit routine success logs; always log collisions, crashes, and large
  file parses.

Acceptance:

- Given a future parse burst, logs can answer which route or background task
  requested the work.
- Logs can distinguish cache hit, in-flight coalesced wait, queued parse, worker
  parse, worker recycle, and actual child exit.

### SPC-006: Detail Read And Payload Observability

Authoritative fix:

- Make large detail requests visible even when disk read time is fast.
- Log enough to separate entry-cache hits, append reads, full file reads,
  returned message count, normalized message count, compaction mode, response
  byte estimate if available, and augmentation time.

Acceptance:

- A future `76 MB` transcript detail request can be classified without enabling
  chatty global `LOG_ENTRY_READS`.
- Unbounded detail requests are easy to count by route, session, provider, and
  client source.

### SPC-007: Unbounded Detail Guardrails

Authoritative fix:

- Finish the bounded catch-up work tracked in
  `docs/tactical/055-session-catchup-unbounded-fetch.md`.
- Require an explicit full-history intent for unbounded loads.
- Add server-side caps or warnings for very large full-detail requests.
- Keep compact-tail defaults for routine reconnect and screenshot-session
  flows.

Acceptance:

- Routine reconnect/catch-up does not accidentally fetch all `6631` messages.
- Full-history fetch remains possible through an explicit path.
- Server logs show when the explicit full-history path is used.

### SPC-008: Regression Tests

Required tests:

- `SummaryParserClient` concurrent parse calls.
- Cheap Codex summary reads that stop before trailing bulk transcript lines.
- Same-version parse coalescing.
- A direct caller that formerly bypassed coordination now uses the coordinated
  path.
- External tracker append burst on a large file does not schedule multiple
  redundant parses for the same file version.
- Session-detail route keeps compact-tail behavior unless full-history intent is
  explicit.

### SPC-009: Client-Side Verification

Required investigation:

- Reproduce a mobile or constrained-browser load of a long session.
- Capture heap, long-task, DOM row count, payload size, and reconnect state.
- Add temporary or durable diagnostics if existing client logs cannot capture
  these signals.

Acceptance:

- We can confirm or rule out client heap/DOM/reconnect failure for a large
  unbounded session-detail payload.
- Server fixes are not credited with solving a client issue that has not been
  measured.

### SPC-010: Post-Fix Log Audit

Required audit after fixes:

- Crash-stop rate for summary workers.
- Summary parse count and bytes read per large session per hour.
- Count of active-request collisions.
- Count of same-version coalesced waits.
- Count of unbounded detail requests.
- Detail augmentation time distribution for long sessions.

Success target:

- Active-request-induced worker kills go to zero.
- Same-version duplicate parses become rare and explainable.
- Large live sessions no longer show hundreds or thousands of full summary
  parses per day.
- Unbounded detail requests are explicit and countable.

## Open Questions

- Should the central summary coordination live inside `SessionIndexService`,
  inside `CodexSessionReader`, or in a provider-agnostic summary service?
- Which existing summary callers truly need exact `messageCount`, latest model,
  or context usage versus cheap head metadata?
- Should cheap Codex summaries surface unknown/approximate values explicitly, or
  omit fields that require a full scan?
- How long should same-version summary cache entries live for active sessions?
- What is the right large-file threshold for elevated logging: `5 MB`, `25 MB`,
  or derived from line count and parse cost?
- Should `ExternalSessionTracker` ever parse full summaries on every append for
  owned live sessions, or should it rely on cheaper append metadata until a
  quiet period?
- What server-side cap is acceptable for implicit session-detail responses
  before a user explicitly requests full history?

## Related Documents

- `docs/tactical/039-summary-parser-worker-isolation.md`
- `docs/tactical/055-session-catchup-unbounded-fetch.md`
- `topics/session-detail-data-layer.md`
- `topics/workstreams.md`
- `ARCHITECTURE.md`
