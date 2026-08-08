# Stream / Persisted Render Convergence

> Provider persistence is the durable transcript authority. The live stream
> may add useful ephemeral detail near the active tail, but live items that
> have persisted counterparts should converge with minimal structural change.

Topic: stream-persisted-render-parity

See also: [transcript-display-objects](transcript-display-objects.md) (the
opposite direction — display-only objects that are *not* provider turns),
[provider-authoring](provider-authoring.md) (a new provider must satisfy this
contract), [codex-sessions](codex-sessions.md),
[stream-durable-id-dedup](stream-durable-id-dedup.md) (the id/dedup half of
"same session, two sources"), and
[codex-code-mode-render-convergence](codex-code-mode-render-convergence.md)
(the Codex 5.6 normalization/rendering plan). Dev-doc:
`docs/project/multi-provider-integration.md`.

## Hidden-activity incident (2026-08-07)

A Claude Gateway turn appeared to stop updating for more than ten minutes after
steering, deferred queue promotion, and a nearby compaction. The local rotating
activity phrase continued, but the latest thinking and compact activity rows did
not advance. Restarting YA revealed the missing assistant, tool-use, and
tool-result activity.

The provider transcript established that this was a projection failure rather
than missing provider work:

- deferred patient messages promoted at `23:17:12Z`;
- a Claude `compact_boundary` persisted at `23:20:11Z`;
- dozens of assistant, tool-use, and tool-result records persisted through
  `23:34:20Z`;
- the process reported idle immediately afterward; and
- a later cold session read after restart returned the records the live view had
  omitted.

No augmentation or subscription error was logged during the interval. Client
diagnostic collection was not enabled for a usable incident trace, so the
server ordering fault is reproduced directly rather than inferred from browser
logs.

### Dispatch-order audit

The path is FIFO until optional asynchronous presentation work enters it:

1. `provider-runtime-host.ts` receives sequenced worker events and removes them
   from `eventQueue` with `shift()`.
2. `Process.emit` iterates its listener `Set` in insertion order, but deliberately
   does not await listener promises.
3. `createSessionSubscription` used to await Markdown, diff, highlighting, and
   other augmentation before emitting each finalized message. Every provider
   message therefore started an independent continuation. Completion order was
   determined by augmentation duration: later messages could overtake an earlier
   one, and one unresolved augmenter could hide its raw provider record.
4. `handleSessionSubscribe` assigns event IDs synchronously in actual send order;
   WebSocket frames preserve that order. `RelayProtocol`, `ManagedStream`, and
   `useSession` forward received events synchronously. The client cannot recover
   provider order from event IDs after the server has already sent a different
   order.
5. `mergeStreamMessage` can replace an existing SDK message by stable `uuid` or
   `id`, which makes raw-first delivery followed by same-id enrichment possible
   without changing row order.

This is not deliberate LIFO dispatch. Listener invocation is ordered; the old
observable order was nondeterministic async completion.

### Ruled-out owning causes

- The rotating activity phrase is client-local animation while
  `isProcessing=true`; it does not prove fresh provider or server events.
- Incremental Claude transcript parsing reuses one entries array, but the
  normalization cache checks both array length and final-entry identity, so
  append-only growth invalidates the cached projection.
- A speculative client refetch on every owned-session update could recover from
  several server faults, but it would add polling and duplicate durable reads
  without fixing the ordering boundary. That experiment was removed.
- Compaction, steering, deferred input, and warm transcript caching remain
  important live-test scenarios, but none owns message dispatch. They increase
  the chance and visibility of a slow-enrichment race.
- Liveness/status events are separate `Process` events. They explain how a view
  could keep showing activity decoration while transcript rows were blocked,
  but changing liveness caching would not release those rows.

## Implemented repair boundary

`packages/server/src/subscriptions.ts` establishes provider order before any
optional await:

- perform bounded synchronous preparation, including task-list correlation;
- emit every raw provider message immediately;
- clear streaming bookkeeping synchronously on stream completion;
- retain one FIFO lane only for mutable streaming-coordinator state;
- run finalized-message work independently with at most four active and 128
  queued items;
- coalesce queued same-id snapshots and publish only the latest generation;
- publish one atomic same-id enriched message, followed by the equivalent
  compatibility `markdown-augment` event;
- keep an unidentified message as one raw representation rather than generating
  two unrelated client IDs; and
- emit turn completion without waiting for optional enrichment, allowing the
  client to become idle and fetch the durable transcript.

Queued state is cleared on completion and cleanup. Running work receives a
cloned message and cannot publish after teardown or after a newer generation
supersedes it. Cleanup also releases viewer presence, live-delta demand, and the
project path-index claim. `Process.emit` deliberately does not await subscription
promises, so optional presentation work cannot backpressure provider ingestion.

`finalized-message-augmenter.ts` is the single per-message implementation for
Markdown, Edit, Write, Read, and ExitPlanMode presentation. Both the persisted
batch facade and live finalizer call it. Every assistant text block receives its
own `_html`; the compatibility event carries the first block only for older
clients, while current compilation prefers each block's inline HTML.

Late-join replay and the active-process/no-session-file REST fallback augment
detached copies of `Process` history. Provider-owned replay state is never
mutated. File-backed reads, active-process reads, and live finalization use the
same private-session augmentation boundary and project-file-link context.

Final Markdown ownership now lives in `SessionDetailState.markdownAugments`.
WebSocket events dispatch through the session-detail reducer, and warm reveal
and route snapshots retain the map. Duplicate updates remain no-ops, live IDs
can migrate to durable IDs, and active-window pruning removes stale entries.
Token-rate pending/block Markdown remains on the ref-backed streaming path.

Focused regressions in `packages/server/test/subscriptions.test.ts` prove raw
order while the first finalizer is blocked, independent later finalization,
latest-generation suppression, atomic enriched-message/event order, immediate
completion, replay cloning, cleanup, and no post-teardown publication.
`packages/server/test/render-parity.test.ts` covers multiple text blocks as well
as provider render parity. Session-detail reducer, selector, snapshot, and hook
tests cover final-Markdown ownership and restoration. The active-process route
regression proves canonical multi-block rendering without mutating process
history.

## The convergence contract

A session reaches the UI two ways:

- **Stream** — live provider events during a running turn (e.g. Codex
  `command_execution`, Claude SDK messages).
- **Persisted** — the same session re-read from disk later (Codex rollout
  JSONL, Claude JSONL DAG, OpenCode SQLite, …).

Both feed the same `compileTranscriptProjection` → render-item pipeline, but
equality is graded by whether the live item has a durable counterpart:

- **Durable-corresponding items — strong convergence.** Tool calls, tool
  results, assistant messages, and other records present in both paths should
  preserve semantic identity, ordering, grouping, parameters, and roughly the
  same layout. These are the highest-jank failures because a refresh can
  reorder several rows or replace one group with another.
- **Live delivery precedes optional enrichment.** Forward raw provider messages
  in provider order before asynchronous markdown, diff, highlighting, or other
  augmentation. Enrichment work is serialized when it shares mutable stream
  state and may follow as a same-id update; it must not delay or reorder the
  underlying activity. A failed or stalled augmenter degrades presentation, not
  transcript visibility.
- **Live enrichment — update in place.** Streaming output, elapsed time,
  progress, provisional status, or a more timely label may enrich a durable
  item while it is active. Prefer changes that do not alter row count, group
  boundaries, navigation anchors, or stable identity. Once the persisted
  counterpart is available, the item settles to the durable representation.
- **Truly ephemeral live items — allowed.** Thinking deltas, transient status,
  progress, and other provider events that are never persisted may appear and
  disappear near the live tail when they are useful. They are not evidence
  that YA should invent a parallel persisted transcript.

The practical stability boundary is therefore `settled transcript | recently
completed turn | active live tail`: the left side should be very stable; some
bounded movement at the right edge is expected. Provider persistence remains
the sole durable source of truth. In particular, Codex rollout files are the
canonical durable transcript; YA must not create a second durable message or
metadata record to preserve live-only shape.

## Draft-first augmentation decision

The implementation has two publication phases per identified finalized item:

1. bounded, order-sensitive synchronous preparation followed by immediate raw
   insertion in provider order; and
2. one atomic same-id replacement after all finalized Markdown, diff, preview,
   highlighting, glossary, and project-link work for that item settles.

There is no subscription-wide finalization tail and no separate
"geometry-neutral" paint. Markdown block structure and the presence,
truncation, or expansion of diffs, plans, task panels, and file previews set
geometry. Syntax-color spans, glossary spans, and file-link anchors are intended
to preserve visible text and line structure, but splitting them out would add a
third render and a new ordering surface. They therefore remain bundled until a
future change demonstrates a material raw-to-final latency reduction and proves
at desktop and phone widths that row height and scroll anchors do not move.
Project-file index hydration remains bundled for the same reason.

Representative output is pinned by augment and parity tests for Markdown
structure, syntax-highlighted code, multi-block assistant output, Edit/Read/
Write/plan previews, project-file links, and glossary annotations. Subscription
tests use controlled promises rather than sleeps: while one item is blocked,
raw drafts remain ordered and visible, later item finalization can publish, and
completion remains immediate. The deterministic transcript Playwright specimen
continues to enforce stable top-level render identity, no horizontal overflow,
and final layout at desktop and phone widths.

For incident reproduction, the high-value operator scenario remains an isolated
YA profile with Claude Gateway bursts, intentionally slow enrichment,
compaction-adjacent output, steering plus deferred input, reconnect, and durable
catch-up. It exercises deployment/provider timing beyond the deterministic
contract tests; it is not a reason to restore serialized enrichment or a
YA-owned shadow transcript.

For durable-corresponding items, "converge" is stronger than "eventually show
similar text." Structured fields are latent UI, and item count/order/grouping
are layout. A fact used to restructure a live tool call should either be
recoverable from persistence or be demonstrably safe as bounded optimistic
tail presentation.

## Enforcement

`packages/server/test/render-parity.test.ts` +
`test/utils/render-parity-harness.ts`. `assertRenderParity(name, persisted,
stream)` normalizes both render-item arrays and reports the first structural
difference by path (e.g. `$[3].toolResult.structured.exitCode`). The
`runPersistedPipeline` / `runStreamPipeline` pair build the two sides from the
same logical session; keep the two fixtures representing the *same* commands so
a drift means a real asymmetry, not two different sessions. The comparison
retains render-item IDs, source-message IDs and parent/tool relationships,
block HTML, media, and structured fields. Provider-specific identity aliases
must be declared at the assertion; the Codex fixture declares only its known
positional durable IDs for the user prompt and final assistant text.

The harness intentionally enforces strict equality for facts and items that
the fixture declares paired. That is a conservative test for the
durable-corresponding category, not a ban on separate live-only event types.
When an intentional live-only item is added, test its tail lifecycle separately
and do not weaken paired-tool parity to accommodate it.

## Worked instance: Codex Bash `exitCode` (2026-07-01)

Adding `exitCode` to Codex structured Bash results surfaced it on the **stream**
path (`command_execution` events carry `exit_code`) but not on **reload**. Two
gaps, both fixed:

1. **The persisted parser dropped a recoverable code.**
   `normalizeCodexToolOutputWithContext`'s Bash branch computed `exitCode` but
   did not pass it to `createBashToolResult` — unlike the command-execution
   path. Fixed by threading `exitCode` through (`codex/normalization.ts`).
2. **The reload fixture was unrealistic.** Real Codex persists the exit code in
   a structured `exec_command_end` event (which funnels through the *same*
   `normalizeCodexCommandExecutionOutput` as the live stream); the parity
   fixture used only a plain `function_call_output` string, which carries no
   exit code for a zero exit. Fixed by adding the `exec_command_end` event the
   real reload path relies on (the later `function_call_output` is deduped).

The durable lesson: **make durable-corresponding items funnel through the same
normalizer using facts recoverable on both sides.** For these Codex commands
that means the structured `exec_command_end`, not a best-effort parse of an
output string. Live-only facts may still render at the active tail, but they
must not silently restructure the settled tool call after reload.

## Provider-normalizes direction (deferred)

`topics/bash-result-contract.md` proposes a provider-base Bash-result
normalizer so every provider emits the same structured facts (output,
empty-output, exit code, timing, interruption, background state). That is the
principled long-term home for this contract — a single normalizer both paths
share, per provider. Phase-1 (a default provider-base normalizer matching
today's Codex heuristic) is **not yet implemented**; the exitCode fix above is
the point fix. Track that work under bash-result-contract, and require a
stream+persisted parity fixture whenever a provider gains a new structured
field.
