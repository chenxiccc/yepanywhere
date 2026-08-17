# Grok Build Provider

> xAI Grok Build provider integration, isolated behind provider-specific
> files and feature gates while ACP supervision matures.

Topic: grok

Related topics: [claude.md](claude.md),
[provider-state-machine.md](provider-state-machine.md),
[provider-model-glyphs.md](provider-model-glyphs.md),
[media-rendering-and-routing.md](media-rendering-and-routing.md),
[steer-queue-provider-differences.md](steer-queue-provider-differences.md),
and architecture-mandates.md.

Dated probes, version-by-version refresh notes, and implementation chronology
live in [`grok.evidence.md`](grok.evidence.md).

## Current contract (1.0.4)

Installed `grok 1.0.4` is the current local target.
`yepAnywhere.grokCli.compatibleThroughVersion` records that version.

**ACP is the embedding path.** YA launches
`grok agent [--effort] [-m] --no-leader stdio` through the existing
`ACPClient`. There is no first-party Grok Node agent SDK. `--no-leader`
keeps the YA-owned process off a shared TUI/leader so updates are not
buffered behind another client.

**Default model is `grok-4.6`.** `getAvailableModels()` follows `grok models`
(`*` / `-` rows) and enriches from `GROK_HOME/models_cache.json`. It does
not hardcode 4.6, so an older CLI can still advertise 4.5. The
unreadable-catalog fallback remains `grok-build`. Compact glyphs are
`Gk 4.6` / `Gk 4.5`. Effort maps to Grok's top-level `--effort`; YA omits
`-m` for the discovered default.

**Continuation is `session/load` + `_meta.noReplay`.** Grok advertises
`agentCapabilities.loadSession`. `session/resume` is not used until
re-measured. A load failure stays fail-closed and never falls back to
`session/new`. `_meta.noReplay` suppresses history replay because
`GrokSessionReader` already owns the durable transcript.

**Mid-turn steer is `x.ai/interject`.** A second `session/prompt` becomes a
later turn. `steer()` sends `{ sessionId, text }` and treats
`status: "queued"` as success. `supportsSteerNow` stays unset: in-flight
generation and ordinary tools finish; only blocking wait tools abort. If
no prompt is in flight, or the extension call fails, `steer()` returns
false and YA queues.

Interject does not cancel the turn. Grok drains the text at the next safe
point (after a completed tool batch, before the next model step, or just
before returning to the user) as a synthetic user item whose durable
`user_message_chunk` is wrapped in Grok's "while you were working" /
`<user_query>` envelope. YA already echoed the raw steer; replay strips
that outer envelope and keeps any `<user_query>` the user themselves
quoted. YA Queue remains the end-of-turn path. Grok TUI
`follow_up_behavior = steer` is CLI-local; YA does not read it.

**Video output.** Grok writes MP4s under the session `videos/` directory.
YA allowlists that root next to `images/`, stores `ftyp` MP4s as
`video/mp4`, and plays them in the shared tool-result media row. Project
copies of those files already play through ordinary local-media links.
ZDR/uploaded-only videos stay non-playable.

**API-key billing.** Grok Build uses the CLI/browser-login subscription by
default. YA scrubs ambient `XAI_API_KEY` from the child unless the
default-off Providers opt-in is on. That opt-in does not reuse
`YEP_STT_XAI_API_KEY`.

**Subagent nesting.** Grok's documented process knobs are
`GROK_SUBAGENTS=0` / `--no-subagents` (disable) and a hard nesting cap of
one: a child cannot spawn further children. YA never writes
`~/.grok/config.toml` or clones `GROK_HOME`. When the server-wide
Subagent nesting limit is `0` and YA's own environment does not already
set `GROK_SUBAGENTS`, the spawned `grok agent stdio` child gets
`GROK_SUBAGENTS=0`. Depths `1`–`4` and **Provider default** inject
nothing: Grok already cannot nest past one. An explicit `GROK_SUBAGENTS`
in YA's environment wins. See [vanilla-defaults](vanilla-defaults.md).

## Harness affordances vs YA visibility

| Grok TUI / ACP affordance | YA surface now | Gap |
| --- | --- | --- |
| Model picker 4.6 / 4.5 + effort | Existing new-session model/effort controls | none for catalog |
| File/search/edit/bash/web/todo/ask/plan | Existing renderer names | none |
| Subagent spawn / bg wait / kill | Spawn rows plus parent-nested child summaries | TUI tasks pane / kill stay out of YA |
| Image gen/edit | Generic row + image media candidate | none |
| Video gen | Generic row plus shared tool-result media player | session `videos/` allowlisted |
| Goal / workflow / monitor / LSP | Native generic activity rows | dedicated goal/workflow UI is new facility |
| Slash commands including `/workflow`, `/goal` | Live `/` menu from `available_commands_update` | descriptions/hints still API-only |
| Mid-turn interject | YA Steer → `x.ai/interject` | `supportsSteerNow` unset |
| Session recap / voice / cancel-rewind bits | ignored metadata | new facility if a YA surface wants them |

`updates.jsonl` remains the replay log. A live TUI session may create that
file after the first persist, not at directory creation.

## Tool vocabulary

Grok attaches a versioned `_meta["x.ai/tool"]` object to ordinary
tool-call updates. `label` is the display key; `kind` is an open action
category; `name` is Grok's native name; `input` is merged with `rawInput`
across updates for the same `toolCallId`. Live ACP and `updates.jsonl`
replay share one normalizer.

| Grok action | YA tool name | Result treatment |
| --- | --- | --- |
| `read_file`, `grep`, `search_replace`, `write` | `Read`, `Grep`, `Edit`, `Write` | Existing compatible file/search schemas |
| `run_terminal_command` | `Bash` | Foreground output or background task id |
| `todo_write` | `TodoWrite` | Full post-update todo state |
| backend web search, `web_fetch` | `WebSearch`, `WebFetch` | Existing web result schemas |
| `ask_user_question`, `exit_plan_mode` | `AskUserQuestion`, `ExitPlanMode` | Existing interaction/plan schemas |
| `spawn_subagent` | `spawn_agent` | Existing spawn schema plus native diagnostic text |
| `list_dir`, background output/kill, enter-plan | Native Grok name | Generic activity row |
| `image_gen`, `image_edit` | `ImageGen`, `ImageEdit` | Generic row plus hidden local-path media candidate |
| `image_to_video`, `reference_to_video`, `video_gen` | `ImageToVideo` / `VideoGen` | Generic row plus `video/mp4` media candidate |

Unknown future kinds keep their native name, canonical metadata, raw
input, generic row, and terminal output. Image and video capture grants
only the realpath-resolved session `images/` or `videos/` root.

## ACP extension requests

- `_x.ai/ask_user_question` maps to YA `AskUserQuestion`.
- `_x.ai/exit_plan_mode` maps to YA `ExitPlanMode`.

Both fail closed when the session is aborted, no approval callback is
available, the payload is unusable, or YA handling throws. Unknown Grok
extension methods remain protocol errors. The shared ACP client installs
an extension handler only when a provider registers one.

## History replay

Replay reads `updates.jsonl` as the authoritative restore stream and
normalizes only transcript-bearing updates. High-churn
`available_commands_update` records are capability evidence, not message
history. Live ACP uses the same update for the `/` menu. Do not copy
arbitrary per-update `_meta` telemetry; keep the stable `x.ai/tool`
identity subset under `input.grokTool`.

## Open provider work

- Re-run the provider-refresh audit when the installed catalog, ACP
  dependency, or first-party request/notification enums change.
- Preserve generic fallbacks for future tool kinds with no YA surface.
- Keep Grok isolated behind `ENABLED_PROVIDERS` until ACP stability is
  good enough for ordinary default-enable.
- Phase 2 scanner/schema for project discovery is still open; session
  listing and `updates.jsonl` replay already exist.
- `/btw` aside fork is not yet on the Grok whitelist.

## Implementer sources

For the released binary, prefer `~/.grok/docs/user-guide/`,
`grok --help`, `grok models`, `GROK_HOME/models_cache.json`, and
`~/.grok/sessions/`. First-party `xai-org/grok-build` is the readable
agent-loop reference; compare its package version and `SOURCE_REV`
against `grok --version` before treating a source finding as evidence
for the installed patch.

<!-- epistemic status: installed 1.0.4 binary + no-token ACP initialize
(grok-4.6 default, xhigh) + matching public xai-org/grok-build 1.0.5 source
as of 2026-08-16; provider remains gated -->
