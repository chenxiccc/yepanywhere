# Claude Provider Control

> YA's Claude-specific control surface distinguishes sessions YA can actively
> configure from sessions it can only observe through provider transcript files.

Topic: claude

Related topics: [session liveness and queue intent](session-liveness.md),
[API failures and retries](claude-api-failures-and-retries.md),
[emulated slash commands](emulated-slash-commands.md),
[provider refresh](provider-refresh.md),
[provider state machine](provider-state-machine.md), and
[thinking configurability](claude-thinking-config.md).
[Subprocess environment boundaries](subprocess-environment.md) defines the
shell-startup and test-hermeticity rules for the local `BASH_ENV` bridge.

## Contracts

- In-session Claude model switching is a YA-owned-process capability, not a
  property of a Claude JSONL transcript. YA can switch a live Claude model only
  when it owns the active provider process and has the SDK `Query` control
  handle that exposes `setModel`. <!-- verified: SHA 9254832 -->
- TUI-started Claude sessions are external ownership from YA's perspective.
  YA may read and render their transcript, but it must not present in-YA
  mid-session model selection while the TUI owns the live process, because YA
  has no SDK process id or control handle to reconfigure. <!-- verified: SHA 9254832 -->
- Resuming or restarting a Claude session from YA creates a new YA-owned
  process for that session path. From that point, model controls may be
  available according to the new process capabilities; this is different from
  controlling the still-running external TUI process.
- A YA-owned Claude session normally has no YA-owned process after a full YA
  server restart. That owner loss is not by itself a handoff condition. If the
  persisted Claude transcript tail is safe to resume, a normal resume should
  start a new YA-owned SDK process with the same Claude session id. Handoff is
  reserved for an explicit unsafe-resume condition or for a user-requested
  replacement session.
- Replacement-session model choice is separate from mid-session model
  switching. A handoff/restart flow may choose the model for the replacement
  process even when the source session was external or no longer owned by YA.
- Claude SDK API-error assistant rows are transcript artifacts, not confirmed
  Anthropic `/v1/messages` responses. If the latest assistant response on the
  active branch is an SDK API-error row, YA must not normal-resume that Claude
  session; use the handoff/restart path so the next provider turn starts from a
  bounded prompt instead of a potentially synthetic `previous_message_id`.
- Claude `/goal` is exposed as a YA-side alias for `/loop wish ...`. YA injects
  the `goal` entry into the visible slash-command inventory only when the SDK
  inventory reports `/loop` and does not already report `/goal` itself. The
  inserted entry carries `emulation.providerText = "/loop wish {{argument}}"`,
  declaring that YA will substitute the user-supplied argument and send the
  expanded provider-text — not the literal `/goal ...` — when the user submits.
  If the SDK begins reporting `/goal` natively, the YA alias must step aside so
  the native command (and its arguments) reach Claude unaltered.
- Non-Claude providers should not get a YA-emulated `/goal` from this path.
  They should show goal-like slash commands only when their provider command
  inventory or another provider-native capability reports native support, or
  when a provider-specific emulation rule (separate from the Claude/`loop`
  alias here) is added.
- Claude automatic session titles come from the first non-meta user turn.
  When a session opens with a provider slash-command wrapper, the title is the
  command plus its arguments; a preceding `isMeta` local-command caveat must
  never become the visible title.
- Live Claude activity must not depend on the original browser tab being the
  only observer. A later YA view of the same YA-owned process should receive
  enough replay, catch-up, durable transcript refresh, and liveness metadata to
  show the interesting agent text, tool runs, task/progress updates, and turn
  boundaries that an already-open tab saw.
- Local YA-owned Claude provider processes should make the canonical session id
  visible to later Bash tool shells as `AGENTCTL_SESSION_ID` once the SDK init
  message reports it. This is a child-shell `BASH_ENV` bridge for `agentctl`
  active-session upkeep, not an attempt to mutate the already-running Claude
  process environment; resume sessions may seed the id before startup, while
  remote dynamic injection needs a separate remote-side design.
- YA-owned Claude launches set `ENABLE_PROMPT_CACHING_1H=1` in the filtered
  child environment by default, preserving any explicit operator value and
  leaving Claude Code's documented `FORCE_PROMPT_CACHING_5M=1` override
  available. Claude Code docs say subscriptions already use one-hour prompt
  cache TTL automatically, while API-key, Bedrock, Vertex, Foundry, and Claude
  Platform on AWS paths keep the cheaper five-minute default unless this env
  var opts them into one-hour TTL; one-hour cache writes are billed at a higher
  rate, so this default is a deliberate YA launch policy rather than proof that
  longer TTL is free or always beneficial. Source: Claude Code prompt-caching
  docs, Cache lifetime section
  (<https://code.claude.com/docs/en/prompt-caching#cache-lifetime>).
  <!-- verified: docs 2026-06-11 -->
- YA-owned Claude launches keep transient backend failures inside Claude's
  original request loop. `CLAUDE_CODE_RETRY_WATCHDOG=1` makes retryable
  429/529 responses persistent with exponential backoff capped at five
  minutes; `CLAUDE_CODE_MAX_RETRIES=2147483647` is an effectively unbounded
  attempt budget for other failures Claude classifies as retryable. Explicit
  operator values override both defaults. Stop/abort remains the cancellation
  path, and YA must not append a synthetic resend turn after an API failure
  because that can reuse a synthetic `previous_message_id`. See
  [claude-api-failures-and-retries](claude-api-failures-and-retries.md).
  <!-- verified: Claude Code 2.1.183 source + tests 2026-06-19 -->
- Claude SDK/API package refreshes are source refreshes when they add message
  types, control methods, transcript fields, model/command metadata, or resume
  behavior that YA consumes. Unknown SDK message types may be temporarily
  passed through for forward compatibility, but they must not become silent
  data loss or invisible state-machine drift.
- Claude model discovery keeps YA's stable family selection tokens even when
  the SDK reports only an extended-context variant. In particular,
  `opus[1m]` supplies live capability metadata to the visible `opus` row rather
  than appearing as a duplicate or losing adaptive-thinking, fast-mode, auto,
  or effort support. Canonical Claude 5 Opus and Sonnet ids are 1M models; the
  auth/probe-failure fallback must describe the current Opus generation and
  retain the provider-native capability controls that are known without a
  handshake.
- Claude's primary model catalog remains the provider-native, latest-oriented
  experience. Previous concrete versions and custom exact ids appear only
  after a server-persisted, individual opt-in in Providers settings; projected
  entries carry additional-catalog metadata so model choosers can group them
  separately.
- Removing a previous-model entry from YA's maintained registry must not erase
  an existing saved selection. Preserve its exact provider id and saved label
  as an unlisted/custom entry until the user removes it. Never silently replace
  a rejected, retired, or provider-remapped model with a newer one.
- `claude-gateway` is a separate, default-off provider for an
  Anthropic-compatible LLM gateway. Configuring it must not reroute the regular
  `claude` provider or mutate `~/.claude/settings.json`: every Gateway launch
  supplies `YEP_CLAUDE_GATEWAY=1`, `ANTHROPIC_BASE_URL`,
  `ANTHROPIC_AUTH_TOKEN`, and `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` in
  the Claude SDK's per-launch flag-settings layer and in that child process's
  environment only. The YA marker identifies the Gateway provider route, not
  the implementation behind its generic Anthropic-compatible endpoint.
- A gateway that returns `X-Copilot-API: 1` from `/v1/models` explicitly
  identifies that implementation. After observing that header, YA adds
  `YEP_COPILOT_API=1` to the Claude flag-settings and child environments for
  launches against the same configured URL. Changing the URL clears the
  identity. YA must not infer this marker from a port, model id, vendor row, or
  other catalog content.
- Gateway launches narrow several Claude Code defaults.
  `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` defaults to `1` (one level of
  subagents, no nesting; the CLI default is 3), deferring to an explicit
  operator value in YA's own environment.
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` is retained deliberately, but
  it is a privacy/traffic choice and not a token or quota saver, and it has a
  cost worth knowing: it puts the CLI in essential-traffic mode, which
  disables GrowthBook, so `getFeatureValue` returns each flag's compiled
  default and the session loses every flag-gated feature — the Monitor tool
  (`tengu_amber_sentinel`) and hosted push (`tengu_kairos_push_notifications`)
  among them. The visible signature: a native Claude session blocks foreground
  `sleep` loops and points at Monitor, while a gateway session does neither.
  `DISABLE_NON_ESSENTIAL_MODEL_CALLS=1` is inert on current Claude Code —
  absent from 2.1.220's env registry, with no replacement knob for spinner
  flavor text or automatic title generation — and is kept only for older CLIs.
- A Claude Gateway's `/v1/models` response is the authoritative selection
  catalog. YA must not merge Claude Code's first-party `supportedModels()`
  result or static Claude fallbacks into it, because those can advertise
  regular-subscription models the gateway cannot serve. Invalid, duplicate,
  disabled, non-chat, embedding, and trajectory-compaction rows are omitted;
  an unavailable catalog produces no model choices rather than silently
  escaping to regular Claude. When a row supplies catalog endpoint metadata,
  it is authoritative: YA omits rows with no supported text endpoint, and the
  gateway may use native Anthropic Messages, Responses translation, or
  chat-completions translation only when the model advertises that endpoint.
  Rows that omit endpoint metadata remain visible for generic and legacy
  gateways whose model catalogs predate that extension; the gateway's
  compatibility route owns the resulting success or visible API failure.
  Model-specific failures never trigger a different provider transport.
- Selecting Claude Gateway in New Session forces a background catalog refresh.
  Until that authoritative catalog contains a selected model, the UI shows a
  retryable unavailable state and blocks fresh launch through every submit
  path. A saved model absent from the response is not offered as an unlisted
  fallback, so a model id from Codex or regular Claude cannot bleed into a
  Gateway launch. Once the catalog arrives, YA selects the saved advertised
  model or its first row and derives thinking/effort controls from that row.
- Claude Gateway may carry an explicit, default-off server-side start command.
  Catalog discovery runs that shell line only when the configured URL is exact
  `localhost` / `localhost.`, IPv4 `127.0.0.0/8`, or IPv6 `::1` and a bounded
  TCP probe finds no listener on its port. Any listener suppresses execution,
  even when `/v1/models` is unhealthy; non-loopback URLs never execute the
  command. Concurrent catalog reads share one bounded Bash launch/readiness
  attempt, and no timer retries after it settles. A later catalog refresh may
  try again. The command runs on the YA server host and owns its working
  directory, environment, and port choices. YA terminates a foreground child
  it launched when Gateway configuration changes or the server shuts down;
  commands that daemonize fall outside that ownership, so the settings UI
  directs operators to keep the gateway in the foreground.
- Claude Gateway retains the Claude harness, transcript, tools, permissions,
  compaction, and resume contracts. Per-model gateway catalog metadata controls
  whether YA advertises adaptive thinking and which effort levels it offers;
  absent metadata means absent controls, never an invented Medium default.
  Anthropic prompt-cache keepalive remains unavailable. Provider selection is
  the routing boundary: a Gateway model stays on the configured gateway, while
  regular Claude models stay on Anthropic's normal transport.
- The provisional YA session id used before Claude SDK initialization must
  remap its persisted metadata to the canonical Claude session id when the
  provider reports it. Explicit persisted provider identity takes precedence
  over transcript model-name heuristics, so a non-Claude model routed through
  the Claude harness remains `claude-gateway` rather than being mislabeled as
  `claude-ollama`.
- `claude-ollama` remains a readable/resumable legacy provider during its
  deprecation grace period, with no automatic migration. Hide it from provider
  and model menus when neither Ollama settings nor persisted
  `claude-ollama` session metadata exist; an explicitly configured or
  previously used installation remains visible with a dismissible notice that
  directs the user to Claude Gateway and says ClaudeOllama will be removed.
- Claude provider-native interviews are `AskUserQuestion` tool calls surfaced
  through the SDK `canUseTool` path, not ordinary approval prompts and not a
  distinct session-state mode. YA must classify them as pending user questions,
  bypass approval allow/deny permission rules for that tool name, render the
  question/options/free-form "Other" UI, and answer by returning the SDK result
  with the original input plus an `answers` map. Single-select answers are
  strings; multi-select answers are string arrays. A completed interview can
  resume into another `AskUserQuestion`, which should reuse the normal
  waiting-input lifecycle instead of needing a special chained-interview state.

## Transcript Structure: Forest, Connector Rows, Dead Segments

Claude JSONL transcripts are a single-parent branching forest: `parentUuid`
is the only link type, each row has at most one parent, and a parent may
have several children (forks). No multi-parent rows have been observed;
code and docs that say "DAG" mean this forest (see the header comments in
`packages/server/src/sessions/dag.ts` and `packages/shared/src/dag.ts`).

**Fork vs. forest — opposite conditions, do not conflate.** A *fork*
(branch) is one parent with several children: the children share every row
up to that parent and diverge only after it, so a fork is a *content*
divergence *with* shared ancestry. The structure earns the name *forest*
(rather than a single rooted tree) only because it can also contain
**multiple roots** — rows whose `parentUuid` resolves to nothing in the
loaded set. Multiple roots are almost always a *loading artifact*, not a
divergence in the conversation: dropped connector rows
(`attachment`/`system`) break the chain client-side, pagination /
incremental-fetch windows omit the parent, and live stream rows carry no
`parentUuid` at all — `dag.ts` deliberately treats all three as "parent
absent, do not relocate." A genuinely second authored root is rare. So
"this row's ancestry is not in view" (an extra root) and "we branched off a
shared row" (a fork) are opposite situations. Every divergence that arises
from *what was written* — the concurrent-writer and rewind/`api_error`
cases below — is a **fork with a shared prefix**, never an extra root. A
fully loaded, connector-complete transcript is a branching *tree*; the
*forest* framing is really about partial/artifacted loading.

Conversation rows routinely chain THROUGH non-conversation connector rows.
Observed connector types: `attachment` rows (CLI-injected context such as
`date_change` notices and file mentions — in observed sessions every
assistant turn descends from one) and `system` rows (e.g. `api_error`
retry bookkeeping). Any layer that drops connector rows breaks the parent
chain of everything after them.

"Dead segments" (branches with no descendants) arise two ways:

1. **Genuinely abandoned content** — rewind/fork/double-escape flows where
   the user deliberately branched away. Hiding these is correct.
2. **Falsely-dead live conversation** — CLI bookkeeping mis-parents the
   next turn. Verified instance (session `c5b32eda`, 2026-06-10): an API
   call failed (Cloudflare 502); the CLI created an `api_error` system row
   in memory with parent = the leaf at error time (an attachment row,
   since no assistant output existed yet) but did not write it. The retry
   succeeded and the full turn output was appended, chaining normally from
   that attachment row. At the NEXT user turn, the CLI flushed the
   buffered `api_error` row (error-time timestamp, so it appears
   out-of-order in the file) and parented the new user row to it — not to
   the real conversation tip. The entire successful retry output became
   graph-dead even though the user read it and the in-process model
   context contained it. This is provider-side behavior YA can only
   observe and render sanely.

Rendering contract for both cases: the server selects the active tip
timestamp-first (`buildDag`) and re-includes dead branches as sibling
branches in file order (`collectVisibleClaudeEntries`) when they contain
completed tool work OR are falsely dead per the discriminator — the
active branch continues from the fork through a `system` (bookkeeping)
row rather than a user-authored row, so the branch was not abandoned by
user action. Deliberate rewind branches (active branch continues through
a `user` row) stay hidden. The client's `orderByParentChain` is
stable/minimal-motion so missing connector rows can never relocate a
segment (a row moves only when its parent is present later in the same
array).

Resume context loss (verified 2026-06-10, provider-side): `claude
--resume` rebuilds model context by walking `parentUuid` from the chosen
tip, so a falsely-dead segment — the assistant's own completed, user-read
work — is silently absent from the resumed context. Probe: a
`--fork-session` resume of the affected session (claude CLI 2.1.170,
1M-context model, ~367k tokens loaded so nothing was compacted away) was
asked, tools disallowed, about two facts that exist only in the dead
segment and one same-vintage fact from the live branch. The live control
came back verbatim-accurate (and the model quoted exact mechanical detail
from other live turns of the same depth), while both dead-segment needles
were reported absent, with the model explicitly distinguishing
reconstruction from recall. Consequence: after an api_error retry
felicity, a resumed Claude session permanently forgets work it completed
and the user read. Reported upstream:
<https://github.com/anthropics/claude-code/issues/66824>. YA's
mitigation is rendering-side only (the contract above). Adjacent to the
existing API-error unsafe-resume contract.

## Concurrent External Writers (TUI + YA) On One Session File

A Claude session is a single `.jsonl` that any process can open and append to;
there is no lock and no cross-process coordination. When a TUI-started session
is `external` to YA and the user sends from YA anyway, YA's resume becomes a
second writer on that one file. The `external-session-warning` banner
(`packages/client/src/components/ExternalSessionWarning.tsx`) is the
user-facing guard for this; the failure modes below are why it does not fade
until the window is focused and why its copy is hedged.

Reproduced end-to-end (claude CLI 2.1.177, 2026-06-13): seed session `S` with
a codeword, resume `S` in a live TUI (which loads the tip into memory), then
`claude --resume S -p "<second codeword>"` from another process. Findings,
each a contract the rendering and resume-safety code must respect:

- **Resume continues in place; it does not SDK-fork.** `--resume` without
  `--fork-session` returns the *same* session id and appends to the *same*
  file. So "external send" is two writers on one transcript, not two files.
  <!-- verified: claude 2.1.177, 2026-06-13 -->
- **A live process never re-reads the transcript.** The TUI answered only with
  the codeword it learned before the external write — the externally-appended
  turn was invisible to it on screen and in the context it sent next. Any
  in-memory provider owner (TUI, or YA's own SDK process) has this staleness;
  file tailing and the live in-memory branch can diverge. <!-- verified -->
- **Two writers fork the `parentUuid` chain.** Both the external turn and the
  TUI's next turn parented to the same pre-existing leaf, producing two sibling
  branches in one file (and N concurrent writers produce an N-way fork). The
  bytes stay valid — a 4-writer race left 0 malformed lines — so the damage is
  *logical* branch divergence, not file corruption. Atomicity of individual
  line appends does not prevent it. <!-- verified -->
- **A later resume keeps exactly one branch and silently drops the rest.**
  Resuming the forked `S` rebuilt context from a single branch and omitted the
  other entirely, with no error. Which branch survives is not reliably the
  latest write: in the repro the dropped branch was the chronologically-later
  TUI exchange the human had been reading. So the mechanism is knowable and
  reproducible, but *which* completed work goes missing is not predictable from
  the outside — hence the banner promises only *likely* effects. <!-- verified -->

This is the multi-writer companion to the single-writer api_error
"Resume context loss" case above; both end in completed, user-read work
absent from resumed context, and YA can only observe and render, not prevent,
provider-side branch selection.

See also: the provider-neutral ownership model, the Codex equivalent, and the
`owner === "none"` pending-tool ("waiting elsewhere") banner are in
[session-ownership.md](session-ownership.md). The proposed remedy for the
off-branch turns a fork strands — surfacing them and folding a summary of them
into the live working branch on demand — is
[fork-catchup.md](fork-catchup.md).

## Current Problem Areas

Observed user reports:

- YA-owned Claude sessions can stop showing useful activity after more than a
  few turns of autonomous work, while `claude --resume <id>` later reveals that
  substantial work completed. In one observed case, the still-open original YA
  window displayed the interesting turn text and tool runs as work proceeded in
  a Claude TUI resume, but another YA view repeatedly looked stalled.
- After a full YA restart, sessions that were previously YA-owned often enter
  the handoff UI instead of normal Claude resume. After restart there is
  necessarily no old YA-owned process, but that should not make the transcript
  unresumable.

Suspected contributing areas to check before declaring this fixed:

- **Live replay and catch-up:** `Process` keeps only a short two-bucket replay
  window and intentionally excludes `stream_event` messages. Catch-up currently
  reconstructs accumulated assistant text, not the full newer Claude activity
  surface such as thinking deltas, task progress, tool progress, session state,
  prompt suggestions, permission denials, rate-limit notices, or mirror errors.
- **SDK message coverage:** the installed Claude SDK's `SDKMessage` union
  includes many messages beyond the historical `user`/`assistant`/`result`/
  `system status` surface. YA's live pass-through and durable
  `claude-sdk-schema` coverage must be audited together so unknown entries do
  not disappear from history, fail parsing, or leave the UI without a renderer.
- **State-machine intake:** Claude SDK now exposes `session_state_changed`
  (`running`, `requires_action`, `idle`) and other control/status messages.
  YA should decide whether those are stronger turn-boundary evidence than the
  older `result`/iterator-done path, and must not leave a process stuck
  `in-turn` or prematurely idle when the SDK has reported a clearer state.
- **Claude interview forms:** Claude's known `AskUserQuestion` path is now
  surfaced as actionable waiting-input UI with cancel, single-select,
  multi-select, and free-form "Other" answer paths. Claude SDK
  `requires_action` is liveness/state evidence, not proof that an interview
  prompt exists without a matching `AskUserQuestion` control request.
- **DAG and progress parenting:** durable Claude progress messages can affect
  `parentUuid` chains; the reader already has progress-aware DAG logic, but the
  live stream, incremental refresh, and resume-safety checks must use matching
  assumptions.
- **Subscriber failure visibility:** `Process.emit()` catches listener errors
  without logging. That protects peers, but it can hide a broken session
  subscriber or augmentation path that only affects some tabs.
- **Resume blocker scope:** the API-error active-branch guard is intentional,
  but normal "no owner after restart" and "external/TUI process owns this
  session" conditions should remain distinct from "unsafe to resume this
  transcript with Claude SDK".

## Invariants

- Client model-switch UI should require `ownership.owner === "self"` and a
  live YA process id.
- Server model-listing and model-switch routes should operate on active
  process ids, not on session ids alone.
- Claude transcript discovery should not imply control authority. A readable
  session file proves history exists; it does not prove YA can steer,
  interrupt, switch model, change thinking, or inspect live SDK commands.
- Claude transcript discovery does prove enough to attempt normal resume when
  the provider, project, and resume id are known and no explicit unsafe-resume
  blocker applies.
- Claude multiple-choice/cancel/free-form prompts must be observable as pending
  user input with enough metadata for YA to answer them through the SDK control
  path; hiding them in raw TUI/session state is a liveness bug.
- `AskUserQuestion` must not be auto-allowed or auto-denied by permission mode
  or explicit permission rules. Its `toolName` is the provider interview
  discriminator; the UI may show the one to four questions from one call in any
  ergonomic layout, and repeated calls after an answer are just repeated
  pending-input requests.
- Unknown Claude SDK messages must be observable during refresh work: either
  normalized/rendered, deliberately ignored with a documented reason, or logged
  as unsupported drift. A catch-all pass-through is not sufficient when the
  message carries user-visible activity or state.

## Representative Change Types

- Changing Claude session ownership detection or external TUI tracking.
- Moving `/model` or model-switch UI entry points between self-owned,
  external, and stopped sessions.
- Changing Claude SDK process creation, resume, or restart/handoff behavior.
- Adding a provider-side bridge that can control an already-running external
  Claude process.
- Changing Claude live message normalization, `Process` replay/catch-up
  behavior, or durable Claude transcript schemas.
- Changing the handoff-required decision, especially after YA restart or after
  a Claude SDK API-error transcript artifact.
- Refreshing `@anthropic-ai/claude-agent-sdk` in a way that changes message
  types, resume behavior, model/command catalog shape, or control methods.

## Tests That Should Fail On Contract Regressions

- An external/TUI-owned Claude session does not expose the `/model` command or
  model-switch modal from the main session composer.
- A model-switch API call without a live YA process id fails instead of trying
  to infer control from the session transcript.
- After YA resumes or restarts a Claude session into a YA-owned process, model
  controls are evaluated from that new process's advertised capabilities.
- A Claude session whose active-branch tail is an SDK API-error assistant row
  returns handoff-required from normal resume instead of passing the transcript
  back to the Claude SDK.
- A Claude session that was YA-owned before a YA server restart can be normally
  resumed from its persisted session id when its active-branch tail is safe.
- A newly attached YA view of an active Claude process receives recent
  user-visible activity and a truthful liveness/status state even when the
  original tab saw the live events earlier.
- Claude SDK message types that are user-visible or state-bearing have focused
  normalization or rendering coverage, and unsupported message types are not
  silently treated as proof of inactivity.
- `AskUserQuestion` produces a `question` input request, appears to activity
  consumers as `user-question`, carries single- and multi-select answers back
  through `updatedInput`, and ignores permission rules that would otherwise
  allow or deny the tool.
- A Claude session that opens with an `isMeta` local-command caveat followed by
  a slash-command wrapper uses the command and arguments as its automatic title,
  including after loading a persisted summary index from an older YA version.
