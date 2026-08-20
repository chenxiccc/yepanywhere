# Provider Refresh

> Provider refresh is YA's discipline for updating provider-facing protocol
> references, model and command catalogs, schema assumptions, and fallback
> constants when an upstream CLI, SDK, or harness change affects YA-visible
> behavior.

Topic: provider-refresh

Related topics: [claude](claude.md), [grok](grok.md),
[opencode-backend](opencode-backend.md),
[pi-provider](pi-provider.md),
[provider-state-machine](provider-state-machine.md),
[provider-model-glyphs](provider-model-glyphs.md),
[cost-efficiency](cost-efficiency.md).

## Contract

Provider release numbers are refresh triggers, not proof that YA behavior must
change. The thing to refresh is the provider surface YA actually consumes:

- startup command, flags, environment filtering, and authentication state;
- model catalog, default model, effort/thinking metadata, service tiers, and
  fallback constants;
- provider command inventory, steering, interrupt, compaction, permission, and
  session-resume controls;
- live protocol events, generated protocol types, event-normalization code, and
  approval/user-input request shapes;
- durable transcript, session index, storage schema, and reader coverage;
- UI-facing provider/model glyph rules only when the model ids users see have
  changed enough to make the existing rendering misleading.

An installed version may be newer than a recorded/expected version without
forcing code changes only when a refresh probe shows no YA-visible difference.
Record that evidence in this topic or the provider topic and keep a concrete
next trigger. Do not leave or lower a declared version just to silence work
when generated types, runtime probes, model catalogs, or schema coverage have
actually changed.

Cost and credential boundaries still apply during refresh work. Do not turn a
subscription-backed provider into an API-billed provider, or pass an ambient API
key to a CLI that normally uses browser/subscription auth, unless the user made
that choice explicit. See [cost-efficiency](cost-efficiency.md).

## Generic Refresh Loop

1. Identify the provider-owned sources of truth. Separate generated protocol
   files, live model/command catalogs, package APIs, local CLI docs, and durable
   transcript schemas.
2. Probe the current install. Capture the exact version, relevant `--help`
   output, model list, generated protocol check, and a small session/export
   sample when schema drift is the risk.
3. Diff YA-visible shape, not raw prose. Prefer normalized fingerprints:
   model ids plus metadata fields YA uses; flag names and accepted positions;
   generated file add/remove/change list; event or part-type coverage counts;
   package current/wanted/latest; schema parse failures or unknown entry counts.
4. Classify the result:
   - **No-op evidence**: version changed, but all consumed surfaces are stable.
     Record the probe and allow the recorded version to lag until the next
     trigger.
   - **Doc refresh**: comments, topic evidence, or fallback rationale are stale,
     but runtime behavior is still correct.
   - **Source refresh**: generated files, package APIs, hardcoded fallback
     constants, command flags, normalization, or tests need edits.
   - **Design refresh**: a new provider control surface exists but adopting it
     changes architecture or product behavior.
5. Enact source refreshes only after the provider-specific gate is satisfied.
   Codex compatibility edits, for example, are covered by the Codex version bump
   audit rule in `AGENTS.md`: the read-only drift check is allowed immediately;
   code edits should be explicitly approved.

## Pi

YA drives the user's installed `pi` binary over RPC. Root `package.json`
`yepAnywhere.piCli.compatibleThroughVersion` records the latest Pi CLI release
whose startup flags, consumed RPC shapes, lifecycle events, model fields, and
session JSONL assumptions were checked. It is an audited-through marker, not a
pin or minimum version.

After updating Pi, run the opt-in installed-binary check documented in
[pi provider](pi-provider.md#installed-binary-compatibility-check). Compare the
matching upstream release tags when the version changed; the real zero-token
probe covers the production model-discovery command but intentionally does not
exercise authenticated assistant events or persisted sessions.

Current refresh, 2026-08-20: official `v0.82.1..v0.84.2` preserves Pi's
published JavaScript bin entry and the RPC commands, response fields,
`agent_settled` boundary, and v3 coding-agent session assumptions consumed by
YA. The 0.84.0 delta-only `message_update` change matches YA's existing
accumulators, and the 0.84.2 Windows zero-token probe completed successfully.
Root compatibility is recorded through Pi 0.84.2.

## Codex

YA's active Codex backend is the installed `codex` CLI app-server path.
App-server generated types and JSON-RPC probes are the load-bearing refresh
inputs.

Former path note: YA previously carried `@openai/codex-sdk` and older docs
described that package as the Codex backend. It is no longer relevant to the
active provider or periodic Codex refresh flow. Do not fetch, mirror, or
regenerate an SDK replica for Codex refresh work unless the backend is
intentionally redesigned to import that package again.

Primary sources:

- root `package.json` `yepAnywhere.codexCli.expectedVersion`;
- root `package.json` `yepAnywhere.codexCli.compatibleThroughVersion`;
- `codex --version`;
- `scripts/update-codex-protocol.mjs`;
- `packages/server/src/sdk/providers/codex-protocol/generated/`;
- `packages/server/src/sdk/providers/codex-protocol/index.ts`;
- `packages/server/src/sdk/providers/codex-protocol/README.md`;
- `packages/server/src/sdk/providers/codex.ts`;
- `packages/shared/src/codex-schema/`;
- `topics/codex-permission-mode.md` for approval/sandbox coupling and live
  turn-boundary invariants;
- persisted JSONL under `~/.codex/sessions/`.

Routine probes:

```bash
codex --version
pnpm codex:protocol:check
```

Protocol generation gives each invocation an ephemeral `CODEX_HOME` under the
repository's `node_modules/.cache`. This keeps Codex's startup-time arg0
janitor away from the shared home used by live sessions, while preserving all
Codex stderr as verification output. The ephemeral home and generated output
must be removed after both successful checks and detected protocol drift.

For a no-token model catalog check, query `codex app-server --listen
stdio://`, send `initialize`, send `initialized`, then call `model/list`.
`scripts/probe-codex-app-server-turns.mjs` is useful for steering/interrupt
contract checks, but it starts a real model turn and is not a routine catalog
probe.

Difference detectors:

- `pnpm codex:protocol:check` exits nonzero or lists generated file drift.
- `model/list` ids or fields consumed by `normalizeModelList()` differ from
  `PREFERRED_MODEL_ORDER`, fallback constants, tests, or UI expectations.
- Session JSONL adds entry or payload shapes that fall through only because
  `parseCodexSessionEntry()` returns raw unknown entries.
- App-server turn, steer, interrupt, approval, user-input, raw-item, or token
  usage notifications change shape.
- `turn/start` approval, `sandboxPolicy`, or named `permissions` fields change
  shape or sticky-default semantics in a way that could break
  [codex-permission-mode](codex-permission-mode.md).
- Server startup warns that detected Codex version differs from
  `expectedVersion`; this alone is a trigger to run the checks above.

`expectedVersion` records the Codex CLI version YA's checked-in app-server
protocol subset was last audited against. It is not a minimum supported version:
older installs may continue to work when YA does not need newer protocol fields,
and version-sensitive behavior should be capability- or version-gated where
possible.

Current source refresh, 2026-08-10:

- Installed Codex is `0.147.0`; the official `rust-v0.147.0` source is commit
  `be6e8eac029b183056b7e4402879f15d2c85f61b`. Root compatibility and
  expected-protocol markers now record `0.147.0`.
- Regeneration adds `ThreadSection` and changes six files in YA's checked-in
  app-server subset. Threads replace `isPinned` with section metadata; image
  generation, encrypted function arguments, MCP read-only hints, and the
  legacy read-path alias are additive or string-compatible metadata that YA
  does not consume. Turn start, steer, interrupt, and completion shapes used by
  YA are unchanged.
- `ToolRequestUserInputParams.isBlocking` is the one consumed behavioral
  addition. YA preserves the flag in its pending-input request and treats a
  missing field from pre-0.147 app servers as blocking, matching Codex's legacy
  deserialization contract. A non-blocking request is allowed to wait for an
  explicit browser answer; automatically submitting an empty answer would
  require a separate interaction/countdown design rather than a compatibility
  fallback.
- The no-token `model/list` probe returns the same seven visible models as
  0.146.0. Sol remains the default; effort, modality, personality, service-tier,
  and 5.4-to-Terra / 5.4-Mini-to-Luna migration metadata are already covered by
  YA's catalog normalizer and fallbacks.
- The active 0.147.0 rollout used for the reported lost-message investigation
  parses cleanly: 24,395 entries, 132 paired user events, 132 normalized
  provenanced user turns, no malformed lines, and no audit exceptions. The
  full local census also had no parse failures; its two exceptions are old
  April rollouts with pre-existing unpaired events, not 0.147 schema drift.
- Codex core gained an acknowledged user-input admission helper, but app-server
  still exposes YA's existing `turn/start` and `turn/steer` response contracts.
  No new acknowledgement route or response field is available for YA to adopt.

Status: Codex 0.147.0 app-server, model-catalog, and persisted-transcript
compatibility is refreshed. The earlier active-turn ID recovery remains the
app-server control fix for heartbeat or other steering races.

Current source refresh, 2026-08-02:

- Installed Codex and npm `@openai/codex` `latest` are `0.146.0`. The official
  `rust-v0.146.0` source is commit
  `e363b08c9175ac1cbe5893615dd2cb9ddf95043b`; root compatibility and expected
  protocol markers now record `0.146.0`.
- Regeneration changes three files in YA's checked-in app-server subset:
  plugin-supplied skills can carry remote icon URLs, threads carry their pinned
  state, and command-execution items identify a trusted plugin script. These are
  additive metadata fields that YA does not yet consume, so provider controls
  and normalizers need no compatibility change.
- The no-token `model/list` probe returns the same seven-model catalog and
  consumed metadata as 0.145.0: Sol, Terra, Luna, GPT-5.5, GPT-5.4,
  GPT-5.4-Mini, and GPT-5.3-Codex-Spark. Sol remains the default; effort,
  modality, personality, and service-tier metadata still match YA's catalog
  normalizer and fallbacks.
- The persisted transcript census found two 0.145-era multi-agent shapes that
  the prior audit missed. YA now retains `inter_agent_communication_metadata`
  as non-rendered provider metadata and renders persisted `sub_agent_activity`
  as the same visible system activity used for live app-server items. All
  1,362,565 lines across 681 local Codex rollouts validate after the schema
  refresh.

Status: Codex 0.146.0 app-server and persisted-transcript compatibility is
refreshed; no model-catalog, permission, or turn-control change is required.

Current source refresh, 2026-07-23:

- Installed Codex and npm `@openai/codex` `latest` are `0.145.0`. The official
  `rust-v0.145.0` source is commit
  `25af12f7e61572b0bc18ddb1008be543b91519b0`; root compatibility and expected
  protocol markers now record `0.145.0`.
- `pnpm codex:protocol:check` found two added and fifteen changed files in YA's
  checked-in subset. Regeneration adds `ResponseItemId` and `SleepItem`; input
  content admits audio; web search can carry structured results; thread
  history exposes direct-input readiness and backward cursors; fork/resume,
  usage, workspace-root, and MCP app-context types match the current server.
- The new fields are additive or stronger aliases for values YA already treats
  opaquely. YA does not send the new optional fork, audio, or runtime-workspace
  controls, and no normalizer or provider-control change is required.
- The no-token `model/list` probe contains Sol, GPT-5.5, Terra, Luna, GPT-5.4,
  GPT-5.4-Mini, and GPT-5.3-Codex-Spark. GPT-5.4 and GPT-5.4-Mini return after
  their 0.144.6 removal, so YA now restores both in the fallback catalog for
  0.145.0 and newer while preserving the reduced fallback for 0.144.6 through
  0.144.x.

Status: Codex 0.145.0 app-server protocol compatibility is refreshed in
generated source, and its version-gated fallback matches the live catalog.

Current source refresh, 2026-07-19:

- Installed Codex and npm `@openai/codex` `latest` are `0.144.6`. The official
  `rust-v0.144.1..rust-v0.144.6` source diff changes no generated app-server
  protocol type, and `pnpm codex:protocol:check` remains clean. The no-op audit
  advances `compatibleThroughVersion` to `0.144.6`; `expectedVersion` remains
  `0.144.1` because the checked-in subset did not regenerate.
- The no-token `model/list` catalog now contains Sol, Terra, Luna, GPT-5.5, and
  GPT-5.3-Codex-Spark. GPT-5.4, GPT-5.4-Mini, GPT-5.3-Codex, and GPT-5.2 are no
  longer advertised. YA keeps the original 0.144.0-0.144.5 fallback for those
  executables and uses the reduced catalog for 0.144.6 through 0.144.x. The
  real-turn probe was also corrected to read the current paginated `data`
  response.
- The official 0.144.6 hotfix corrects Sol, Terra, and Luna context windows to
  272,000 tokens. YA now uses that value for live normalized and fallback
  GPT-5.6 model metadata while retaining the older 258,000-token default for
  earlier or unidentified Codex models.
- The persisted transcript census found `thread_rolled_back`, an operational
  event YA does not render but must retain in the schema. After adding it, all
  983,521 lines across 467 local Codex rollouts validate.
- Non-generated upstream drift preserves acknowledged model and reasoning
  effort across thread resume. `ModelMessages` also gained optional
  `auto_review.policy`; it is model-manager copy, not a new YA app-server event
  or persisted transcript type.

Status: Codex 0.144.6 runtime/catalog compatibility is refreshed. No new
app-server control or user-visible message renderer is required.

Current source refresh, 2026-07-10:

- Installed Codex is `codex-cli 0.144.1`. Root `package.json` now records
  `yepAnywhere.codexCli.expectedVersion` and `compatibleThroughVersion` as
  `0.144.1`; `pnpm codex:protocol:check` remains clean.
- The no-token app-server `model/list` probe is unchanged from 0.144.0:
  `gpt-5.6-sol` remains the default, followed by `gpt-5.6-terra`,
  `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and
  `gpt-5.3-codex-spark`, with the same reasoning-effort and service-tier
  surface consumed by YA.
- A full Zod audit of 1,342 persisted Codex rollouts now validates all
  1,875,103 JSONL lines. Schema coverage was added for code-mode tool-search
  items, `world_state`, `patch_apply_end`, `thread_settings_applied`, the
  other observed operational event discriminants, and nullable primary rate
  limits.
- Codex Desktop code-mode rollouts persist an outer `custom_tool_call` named
  `exec`, raw JavaScript orchestration input, and text content-block outputs.
  YA now uses a standalone fail-closed recognizer for direct literal
  `tools.<name>(...)` calls. A single recognized call reuses the canonical
  Read/Bash/Edit renderer; multiple calls remain an explicit Exec group; and
  unknown JavaScript keeps the generic fallback. Both live app-server events
  and persisted reloads share this normalization, and the recognizer never
  evaluates provider code.
- Adjacent `patch_apply_end` events have provider-native call ids that differ
  from the outer code-mode call id. YA associates structured changes only
  when exactly one recognized apply-patch call is pending, preserving the raw
  fallback when correlation is ambiguous.

Status: Codex 0.144.1 app-server, persisted transcript schemas, and code-mode
tool rendering refreshed; no model-catalog or provider-control change was
required.

Current source refresh, 2026-07-09:

- Installed Codex is `codex-cli 0.144.0`. Root `package.json` now records
  `yepAnywhere.codexCli.expectedVersion` and `compatibleThroughVersion` as
  `0.144.0`.
- `pnpm codex:protocol:check` reported four new and thirteen changed generated
  files. The refreshed subset adds extracted web-search and image-generation
  item types, thread history/extra fields, provider-model fallback control,
  custom multi-agent mode hints, session-budget errors, richer MCP app context,
  and direct `lastTurnId` fork boundaries. YA does not send the new optional
  thread controls; existing web-search/image item fields remain compatible.
  `thread/rollback` is deprecated but still available, so adopting direct fork
  boundaries is a design follow-up rather than a 0.144 compatibility blocker.
- App-server `model/list` added `gpt-5.6-sol`, `gpt-5.6-terra`, and
  `gpt-5.6-luna`. It marks Sol as default with low reasoning effort and exposes
  `max` plus `ultra` effort where supported. YA now ranks Sol first and uses it
  as the fallback default for CLI 0.144+, while preserving the GPT-5.5 fallback
  catalog for 0.124 through 0.143 installs.
- Compact model badges use semantic glyphs for the named 5.6 variants:
  `Cd ☀` (Sol), `Cd ♁` (Terra), and `Cd ☾` (Luna).
- Codex's best-effort shared arg0-temp janitor emitted `Directory not empty`
  while concurrent Codex sessions populated the shared home. Protocol
  generation now uses an isolated ephemeral Codex home, so routine checks stay
  warning-free without hiding other Codex stderr.

Status: Codex 0.144 compatibility, GPT-5.6 model defaults/catalog, and compact
glyphs refreshed; no additional provider runtime change is required.

Current source refresh, 2026-06-29:

- Installed Codex is `codex-cli 0.142.4`; npm `@openai/codex` `latest` is
  `0.142.4`. Root `package.json` records
  `yepAnywhere.codexCli.expectedVersion` and
  `compatibleThroughVersion` as `0.142.4`.
- `pnpm codex:protocol:check` initially reported stale checked-in generated
  files: `LegacyAppPathString.ts`, `ResponseItem.ts`,
  `v2/ThreadForkResponse.ts`, `v2/ThreadResumeResponse.ts`,
  `v2/ThreadStartParams.ts`, `v2/ThreadStartResponse.ts`, and
  `v2/TurnStartParams.ts`. Regenerating the app-server subset made the check
  clean.
- YA-visible protocol drift is generated-only in this slice: path-conversion
  comment wording changed; `ResponseItem` no longer gives
  `compaction_trigger` an internal metadata passthrough field; and
  `multiAgentMode` on thread/turn params and responses is now deprecated or
  ignored in favor of Ultra reasoning effort. YA does not set
  `multiAgentMode` and does not consume `compaction_trigger` metadata, so no
  provider runtime change is indicated.
- App-server `model/list` returned the same visible YA model set:
  `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and
  `gpt-5.3-codex-spark`; `priority` service tier remains on `gpt-5.5` and
  `gpt-5.4`.

Status: Codex 0.142.4 compatibility refresh complete in generated source; no
new runtime behavior change was introduced.

Previous source refresh, 2026-06-16:

- Installed Codex is `codex-cli 0.140.0`; repo expected version is `0.140.0`.
- `pnpm codex:protocol:check` is clean after regenerating the checked-in
  app-server subset. Notable protocol drift from the 0.139 target: generated
  `AgentMessageInputContent` now admits `input_text`; `ThreadSource` is now
  provider-defined `string`; `ToolRequestUserInputParams` gained
  `autoResolutionMs`; `ThreadStartParams` gained selected capability roots; and
  `ThreadItem` gained `subAgentActivity`.
- App-server `model/list` returned the same visible YA model set:
  `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.3-codex-spark`; `priority`
  service tier remains on `gpt-5.5` and `gpt-5.4`.
- Runtime compatibility change: YA now normalizes live `subAgentActivity`
  items into visible system messages. Codex docs say subagent activity is
  surfaced in the first-party CLI/app, so silently dropping those app-server
  items would make YA less faithful to the provider UI. Selected capability
  roots remain protocol-only for YA because this provider path does not set
  them, and tool user-input requests still receive empty answers in the current
  MVP path.

Status: Codex 0.140 compatibility refresh complete in source; no new
latest-Codex requirement was introduced.

Previous source refresh, 2026-06-14:

- Installed Codex is `codex-cli 0.139.0`; repo expected version is `0.139.0`.
- `pnpm codex:protocol:check` failed only because generated
  `v2/TurnStartParams.ts` changed a comment from turn-scoped environments to
  environments that also apply to subsequent turns. Regenerating the checked-in
  app-server subset produced no type-shape or runtime contract change.
- No Codex provider code needed changing: YA already treats turn environment
  overrides as sticky in the same way as the app-server comment now says, and
  the provider currently does not send `environments` on ordinary user turns.

Status: Codex 0.139 compatibility refresh complete in source; no new
latest-Codex requirement was introduced.

Previous source refresh, 2026-06-09:

- Installed Codex is `codex-cli 0.138.0`; repo expected version is `0.138.0`.
- `pnpm codex:protocol:check` is clean after regenerating the checked-in
  app-server subset. Notable protocol drift from the 0.135 target: generated
  `ReasoningEffort` is now provider-defined `string`; raw `ResponseItem` gained
  opaque `agent_message`; approval params gained `environmentId`; thread
  metadata gained `parentThreadId`; user-message params/items gained client ids;
  resume responses can include `initialTurnsPage`; workspace roots are typed as
  absolute paths; `persistExtendedHistory` is no longer part of start/resume
  params.
- Runtime compatibility change: YA no longer sends the deprecated
  `persistExtendedHistory` start/resume field. The field was already optional
  and deprecated in prior Codex versions, so omitting it avoids unknown-field
  risk on 0.138 without forcing old users to upgrade.
- App-server `model/list` still returned the visible YA model set:
  `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.3-codex-spark`; `priority`
  service tier remains on `gpt-5.5` and `gpt-5.4`.
- Startup version mismatch wording now describes the package value as an
  advisory audited target, not a strict version requirement.

Status at the time: Codex 0.138 compatibility refresh complete in source; no
new latest-Codex requirement was introduced.

Previous read-only audit, 2026-06-05:

- Installed Codex is `codex-cli 0.137.0`; repo expected version is `0.135.0`.
- `pnpm codex:protocol:check` failed. New generated files:
  `v2/SortDirection.ts`, `v2/ThreadResumeInitialTurnsPageParams.ts`,
  `v2/TurnsPage.ts`. Changed generated files:
  `v2/PermissionsRequestApprovalParams.ts`, `v2/Thread.ts`,
  `v2/ThreadItem.ts`, `v2/ThreadResumeParams.ts`,
  `v2/ThreadResumeResponse.ts`, `v2/ThreadStartParams.ts`,
  `v2/TurnStartParams.ts`, `v2/TurnSteerParams.ts`.
- App-server `model/list` returned `gpt-5.5`, `gpt-5.4`,
  `gpt-5.4-mini`, and `gpt-5.3-codex-spark`.

Status at the time: Codex was due for a source refresh because generated
protocol files had changed.

## Claude

YA uses the official `@anthropic-ai/claude-agent-sdk` package and its native
Claude Code executable packages. There is no checked-in generated Claude
protocol; refresh work is package/API driven plus transcript-schema and model
catalog checks.

Primary sources:

- `packages/server/package.json` and `pnpm-lock.yaml` for
  `@anthropic-ai/claude-agent-sdk`;
- root `package.json` `yepAnywhere.claudeCode.compatibleThroughVersion` and
  `yepAnywhere.claudeCode.claudeAgentSdkVersion`;
- SDK `query()` control methods used in `packages/server/src/sdk/providers/claude.ts`;
- live `supportedModels()` and `supportedCommands()` from the SDK handshake;
- `CLAUDE_MODELS_FALLBACK`, `mergeClaudeModels()`, and `/goal` alias logic;
- `packages/shared/src/claude-sdk-schema/`;
- persisted Claude session JSONL under `~/.claude/projects/` or the configured
  `CLAUDE_CONFIG_DIR`.

Routine probes:

```bash
pnpm --filter @yep-anywhere/server outdated @anthropic-ai/claude-agent-sdk --format json
pnpm --filter @yep-anywhere/server test -- test/sdk/providers/claude.test.ts
```

When authenticated and the live model catalog matters, probe the provider's
`getAvailableModels()` path or the server provider catalog rather than updating
fallbacks from memory. A fallback edit is warranted only when the fallback would
be user-visible during auth/probe failure or when tests encode an outdated
normalization contract.

Difference detectors:

- Package latest version exceeds the lockfile version.
- SDK types or runtime methods used by `query()`, `supportedModels()`,
  `supportedCommands()`, `setModel()`, `setMaxThinkingTokens()`, `interrupt()`,
  or `mcpServerStatus()` change.
- The SDK starts reporting `/goal` natively or stops reporting `/loop`; YA's
  `/goal` alias must continue to step aside for native support.
- Claude transcript JSONL adds entry/content/tool-result shapes not represented
  by `claude-sdk-schema` or visible normalization tests.
- Model ids, effort levels, or context windows change enough to make fallback
  constants or model glyph rules misleading.
- A model disappears from the live/latest catalog, changes lifecycle status,
  reaches a published retirement boundary, starts rejecting requests, or
  silently resolves to another id. Compare those changes with the opt-in
  previous-model registry in
  [older-claude-models](older-claude-models.md).

Previous-model registry review:

1. Treat a displaced model as a candidate, not an automatic registry addition.
2. Retain only exact ids that remain usable and have a concrete product reason.
3. Add deprecation/retirement copy when it helps users make a choice.
4. Remove an entry when upstream retires, rejects, or remaps it.
5. Preserve existing saved selections as unlisted/custom entries; never
   auto-migrate them.
6. Use read-only catalog and lifecycle checks routinely. Do not spend tokens
   on live model turns without explicit approval.

Current source refresh, 2026-08-06:

- `@anthropic-ai/claude-agent-sdk` was refreshed from `0.3.220` to `0.3.223`;
  its SDK-bundled executable reports Claude Code `2.1.223`. YA resolves that
  bundled executable before the independently installed `claude`, so updating
  only the standalone installation would not update ordinary YA sessions.
- SDK type drift remains additive on YA-consumed surfaces. New fields include a
  resume dropped-turn identifier and unclassified resource metadata; schema
  internals also accept a wider set of raw inputs before producing the same
  typed file/environment results. YA's model/command discovery, query control,
  thinking updates, interruption, MCP status, and message unions compile
  unchanged.
- Claude Code 2.1.223 adds assumed-window enforcement for models absent from its
  built-in recognition registry. Its
  `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT` opt-out restores the
  reactive `auto` source but does not enlarge the numeric context maximum or
  change `modelUsage.contextWindow`. Claude Gateway uses that opt-out only for
  a catalog-known row without usable window metadata; metadata-rich rows retain
  their catalog-derived total and automatic-compaction controls.
- Gateway model IDs are not inherently unknown: Claude Code canonicalization,
  built-in models, and model overrides decide recognition. Numeric maximum
  overrides remain ineffective for IDs normalized to `claude-*`; that separate
  long-context path is not claimed as compatible by the generic gateway
  mapping.
- A successful Gateway catalog read publishes its model metadata together with
  the exact loopback address that answered readiness. Session launch uses that
  same endpoint until a later successful catalog replaces it; failed refreshes
  retain the prior snapshot, while a configuration change invalidates the whole
  generation. This prevents dual-stack `localhost` from validating one gateway
  and launching against another.

Status: Claude Code 2.1.223 / SDK 0.3.223 package, type, and gateway launch
compatibility is refreshed. A live `gpt-5.6-sol` request crossed the former
200K local boundary with 205,104 active input/cache tokens and reported the
catalog-derived 400K runtime window; details and the metadata-less runtime
recheck boundary are in
[resume-compaction](resume-compaction.md#claude-gateway-runtime-context-and-compaction-windows).

Current source refresh, 2026-07-25:

- `@anthropic-ai/claude-agent-sdk` was refreshed from `0.3.218` to `0.3.220`;
  its native executable reports Claude Code `2.1.220`. Claude Code `2.1.219`
  introduced Claude Opus 5 as `claude-opus-5`, the default Opus model with a
  1M context window; `2.1.220` contains reliability fixes.
- An authenticated, no-turn SDK handshake reports `default` and `opus[1m]`
  resolving to `claude-opus-5[1m]` on this account. Both rows advertise
  adaptive thinking, fast mode, auto permission mode, and
  `low`/`medium`/`high`/`xhigh`/`max` effort. The live command inventory
  contains both `/goal` and `/loop`, so YA's conditional `/goal` alias
  correctly steps aside for the native command.
- YA now transfers the live `opus[1m]` capability fields to its stable visible
  `opus` selection token, preserves live capability/context metadata while
  keeping the generic `default` label, and identifies canonical
  `claude-opus-5`/`claude-sonnet-5` model ids as 1M. The auth/probe-failure
  fallback describes Opus 5 and retains its adaptive, fast, auto, and effort
  controls.
- SDK type drift is additive on unconsumed surfaces: `DirectoryAdded` hooks,
  fast-mode disabled reasons, strict sandbox-network allowlists, workflow size
  guidance, and an interrupt capability that can cancel queued commands. YA's
  model/command discovery, model and thinking updates, ordinary interrupt,
  MCP status, and existing message union remain source-compatible. Adopting
  cancel-queued interrupt semantics would be a separate queue/control design
  change, not an Opus 5 compatibility requirement.
- The durable transcript census also found three older Claude records outside
  the schema: an informational warning, assistant `fallback` content, and its
  paired `model_refusal_fallback` system audit row. YA now retains all three
  shapes without changing their renderer behavior; all 975,598 lines across
  7,100 local Claude transcript files validate.

Status: Claude Opus 5 is available through Claude Code `2.1.220` / SDK
`0.3.220`, with provider catalog, fallback metadata, and context-window
normalization refreshed.

Current source refresh, 2026-07-23:

- `@anthropic-ai/claude-agent-sdk` was refreshed from `0.3.215` to `0.3.218`;
  its bundled and independently installed runtime report Claude Code
  `2.1.218`. Root compatibility markers record that pair.
- The SDK changes are additive on YA-consumed surfaces: usage may identify the
  canonical model/provider, rewind results may list skipped links, teammate
  messages and timing records carry more provenance, and the bridge adds a
  rename callback. `set_model` accepting null and sandbox filesystem
  `disabled` do not change YA's existing calls.
- The deprecated `bubble` agent-definition mode was removed. YA does not use
  that mode, and the provider's model/command discovery, setting, interrupt,
  and MCP controls remain type-compatible.

Status: Claude Code 2.1.218 / SDK 0.3.218 package and control compatibility is
refreshed; no YA runtime behavior change is required.

Current source refresh, 2026-07-19:

- `@anthropic-ai/claude-agent-sdk` was refreshed from `0.3.205` to `0.3.215`;
  its bundled executable and the independently installed `claude` both report
  Claude Code `2.1.215`. Root compatibility markers now record that pair.
- The SDK retains every `SDKMessage` union member YA already knew; drift is
  additive within existing messages. Notable fields include assistant
  `aborted`, `timestamp`, and `resumed_from_incomplete_thinking`; tool-progress
  heartbeats and subagent retry detail; expanded terminal reasons; permission
  rationale fields; and `SessionStart` source `fork`.
- Persisted transcript coverage added provider connector `attachment`,
  `permission-mode`, leaf-based `last-prompt`, queue `popAll`, plus system
  `turn_duration`, `away_summary`, `scheduled_task_fire`, and `local_command`.
  All 104,553 lines across 200 local Claude transcripts now validate.
- No existing Claude provider control call changed incompatibly, and the full
  repository typecheck passes with SDK 0.3.215. The 2.1.215 release itself only
  stops Claude from invoking `/verify` and `/code-review` autonomously.

Optional follow-ups: render the new tool-progress heartbeat/subagent retry
detail in activity UI; surface truncated `aborted` assistant frames distinctly;
and use structured permission rationale to improve approval copy. These are
additive UX work, not compatibility blockers, and should remain provider-native
and default-preserving.

Status: Claude Code 2.1.215 / SDK 0.3.215 runtime, type, and persisted-session
compatibility is refreshed.

Current source refresh, 2026-07-09:

- `@anthropic-ai/claude-agent-sdk` was refreshed from `0.3.199` to `0.3.205`.
  Its bundled Linux executable and the independently installed `claude` both
  report Claude Code `2.1.205`; root `package.json` records the paired runtime
  and SDK compatibility markers.
- The SDK control methods YA uses for model/command discovery, model and
  thinking updates, interruption, and MCP status remain present. Focused Claude
  provider tests pass, and no YA runtime source change is indicated by this
  package refresh.

Status: Claude Code 2.1.205 / SDK 0.3.205 compatibility refresh complete as a
package and marker update; no new runtime behavior change was introduced.

Current source refresh, 2026-07-03:

- `@anthropic-ai/claude-agent-sdk` was refreshed from `0.3.195` to `0.3.199`,
  whose bundled executable reports Claude Code `2.1.199`.
- npm `@anthropic-ai/claude-agent-sdk` `latest` is `0.3.199` (`next` is
  `0.3.200`). Root `package.json` records Claude Code compatibility through
  `2.1.199` and pairs it with SDK `0.3.199`.
- Fable remains represented by YA's existing fallback/catalog normalization:
  the `fable` alias and SDK-reported `claude-fable-5` carry 1M context,
  adaptive thinking, auto mode, and effort metadata. No additional runtime
  source change was indicated by this package refresh slice.

Status: Claude Code 2.1.199 / SDK 0.3.199 compatibility refresh complete as a
package and marker update; no new runtime behavior change was introduced.

Previous source refresh, 2026-06-29:

- `@anthropic-ai/claude-agent-sdk` was refreshed from `0.3.183` to `0.3.195`,
  whose package metadata declares bundled Claude Code `2.1.195`.
- Local `claude --version` reports `2.1.195 (Claude Code)`, and npm
  `@anthropic-ai/claude-agent-sdk` `latest` is `0.3.195` (`next` is
  `0.3.196`). Root `package.json` records Claude Code compatibility through
  `2.1.195` and pairs it with SDK `0.3.195`.
- No checked-in Claude protocol regeneration exists. Focused Claude provider
  tests passed after the dependency refresh, and no YA source change was
  indicated by the package/runtime version check in this slice.

Status: Claude Code 2.1.195 / SDK 0.3.195 compatibility refresh complete as a
package and marker update; no new runtime behavior change was introduced.

Previous source refresh, 2026-06-19:

- `@anthropic-ai/claude-agent-sdk` was refreshed from `0.3.170` to `0.3.183`,
  whose package metadata declares bundled Claude Code `2.1.183`.
- Claude Code 2.1.181 added automatic recovery for API connection drops during
  thinking. This matters to YA because local provider startup prefers the
  SDK-bundled executable over an independently installed `claude` binary.
- YA now opts into Claude Code's persistent retry watchdog for retryable
  429/529 responses and preserves the original in-flight request with
  exponential backoff capped at five minutes. The documented retry-count limit
  is set to an effectively unbounded value for other transient server, timeout,
  and connection failures. Both launch values preserve explicit operator
  overrides.
- SDK type drift adds `system/informational` user-visible banners and
  `system/worker_shutting_down` remote-worker lifecycle events. YA's loose
  server pass-through accepts both. `worker_shutting_down` is not authoritative
  for YA's locally owned process lifecycle; `informational` still needs a
  deliberate client rendering policy because the current system-message
  allowlist drops it.

Status: retry compatibility is refreshed through Claude Code 2.1.183. The new
informational-message rendering surface remains a known follow-up rather than a
retry-path blocker.

Current read-only/local audit, 2026-06-14:

- Local `claude --version` reports `2.1.177 (Claude Code)`.
- YA has no checked-in expected Claude CLI version gate analogous to Codex's
  `expectedVersion`. The Claude provider resolves the installed executable,
  checks `--version` for usability, and relies on SDK/live catalog probes for
  model and command surfaces.
- The 2.1.177 behavior YA currently depends on is already recorded in
  [claude](claude.md) and [session-ownership](session-ownership.md): `--resume`
  appends to the same transcript file, live processes do not re-read external
  appends, concurrent writers fork the `parentUuid` chain, and later resume can
  silently drop one branch. No provider source change is indicated by this
  local version check.

Status: Claude 2.1.177 awareness is documented; no source refresh needed from
the local CLI version alone.

Previous source refresh, 2026-06-09:

- `@anthropic-ai/claude-agent-sdk` was refreshed from `0.3.158` to `0.3.170`,
  whose package metadata declares bundled Claude Code `2.1.170`.
- Fable surfaced in the new SDK types as the `fable` model alias and
  `claude-fable-5` full model id. YA now exposes a fallback `fable` option so
  users can select it even when the live model probe is unavailable.
- Fable context and effort metadata are reflected in YA's fallback catalog:
  1M context, adaptive thinking, and `low`/`medium`/`high`/`xhigh`/`max`
  effort levels with `high` as the default.
- SDK model metadata already carried optional adaptive/fast/auto mode flags;
  YA now preserves those fields from `supportedModels()` rather than dropping
  them.
- Follow-up UI mapping:
  - `supportsAdaptiveThinking: false` hides adaptive thinking modes in the
    shared thinking controls and normalizes outgoing turn settings to `off`.
  - `supportsEffort: false` hides the forced `on:<effort>` mode while keeping
    adaptive `auto` available.
  - `supportsAutoMode: true` exposes permission mode `auto` in the session
    toolbar and in new-session/new-session-default permission choices. Absent
    metadata keeps the previous permission-mode list for older executables.
    The fallback `fable` catalog entry must carry this flag too; otherwise
    cached or fallback provider discovery hides the new permission option even
    after the model itself appears.
- `supportsFastMode` is still metadata-only in YA. Claude Code exposes fast
  mode as `/fast` or a settings-layer `fastMode` knob with explicit cost
  trade-offs, not as an existing YA per-turn/process-config field. Exposing it
  should be a separate provider-control slice with an explicit default/on/off
  setting and cost copy rather than silently attaching it to model selection.
- Other SDK drift inspected but not enacted in this slice: pending
  `request_user_dialog` replay fields, usage and skill-reload control methods,
  repo-root/stage-file control requests, and additional hook/settings schema
  growth. No current YA call site requires those methods for Fable exposure.

Status at the time: Claude Fable/model-metadata refresh complete in source.
Older Claude Code executables can still use the existing model choices;
selecting `fable` requires an upstream install/account that recognizes that
alias.

Previous read-only audit, 2026-06-05:

- `@anthropic-ai/claude-agent-sdk` is pinned/current at `0.3.158`; latest npm
  version is `0.3.163`.

Status: Claude is due for a package/API audit and likely dependency refresh.
No checked-in generated Claude protocol needs regeneration.

## Grok ACP

The local installation is the source of truth for the provider YA actually
launches. The first-party public source is the best implementation reference,
but its version and `SOURCE_REV` must be checked because it is periodically
synced and may trail the released binary.

Primary sources:

- `grok --version`;
- `grok models`;
- `~/.grok/models_cache.json`;
- `grok --help`, `grok agent --help`, and `grok agent stdio --help`;
- local docs under `~/.grok/docs/user-guide/`, especially
  `15-agent-mode.md`, `17-sessions.md`, `03-keyboard-shortcuts.md`,
  `11-custom-models.md`, and `22-permissions-and-safety.md`;
- first-party `xai-org/grok-build` source, including its package version and
  root `SOURCE_REV`;
- root `package.json` `yepAnywhere.grokCli.compatibleThroughVersion`;
- `packages/server/src/sdk/providers/grok-acp.ts`;
- `packages/server/src/sdk/providers/grok-tool-normalization.ts`;
- `packages/server/src/sessions/grok-reader.ts`;
- ACP SDK dependency `@agentclientprotocol/sdk`;
- persisted sessions under `~/.grok/sessions/`.

Routine probes:

```bash
grok --version
grok models
node -e 'console.log(require("fs").readFileSync(`${process.env.HOME}/.grok/models_cache.json`, "utf8"))'
grok agent --help
grok agent stdio --help
```

Difference detectors:

- `grok models` or `models_cache.json` changes visible ids, metadata, cache
  shape, or the default in a way the dynamic normalizer does not preserve.
- `grok agent` flags move between top-level, `agent`, and `agent stdio`
  positions; YA 1.0.4+ places `--effort`/`-m` after `agent` and passes
  `--no-leader` before `stdio`.
- Local docs or first-party source add or remove ACP methods, reverse
  extension requests, permission modes, interject/steering semantics, session
  storage files, compaction behavior, or custom-model credential precedence.
- ACP update or permission request shapes no longer match `GrokACPProvider`
  normalization tests.
- `@agentclientprotocol/sdk` changes enough to alter `ACPClient` request,
  notification, or permission typings.

Current source refresh, 2026-08-16:

- Installed Grok is `grok 1.0.4 (d846eb93d9) [stable]`. Public `xai-org/grok-build`
  is git `9fabadea800fa6e2ed8ec91c4f45f02b7e2504f4`, `SOURCE_REV`
  `7bd63df3c9bb1bf98e7a9b3486f4a0189ea94e55`, crate version 1.0.5 (one patch
  ahead of the installed binary).
- `grok models` and a no-token ACP `initialize`/`session/new` both advertise
  default `grok-4.6` plus `grok-4.5`. Grok 4.6 default effort is `xhigh`; 4.5
  remains `high`. YA's catalog listing parser now accepts both `*` and `-`
  rows so 4.5 stays selectable.
- Launch is `grok agent [--effort] [-m] --no-leader stdio`. `--include-partial-messages`
  is headless-only and is not an ACP launch flag. There is no Grok-specific
  Node agent SDK; official embedding remains ACP via
  `@agentclientprotocol/sdk`.
- `loadSession` is still true. Initialize also advertises
  `sessionCapabilities.resume`; YA keeps `session/load` + `_meta.noReplay`
  because that path is measured and still advertised.
- New canonical kinds (`video_gen` / `image_to_video` / `reference_to_video`,
  `update_goal`, `workflow`, `monitor`, `lsp`) stay on the existing generic
  activity vocabulary. Video files are not fed through the image media
  store.
- `@agentclientprotocol/sdk` remains 0.12.0. 0.24.0 is latest; 1.0.4 initialize
  and the extension methods YA already handles do not require the upgrade.

Status: Grok ACP is current through installed 1.0.4. Root
`yepAnywhere.grokCli.compatibleThroughVersion` records `1.0.4`.

Enacted audit, 2026-07-23:

- Installed Grok is `grok 0.2.111 (94172f2aa4) [stable]`.
- `grok models` advertises only/default `grok-4.5`.
  `models_cache.json` reports a 500k context window and low/medium/high effort,
  with high as the default.
- YA now discovers the CLI-visible catalog and enriches it from the cache
  instead of hardcoding `grok-build`; that id remains an unreadable-catalog
  fallback for older installations.
- A live initialize probe reported ACP protocol version 1, agent version
  0.2.111, `grok-4.5`, and the current slash-command inventory.
- Standard update types now also include current-mode, config-option, and
  session-info metadata. Grok persists `_x.ai/session/update` retry and
  turn-completed notifications. Neither is a missing transcript message type
  for current YA surfaces.
- The first-party Apache-2.0 `xai-org/grok-build` source was inspected at git
  `a5727c5960452e7527a154b25cb5bf00cda0545e`, source revision
  `30192d2eef5d91a8fff0e53957de5bd05b43398c`, package version 0.2.110.
- That source exposed two blocking reverse requests:
  `x.ai/ask_user_question` and `x.ai/exit_plan_mode`. YA now maps them to its
  existing pending-input flows and fails closed when input cannot be obtained.
- `@agentclientprotocol/sdk` remains pinned at 0.12.0. Its existing extension
  method API and standard update union cover these Grok surfaces, so no
  dependency upgrade is needed.
- A live assistant/tool smoke is still due: the current account completed
  initialize/session setup but returned HTTP 402 on the model call.

Status: Grok ACP source and docs are current through installed 0.2.111 and
public source 0.2.110, subject to the live-prompt coverage gap above.

## OpenCode

YA's OpenCode backend currently uses `opencode serve` over HTTP/SSE plus durable
storage/export readers. The provider dynamically queries `opencode models`, so
ordinary remote model-catalog changes do not by themselves require a source
refresh unless fallback constants, sorting, or model glyphs become misleading.

Primary sources:

- `opencode --version`;
- `opencode models`;
- `opencode serve --help`;
- `opencode acp --help` for strategic ACP comparison;
- live SSE events from `opencode serve`;
- `opencode export <sessionID>` and storage under
  `~/.local/share/opencode/storage/`;
- `packages/server/src/sdk/providers/opencode.ts`;
- `packages/server/src/sessions/opencode-reader.ts`;
- `packages/shared/src/opencode-schema/`;
- [opencode-backend](opencode-backend.md) coverage tables.

Routine probes:

```bash
opencode --version
opencode models
opencode serve --help
opencode acp --help
```

When transcript/rendering compatibility is the question, sample real exports
and SSE fixtures, then count part/event types against visible YA block coverage
as described in [opencode-backend](opencode-backend.md). Keep both raw coverage
and coverage after excluding deliberate metadata-only parts.

Difference detectors:

- `opencode serve` request/response, SSE, liveness, or permission route shapes
  change.
- New stored/export part types are skipped by `convertOpenCodeParts()` but
  should be visible text, thinking, tool use, tool result, or file-change UI.
- `opencode models` changes the provider/model id format, breaking
  `provider/model` parsing or the `local-glm/*` first sorting contract.
- `opencode acp` becomes mature enough to justify a design comparison against
  the current HTTP/SSE provider.
- Model ids become misleading in the model indicator UI; that belongs with
  [provider-model-glyphs](provider-model-glyphs.md), not necessarily the
  provider runtime.

Current read-only audit, 2026-06-05:

- Installed OpenCode is still `1.15.13`, matching the existing
  [opencode-backend](opencode-backend.md) local sample version.
- `opencode models` returns a current dynamic catalog including new Copilot,
  OpenAI, Claude, Gemini, Hugging Face, and `local-glm` entries; this is
  runtime data and the provider already queries it dynamically.
- `opencode acp --help` exists, but YA still uses `opencode serve`.

Status: OpenCode is not due for a routine version refresh from the local binary
state. It has a design-refresh candidate if YA wants to evaluate the ACP backend
instead of the current HTTP/SSE backend, and the dynamic model catalog may
justify a separate glyph/UI polish pass.

## Package Cross-Checks

The server package currently pins provider-adjacent packages as follows:

| package | current/wanted | latest observed | role |
|---|---:|---:|---|
| `@anthropic-ai/claude-agent-sdk` | `0.3.223` | `0.3.223` | Active Claude provider dependency |
| `@agentclientprotocol/sdk` | `0.12.0` | `0.24.0` | Active ACP client dependency for Grok/Gemini |

Treat both rows as provider-refresh inputs.
