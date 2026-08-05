# Resume Compaction

> Resume compaction is YA's provider-neutral compact-before-resume
> contract for old or context-heavy sessions, preserving the same
> provider session when upstream supports it instead of silently starting
> a YA handoff.

Topic: resume-compaction

Related topics: [claude](claude.md),
[session-context-actions](session-context-actions.md),
[compact-and-handoff](compact-and-handoff.md),
[provider-refresh](provider-refresh.md),
[provider-state-machine](provider-state-machine.md),
[session-liveness](session-liveness.md),
[cost-efficiency](cost-efficiency.md),
[injected-message-visibility](injected-message-visibility.md)

## Motivation

Claude TUI exposes a useful old-session choice: resume the full long
session, or resume from a provider-created summary when the transcript is
large enough that full resume may consume substantial budget. YA currently
does not model that choice directly. In old or disconnected Claude sessions,
the user can instead see a new-session or handoff-shaped dialog even when
the desired behavior is still same-session continuation after compaction.

This concern is initiation and control. YA already has credible read/render
support once compaction boundaries exist.

## Current Ground Truth

As of 2026-06-08, checked evidence supports these starting assumptions:

- Claude transcript `compact_boundary` messages already preserve DAG
  continuity and context-usage accounting in YA's reader/render path.
- Codex app-server `compaction` / `context_compaction` items already
  normalize into the same visible system boundary.
- The shared provider interface has no explicit `compact()` method.
  Existing generic control is slash-command discovery plus sending a
  prompt such as `/compact` when the provider advertises it.
- The Claude Agent SDK documents `/compact` as a slash command, session
  resume through a provider resume id, `system` compact boundary messages,
  and failure cases when the conversation is already too full to compact.
- The user has observed at least one YA-visible compaction attempt fail with
  a "context too full" style error. That supports treating compaction as
  constrained by provider context limits, not as an unlimited external
  summarization service.
- OpenAI documents `POST /v1/responses/compact`. The pinned Codex app-server
  protocol also exposes `thread/compact/start`; YA uses that provider-native
  request when it must initiate a manual Codex compact and continues to
  normalize the resulting compaction item into the shared visible boundary.

Evidence anchors:

- Claude commands: <https://code.claude.com/docs/en/commands>
- Claude Agent SDK sessions:
  <https://code.claude.com/docs/en/agent-sdk/sessions>
- Claude errors: <https://code.claude.com/docs/en/errors>
- OpenAI Responses compact:
  <https://platform.openai.com/docs/api-reference/responses/compact?api-mode=responses>

Do not infer from the Claude TUI wording or the "context too full" failure
that Anthropic uses the same model, a cheaper model, a special atomic
"resume from summary" SDK call, or a budget-free operation. Treat the
cheaper path as a user-visible cost/context tradeoff until upstream
documents a stronger claim.

## Product Contract

When a stopped provider session is old or context-heavy and the provider
can safely compact before the next user turn, YA should offer an explicit
choice:

- Full resume: keep today's semantics and ask the provider to load the
  full conversation history.
- Compact then resume: resume the same provider session, run provider
  compaction first, and submit the user's queued turn only after a compact
  boundary or equivalent success signal arrives.
- Handoff/new session: remain an explicit fallback for providers or states
  that cannot compact the same provider session safely.

The YA URL session id remains canonical. Provider-native ids may be used as
resume handles, but compact-first resume must not silently replace the
YA-visible session id in URLs, persisted metadata, REST or WebSocket
payloads, or UI copy.

Compaction is a bounded user-initiated operation. It may take minutes on a
large transcript, may spend provider budget, and may fail if the upstream
conversation is already too full. YA should show progress and preserve the
provider state-machine rules while it is running instead of presenting the
session as idle.

## Implementation Gates

Gate 0, evidence refresh: Before code changes, re-check current Claude SDK
types/docs, OpenAI compact docs, and the local Codex protocol surfaces. The
known path may have moved, and provider-refresh rules require YA-facing
assumptions to be verified against the current upstream.

Gate 1, read/render audit: Confirm existing compact boundary rendering and
history continuity still work for Claude and Codex. In particular, parse
both persisted camel-case and current SDK snake-case Claude compact metadata
if both shapes can appear in local transcripts. Keep
`local_command_output` display separate from the actual compaction boundary.

Gate 2, provider contract: Add a first-class resume mode or capability
surface before wiring UI. A conservative starting shape is a provider
capability such as `compactBeforeResume` plus a resume option like
`resumeMode: "full" | "compact-first"`. Do not add a generic `compact()`
method unless at least one provider implementation has a real callable
operation and the failure semantics are specified.

Gate 3, Claude same-session prototype: For compact-first resume, start or
resume the same Claude provider session, send the native `/compact` command
only when advertised, wait for `compact_boundary` or an equivalent compact
success status, then submit the user's turn in the same provider process.
On failure, timeout, or unsupported command, surface a controlled decision
instead of silently falling back to handoff.

Gate 4, old-session UI choice: When YA detects a stopped old or
context-heavy session and the provider supports compact-first resume, show
the user a clear choice before the next turn is attempted. Copy should say
that full resume may consume more context/budget, compact-first summarizes
older context and can fail, and handoff starts a replacement session.

Gate 5, Codex initiation probe: Treat Codex as a separate provider-specific
gate. YA currently observes Codex compaction items; initiating compaction
requires selecting an upstream mechanism, reviewing credential and cost
behavior, and adding tests around local app-server or API protocol drift.

Gate 6, rollout and verification: Keep the feature prompt-gated or
configuration-gated until Claude same-session resume, failure handling,
queue ordering, and UI state have tests. Log enough provider-phase detail
to debug slow compactions without dumping transcript content.

## Failure Posture

If provider compaction fails because the conversation is too full, offer a
full resume or explicit handoff; do not retry compaction in a loop.

That failure mode is evidence about provider constraints, not a license to
invent a separate YA-side summarizer as a silent fallback. A separate
summarizer would be a different feature with its own model, privacy, cost,
and quality contract.

If the provider does not advertise a compaction command or callable compact
surface, keep the current full-resume or handoff behavior and explain the
missing provider capability in debug surfaces.

If no client is actively requesting the resume, do not start background
compaction. A closed tab or idle provider session must not indefinitely
consume server resources.

If the provider documents a model choice for compaction, model it
explicitly. Otherwise do not silently switch to a different or allegedly
cheaper model on the user's behalf.

## Test Plan

- Provider-interface unit tests for `full` versus `compact-first` resume
  mode selection and unsupported-provider failure.
- Claude fake-provider tests where `/compact` emits compacting status,
  a compact boundary, and then accepts the queued user turn in the same
  resumed session.
- Claude failure tests for command-not-advertised, compact timeout, and
  upstream compact failure.
- Reader tests that preserve continuity and metadata for both old persisted
  and current SDK compact boundary shapes.
- Client tests for the old-session choice and busy/progress state.
- Codex regression tests proving existing compaction item normalization
  remains intact before any Codex initiation work is added.

## Live threshold trigger (task 029)

Distinct from resume-time compact-first above: a **live, in-session**
preemptive compaction, configured per model as "compact at X% of that model's
full context window" (`clientDefaults.compactAtContextPercent[model]`). The
percentage is an explicit user hint, not a YA recommendation: performance
degradation at long context and the quality cost of compacting earlier are both
task-specific empirical questions. With no value, YA makes no threshold request
and leaves the provider's automatic behavior unchanged.

The provider capability determines who owns timing:

- A provider with `supportsNativeCompactThreshold` receives the derived integer
  token limit. Codex expresses it in `thread/start` or `thread/resume` config as
  `model_auto_compact_token_limit`, paired with
  `model_auto_compact_token_limit_scope: "total"`. Both keys are absent when
  the setting is off. Because Codex's live `thread/settings/update` request does
  not carry config overrides, a changed or cleared threshold resumes the same
  thread with the new launch config before delivering the turn.
- Providers without that capability retain YA orchestration. YA checks live
  usage at the first idle boundary after assistant output and immediately calls
  the provider's manual compact command. The same path is forced for any
  provider by the global, default-off
  `clientDefaults.forceYaOrchestratedCompaction` setting. Codex dispatches that
  command out of band as `thread/compact/start`; Claude receives its hidden
  `/compact` turn.

The YA path reuses `Supervisor.tryResumeCompaction`, so it drives the native
compaction boundary (same result + render contract), and an injected textual
`/compact` carries no user echo (`metadata.hidden`; see
[injected-message-visibility](injected-message-visibility.md)). The pure
decision is `crossesCompactThreshold(percent, contextWindow, inputTokens)`;
the orchestration is `Supervisor.maybeCompactAfterIdle`, called once when a
completed assistant turn makes the process idle.

Design intent and invariants:

- **Voluntary, momentum-preserving.** It is a "do it when the user won't be
  bothered" compaction, not a needed one. It starts speculatively at the first
  idle boundary after assistant output, so a later user request does not pay
  compaction latency. Delivery intent is recorded before any asynchronous
  slash-command discovery; if new input arrives during the usage read or
  compact-command lookup, that input wins and the speculative compact is
  skipped even if the process still formally reports `idle`.
- **Harness-enforced compaction is untouched and remains the backstop.** This
  trigger is purely *earlier and additive*; nothing about the harness's own
  auto-compaction changed. When the setting is off, provider behavior is
  exactly the provider default.
- **No double compaction.** Each assistant-output version is considered once.
  The compact operation's own idle boundary cannot recursively trigger another
  compact even if the durable usage summary has not caught up.
- **Conservative YA fallback (task 002).** Idle only, only when usage is known,
  and best-effort: the turn is delivered regardless of the compaction outcome,
  with no retry loop; failure is logged, never blocks the turn.

Scope boundary: the trigger belongs to the process idle transition, not a REST
route. Deferred turns promoted at that same boundary still take precedence:
`Process` promotes eligible deferred work before publishing idle, so YA never
starts speculative compaction in front of an already-queued turn.

The idle timing deliberately leaves a theoretical compute saving unimplemented:
YA does not wait for composer activity or other evidence that another user turn
is coming. The simpler unconditional idle check minimizes user-facing latency;
an occasional compact after the user was actually finished is acceptable.

## Claude global automatic threshold override

Claude Code's `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is a third, distinct facility.
It is not the per-model percentage of full context above and it does not issue
an immediate `/compact`. It changes the percentage of **Claude Code's own
auto-compaction window** at which Claude may compact proactively:

- YA stores one global, optional
  `claudeAutoCompactPercentOverride` provider setting. There is no per-session
  or new-session override.
- Claude advertises `supportsLaunchCompactPercentOverride`; Claude Gateway and
  Claude + Ollama do not. The Providers UI is hidden when an older server's
  provider response lacks the capability, so that client makes no unsupported
  settings write.
- A value from 1 through 100 is passed to every regular Claude create/resume as
  the exact decimal environment value
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=<percent>`. Off is canonical omission: YA
  does not set the variable and preserves any operator-owned ambient
  environment/default.
- The override can only lower Claude's default. Values above the effective
  default have no effect, and the variable only takes effect in the Claude Code
  cases where proactive auto-compaction is active. For the plain Claude
  provider YA does not set `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; therefore this
  option does not redefine Claude's effective window or the status line's
  full-context `used_percentage`. Claude Gateway is the one exception, below.

## Claude Gateway auto-compaction window

Claude Code cannot verify a proxied model's context window through a gateway.
Anthropic documents the consequence for its own models — behind
`ANTHROPIC_BASE_URL` a 1M-window Sonnet 5 session is budgeted at 200K — and a
non-Anthropic proxied model gets the same 200K budget with no way to discover
the truth. The gateway's own `/v1/models` catalog is that truth, and YA already
parses `capabilities.limits.max_context_window_tokens` from it.

So `ClaudeGatewayProvider` passes that window to each launch as
`CLAUDE_CODE_AUTO_COMPACT_WINDOW`, and only that provider does:

- The value comes from the last successful catalog read. A launch before any
  read omits the variable and keeps Claude Code's own gateway default, rather
  than asserting a window YA has not seen.
- Claude Code accepts 100,000 through 1,000,000 as a plain integer, so
  `gatewayAutoCompactWindow` clamps into that range. A model advertising less
  than 100K takes the floor — still tighter than the 200K it replaces, and the
  closest Claude Code can express.
- Diagnosed 2026-08-05 from a wedged `gpt-5.6-sol` session (real window
  400K): context climbed to 200,935 tokens with zero compaction anywhere in
  the transcript, and the session then accepted no further input. YA's own
  early compaction could not have covered this — it fires only at an idle
  boundary, and this turn ran from below the threshold to the ceiling without
  one. Whether the wedge itself lives in Claude Code or the gateway is
  unresolved; agreeing on the window removes the boundary it wedged at.
- Because Claude Code's `used_percentage` measures against the model's full
  window rather than this override, YA's own percentage and Claude Code's
  compaction point now describe the same window instead of differing by the
  ratio of real window to 200K.
- Anthropic documents manual `/compact`, but no interactive SDK/command setter
  for the automatic percentage. The percentage is launch-scoped. If the global
  setting changed while YA still owns a live Claude process, the next ordinary
  user turn restarts and resumes the same provider session with the new
  environment before delivery. Active steering never interrupts a turn for
  this setting; the following ordinary turn performs the comparison.

Anthropic documents that the environment override applies to main
conversations and subagents. Its applicability is provider behavior, not a YA
promise that every Claude model/session compacts proactively:

- Claude environment variables:
  <https://code.claude.com/docs/en/env-vars>
- Claude Agent SDK slash commands:
  <https://code.claude.com/docs/en/agent-sdk/slash-commands>

Compatibility corpus checked 2026-07-31 for this optional setting: stable
server releases `v0.7.0` and `v0.6.2` lack both
`settings.claudeAutoCompactPercentOverride` and
`providers[].supportsLaunchCompactPercentOverride`. The absent-capability
fallback above makes no unsupported request and preserves all existing
provider-capability meanings.

## Open Questions

- Does Claude TUI use only the documented slash command path, or does it
  have an additional internal resume-from-summary affordance? YA should not
  depend on an undocumented answer.
- Which signal should trigger the prompt: elapsed inactivity, transcript
  token count, provider resume failure, or a combination? The first rollout
  should prefer explicit user choice over fragile prediction.
- Should compact-first resume be available from the ordinary stopped-session
  composer, the restart/handoff dialog, or both? The provider contract
  should be decided before UI copy spreads.
