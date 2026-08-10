# Steer/queue provider differences (Claude vs Codex)

> Steer/queue provider differences: what "send while the agent is busy"
> actually does in each provider's native stack, on what level Codex
> "uniquely" supports steering, and how each provider signals that a turn is
> really over.

Topic: steer-queue-provider-differences

See also:
- [message-control-steer-queue-btw-later-interrupt.md](message-control-steer-queue-btw-later-interrupt.md)
  — YA's UI-visible delivery-intent contract that consumes these facts.
- `packages/server/src/sdk/providers/codex-turn-lifecycle-findings.md` —
  Codex app-server probe evidence this doc builds on.

## The turn, precisely

A *turn* is one user input followed by the agent's full autonomous loop
(any number of tool calls and interim assistant updates) ending in a final
response. Interim updates are not turn ends:

- **Claude (verified in real `~/.claude/projects` JSONL, 2026-06-11):**
  mid-loop assistant records carry `stop_reason: "tool_use"`; only the
  turn-final record carries `end_turn` (or `stop_sequence`). Sampled
  sessions: 239 `tool_use` / 9 `end_turn`; 304 / 5. Turn boundaries ARE
  recoverable from JSONL history, contra the upstream belief that they are
  SDK-only.
- **Codex (verified by probe, see codex-turn-lifecycle-findings):** turn
  completion is a discrete `turn/completed` JSON-RPC notification; interim
  text arrives as items inside the active turn.

The motivating upstream demo (kzahel, 2026-06-11): one prompt running six
10-second sleeps with interim "Sleep n/6 finished" updates is ONE turn —
the native Codex app held his queued message until all six finished.

## Native send-while-busy semantics

### Codex

- Typed mid-turn input in the native TUI is pending steering: shown under
  `Messages to be submitted after next tool call`; `Esc` interrupts to
  submit immediately (observed 2026-06-05, reproduced 2026-06-11).
- The explicit queue affordance in the Codex app holds the message until
  `turn/completed` (observed in the upstream sleep demo).
- Protocol: `turn/steer` appends input to the active turn; the model sees
  it at its next inference step, i.e. after the in-flight tool call.

So native Codex "steer" ≡ "after next tool call", and native Codex
"queue" ≡ "at end of turn".

#### Active-turn identity during resume

Codex app-server's `turn/start` response can identify the submitted turn while
the resumed core is already executing that work under a different active-turn
ID. Active-turn notifications (`item/*`, plan and token updates, and
`turn/completed`) are the authoritative live identity for that thread. YA
adopts the ID observed there before matching completion or sending controls.

If a steer or interrupt races the first authoritative notification, Codex
rejects the request before acting and reports both the expected and actual
active-turn IDs. YA adopts the reported actual ID and retries that same control
once. A second mismatch or any differently shaped error is a real failure:
steer returns to YA's deferred delivery path, while interrupt proceeds to the
ordinary verified hard-abort fallback.

### Claude

Claude Code's command queue supports three priorities on user messages.
Evidence (2026-06-11): `SDKUserMessage.priority?: 'now' | 'next' |
'later'` in `@anthropic-ai/claude-agent-sdk` 0.3.170 `sdk.d.ts`, plus the
bundled CLI 2.1.173 implementation:

- rank table `{now: 0, next: 1, later: 2}`;
- the agent loop drains queued commands at post-tool-batch boundaries via
  `getCommandsByMaxPriority("next")` — so `later` items are NOT consumed
  mid-turn and wait for end of turn;
- a queued `priority === "now"` message additionally fires
  `abort("interrupt")` on the in-flight API request — stronger than Codex
  steer, which waits out the current tool call;
- internal task notifications inject with `next`; cron/loop scheduled
  prompts inject with `later`.

Mapping:

| Claude priority | Delivery | Codex equivalent |
|---|---|---|
| `now` | interrupt in-flight generation, inject | stronger than `turn/steer` (TUI `Esc`-steer is the close analog) |
| `next` | after the current tool batch | `turn/steer` ("after next tool call") |
| `later` | end of turn | app queue / YA `deferred` |

Default-lane resolution (verified in bundle 2.1.173, 2026-06-11): the
command-queue factory exposes `enqueue` (default `priority ?? "next"`)
and `enqueuePendingNotification` (default `"later"`). Prompt-mode
submissions — TUI Enter and bridge-injected user messages alike — route
through `enqueue` with no explicit priority, so **Claude's default
Enter-while-busy send is `next`**: same lane as Codex steer, not `now`
(a circulating claim that Enter is `now` is wrong — `now` is only ever
set explicitly) and not `later`. `later` defaults apply only to internal
pending notifications; cron/loop prompts pass `later` explicitly.

Why Claude `next` still *feels* slower than Codex steer: boundary
granularity. Claude drains `next` items at post-tool-batch boundaries —
one API response can bundle a long extended-thinking stretch plus
several tool executions before the next model request. Codex injects
after the single in-flight tool call. Same lane, coarser tick.

Consequence for YA: `claude.ts` now advertises steering and implements
`steer` by pushing the user message into YA's `MessageQueue` immediately.
`Process` stamps Claude steer messages with `priority: "now"` when the
browser sets `metadata.steerNow`, otherwise `priority: "next"`. Browser clients
default the existing **Steer now** preference on when no stored
`steerNowDefault` exists; an explicit false remains authoritative and selects
`next`. YA-held queued (`deferred`) and patient messages are still kept out of
`MessageQueue` until their turn-end / verified-quiet criteria pass; when they
finally enter Claude, YA stamps `priority: "later"` as a wire-level guard.

The full YA→Claude send path, naming both queue layers:

```
YA composer → either YA deferred queue (queue/patient timing) or immediate
steer path → YA MessageQueue (batch/concat) → SDK streamInput → CLI stdin
→ CLI command queue (YA stamps next/now/later) → drained at tool-batch
boundary / turn start
```

The agent SDK spawns this same CLI and is a thin stdio client, so YA is
always driving the queue machinery described above. YA controls *when*
a message enters the pipe (its own queues) and *which lane* it takes
(`priority` on the SDKUserMessage). The transcript JSONL is observation
only; a message visible there has left every queue.

## Levels of "soon" (urgency ladder, short of hard interrupt)

Every lane available for delivering new user input, most to least urgent,
with the invoking mechanism. Hard interrupts (Claude `query.interrupt()`,
Codex `turn/interrupt`) bracket the ladder but cancel work; they are not
"send" lanes.

| Level | Claude mechanism | Codex mechanism | YA UI |
|---|---|---|---|
| 0. Inject now (abort in-flight *generation*, keep the turn) | `priority: "now"` on a streamed user message; while inference is active the CLI aborts sampling and re-calls the model with the message. The priority itself stays queued behind foreground Bash. YA separately makes configured Bash calls resumable after writing the steer, as described below. | none as a single lane; TUI `Esc` on the pending-steer prompt composes interrupt+submit | Claude-only `Now` checkbox beside steer, default on when no preference is stored |
| 1. After current tool call / tool batch | `priority: "next"`; the loop drains `getCommandsByMaxPriority("next")` at post-tool-batch boundaries (internal task notifications use this lane) | `turn/steer` RPC `{threadId, expectedTurnId, input}`; lands in the active turn's `pending_input`, consumed when the *next model request* is composed — it does NOT abort in-flight sampling, so during a long thinking/text stretch it waits for the whole current response (and its tool batch). Native TUI default for typed mid-turn input | ↗ steer |
| 2. End of turn (the real queue) | `priority: "later"`; not consumed mid-turn, starts the next turn at turn end (cron/loop prompts use this lane) | no protocol lane — the native app holds the message client-side until `turn/completed`; YA holds it server-side (`deferred`) | → queue |
| 3. End of turn + verified quiet window | not native | not native | Zz patient (`patienceSeconds`) |

Asymmetry worth knowing: Codex exposes steering in the protocol but
queueing only as client-side holding; Claude exposes all three native
lanes as data on the user message itself (`priority`), so "Claude can't
steer" was never a platform fact.

All lanes are client-side queue disciplines. The Messages API is
stateless — every request re-sends the conversation, so a queued message
reaches the LLM server only when the next request is composed with it
included (`now` = abort current request, message rides the immediate
re-request; `next` = next request after the tool batch; `later` = first
request of the next turn). This is why Claude's TUI can offer "press up
to edit queued messages": queue residency is purely local
(`popEditableAt` pulls the entry back into the composer), and the edit
window closes exactly when the entry is drained into a request. YA's
deferred queue is the same discipline one level up the stack.

### TUI affordances (or their absence)

The Claude TUI exposes NO keypress or mode toggle for `now` or `later`
(verified 2026-06-11: the 2.1.173 bundle contains zero producers of
`priority: "now"`; `"later"` is produced only by internal cron/loop
schedulers). The user-reachable surface is exactly: Enter → `next`,
Esc → hard interrupt (running command killed, turn ends). The
`now`/`later` lanes are wire-level — reachable only by programmatic
clients injecting messages with an explicit `priority` (SDK
`streamInput`, the desktop/claude.ai bridge). A supervisor like YA can
therefore expose a fuller send-mode UI than the native TUI itself.

Delivery is not response: in a live test (haiku, six 10s sleeps), a
plain Enter mid-turn produced a thinking block acknowledging the message
at the next tool boundary — the `next` lane delivered promptly — but the
model elected to finish its instructed sleep sequence before replying.
Steering hands the model the message; whether it acts mid-task is model
behavior. Perceived "Claude is less responsive than Codex" conflates
lane latency (similar) with model compliance (varies).

### `now` vs hard-interrupt+send

During active inference, both abort sampling promptly; everything around that
differs. Hard interrupt (Esc / `query.interrupt()`) ends the turn in a terminal
"interrupted" state and may cancel the active tool. `priority: "now"` keeps the
turn: the next model request includes the new message, with no hard-interrupt
boundary. In the live YA SDK test below, `now` alone did not abort or background
a foreground Bash command; the input stayed queued until the command completed.
This supersedes the earlier inference that streamed `now` necessarily invokes
the CLI's automatic task-backgrounding behavior. The installed SDK exposes
`query.backgroundTasks(toolUseId)` as a separate imperative control for
foreground Bash commands and subagents; it is not a state query and `now` does
not implicitly call it in the observed YA path. YA now calls that separate
control for matching Bash commands only, after sending the steer.

### Residual correction race and banked grace gate

Live Claude 2.1.223 / Agent SDK 0.3.223 probes on 2026-08-08 established the
current YA behavior:

- A forced `now` steer enqueued at `07:11:51.118Z` while foreground Bash slept
  for 120 seconds. Bash completed normally at `07:13:36.774Z`; only then did
  the command queue dequeue the steer at `07:13:36.777Z`. There was no process
  interruption, background result, or interrupted transcript boundary.
- In a boundary-race probe, the first correction was delivered at
  `07:20:22.054Z`. A second `now` correction enqueued 112 ms later and dequeued
  2 ms after that. Claude emitted only the second correction's `FINAL`; the
  harmless Bash action requested by the first correction never launched.
- In the motivating session, three ordinary `next` steers enqueued over 34
  minutes were all removed at the same post-Bash boundary before Claude's next
  tool call. That trace demonstrates provider-side burst draining, not a
  one-steer-at-a-time failure.

This makes `now` the useful default: it remains patient across the observed
foreground Bash phase, then can replace a just-delivered correction while the
next inference is still running. It does **not** make separately submitted
messages atomic. Claude can still finish inference and launch a side-effecting
tool in the interval before a later correction arrives. Transparency for
non-Bash foreground tools remains unverified; do not generalize the Bash result
to Edit, MCP, or other tool executors without a matching probe or upstream
contract.

A general guarantee therefore needs a grace period before tool execution, not
a guessed list of interruptible commands. A future YA implementation could
investigate a configurable asynchronous `PreToolUse` hook that briefly holds
every tool and allows a newly arrived `now` message to cancel the pending call.
Before adoption it must prove that CLI cancellation aborts a hook-pending tool,
cover every provider tool class, and justify the latency paid on every action.

A configurable Bash re-foregrounding policy is implemented separately from the
`now` lane. Once a steer has been yielded into the SDK input stream, YA waits one
event-loop turn and calls `backgroundTasks(toolUseId)` for each matching active
main-turn Bash call. It never uses the all-task form, never targets Edit,
subagent-owned Bash, or any other tool, and never hard-interrupts the provider.
A successful call returns a synthetic "running in the background" tool result
so Claude can consume the already-written steer while the original process
continues.

Claude has an early registration window: in controlled SDK 0.3.223 / Claude
2.1.223 probes, the exact-ID control returned false one second after the command
created its start marker, but succeeded at three and five seconds. YA therefore
retries that exact ID once per second for at most twelve seconds while the same
Bash tool remains foreground. A tool result, successful background request, or
provider abort stops the retry; a miss leaves the steer in Claude's ordinary
`now` lane. The bounded retry exists only after a steer and creates no idle
session loop.

The live success probes established the intended ordering and safety properties:
the transcript enqueued the urgent correction before backgrounding; the Bash
completion marker was written normally; Claude received the background result,
waited on the same task with `TaskOutput`, emitted `FINAL`, and never launched
the deliberately requested follow-on Bash. This proves process preservation and
prompt re-entry for the tested Bash path, not atomic multi-message steering.

The server setting `claudeSteerBackgroundBash` owns the concurrency policy for
new Claude processes. Both expressions match the whole raw
`Bash.input.command`, case-sensitively and with dot matching newlines. The
default is `{ allowRegex: ".*", denyRegex: "" }`: allow every Bash command and
deny none. Empty allow disables re-foregrounding; empty deny has the special
meaning "deny nothing"; deny wins when both match. Invalid settings writes are
rejected, and invalid programmatic values fail closed. Operators can deny
expensive, side-effecting, or lock-holding commands when Claude must not act
concurrently with them. YA carries no built-in `agentctl` or command whitelist.

Claude's internal `cancel_async_message` control is narrower. SDK 0.3.223
declares the control request and implements it at runtime, but omits it from the
public `Query` interface. It can drop one UUID-stamped message only while that
message is still resident in Claude's command queue; after dequeue/coalescing
it is a no-op. It could eventually improve YA's existing **Cancel unacted
steer** path, but it cannot close the post-dequeue correction race.

## Is the patient lane redundant?

Mostly-idle sessions: yes-ish — once a queue really waits for end of
turn, patient only adds its quiet window. But "end of turn" and "agent is
really done unless we say something" differ exactly when turns chain
without user input: Claude background tasks settle and inject
`task-notification` commands at priority `next` (waking a new turn),
cron/loop prompts fire at `later`, and YA heartbeat turns start turns on
idle sessions. The unattended-for-hours scenario is the one where
chaining is common, so the patient lane is the only "wait for true
quiet" option. Keep: queue = end of turn (default), patient = optional
quiet window in seconds.

## On what level is "only Codex steers" true?

Historically, only at the YA-integration level: YA wired `steerFn` for
`codex` (`turn/steer`) and for `grok-acp`, while Claude busy sends were held
in YA's deferred queue. The Grok half of that was never real steering — YA
sent a second ordinary `session/prompt`, which Grok answers as a later turn,
so Grok's `steerFn` was withdrawn on 2026-08-05 (measurement in
[grok.md](grok.md)). Distinguish that from Codex's `turn/steer`, which does
act on the running turn: a provider-native *queued follow-up prompt* is not
steering, whatever the call site is named. As of 2026-06-11, the Claude half
is also no longer true in YA:
Claude advertises `supportsSteering`, steer sends enter `MessageQueue`
immediately with `priority: "now"` by default, and an explicit disabled
**Steer now** preference selects `priority: "next"`. The Claude platform itself
supports both the
"after next tool batch" semantics (`next`) and the stronger immediate mode
(`now`); YA exposes both without inventing another delivery lane.

## Perceived responsiveness, explained

- Codex steer lands within one tool call (seconds during tool-heavy work).
- Claude steer in YA uses `now` by default. It interrupts active inference.
  Matching foreground Bash commands are then made resumable by exact tool ID;
  an unmatched or early-registration miss leaves the steer waiting for the
  foreground result. An explicit disabled **Steer now** preference restores the
  post-tool-batch `next` lane, while Bash re-foregrounding remains a separate
  server policy.
- Claude queue in YA is deliberately different: queued sends stay in YA's
  deferred queue until the turn-end `result` boundary, then enter Claude as
  `priority: "later"`.

## "Really done forever unless we say something"

What each side gives YA as the done-signal:

- **Codex:** `turn/completed` notification (status completed / interrupted
  / failed). YA's codex provider maps it to a `result` message →
  `Process.transitionToIdle()`. YA first adopts that notification's turn ID,
  so a resumed core whose active ID differs from the earlier submission ID
  cannot strand the process in `in-turn`.
- **Claude:** the SDK `result` message per turn (YA's idle trigger), plus
  `system/session_state_changed` (`idle`/`running`/`requires_action`),
  plus — for history with no live process — JSONL `stop_reason`
  (`end_turn`/`stop_sequence` vs `tool_use`).

Caveats — "idle" is not literally "forever":

- `waiting-input` (tool approval, AskUserQuestion) pauses inside a turn;
  not idle, not done.
- Claude background tasks (backgrounded Bash/subagents) can settle after
  turn end and inject `task-notification` commands at priority `next`,
  waking a new turn with no user input. Scheduled cron/loop prompts
  (priority `later`) likewise start turns.
- YA's own heartbeat turns intentionally start new turns on idle sessions.

This is why YA's patient queue gates on `verified-idle` plus a per-item
quiet window (`patienceSeconds`) rather than trusting one idle edge: the
quiet window absorbs turn-chaining (background-task wakeups, heartbeats)
that a bare end-of-turn signal misses.
