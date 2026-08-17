# Grok Build Evidence

This companion preserves dated probes, version-by-version refresh notes, and
implementation chronology behind the live contract in
[`grok.md`](grok.md). It is evidence and design history, not the current
product contract.

## 2026-08-17 — Interject ack is wrapped

Live session `01a00e85-819d-7850-8a0d-800a7fa3ad3c` accepted every mid-turn
steer (`events.jsonl` `type: interjected`) and still issued a later
`session/prompt` that concatenated those same texts with `--------`.
Grok's ACP handler returns `ExtMethodResult`
`{ result: { status: "queued" } }`. YA's `steer()` had compared the outer
`status`, returned false, and `Process.queuePreparedMessage` pushed the
already-accepted text into `MessageQueue`. When the first prompt ended,
the iterator drained that queue as one joined turn. Observed 2026-08-17
after the `0275d564` interject wiring; Codex + patient queue was not
involved in that concat. Grok patient items still promote at ordinary
turn-end (not Claude's verified-idle path).

## 2026-08-17 — Interject envelope is display-only

Live `01a00e6c-4f08-7e11-9cad-32996bb47a0c` `updates.jsonl` confirmed
drain writes one `user_message_chunk` whose text is the documented
envelope. YA's optimistic steer echo is the inner text; replay must
unwrap the outer wrapper or the confirmed turn shows the boilerplate.
Quoted inner `<user_query>` blocks stay in the user's text.

## 2026-08-16 — 1.0.4 / grok-4.6 refresh

Installed `grok 1.0.4 (d846eb93d9) [stable]`. Public `xai-org/grok-build`
refreshed to git `9fabadea800fa6e2ed8ec91c4f45f02b7e2504f4` (`SOURCE_REV`
`7bd63df3c9bb1bf98e7a9b3486f4a0189ea94e55`, crate 1.0.5).

A no-token ACP `initialize`/`session/new` reported `currentModelId: grok-4.6`
with 500k context and default effort `xhigh`. `grok models` listed
`grok-4.6` (default) and `grok-4.5`.

Rejected embedding alternatives for YA live supervision:

- `grok agent serve` — same ACP contract over WebSocket, extra process and
  auth surface, no richer events.
- Headless `-p --output-format streaming-json` / `--include-partial-messages`
  — one-shot script output, not a durable multi-turn session.
- Direct xAI HTTP APIs — lose the CLI tool loop, sandbox, skills, and
  `~/.grok/sessions` identity.
- Unofficial CLIs such as `@vibe-kit/grok-cli` — a different product.

YA's pinned `@agentclientprotocol/sdk` 0.12.0 still covers the 1.0.4
initialize union and the two reverse extension methods YA handles.
Upgrading to 0.24.0 is a shared ACP-client change, not a Grok-backend
replacement.

1.0.4 still advertises `agentCapabilities.loadSession: true`. It also
advertises `sessionCapabilities.resume`; YA did not switch to
`session/resume` in this refresh.

Interject drain (from public 1.0.5 source): ACP returns `{ status:
"queued" }` immediately. The session actor holds text (and optional
images) and drains after a completed tool batch, at the top of the next
model step, or immediately before the turn would return to the user.
Drain injects `SyntheticReason::Interjection` with envelope:

```
The user sent a message while you were working:
<user_query>
…interjection text…
</user_query>
Make sure to complete any unfinished tasks from previous turns.
```

Only blocking wait tools (`get_task_output` / `wait_tasks` and aliases,
when actually waiting) abort. Mid-sample text is not spliced; the next
model step sees completed assistant text, tool results, then the
synthetic user item. If no turn is running, Grok converts the
interjection into a normal queued prompt.

## 2026-08-05 — 0.2.118 continuation and steering correction

Re-measured against installed `grok 0.2.118 (1e1687c1cf) [stable]` by
probing `grok agent stdio` directly.

Two YA contracts were wrong and were corrected:

- Continuation is `session/load`, not `session/resume`. Initialize
  advertised `agentCapabilities.loadSession: true` and implemented no
  resume method: both `session/resume` and the unstable extension form
  answered JSON-RPC `-32601 Method not found`. YA had been calling
  unstable `session/resume`, so a Grok session whose YA-owned process
  ended could never be picked back up.
- A plain `session/load` re-emitted stored conversation as ordinary
  `session/update` notifications — measured: three history chunks
  including the prior turn's answer. `_meta: { noReplay: true }` dropped
  that to zero replayed chunks while the model kept full context.
- A second `session/prompt` finished the running turn and answered later.
  `x.ai/interject` queued into the running turn. The 2026-05-28 smoke
  (below) had proved the second prompt was *accepted*, not that it
  steered the running turn.

## 2026-07-29 — 0.2.112 local surface

Installed `grok 0.2.112 (9bbd559437) [stable]`. `grok models` advertised
only `grok-4.5` as default. `~/.grok/models_cache.json` described Grok 4.5
with a 500k context window and `high` (default), `medium`, and `low`
effort.

A live no-model-call ACP initialize reported protocol version 1, agent
version 0.2.112, `grok-4.5`, and commands including `compact`, `context`,
`session-info`, `deep-research`, `workflow`, and `goal`.

Session storage: `~/.grok/sessions/<encoded-cwd>/<uuid>/` containing
`summary.json`, `updates.jsonl`, `chat_history.jsonl`, `plan.json`,
`rewind_points.jsonl`, `signals.json`, `feedback.jsonl`,
`compaction_checkpoints/`, and `subagents/`, plus top-level
`session_search.sqlite`. Installed docs called `updates.jsonl` the
authoritative conversation log for `/load` and restore.

Matching public `xai-org/grok-build` source was git
`5da6962e4adb9c857f3def762542b52b4ec3e522`, monorepo `SOURCE_REV`
`2a818575225183d8ca915f5632a09b8067b5156a`. Package and installed CLI
were both 0.2.112.

Three successful Grok 4.5 medium-effort sessions exercised read / list /
grep / write / edit / bash, todo, web search/fetch, image gen/edit and
Markdown links, subagent spawn, background start/output/kill, user
question, enter-plan, plan-file write, and exit-plan. A spawned
read-only subagent supplied a fourth persisted session. This replaced
the earlier HTTP 402 evidence gap.

The public schema listed `goal_update`, but the requested goal-oriented
live run used `todo_write`; no distinct `goal_update` event was observed.

## 2026-07-23 — 0.2.111 and public source

Installed `grok 0.2.111 (94172f2aa4) [stable]`. Public checkout inspected
at git `a5727c5960452e7527a154b25cb5bf00cda0545e` (`SOURCE_REV`
`30192d2eef5d91a8fff0e53957de5bd05b43398c`, package 0.2.110). One-release
source lag was an explicit evidence boundary.

This refresh enacted: `grok models` + cache catalog discovery; consistent
`GROK_HOME` for binary/auth/cache; `x.ai/ask_user_question` and
`x.ai/exit_plan_mode` reverse-request bridges; audit of standard update
union and `_x.ai/session/update` as metadata-only.

A real prompt reached xAI but returned HTTP 402, so that refresh made no
claim of a successful 0.2.111 assistant/tool stream.

## 2026-05-28 — 0.2.3 refresh and steering smoke

Installed `grok 0.2.3 (14d81fd87) [stable]`. `grok models` and
`models_cache.json` agreed on a single visible model `grok-build`. Live
steering smoke through `GrokACPProvider` created a disposable cwd under
`.artifacts/grok-steer-cwd-*`, native session id
`019e6d49-7bdf-7da2-acaf-20b980bfe0db`. `session.steer()` returned true
and the drained assistant response contained both the initial `START_*`
token and the interjected `ACK_*` token.

That smoke was later reinterpreted: acceptance of a second prompt is not
proof of mid-turn steer. See 2026-08-05.

Server-restart reattachment smoke for native id
`019e6d4a-ffa9-7651-ba4e-c4baf2d772b4` resolved provider `grok`, model
`grok-build`, owner `none`. Detail still returned an empty `messages`
array because full `updates.jsonl` replay was then Phase 2 work (since
landed).

At 0.2.3, `grok agent stdio` accepted top-level `--effort`/`-m` *before*
`agent`; putting `--effort` after `agent` was rejected. 1.0.4 docs later
put agent flags after `agent` and before the transport.

## 2026-05-26 — Phase 1 takeover snapshot

`"grok"` was already in the provider list. `grok-acp.ts` started
`grok agent stdio` through `ACPClient`. Native Grok session IDs such as
`019e6603-889a-7451-a3f1-e44f37cfb125` were returned by
`POST /api/projects/.../sessions` and matched
`~/.grok/sessions/%2Flocal%2Fgraehl%2Fyepanywhere/<id>/summary.json`.
WebSocket subscription observed thinking, `Read` and `Bash`, `kind`,
`locations`, execute status lifecycle, and structured results.

`GrokSessionReader.getSession()` was then summary-only; it now replays
transcript-bearing `updates.jsonl` records.

Focused provider tests had been failing on auth parsing (any nonempty
`auth.json` treated as authenticated) and mocked ACP tests expecting
connection side effects before advancing the async iterator.

## Implementation phases (historical)

Phase 0 research and Phase 1 live supervision landed as an isolated
provider. Phase 2 scanner/schema for project discovery remains open.
Phase 3 polish (broader README/capability docs, default-enable decision)
remains open. Early-prototype non-goals — no edits to `Process`,
`EventBus`, replay buffer, or other-provider instantiation — applied to
that first landing, not to later Grok work.

## Rejected steer implementation

Do not implement Grok steer as a second `session/prompt`. The TUI
`Ctrl+Enter` interject continues the current turn; ACP `x.ai/interject`
is the matching embedding path. `session/cancel` remains the interrupt
path if wired later. `/btw` aside fork is a separate YA whitelist; Grok
is not on it yet.

## Implementer source pointers

For a released binary, prefer:

- `~/.grok/docs/user-guide/03-keyboard-shortcuts.md` (active-turn
  `Ctrl+Enter` interject)
- `05-configuration.md`, `14-headless-mode.md`, `15-agent-mode.md`,
  `16-subagents.md`, `17-sessions.md`
- `~/.grok/bin/grok --help`, `grok models`, `~/.grok/models_cache.json`
- Actual session directories under `~/.grok/sessions/`

## 2026-08-16 — Grok subagent depth launch knobs

Installed 1.0.4 user-guide `16-subagents.md` and `05-configuration.md`
document only:

- `GROK_SUBAGENTS=0` (or `1` to enable) as a process environment variable
- `[subagents] enabled = false` in `~/.grok/config.toml` (not used by YA)
- a hard nesting cap of one: a subagent that calls `spawn_subagent` fails

`grok --help` also lists `--no-subagents` and `--agents <JSON>` on the
top-level TUI command. `grok agent --help` does not list `--no-subagents`.
YA therefore injects `GROK_SUBAGENTS=0` on the `grok agent stdio` child
when the server-wide limit is `0`, and does not try to raise Grok's
native cap of one.
