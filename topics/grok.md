# Grok Build Provider

This topic tracks integration of xAI's Grok Build (the agentic coding CLI
invoked as `grok`) as a YA provider. Emphasis is on ACP-driven live
supervision for tool activity and thinking visibility, CLI-native effort/model
controls, and (later) history interop from `~/.grok/` artifacts. Grok behavior
is isolated behind `ENABLED_PROVIDERS`; the only shared ACP addition is a
conditional extension-request hook that remains absent for other providers.

Related topics: [claude.md](claude.md), [provider-state-machine.md](provider-state-machine.md), [provider-model-glyphs.md](provider-model-glyphs.md), architecture-mandates.md.

## Current upstream and local surface (2026-07-29)

Grok Build is xAI's terminal-first coding agent. It supports an interactive
TUI, headless mode, subagents, skills, AGENTS.md, hooks, MCP, a sandbox and
permission system, and ACP for embedding in other apps. xAI released the
client source under Apache-2.0 in July 2026; the public source now supplements
the installed binary and state as a first-party compatibility reference.

Local evidence on this host (non-destructive inspection of the installed binary and state):

- Installed version: `grok 0.2.112 (9bbd559437) [stable]`; the stable update
  check also reports 0.2.112 as latest.
- `grok models` advertises only `grok-4.5` and marks it as the default.
- `~/.grok/models_cache.json` describes Grok 4.5 with a 500k context window
  and `high` (default), `medium`, and `low` reasoning efforts.
- `grok agent stdio` remains YA's transport. A live, no-model-call ACP
  initialize probe reported protocol version 1, agent version 0.2.112,
  `grok-4.5`, and commands including `compact`, `context`, `session-info`,
  `deep-research`, `workflow`, and `goal`.
- The base ACP update union now includes transcript-bearing message, thought,
  tool, and plan updates plus command, mode, configuration, and session-info
  metadata updates. YA normalizes the transcript-bearing updates, consumes the
  command inventory, and deliberately ignores metadata-only updates until a YA
  surface needs them.
- Grok also uses `_x.ai/session/update` notifications for provider state such
  as retries and turn completion. Those are operational metadata rather than
  an additional transcript stream.
- Session storage: `~/.grok/sessions/<encoded-cwd>/<uuid>/` containing
  `summary.json`, `updates.jsonl`, `chat_history.jsonl`, `plan.json`,
  `rewind_points.jsonl`, `signals.json`, `feedback.jsonl`,
  `compaction_checkpoints/`, and `subagents/`, plus the top-level
  `session_search.sqlite`. The installed docs call `updates.jsonl` the
  authoritative conversation log for `/load` and restore.

ACP (via the already-vendored `@agentclientprotocol/sdk` and YA's `ACPClient`) is the highest-leverage integration surface. Protocol surfaces:

- `agent_thought_chunk` (thinking/reasoning exposure)
- `tool_call` / `tool_call_update` with `kind` in {"read","edit","delete","move","search","execute","think","fetch","other"}, `locations[]` (file+line follow-along), `content` including `Diff` for edits, raw I/O, status lifecycle
- `plan` updates
- Permission requests (map to YA `onToolApproval`)

This gives first-class visibility into read, edit (with diffs), bash/execute, and thinking — comparable or better structured than current Claude events for supervision use cases.

## 0.2.112 Tool Vocabulary and Rendering Contract

Grok 0.2.112 attaches a versioned `_meta["x.ai/tool"]` object to ordinary
tool-call updates. The matching public `xai-org/grok-build` source is git
`5da6962e4adb9c857f3def762542b52b4ec3e522`, with monorepo `SOURCE_REV`
`2a818575225183d8ca915f5632a09b8067b5156a`. Its package version and the
installed stable CLI are both 0.2.112, so the source schema is applicable to
the runtime traces in this audit.

The canonical envelope is the primary identity contract:

- `label` is the cross-harness grouping/display key.
- `kind` is an open, finer-grained action category; unknown values must remain
  usable.
- `name` is Grok's native model-facing name and remains useful for diagnostics.
- `input` is only a canonical projection. YA merges it with `rawInput` from
  every update for the same `toolCallId`, because edit strings, write contents,
  and some lifecycle fields intentionally remain raw or arrive only once.
- `namespace` is parsed loosely. A namespace added upstream must not make the
  whole tool unusable in YA.

Live ACP and `updates.jsonl` replay use the same Grok-specific normalizer and
therefore have the same externally visible contract:

| Grok action | YA tool name | Result treatment |
| --- | --- | --- |
| `read_file`, `grep`, `search_replace`, `write` | `Read`, `Grep`, `Edit`, `Write` | Existing compatible file/search schemas |
| `run_terminal_command` | `Bash` | Foreground output or background task id |
| `todo_write` | `TodoWrite` | Full post-update todo state |
| backend web search, `web_fetch` | `WebSearch`, `WebFetch` | Existing web result schemas |
| `ask_user_question`, `exit_plan_mode` | `AskUserQuestion`, `ExitPlanMode` | Existing interaction/plan schemas |
| `spawn_subagent` | `spawn_agent` | Existing spawn schema plus native diagnostic text |
| `list_dir`, background output/kill, enter-plan | Native Grok name | Generic activity row; no misleading renderer alias |
| `image_gen`, `image_edit` | `ImageGen`, `ImageEdit` | Generic activity row plus a hidden local-path media candidate |

An update may change its generic ACP title or omit input entirely. The
display name and accumulated input stay stable for the whole call. Terminal
updates emit exactly one result per `toolCallId`, including background-command
launches whose later updates continue reporting progress.

Image generation and editing deliberately do not impersonate `ViewImage`:
their invocation does not have that renderer's input schema. Instead, the
terminal image path is attached as a media candidate for YA's existing
relay-safe materializer. Markdown image links written by Grok remain ordinary
provider text and follow the shared media-rendering policy.

Grok's generated images live outside the project tree. Media capture grants
only the realpath-resolved
`GROK_SESSIONS_DIR/<encoded-project>/<session-id>/images/` root for the
matching Grok project and session. It rejects another provider, project,
session, or a symlink escape; this exception does not add `~/.grok` to the
normal local-file/image allowlist.

Unknown future canonical kinds keep their native name, canonical metadata,
raw input, generic row, and terminal output. Adding a Grok kind should degrade
to useful diagnostics rather than becoming an orphaned or mislabeled call.

## Model and Effort Controls — Recommendation for YA New Session UI

YA's new-session flow (`NewSessionForm.tsx`, `useProviders`, `getAvailableModels()` from the provider, `useModelSettings` + `EFFORT_LEVEL_OPTIONS`, `ModelInfo` + `EffortLevel` / `ThinkingConfig` / `ThinkingOption` in `packages/shared/src/types.ts`) populates a per-provider model dropdown + optional effort/thinking toggle.

From the Grok CLI and cache, which define what the installed binary can run:

- The current visible/default model is `grok-4.5` (display name "Grok 4.5").
- The current model supports `low`, `medium`, and `high` effort, with `high`
  as its default.
- `getAvailableModels()` queries `grok models` for the visible ids, ordering,
  and default, then enriches them from `GROK_HOME/models_cache.json`.
  Object-keyed and older array-shaped caches are both accepted.
- If neither live listing nor cache can be read, YA retains `grok-build` as a
  compatibility fallback for older installations. The fallback does not
  override a readable current catalog.
- YA omits `-m` for the discovered default or the generic `default` alias and
  passes an explicit id for any other selection. It maps the selected YA
  effort to Grok's top-level `--effort` flag; no selection leaves the CLI
  default intact.

No special casing or UI changes are required in `NewSessionForm` or the model settings hooks; the normal per-provider `ModelInfo[]` path is sufficient.

## API Key Billing Boundary

Grok Build should use the user's CLI/browser-login subscription by default, not
an xAI API key inherited from YA's launch environment. YA therefore scrubs
ambient `XAI_API_KEY` during config load and strips xAI API-key names from the
spawned `grok` child by default. This is especially important because Grok STT
can use xAI API billing while Grok Build provider sessions should not
accidentally switch to pay-as-you-go model billing.

If the user intentionally wants Grok Build to use xAI API-key billing, the
Providers settings page exposes a default-off opt-in. That opt-in reinjects
only the ambient `XAI_API_KEY` captured at YA startup; it does not reuse
`YEP_STT_XAI_API_KEY`, so STT can remain on different billing from Grok Build.

## Implementation Phases

The mandate from local rules and architecture docs is to prototype Grok-specific concerns without touching load-bearing shared paths.

**Phase 0 (research, this topic) — complete**
- Local + docs inspection of models, effort flags, ACP surface, session layout (done).
- Model name decision recorded above.

**Phase 1 (live supervision prototype) — landed**

- Add `"grok"` (and/or `"grok-acp"`) to the `ProviderName` union and `ALL_PROVIDERS` list (additive only).
- `packages/server/src/sdk/providers/grok-acp.ts`:
  - Implements `AgentProvider` + `startSession` using the existing `ACPClient`.
  - Spawns `grok agent stdio`, with top-level model/effort flags.
  - Normalizes `SessionNotification` / `agent_thought_chunk` / `tool_call` (kinds + diffs + locations) into `SDKMessage` (thinking blocks + tool_use/tool_result).
  - Wires permission callbacks to YA's `CanUseTool`.
  - Discovers the visible model catalog and metadata from the installed CLI.
  - Maps effort from YA `EffortLevel` to CLI flags where possible.
  - Maps Grok question and plan-approval extension requests to YA pending
    input.
- Register the new provider instance in `providers/index.ts` (additive switch case + `getAllProviders`).
- Extend `ENABLED_PROVIDERS` parsing and the provider-resolution / routes paths (additive; existing providers unaffected when the env var is not set or does not include "grok").
- CLI detection + auth status: `GROK_HOME/bin/grok` and
  `GROK_HOME/auth.json` (read-only checks).
- The shared ACP client exposes a callback only when Grok registers it.
  `Process`, `Supervisor`, message routing, other provider implementations,
  and the client render pipeline remain untouched.

**Phase 2 (history / interop)**
- New scanner: `packages/server/src/projects/grok-scanner.ts` (modeled on `codex-scanner.ts`).
- Minimal schema under `packages/shared/src/grok-schema/` for the multi-file jsonl + sqlite layout (only as needed for list + transcript loading).
- Wire into `ProjectScanner` (additive branch).

**Phase 3 (polish)**
- Update docs (CLAUDE.md provider list, `docs/research/provider-capabilities.md`, README table, competitive matrix).
- Add version expectation (like Codex) + audit note in `AGENTS.md`.
- Tests, mocks in `__mocks__/`, e2e if warranted.
- Publish remote client (per local rules) only after a verified live-supervision win.

**Explicit non-goals for early prototypes (stability protection)**
- No edits to `Process.ts`, `EventBus`, replay buffer logic, or any shared hot path.
- No changes to how other providers are instantiated or how their iterators are wrapped.
- Scanner/history work can be stubbed or behind a separate feature flag initially.
- Do not generalize Grok normalization into other providers without a shared
  contract and evidence.

This structure keeps Grok startup and normalization behind its provider gate;
other ACP providers do not advertise or handle Grok extension requests.

## History Replay Detail Policy

Grok history replay reads `updates.jsonl` as the authoritative restore stream and
normalizes only the transcript-bearing updates. High-churn
`available_commands_update` records are treated as capability evidence, not
message history. In live ACP sessions, the same update feeds the existing
`SlashCommand[]` provider hook so the `/` menu can show Grok commands
immediately while descriptions, argument hints, and Grok skill provenance remain
API-carried optional detail for later UI expansion.

Replay should follow the provider optional-detail dictionary in
[provider-state-machine.md](provider-state-machine.md): map `read_file`,
terminal execution, `grep`, `search_replace`, and `todo_write` to existing YA
`Read`, `Bash`, `Grep`, `Edit`, and `TodoWrite` schemas when the fields are
one-to-one enough; otherwise keep compact Grok-specific detail rather than
forcing misleading generic shapes. Do not copy arbitrary per-update `_meta`
telemetry. The stable `x.ai/tool` identity subset is retained under
`input.grokTool` so future renderers and diagnostics can distinguish native
name, label, kind, namespace, read-only intent, and schema version without
depending on raw ACP envelopes.

## ACP Extension Request Contract

Grok uses reverse ACP extension requests for two blocking interactions that
are not ordinary session updates:

- `_x.ai/ask_user_question` is mapped to YA's existing
  `AskUserQuestion` pending-input surface. Multiple choice, multi-select,
  cancel, and free-form "Other" text round-trip to Grok's accepted/cancelled
  response shape. A free-form-only answer is returned as `Other`; accompanying
  text and selected-option previews use Grok's per-question annotations.
- `_x.ai/exit_plan_mode` is mapped to YA's existing `ExitPlanMode` approval.
  Approval returns `approved`; denial returns `cancelled` with feedback when
  the user supplied it.

Both requests fail closed when the session is aborted, no approval callback is
available, the question payload is unusable, or YA handling throws. Unknown
Grok extension methods remain protocol errors instead of receiving a
success-shaped empty response. The shared ACP client installs an extension
handler only when a provider registers one, preserving the prior behavior for
other ACP providers.

YA's pinned `@agentclientprotocol/sdk` 0.12.0 already supports extension
methods and the standard update variants Grok currently uses, so this refresh
does not require an ACP dependency upgrade.

## Open Questions & Epistemic Status

- Three successful Grok 4.5 medium-effort sessions exercised the 0.2.112
  vocabulary against a disposable project: read/list/grep/write/edit/bash,
  todo updates, web search/fetch, image generation/editing and Markdown links,
  subagent spawn, background start/output/kill, user question, enter-plan,
  plan-file write, and exit-plan. A spawned read-only subagent supplied a
  fourth persisted session. This replaces the earlier HTTP 402 evidence gap.
- The public schema lists `goal_update`, but the requested goal-oriented live
  run used `todo_write`; no distinct `goal_update` event was observed. YA
  therefore has no speculative renderer mapping for it.
- Grok questions in plan mode can advertise provider-specific "Chat about
  this" and "Skip interview" outcomes. YA currently exposes the shared
  answer-or-cancel surface only.
- Evolution of the on-disk multi-file + sqlite layout during the beta (treat as unstable; ACP live path is the stable contract for supervision).

Claims above are grounded in the installed binary/state, live no-cost ACP
probes, successful model/tool streams, persisted replay, and the matching
0.2.112 first-party public source.

## Steering, Interject, and /btw Forking Support

YA has two distinct but complementary mechanisms for "talking to an agent that is already working":

1. **In-turn steering / interjection** (`AgentSession.steer(message)` returning `Promise<boolean>`):
   - Sends additional user input into the *currently running turn* without cancelling it.
   - YA's `Process` prefers this path (when `in-turn` and `supportsSteering`) over simply queuing the message for after the turn ends.
   - The boolean return tells the caller whether the provider accepted it for immediate steering.

2. **/btw aside fork** (full parallel subsession):
   - YA creates an entirely new provider session (separate `startSession` call) that runs alongside the parent.
   - Special UI (split-pane or stacked "asides", `[YA /btw aside]` markers, transfer between mother/aside composers, `/done` to close).
   - Controlled by the client-side `BTW_ASIDE_FORK_PROVIDERS` whitelist + `providerSupportsBtwAsideFork`.
   - This is the "fork/subsession based btw-like flow".

Grok Build's own TUI makes the distinction very clear (from `~/.grok/docs/user-guide/03-keyboard-shortcuts.md`):

> When the agent is generating, `Ctrl+Enter` from the prompt sends a **mid-turn interjection without cancelling the turn**.
>
> | `Ctrl+Enter` | Interject (continues the current turn) |

`Ctrl+C` is the cancel/interrupt.

### ACP Primitives Available

- `session/prompt` — can be called more than once. Agents are expected to handle follow-up prompts while a turn is active (exactly the interject use case).
- Experimental `session/fork` (takes `sessionId`) — maps directly to YA's aside model.
- `session/cancel` — the interrupt path (already used by Gemini-ACP etc.).

Current state in YA's ACP providers (Gemini-ACP etc.): `supportsSteering = false` because the current `ACPClient.prompt()` wrapper + Gemini usage is "one prompt + wait for completion".

### Feasibility & Plan for the Grok Provider

**Good news**: Grok Build's native behavior + ACP surface makes this one of the *better* providers for both mechanisms.

Recommended approach (add to the Phase 1 implementation in the existing plan):

- Set `readonly supportsSteering = true;` on the Grok provider.
- Implement `steer(message)` in the `AgentSession` return value by calling a second `connection.prompt(...)` (or extend `ACPClient` with an `interject(sessionId, text)` helper that re-uses the same session). Return `true` on success.
- For the full `/btw` fork experience:
  - Add `"grok"` to `BTW_ASIDE_FORK_PROVIDERS` in `SessionPage.tsx` (YA-level forking will just work once the provider can start sessions).
  - Later (when Grok advertises the capability), prefer the native ACP `ForkSessionRequest` for the aside.
- `interrupt()` can be wired to `session/cancel` (or whatever Grok's ACP equivalent is).

A brand-new "explicit btw surface" is probably unnecessary. The existing `/btw` slash command + composer routing + the `steer` primitive should give users the same power as the TUI's Ctrl-Enter interject, plus the richer aside UI that YA already has for Claude/Codex users.

If Grok's ACP agent treats a second `prompt` during a turn as "start a new turn instead of interject", we may need a small protocol extension or a Grok-specific interject RPC — but given that the TUI itself offers the feature, the underlying agent loop is almost certainly already doing the right thing.

Update the tracking checkboxes below to include these items.

## Grok Build Sources for Implementers

**Critical for any future agent or human implementer:**

For the exact released binary, prefer its bundled docs and runtime probes:

- `~/.grok/docs/user-guide/`
  - `03-keyboard-shortcuts.md` — especially the "During an active turn" section documenting `Ctrl+Enter` interject.
  - `05-configuration.md`
  - `14-headless-mode.md`
  - Other files as they appear (skills, modes, ACP integration notes, etc.).

Also authoritative on this host:
- `~/.grok/bin/grok --help`
- `grok models`
- `~/.grok/models_cache.json`
- Actual session directories under `~/.grok/sessions/...` (multiple `.jsonl` files per session + `session_search.sqlite`).

The first-party `xai-org/grok-build` repository is the definitive readable
reference for agent-loop, ACP extension, tool, and TUI behavior. It is synced
periodically from an internal monorepo and may trail the released binary, so
compare its package version and `SOURCE_REV` against `grok --version` before
using a source finding as evidence for the installed patch.

## Historical Progress Snapshot (2026-05-26 Takeover)

Current live repo state has a Grok ACP provider at a verified Phase 1 point.
It has landed as an isolated provider integration, with history replay left as
explicit follow-up work.

What is already in place:

- `"grok"` is added to the shared and server provider names and provider list.
- `packages/server/src/sdk/providers/grok-acp.ts` starts `grok agent stdio`
  through the existing ACP client.
- Provider registration is wired through the server provider catalog and
  `ENABLED_PROVIDERS` filter path.
- The new-session client can see provider metadata once the server reports it;
  client provider badges/filter colors/registry are being filled in.
- Grok summary/session lookup is implemented in
  `packages/server/src/sessions/grok-reader.ts`, using Grok's native session
  ID (`summary.info.id` or the session directory basename) rather than a
  synthetic YA ID.
- Rich live ACP normalization now preserves `agent_thought_chunk` as thinking
  blocks, tool names mapped from kind/title (`Read`, `Bash`, etc.), tool
  kind/status, locations, raw input/content, and structured read/bash results.
- Active-turn steering is implemented by sending a second ACP
  `session/prompt` on the same live Grok session while keeping YA's update
  drain open until all active Grok prompt calls settle.
- Client provider registry/badges/filter colors/model glyphs are wired.
- `topics/grok.md` remains the active progress tracker; related reliability
  context lives in [`session-liveness.md`](session-liveness.md).

Issues found during takeover:

- Focused provider tests were failing before refinement:
  auth parsing treated any nonempty `auth.json` as authenticated, and mocked
  ACP tests expected connection side effects before advancing the async
  iterator.
- `grok models` on this host reported `grok 0.1.220`, logged in via
  grok.com, default `grok-build`, and available `grok-build` plus
  `grok-build-latest`. This changed in the 0.2.3 refresh below.
- `grok agent stdio` accepts top-level `--effort`/`-m` before `agent`; putting
  `--effort` after `agent` is rejected by the CLI. Provider args should keep
  those flags before `agent`.
- The native-session-ID behavior is live-verified: the localhost new-session
  API blocks until Grok returns its own ACP session id, and process/metadata
  lookup works using that id.

Verification completed during takeover:

1. `grok-acp.test.ts` passes with 23 focused tests.
2. `REAL_GROK_TESTS=true FOREGROUND=1` real smoke passed against the installed,
   logged-in CLI.
3. `POST /api/projects/.../sessions` on localhost:3400 returned native Grok
   ids such as `019e6603-889a-7451-a3f1-e44f37cfb125`, and the matching
   `~/.grok/sessions/%2Flocal%2Fgraehl%2Fyepanywhere/<id>/summary.json`
   existed.
4. `/api/projects/.../sessions/<native-id>/metadata` and
   `/api/sessions/<native-id>/process` both resolved the same Grok id while
   the process was live.
5. A WebSocket session subscription observed thinking, `Read` and `Bash`
   tool uses, `kind`, `locations`, execute `status` lifecycle, tool results,
   structured file/stdout result payloads, and final assistant text.
6. Temporary Grok-provider sessions from this topic were aborted/removed from
   `~/.grok/sessions`, YA session metadata, and recents; no Grok YA processes
   or stale Grok debug processes remained after cleanup.

Gap at that snapshot, now resolved:

- `GrokSessionReader.getSession()` was summary-only. It now replays
  transcript-bearing `updates.jsonl` records and uses the same tool
  normalization as live ACP.

## Open Provider Work

Grok provider work remains broader than modal prompt/interview handling:

- **Source refresh:** the provider-refresh audit currently marks Grok ACP as
  current through installed and public-source 0.2.112. Re-run it when
  the installed model/command catalog, ACP dependency, or first-party request
  and notification enums change.
- **Broader replay corpus:** current `updates.jsonl` replay covers the
  transcript and 0.2.112 vocabulary observed in the live coverage sessions.
  Preserve generic fallbacks for valid future tool kinds and provider metadata
  that have no YA surface.
- **Default-enable decision:** keep Grok isolated behind provider gating until
  ACP stability and ongoing live prompt behavior are good enough for ordinary
  use.

## 0.2.3 Refresh and Steering Smoke (2026-05-28)

The local Grok install was updated to `grok 0.2.3 (14d81fd87) [stable]`, and
the local user-guide docs were refreshed at `2026-05-28 06:25 UTC`.

Observed changes relevant to YA:

- `grok models` and `models_cache.json` now agree on a single visible model:
  `grok-build`. The earlier `grok-build-latest` CLI listing is gone, so YA's
  single-model provider policy now matches the current CLI surface.
- `grok agent stdio` remains the documented ACP transport. Top-level
  `--effort` is still accepted by the main CLI; the `agent` command now also
  documents `-m/--model` and `--reasoning-effort`, while the `stdio`
  subcommand itself still takes no flags.
- The keyboard docs still document `Ctrl+Enter` as an active-turn interject
  that continues the current turn.
- The sessions doc now describes more per-session files and calls
  `updates.jsonl` the authoritative restore log. YA's current summary reader is
  unaffected, but full transcript replay should use `updates.jsonl` first.

Live steering smoke passed against the 0.2.3 CLI through YA's
`GrokACPProvider` rather than a raw ACP toy client:

1. Created a disposable cwd under `.artifacts/grok-steer-cwd-*`.
2. Started a real `grok agent stdio` session with native Grok session id
   `019e6d49-7bdf-7da2-acaf-20b980bfe0db`.
3. Advanced YA's iterator until the first prompt was in flight, then called
   `session.steer()` with a unique `STEER_*` token.
4. `session.steer()` returned `true`, the drained assistant response contained
   both the initial `START_*` token and the interjected `ACK_*` token, and the
   turn ended with a `result` message.
5. The smoke removed the disposable cwd, the matching
   `~/.grok/sessions/<encoded-cwd>` directory, and sqlite `session_docs` row;
   a follow-up check found no `grok-steer-cwd` or `yepanywhere` Grok rows.

YA server restart reattachment smoke also passed for the user-confirmed native
Grok id `019e6d4a-ffa9-7651-ba4e-c4baf2d772b4` in project
`/local/graehl/trtllm-speculative/draft` after `reyep` restarted the server.
`/api/projects/<projectId>/sessions/<native-id>/metadata` and the detail route
both resolved the session as provider `grok`, model `grok-build`, owner `none`,
and title "Bearings Research Paper Reading Session Analysis". Detail still
returns an empty `messages` array because full Grok `updates.jsonl` transcript
replay remains Phase 2 history work.

Bundled references for future released-binary checks:

- Read:
  `~/.grok/docs/user-guide/15-agent-mode.md`,
  `17-sessions.md`, `03-keyboard-shortcuts.md`, and related files.

## 0.2.111 and Open-Source Refresh (2026-07-23)

The local install is `grok 0.2.111 (94172f2aa4) [stable]`. xAI's public
`xai-org/grok-build` checkout was inspected at git
`a5727c5960452e7527a154b25cb5bf00cda0545e`; its recorded source revision is
`30192d2eef5d91a8fff0e53957de5bd05b43398c` and its package version is
0.2.110. The installed 0.2.111 changelog is primarily TUI fixes, but the
one-release source lag remains an explicit evidence boundary.

This refresh enacted four YA-visible changes:

1. Model discovery now follows `grok models` and enriches the visible catalog
   from `GROK_HOME/models_cache.json`. The current catalog is the single,
   default `grok-4.5` model with a 500k context window and
   low/medium/high effort metadata. `grok-build` remains only as an unreadable-
   catalog fallback for old installations.
2. `GROK_HOME` now consistently controls binary, auth, and model-cache lookup.
3. Grok's `x.ai/ask_user_question` and `x.ai/exit_plan_mode` reverse requests
   reuse YA's pending-question and plan-approval flows. This was the material
   compatibility gap exposed by the newly public first-party source.
4. The standard update union and `_x.ai/session/update` notifications were
   audited. YA already handles the transcript-bearing standard updates; the
   new mode/config/session-info and xAI lifecycle variants are metadata-only
   for current YA surfaces.

The installed CLI completed ACP initialize and session creation without a
model call. A real prompt reached xAI but returned HTTP 402 because the current
account balance is exhausted, so the refresh makes no claim of a successful
0.2.111 assistant/tool stream. Unit tests cover model normalization and both
reverse-request bridges.

## Tracking

The checkboxes below live in the committed topic doc and can be updated in
place. Liveness-specific evidence from the takeover also informs
[`session-liveness.md`](session-liveness.md).

- [x] Add "grok" / "grok-acp" to `ProviderName` + `ALL_PROVIDERS` (additive)
- [x] New `grok-acp.ts` ACP-based provider with dynamically discovered models
  and normalized events (thinking + tools + approvals)
- [x] Effort / `--effort` mapping from YA `EffortLevel` using top-level CLI args
- [x] Auth/install detection and `isAuthenticated` using `~/.grok/` state, including nested auth profiles
- [x] Register + `ENABLED_PROVIDERS` wiring (no impact on default "all")
- [x] Native Grok session ID used in new-session URL and recoverable through provider metadata/process lookup
- [x] End-to-end live supervision test (visible read/bash/thought events in a desktop WebSocket subscription)
- [x] Rich ACP event fidelity test: thoughts, tool kind/status, locations, execute output, and structured read/bash results
- [x] Active-turn interject/steering via repeated ACP prompt (mocked coverage
  and 0.2.3 live smoke passed)
- [x] 0.2.3 CLI/docs refresh audited and recorded
- [x] 0.2.111 CLI/cache/ACP and public 0.2.110 source audited
- [x] 0.2.112 installed CLI, matching public source, canonical tool metadata,
  full live vocabulary, and persisted replay audited
- [x] Live and replay tool lifecycles share stable canonical normalization,
  compatible YA renderer schemas, one terminal result, and image media
  candidates
- [x] Prompt/interview and plan-exit extension requests mapped to YA pending
  input
- [x] Dynamic model catalog reconciled with the current local Grok binary and
  cache
- [ ] (Phase 2) `grok-scanner.ts` + minimal schema for project discovery —
  session listing and full `updates.jsonl` transcript replay exist
- [ ] Docs updates + version pinning note — topic and `CLAUDE.md` provider list updated; broader README/provider capability docs not done
- [ ] Decision point: promote "grok" to default-enabled once ACP surface proves stable

A multi-session implementation effort may track itself in a gitignored private
task file; that file references this committed topic, not the reverse.

---

Topic: grok

<!-- epistemic status: installed 0.2.112 binary/cache + successful Grok 4.5
ACP/tool sessions + matching public xai-org/grok-build 0.2.112 source as of
2026-07-29; provider remains gated -->
