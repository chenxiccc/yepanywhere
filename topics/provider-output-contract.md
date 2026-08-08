# Provider Output Contract

> The provider output contract is the single spec for the normalized objects
> every provider integration must produce — message envelope, content blocks,
> structured tool results, status, and lineage links. The named TS types are
> the type definition; runtime validation stays off hot paths.

Topic: provider-output-contract

See also:
[provider-authoring](provider-authoring.md) (the workflow map — *how to add*
a provider; this topic is the output half, *what a provider should attempt
to produce*),
[provider-abstraction](provider-abstraction.md) (when a provider/model
conditional gets promoted to the `AgentProvider` seam),
[stream-persisted-render-parity](stream-persisted-render-parity.md) (the
convergence contract between the two delivery paths),
[stream-durable-id-dedup](stream-durable-id-dedup.md) (id stability across
stream and durable copies),
[provider-state-machine](provider-state-machine.md) (the status half of the
contract),
[provider-session-tree](provider-session-tree.md) (lineage capability audit),
[transcript-display-objects](transcript-display-objects.md) (display-only
objects that are *not* provider output).

## Rule: normalize in the provider layer, against this spec

All provider-specific shape conversion happens in the provider seam — the
session reader, the stream adapter, and their normalization helpers — and
produces the shapes named here. Routes, renderers, and the client must not
carry provider conditionals that repair output shape; a shape defect in what
a provider emits is fixed in that provider's normalization helper, behind
this contract. ([provider-abstraction](provider-abstraction.md) governs when
an existing scattered conditional gets promoted into the seam.)

Where normalization lives today:

- **Persisted path.** Readers (`packages/server/src/sessions/*-reader.ts`)
  return provider-raw payloads inside `UnifiedSession`
  (`packages/shared/src/session/UnifiedSession.ts`, a tagged union by
  provider). `normalizeSession`
  (`packages/server/src/sessions/normalization.ts`) is the central
  per-provider switch that converts raw entries to normalized `Message`s,
  delegating to provider-specific helpers
  (`packages/server/src/codex/normalization.ts`,
  `packages/server/src/sdk/providers/gemini-tools.ts`,
  `packages/server/src/sdk/providers/opencode-tools.ts`,
  `packages/server/src/sessions/claude-messages.ts`).
- **Stream path.** Provider stream adapters under
  `packages/server/src/sdk/providers/` emit messages that
  `normalizeStreamMessage` (`packages/server/src/subscriptions.ts`) touches
  only lightly; heavy provider-specific transforms belong upstream in the
  adapter.

New provider work extends those helpers; it does not add conversion logic
downstream of them.

## Two delivery paths, one durable-corresponding output

A session reaches the UI live from the **stream** and again later
re-read from **persisted** storage. Both feed the same render pipeline, and
[stream-persisted-render-parity](stream-persisted-render-parity.md) requires
items with durable counterparts to converge — same semantic tool calls and
*structured* result fields, not merely similar visible text. Useful live-only
tail events are allowed; they do not justify a YA-owned shadow transcript.
Message ids must match deterministically across the two paths wherever the
provider allows ([stream-durable-id-dedup](stream-durable-id-dedup.md)); a
provider whose ids genuinely cannot align sets the `needsApproxMessageDedup`
capability and accepts the tight content+timestamp reconcile backstop.

## Typing stance: rigidly described, loosely enforced

The runtime representation is deliberately dict-like. The hot read path
casts (`JSON.parse(line) as ClaudeSessionEntry` in the Claude reader); the
client `Message` is an all-optional interface with an open
`[key: string]: unknown` index signature. There is no hot-path schema
validation, and none should be added — transcript reads and stream fan-out
are the highest-rate surfaces in the server.

The rigid description lives in named types, which are this contract's type
definition:

- `AppMessage`, `AppMessageExtensions`, `AppContentBlock` —
  `packages/shared/src/app-types.ts` (persisted entry + app extensions; the
  main app-side message type).
- Client `Message` — `packages/client/src/types.ts`.
- Server `Message`, `SessionSummary`, `Session` —
  `packages/server/src/supervisor/types.ts`.
- Zod schema families — `packages/shared/src/claude-sdk-schema/`
  (`entry/`, `message/`, `content/`, `tool/`, `guards.ts`), validated
  offline via `scripts/validate-jsonl.ts` and
  `scripts/validate-tool-results.ts` and in tests.

TS-only types are erased at compile time, so naming and expanding them has
**zero runtime cost**; the cost line is runtime `.parse()`, which stays in
offline validation and tests. Where a Zod schema exists, prefer the
`z.infer`-derived named type (as `claude-sdk-schema/types.ts` already does)
so the doc, the type, and the validator cannot drift three ways. A new
normalized shape gets a named exported type in `packages/shared` and a
mention here.

## The normalized message envelope

What a provider's normalization must attempt to supply per message. Unknown
fields are **passed through, never stripped** — consumers tolerate extras;
they rely only on the fields below.

- **Identity**: `uuid` (preferred) or `id`; consumers resolve identity as
  `uuid ?? id` (`getMessageId`). The id must be stable between the streamed
  copy and the durable copy of the same message (see parity/dedup above).
  Dedup and incremental fetch (`afterMessageId`) key on it; there are no
  content hashes anywhere in identity judgment.
- **Kind**: `type` — `user` | `assistant` | `system` | `summary`, plus
  provider-specific subtypes discriminated further by `subtype`. `role` is
  set for user/assistant.
- **Content**: canonical location is `message.content` (string or
  `AppContentBlock[]`); a top-level `content` convenience copy is added by
  the reader. Block types consumers render: `text`, `thinking`
  (+`signature`), `tool_use` (`id`, `name`, `input`), `tool_result`
  (`tool_use_id`, `content`, `is_error`). Unknown block types pass through.
- **Timestamp**: ISO-8601 `timestamp`. Load-bearing, not decorative: the
  approx-dedup backstop windows, pending-echo reconciliation, and ordering
  fallbacks all compare timestamps.
- **Structured tool results**: `toolUseResult` (and/or a `tool_result`
  block). The parity harness compares these as structured objects; a field
  present in the stream copy must survive the persisted copy.
- **Lineage**: `parentUuid` when the provider has entry-level parent links
  (see next section). Null/absent for linear providers.
- **App extensions** (added by YA downstream, never by the provider
  normalization itself): `_source` (`sdk`/`jsonl`), `_isStreaming`,
  `isSubagent`, `orphanedToolUseIds` — documented in
  `AppMessageExtensions`.

## Command execution metadata (exit code, runtime)

Command-like tool results (Bash and shell-session polls such as Codex
`write_stdin`/`wait`) normalize per-command execution metadata into the
structured tool result when the provider reports it, instead of leaving it
embedded in output text or raw provider records:

- `exitCode?: number` — the command's exit status.
- `durationSeconds?: number` — provider-reported wall time for the command.

Provider sources normalized today: Codex unified-exec chunk records
(`{chunk_id, wall_time_seconds, exit_code, output, session_id}` printed as
tool output — the chunk's `output` becomes the result text, raw chunk fields
pass through structured per the pass-through rule, and a `stdout` alias
rides alongside so renderers need no chunk knowledge), and Codex shell text
envelopes (`Wall time[:] N seconds`, `Process exited with code N`,
`Exit code[:] N`). Claude SDK Bash successes carry structured output, while
failures may carry `is_error: true` plus a string beginning `Error: Exit code
N`; transcript projection normalizes that authoritative failure envelope into
combined output and `exitCode`. Without `is_error: true`, identical text
remains command output.

Display rules (client, `getCommandResultMeta`/`formatCommandDuration` in
`packages/client/src/lib/shellToolOutput.ts`):

- **Exit code 0 is never shown** — success is the default; a visible exit
  code always means failure. Every nonzero command result shows `rc=N` in the
  collapsed row header, whether or not the command produced output.
- **Failure state does not recolor combined output** — the row's error-status
  dot and `rc=N` carry command failure. Known stderr remains error-colored;
  its foreground must retain strong contrast in dark and light themes.
  Combined provider output uses the normal output color.
- **Command output remains fixed-width** — source and enriched renderings of
  stdout, stderr, and combined output use the same fixed-width metrics. File
  links, glossary terms, and other annotations may change color or decoration,
  but do not switch the surrounding output to the prose face.
- **Runtime is a detail-view fact**: shown in the command detail surfaces —
  the Bash output modal, the expanded result body — not in collapsed row
  summaries, except alongside a nonzero exit code (`rc=1 in 12.5s`).
- Renderers read metadata through `getCommandResultMeta`, which accepts
  both the normalized fields and raw provider spellings
  (`exit_code`, `wall_time_seconds`), so a provider whose normalization
  lags still displays correctly once its fields pass through structured.

## Web browsing results (Codex `web.run`)

Codex's namespaced browsing tool (`web.run`; `web__run` when flattened into
a code-mode `exec` script) normalizes to canonical tool name `Web` with the
structured result `CodexWebRunResult`
(`packages/shared/src/codex-web-run.ts`). The provider prints one text blob
— a script envelope (`Script completed` / `Wall time N seconds` /
`Output:`) followed by page blocks separated by an exact 80-dash rule. Each
block is a `Title (URL)` line plus a marker line carrying a follow-up
reference (`turn0search4`), `[wordlim: N]`, and `Key: value;` metadata
(Published, Crawled, Content type, Source, Redirected to URL, Total lines);
the body is either windowed page lines (`L0: …`, several may share one
physical line) or a prose search snippet.

The parser (`packages/server/src/codex/webRun.ts`) treats the U+E200–E202
private-use citation wrappers as format-significant markup:
`cite<id>†<label>[†<domain>]` reduces to its visible
label, bare page references drop. It fails closed — output without the
envelope or a page block keeps its raw-text presentation — and the
normalized `content` string drops the envelope, so "Script completed" never
reaches rendered text. The client `Web` renderer
(`packages/client/src/components/renderers/tools/WebRenderer.tsx`) renders
page content in the prose output font (it is web prose, not terminal
output) and mirrors the shell-output preview affordances via the shared
primitives in `renderers/tools/outputPreview.tsx` (first-N-lines clamp,
tail tooltip, hidden-line badge, hover copy button, click-for-modal).

## Inline base64 is interchange-only

JSON is the interchange representation, and base64 is how binary survives
inside it. The API wire format and the persisted jsonl legitimately carry
images as inline base64 content blocks — JSON has no binary type, and the
transcript is a replayable log. That legitimacy ends at ingest: past the
boundary where wire messages become retained client/session state, binary
payloads belong behind refs/handles (server-served media refs, or client
`Blob` + object URL), never as inline base64 strings held in memory. A heap-resident base64 string costs ~2.7x
the raw bytes (base64 overhead x UTF-16), is pinned to the JS heap where a
`Blob` could be spilled by the browser, and re-streams at full weight to
remote clients on every fresh transcript load.

Direction: the **server** owns the conversion, not the client. Whatever
the harness emits with inline base64 — user-pasted screenshots, tool
results, or assistant-*generated* images — is extracted at the server's
provider seam; the client receives either binary over the existing
authenticated channel or a media URL. The URL form carries security
obligations, not just plumbing:

- same authn/authz as the transcript itself — an unguessable capability
  URL is not authorization (URLs leak via logs, history, referers, and
  shared screens);
- opaque media ids mapped server-side, never client-supplied paths;
- correct `Content-Type` with sniffing disabled, and script-capable
  formats (SVG) served neutralized — generated media is untrusted input;
- must work over both transports: direct HTTP and the relay tunnel,
  where a side-channel HTTPS fetch would bypass the end-to-end
  encryption — media on the relay path rides the encrypted channel.

Known debt: today the client `Message` model retains wire-shaped blocks,
so inline base64 rides through to render and into the session-detail
transcript cache. The measured retention charges
([session-detail-data-layer](session-detail-data-layer.md)) count that
payload at true weight, which contains the damage but does not fix the
representation. The intended client seam is the session-detail ingest
boundary once the store-authoritative migration completes, consuming the
server-served refs above (which also cut transcript transfer to mobile
clients). [`session-media-handles.md`](session-media-handles.md) records
the problem statement, measured local evidence, and a possible opaque
media-id lookup model. When it lands, resume/replay and the offline Zod
validation paths must reconstitute or tolerate handles.

## Status

The status half of the contract is
[provider-state-machine](provider-state-machine.md): `processState`
(`idle`/`in-turn`/`waiting-input`), `sessionLiveness.derivedStatus`,
compacting, and ownership. Providers supply raw process/stream events; the
seam derives these normalized states — the same
normalize-in-the-provider-layer rule applies.

## Lineage: forest links at two levels

Provider lineage appears at two distinct levels, and the contract keeps them
separate:

- **Entry-level parent links** (a message forest inside one transcript):
  Claude `parentUuid` (single-parent branching forest — see the
  `packages/shared/src/dag.ts` module header), Pi v3 `id`/`parentId`.
- **Session-level source links** (lineage between session ids): Codex
  `forked_from_id`, OpenCode session `parentID`, and YA-created transcript
  copies. YA surfaces ordinary copy provenance as `forkedFromSessionId`.
  `parentSessionId` is a different, interactive relationship reserved for a
  YA `/btw` aside's Mother and is explicit through
  `parentSessionKind: "btw-aside"`.

Distinguish **harness-native data model** from **what YA currently
surfaces**. Capability flags describe the latter only: Pi natively maintains
a tree (`/tree`, per-entry `parentId`) while YA reads just the active-leaf
path, so Pi's `supportsDag` is `false` without contradicting Pi's data
model. The audit and the proposed `sessionTree` capability live in
[provider-session-tree](provider-session-tree.md).

**Traversal rule**: any parent-link traversal — linearization, reorder
repair, walk-to-root, tree projection — uses the shared facility in
`packages/shared/src/dag.ts` (`orderByParentChain`, `needsReorder`, over the
`DagOrderable` view) rather than a hand-rolled per-provider walk. The
facility is deliberately a small family, because the traversals differ by
intent: conservative reorder repair (never invents order), active-leaf path
selection, and lineage/tree projection. Extend it by generalizing the
id/parent accessors (today it hardcodes `parentUuid`), not by copying the
loop. Known debt predating this rule: the Pi reader's walk-to-root and the
Claude reader's DAG handling are self-contained.

## Capabilities registry

Client-side capability flags (`ProviderCapabilities`,
`packages/client/src/providers/types.ts`): `supportsDag`,
`supportsCloning`, `needsApproxMessageDedup`, `approxDedupExcludesTools`.
Each flag is a claim about how far the provider's normalization satisfies a
section of this contract; when a provider's normalization improves (e.g.
deterministic id alignment lands), flip the flag in the same change.
