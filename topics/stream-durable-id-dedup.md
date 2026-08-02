# Stream-vs-durable message id dedup

> A provider's live-stream message ids can diverge from its durable
> (JSONL/DB) ids; when a backfill merges durable rows the client already
> has from the stream, messages render twice. Align ids deterministically
> where the provider allows it; fall back to a tight content+timestamp
> reconcile only where it cannot.

Topic: stream-durable-id-dedup

## The defect this prevents

The client holds a live array merged from two sources: the **stream**
(SSE/SDK, tagged `_source: "sdk"`) and **durable backfill** (`_source:
"jsonl"`, fetched via the REST message list). Dedup across the two is by
message id (`getMessageId` in `mergeMessages.ts`). If the same message
carries different ids in each source, the backfill copy is appended as a
duplicate.

In a live, owned session the durable rows are normally never merged
mid-turn (`handleFileChange` early-returns for owned sessions). An
**interrupt/steer** breaks that: abort -> idle -> new turn forces a stream
re-subscribe -> `connected` -> `fetchNewMessages()` -> merge of the
now-persisted post-interrupt rows. Hence the report "every message after I
interrupted to deliver a queued steer is double-displayed."

## Two-layer remedy

1. **Deterministic id alignment (preferred).** Make the streamed id equal
   the durable id, so dedup-by-id just works. No false-merge risk.
2. **Approx-dedup backstop.** `lib/linearMessageDedup.ts`
   (`reconcileLinearMessages`, `hasEquivalentJsonlMessage`) merges
   same-fingerprint (type+role+content) cross-source copies within a tight
   timestamp window. Gated by the provider capability
   `needsApproxMessageDedup` (codex, codex-oss, opencode). The window is
   **2s** (default and replay): a human does not send two identical turns
   that fast, so this minimizes the real risk — silently merging two
   genuinely-distinct identical messages (the old 90s replay window made
   that risk large). Deterministic alignment carries the load; this only
   catches the residue. The optional capability `approxDedupExcludesTools`
   (codex, codex-oss) removes tool_use/tool_result messages from this
   backstop entirely: native tool uuids are deterministic (`call_id`), while
   the code-mode `commandExecution` exception uses a separately scoped exact
   turn/semantics reconciliation. The broad backstop would otherwise be the
   one place a legitimately repeated identical tool call could be wrongly
   merged. The `excludeTools` option on both backstop functions implements
   this; OpenCode leaves it off.
   The one deliberately wider exception is the **first plain user turn**:
   new-session startup can show the optimistic user echo before Codex has
   finished thread setup and written the durable response-item user row. That
   first-turn pair gets a 30s startup window, but only when no earlier user
   turn exists; later repeated user turns, assistant text, and tool rows still
   use the 2s backstop. This is a merge-layer backstop, not the whole UI
   contract: the rendered transcript still must not show two adjacent copies of
   the same visible first user turn while startup is settling.

## Claude (busy-path sends)

Claude dedups by id for ordinary traffic — direct sends round-trip YA's queue
uuid into the durable user row — but **busy-path sends do not**. Verified on a
real session (af737e0c, 2026-07-03): a steer/queued delivery while the CLI is
in-turn is persisted as a `queue-operation`/`enqueue` row (**no uuid**, text +
enqueue timestamp) plus, at delivery, `queued_command` attachment rows and a
paired `queue-operation`/`remove`. YA's uuid/tempId appear nowhere, so the
optimistic echo (uuid = YA queue uuid, also replayed from the SSE buckets while
the process lives) and the reader's normalized row (positional id
`queue-operation-{index}-{ts}`, `deferredSource: "queue-operation"`) can never
merge by id. With `needsApproxMessageDedup` deliberately false for Claude,
every durable merge while the echo was live double-rendered the send — the
"duplicate sent messages while Claude is busy" report. Deterministic alignment
is impossible here: the CLI drops the supplied uuid on its queue path.

- **Scoped pairing (landed).** Capability `dedupQueueOperationEchoes`
  (claude, claude-ollama) enables `reconcileClaudeQueueOperationEchoes`
  (`linearMessageDedup.ts`): durable `deferredSource: "queue-operation"` user
  rows pair one-to-one against sdk-source plain user turns with identical
  normalized text, nearest timestamp first, within 60s. Both sides are stamped
  at enqueue time on the same machine (observed ms apart; the slack absorbs
  CLI stdin lag), and the structural scoping — only queue-op rows, only
  sdk echoes, one-to-one — is what makes the wide window safe where the
  general backstop must stay at 2s. The merged message keeps the **row's**
  identity (`queue-operation-…` id, not the echo uuid) so later durable
  fetches keep deduping by id; echo-only fields (tempId, metadata) survive.
- **Dequeue-path pairing (landed 2026-07-04).** The CLI has a second delivery
  shape the row pairing cannot see. On interrupt (verified on ac165df3: user
  rejects a long-running tool with steers pending) — and on some end-of-turn
  deliveries — it *dequeues* every pending queued message: content-less
  `queue-operation`/`dequeue` rows the reader never surfaces, plus **one real
  user row** (its own uuid, parented on the `[Request interrupted by user…]`
  marker) whose text is the dequeued texts joined by `"\n"`. With no
  queue-op row to pair against, the echoes stranded as perpetual "sent"
  copies above the interrupt while the durable turn rendered again below it —
  so the post-interrupt response appeared to follow the interrupt with its
  actual prompt sitting misplaced above. `reconcileDequeueDeliveredTurns`
  (same entry point, same capability) pairs a durable plain user row with the
  in-order run of unconfirmed self-send echoes (tempId/messageMetadata
  required — provider stream copies carry neither) whose concatenation
  reproduces its text exactly. The **durable position wins**: the turn reads
  at its delivery point, immediately after the interrupt marker, matching how
  remove-path deliveries read. Exact-concatenation matching replaces a tight
  timestamp window (enqueue→delivery can span a long tool run); the only time
  constraint is that no consumed echo postdates delivery beyond 60s skew.
- **Late-delivered entries vs incremental fetch (landed).** The normalized
  queue entry keeps its enqueue *position* but only becomes visible at
  delivery, so a purely positional `afterMessageId` slice can sit past it and
  never send it. The reader stamps `queueDeliveredAt` (the remove op's
  timestamp, `claude-messages.ts`), and `sliceAfterMessageIdWithMatch`
  (`pagination.ts`) additionally returns pre-anchor entries whose delivery
  postdates the anchor row. Re-sends merge idempotently by id client-side.
- **Delivery-state feedback (landed, default-on).** The pairing doubles as
  the send-confirmation signal: a self-sent turn (tempId/messageMetadata on
  the echo) renders fainter with a light "sent" tag in the bubble's right
  margin (hover title + tap popover explain it) while sdk-source-only —
  server-accepted but not yet proven durable, exactly the copy a process kill
  could lose — and flips to the ordinary unadorned bubble when the durable
  copy merges (`lib/deliveryState.ts`, `UserPromptBlock`). A ✓ glyph was
  rejected: it reads as confirmed/seen, the opposite of the state it marks. Owned sessions normally skip
  file-change fetches; while unconfirmed sends exist they fetch incrementally
  so confirmation lands mid-turn (`useSession.handleFileChange`).

Residual gaps: two identical busy sends >60s apart whose CLI enqueue lagged
that far (pairing misses; duplicate returns), and pre-delivery steers show
"sent" until the CLI delivers them (the enqueue row exists but the reader
only surfaces delivered entries). The dequeue pairing adds one more: its
exact-text match can absorb the stranded echo of a steer the CLI *lost*
into a later identical-text direct send's durable row — the text still
renders once, but the visible evidence that a send went missing is gone.

## OpenCode

Verified against `references/opencode` (run `pnpm clone-references` —
note it fetches only Codex; OpenCode was cloned manually for this):
`/event` is **forward-only** (no replay on connect), so duplication is
purely the REST backfill. The send API `POST /session/:id/message` accepts
an optional client `messageID` and adopts it as the durable SQLite primary
key; live `message.part.updated` carries `part.messageID` == the durable
`message.id`.

- **Assistant: fixed deterministically.** Emit each streamed assistant
  message under its own `part.messageId` (`opencode.ts`), not a
  carried-over "current" id. Streamed uuid == durable id.
- **User echo: on the backstop.** Streamed user uuid is YA's queue
  `message.uuid`; durable is OpenCode's `message.id`. They never match,
  so the 2s reconcile handles it (steer message + durable copy are
  identical content within 2s). Residual gap: two identical steers <2s
  apart.

### Deferred option A (more accurate user-echo fix)

The clean deterministic user-echo fix is to **mint an OpenCode-format id
(`msg_` + ascending suffix; see OpenCode `Identifier`, schema only
requires the `msg` prefix) as the queue `message.uuid` itself**, then pass
it as `messageID` on the send POST. Then echo uuid == queue uuid ==
durable id, all consistent.

Why deferred, not done: `message.uuid` is also the key the supervisor uses
to attach the client `tempId` for optimistic-send reconciliation
(`Process.ts` queue path; client reconciles by `tempId` in `useSession`).
Repointing only the echo uuid would break that and double the user's *own*
sends. A correct A therefore changes the **shared, provider-agnostic queue
path** to be provider-aware, and needs a sweep confirming no
`message.uuid` consumer assumes a random-UUID format. Disproportionate vs.
the backstop, which already covers the case — revisit only if the
2s-identical-steer residue actually bites.

## Codex

YA drives Codex over the app-server **thread-item** stream
(`thread/start` with `experimentalRawEvents: false`), so the live render
path is `item/started`/`item/completed` → `convertItemToSDKMessages`
(NOT the `rawResponseItem/*` path, which is opt-in and unused here). What
id a thread item carries decides whether alignment is possible, and it
splits by item class (verified in `references/codex`
`app-server-protocol/src/protocol/thread_history.rs`):

| Item | Live thread `item.id` | Durable rollout id | Aligned? |
|---|---|---|---|
| Native tool calls/results | `payload.call_id` (`id: payload.call_id.clone()`) | `call_id` on the response item | **Yes** — both key on `call_id` |
| Code-mode nested command | inner `commandExecution` id (`exec-*`) | outer `custom_tool_call.call_id` (`call_*`) | **No direct id** — scoped reconciliation below |
| Checklist update | transient YA id for `turn/plan/updated` (notification has no item id) | `function_call.call_id` or outer `custom_tool_call.call_id` (`call_*`) | **No direct id** — scoped reconciliation below |
| User turns | counter `item-{N}` + separate `client_id` | event_msg `client_id` (null until YA sends it); also a positional response-item copy | Deferred (see below) |
| Assistant / reasoning | counter `item-{N}` (`next_item_id()`) | `response_item.payload.id` — **null in practice** | **No** — no shared id; backstop only |

The decisive correction over the original plan: in the active
(thread-item) config, assistant messages have **no shared id either
side** — the live id is a synthetic per-thread counter and the rollout's
`payload.id` is null (confirmed on a real 2026-06 rollout: 13 assistant
items, all `payload.id == null`). So the "Assistant w/ `ResponseItem.id`"
class does not occur, and *all* assistant messages fall to the
content+timestamp backstop. Only **native tool calls** are cleanly alignable by
provider id. Code-mode and checklist updates add the bounded exceptions below.

### Done: native tool-call id alignment and scoped reconciliation

For directly alignable native tools, both sides key the rendered message uuid
on `call_id` (call → `call_id`, result → `${call_id}-result`), independent of
turn — `call_id` is globally unique, so no turn scoping is needed:
- Live (`codex.ts`): `convertItemToSDKMessages` routes tool-backed thread
  items (`isToolBackedThreadItem`) through `buildItemToolUuid(item.id)` /
  `buildItemResultUuid(callId)`; message/reasoning items keep
  `${itemId}-${turnId}`. A code-mode command temporarily uses its inner
  `exec-*` item id until the scoped reconciliation below. The streaming-result
  and (opt-in) rawResponse paths use the same helpers.
- Durable (`normalization.ts`): `codexDurableResponseItemUuid` maps
  `function_call`/`custom_tool_call`/`web_search_call` →
  `call_id`, `*_output` → `${call_id}-result`; the `exec_command_end`
  event result keys on `${call_id}-result` too. Messages keep the
  positional `codex-${index}-${ts}` uuid (the index still advances, so
  positional ids stay stable).
- Contract test: `render-parity.test.ts` "aligns Codex tool-call uuids
  across stream and durable sources" asserts uuid equality per `call_id`,
  and "dedups Codex tool messages by id … with the backstop off" proves the
  ids carry tool dedup without `reconcileLinearMessages`.
- Code-mode exception (verified 2026-07-10): a real multi-read execution used
  live id `exec-f6e9…` and durable outer id `call_FE1X…`; the raw SDK log had
  no `rawResponseItem/completed` bridge for that turn. Both paths did expose
  the same rollout turn id and normalized to the same `Bash` input/action
  vector. Server normalization now attaches ephemeral
  `_codexToolCorrelation` metadata to those live and durable-shaped messages.
  `codexToolReconciliation.ts` pairs only opposite origins in the same turn
  with exactly equal normalized name/input/actions, one-to-one by nearest
  timestamp within 10s, then adopts `call_*` / `call_*-result` as canonical.
  The durable row remains authoritative and no YA record is persisted.
- Checklist exception (verified against Codex 0.146.0): app-server emits
  `turn/plan/updated` with the full plan but no item/call id, while code-mode
  rollout stores the enclosing `custom_tool_call` (ordinary tool mode uses a
  `function_call`). YA assigns a turn-local live id, then uses the same exact
  same-turn normalized-input reconciliation to adopt the durable `call_*`
  identity when backfill overlaps the stream.
- Multi-nested code mode fails closed: several inner `commandExecution`
  parents cannot be assigned safely to one outer call by id. The explored
  projection may make their default visual group converge, but raw parent
  structure and active-tail collapse identity may replace once rollout lands.
- Backstop excluded for tools: native ids plus the scoped code-mode reconciler
  carry the known cases, so the approximate backstop does not run over tools
  (`approxDedupExcludesTools`); it stays on only for the residual non-tool
  messages. See the Two-layer remedy note above.

### Deferred: user-turn id alignment

The round-trip exists — sending `clientUserMessageId` on `turn/start`
(`codex.ts:createTurnStartParams`) and `turn/steer` makes Codex persist it
as the event_msg `user_message.client_id` (`references/codex`
`core/src/session/mod.rs:3717` sets `client_id: client_user_message_id`),
and the live echo already uses the same `message.uuid`. The durable
double-source is now correlated for authorship by
`codex-user-turn-provenance.ts`: the adjacent event witnesses the turn and the
response item remains the rich rendering payload. Normalized messages expose
that result as `codexUserTurnProvenance`, but still use the response item's
positional uuid because YA's checked-in event schema does not yet retain the
paired `client_id`. Adopting that id and re-measuring the approximate backstop
are deferred indefinitely: the existing backstop covers the known symptom,
while an id migration would cross schema, pagination, and reconciliation
boundaries. Reopen only for a reproducible duplicate that survives current
dedup and after auditing the end-to-end provider id contract. See the closed
disposition in `topics/codex-user-turn-provenance.md`.

The first user turn has one additional startup wrinkle: YA may render the
optimistic opening turn before the Codex thread has finished startup and before
the durable first user row appears. A real report on 2026-06-30
(`019f1642-3917-7052-aa32-1262257ec3f1`) had the session meta at
`02:01:07.884Z` and the durable visible user row at `02:01:12.931Z`, outside
the general 2s window. The fix is a first-plain-user-turn-only 30s window in
`linearMessageDedup`, not a looser general Codex backstop.

An in-turn steer has the inverse timing problem: its optimistic echo can exist
for longer than the ordinary 15–30-second server replay window before Codex
consumes and persists it. A reconnect in that interval must still replay the
accepted echo. `Process` therefore retains steer echoes separately until the
provider turn boundary, while continuing to use the bounded rolling buckets for
ordinary messages and for the short post-boundary persistence gap. This
retention is bounded by the number of steers in the active turn; it does not
turn the general replay buffer into an unbounded transcript. When Codex finally
persists a long-lived steer, its positional durable id still differs from the
echo's YA uuid and the timestamps can be far outside the general 2s backstop.
`reconcileCodexSteerEchoes` therefore pairs only unconfirmed self-sent
`deliveryIntent: "steer"` echoes with exact-text durable user turns,
one-to-one, and adopts the durable row's identity and position.

### Re-reported first-turn duplicate with attachments

On 2026-06-30, session `019f1685-f1c8-7171-b056-e9b3f2f6be61` showed the
opening prompt twice as two normal user bubbles. That session was created from
`NewSessionForm` with an attachment. Evidence bounds the root cause:

- The REST session detail had one visible opening user row:
  `codex-2-2026-06-30T03:15:16.034Z`.
- A fresh headless load of the same URL rendered one opening user prompt, so the
  duplicate was not persisted in the durable transcript and was not produced by
  a clean initial load.
- The attached-new-session path is two-phase: create an empty session,
  materialize the attachments, then call `api.queueMessage(...)` for the first
  turn with `tempId` intentionally `undefined`. That removes the strongest
  client identity hook and lengthens the startup window before the durable row
  exists.
- During that window, the client can hold more than one live/user copy: YA's own
  queued echo and Codex's later thread-item user echo, or a stale in-memory
  stream copy plus a later durable backfill. The current backstop handles
  cross-source same-fingerprint pairs, and exact same-source repeats only when
  timestamps are identical; it does not enforce a user-visible "one first turn"
  invariant across all startup sources.

The UI contract should be stronger than "the right source eventually wins":
before rendering the main transcript, the first visible user turn may appear at
most once. For the startup window, compare the user-visible prompt text after
stripping YA's uploaded-files metadata into the same attachment model the UI
renders, plus the rendered attachment identity set. If two adjacent user rows
match that visible identity, collapse them and prefer the authoritative durable
row when present, otherwise prefer the metadata-rich/latest live row. Do not
extend this to arbitrary later repeated user turns; a user really can resend the
same text later.

Landed fix:

- `linearMessageDedup` now computes an attachment-bearing visible first-user
  fingerprint: rendered prompt text after removing YA's uploaded-files metadata,
  plus attachment paths from either the metadata section or message attachment
  fields.
- The guard merges SDK/JSONL first-turn copies and same-source SDK startup
  copies when that visible attachment fingerprint matches inside the existing
  30s first-turn window. It still leaves text-only same-source repeats on the
  previous strict rule, because two text-only first messages can be real user
  actions.
- Regression coverage pins the attached new-session cases above and confirms a
  later identical attached prompt remains two turns.

Still deferred: thread a client user message id through the attached-new-session
two-phase path too; that removes the need for this safety net on the opening
turn instead of only masking it.

### Pitfalls that turned out fine (for the deferred user-turn work)

Confirmed non-issues while doing the tool-call alignment, recorded so the
user-turn step doesn't re-investigate them:
- The live `-result` suffix correlation moved in lockstep: tool-result
  uuids derive from the same `call_id` as the call, on both sides.
- `getCodexEntryDedupeKey` (`codex-reader.ts`) keys the **within-file**
  dedup on timestamp+role+content, not on ids, so changing the rendered
  uuid does not touch it; the tool-context maps key on `call_id`, which is
  unchanged. No regression there.
- Parsing `response_item.id` is pointless for assistants (null in
  practice); only `user_message.client_id` is worth parsing, and only once
  the user-turn renderer is changed to consume it.

## pi

Same shape as OpenCode's user echo, and the durable copy only began to exist
when `PiSessionReader` landed (`e7428b09`) — before that pi routed to
`NullSessionReader`, so there was no second copy to collide with. The divergence:

| Source | User-turn uuid | Where |
|---|---|---|
| Live stream echo | YA queue `message.uuid` | `pi.ts` (`yield {type:"user", uuid: message.uuid}`) |
| Durable backfill | pi JSONL node `id` | `pi-reader.ts` `mapNode` (`uuid = node.id`) |

They never match, and pi originally shipped `needsApproxMessageDedup: false`, so
by-id dedup left the **first turn double-rendered** — visible only on that turn
because it is the one actively-streaming turn whose user node is already
persisted+loaded while the assistant is still single-sourced from the live
stream; later owned turns don't merge durable rows mid-stream (`handleFileChange`
early-return). The server-side uuid duplicate-guard (`Process.ts` ~2663) only
catches same-uuid optimistic+echo collisions; the durable copy arrives via the
REST path and never enters that bucket.

- **User echo: on the backstop (landed).** `PiProvider.needsApproxMessageDedup =
  true`. Both copies carry timestamps — the live echo is stamped at emit time by
  `Process.withTimestamp` (`Process.ts:2650`) and stored for replay, the durable
  copy carries pi's node timestamp — and they are co-temporal (same moment pi
  persists the user node), identical content, so the 2s reconcile merges them.
  Residual gap: two identical prompts <2s apart, plus the long-turn assistant
  case below.

### Deferred: deterministic alignment needs a `graehl/pi` fork

Unlike OpenCode (whose send API accepts a client `messageID`), **pi exposes no id
hook over RPC**, verified against `~/pi` (`@earendil-works/pi`):

- pi mints node ids itself: `appendMessage` → `createEntryId()` →
  `uuidv7().slice(0,8)` with collision retry (`harness/session/jsonl-storage.ts`,
  `session.ts`). Random and unpredictable, so YA cannot pre-compute them.
- The `prompt`/`steer`/`follow_up` RPC commands' `id?` field is the **request
  correlation id**, not a node id (`modes/rpc/rpc-types.ts`); there is no
  message-id parameter pi would adopt.
- pi never *surfaces* the persisted node id either: `message_start` is emitted
  for user messages but carries only the logical `AgentMessage` (no entry id;
  `agent-loop.ts:112`), and `get_messages`/`get_state` return
  `AgentMessage[]` / session meta — also no entry ids (`agent-session.ts:839`,
  `modes/rpc/rpc-mode.ts`). The entry id lives **only** in the durable JSONL,
  which is exactly what `PiSessionReader` reads.

So a YA-only deterministic fix is impossible. The clean fix is a fork change to
`graehl/pi` (the designated integration target): add an optional `id` to
`appendMessage` and thread a client-supplied id from the `prompt` RPC down to the
user-message append, then YA passes its queue `message.uuid`. Note this is
*simpler* than OpenCode's deferred option A — YA's queue uuid path is unchanged
(pi adopts YA's existing uuid; YA's `tempId` reconciliation is untouched). A
complete version surfaces session entry ids in the message-lifecycle events
(harness injects the id at append time) so assistant/tool uuids align too,
retiring the backstop dependence entirely. Deferred while we stay on upstream
pi (no fork); the backstop covers the reported symptom in the meantime.

### Resume uuid is already pi's id (not gated on the first turn)

A tangent that came up: pi writes its session **header file at startup**
(`jsonl-storage.ts` `create`), so the resumable id (= filename uuid = header
`id`) exists before any turn. pi's `get_state` returns it (`pi.ts` resolves it
synchronously), the init message carries it, and the generic
`waitForSessionId()` + init remap (`Supervisor.ts:898`, `Process.ts:2710`)
already adopt it as the canonical/URL id — pi is not special-cased out. So the
URL uuid is already `pi --session <uuid>` resume-capable; no first-turn block is
needed for it, and a first-turn block would *not* hand YA the user node id
anyway (pi doesn't emit it; see above).

## Key files

- `packages/client/src/providers/implementations/PiProvider.ts` — pi capability.
- `packages/server/src/sessions/pi-reader.ts` — durable pi node-id mapping.
- `packages/server/src/sdk/providers/pi.ts` — pi live stream user-echo uuid.
- `packages/client/src/lib/linearMessageDedup.ts` — the shared backstop.
- `packages/client/src/providers/types.ts` — `needsApproxMessageDedup`.
- `packages/client/src/hooks/useSessionMessages.ts` — merge + dedup gates.
- `packages/server/src/sdk/providers/opencode.ts` — OpenCode stream ids.
- `packages/server/src/sessions/normalization.ts`,
  `packages/server/src/sessions/codex-reader.ts` — durable Codex ids.
- `packages/shared/src/codex-schema/session.ts` — Codex schema (drops ids).
