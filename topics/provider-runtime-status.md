# Provider runtime notifications and user-visible status

> Provider retry and terminal-failure notifications must remain distinguishable
> from transcript content, survive the lifecycle that owns them, and tell the
> user whether recovery is automatic or requires action.

Topic: provider-runtime-status

## Layers

Provider failures reach YA through three related but distinct layers:

1. **Provider notification.** The native SDK or app-server emits its own event.
   Examples include Claude `system/api_retry` messages and Codex app-server
   `error` notifications followed by `turn/completed`.
2. **Normalized SDK message.** The provider adapter converts the native event
   into YA's loose `SDKMessage` envelope. Live transcript errors need stable
   identities so a following id-less result/status message cannot replace them.
3. **Session runtime status.** `Process` and `Supervisor` project actionable
   retry/failure state into REST, session subscriptions, the activity bus, and
   the composer status surface. This is status about the provider runtime, not
   a provider-authored conversation turn.

Do not infer terminal failure from silence. A terminal status requires an
explicit provider error or failed-turn signal. Liveness remains a separate
answer to whether the process is alive, active, idle, or waiting for input.

## Recovery semantics and color

Color follows recovery behavior rather than the underlying error taxonomy:

| Runtime kind | Meaning | Surface tone | Clear condition |
| --- | --- | --- | --- |
| `retrying` | The provider says it will retry automatically. | Warning/yellow | Provider progress, completed turn, abort, or replacement status. |
| `terminal` | The current turn ended and will not retry automatically. The session may still be usable. | Danger/red | The next user turn begins, or YA restarts. |

“Terminal” is turn-scoped. UI copy should say that the provider stopped or the
turn ended; it must not imply that the session or provider process crashed.
Hover/title detail should say explicitly whether retry is automatic and include
the provider's error text when available.

Changing models while `retrying` is an explicit recovery override. Apply the
new model first, then interrupt the provider-owned retrying turn so the next
queued or newly submitted turn can use that model; clear the retry status once
the interrupt is accepted. A model change during an ordinary active turn
remains a next-turn setting and must not truncate useful output. If a provider
can change models dynamically but cannot interrupt a retrying request, YA must
restart that provider process rather than leave the old-model retry clock in
control.

Likewise, changing Claude effort during an ordinary active turn is a
next-turn setting. YA accepts the selection immediately, applies it at the
provider idle boundary before queued work, and never interrupts the current
turn. Manual stop remains independently available; treating a configuration
choice as a stop can discard nearly completed, already-paid-for reasoning on a
high-cost turn.

Effort control writes are serialized and latest-selection-wins: a slower older
provider call cannot overwrite a newer choice. At a turn boundary, failure to
apply the selected effort retains that selection and keeps the process
non-idle, so deferred work cannot start under the previous effort. A later
selection retries the provider control; only a successful application
completes the idle transition and releases queued work. The failed control
write is surfaced to the active client as a configuration error and logged
without terminating the process's provider-message consumer, so the resumed
turn can still report progress and completion.

YA's initial Codex `CodexErrorInfo` normalization maps as follows:

- `serverOverloaded` -> `overloaded`
- `usageLimitExceeded` and `sessionBudgetExceeded` -> `rate_limit`
- `internalServerError` -> `server_error`
- HTTP/response-stream connection and disconnect variants -> `network`
- all other terminal errors -> `unknown`

The `sessionBudgetExceeded` mapping is a known semantic mismatch: Codex uses it
for its configured shared rollout token budget, not subscription credits. A
future taxonomy should distinguish at least context/session budget, auth,
policy, request, and sandbox failures from billing rate limits.

## Codex 0.144.1 source audit

The findings in this section were checked against the official Codex source at
tag `rust-v0.144.1`, matching root `package.json`
`yepAnywhere.codexCli.expectedVersion`. Run `pnpm references:sync` to put the
gitignored `references/codex` checkout at that tag, or `pnpm references:check`
to verify an existing checkout without changing it.

The most useful upstream coordinates are:

- `codex-rs/protocol/src/error.rs`: `CodexErr`, `CodexErr::is_retryable`, and
  `CodexErr::to_codex_protocol_error` define retry policy and public error
  classification.
- `codex-rs/protocol/src/protocol.rs`: `CodexErrorInfo::affects_turn_status`
  separates failed turns from command/control errors.
- `codex-rs/core/src/responses_retry.rs`:
  `handle_retryable_response_stream_error` controls retry count, backoff,
  WebSocket-to-HTTPS fallback, and visible reconnect notifications.
- `codex-rs/core/src/session/mod.rs`: `Session::notify_stream_error` constructs
  the intermediate retry event.
- `codex-rs/app-server/src/bespoke_event_handling.rs`: the `EventMsg::Error`
  and `EventMsg::StreamError` branches translate core events into app-server
  notifications; `handle_error_notification` records terminal turn state.
- `codex-rs/app-server-protocol/src/protocol/v2/notification.rs`:
  `ErrorNotification` documents `willRetry` as the authoritative recovery
  signal.
- `codex-rs/app-server-protocol/src/protocol/v2/shared.rs`: the camel-case
  app-server `CodexErrorInfo` wire variants consumed by YA.
- `codex-rs/app-server-protocol/src/protocol/thread_history.rs`:
  `ThreadHistoryBuilder::handle_error` reconstructs failed turns when a durable
  core `ErrorEvent` is available.
- `codex-rs/tui/src/chatwidget/streaming.rs`: `ChatWidget::on_stream_error`
  shows automatic retries in the status area.
- `codex-rs/tui/src/chatwidget/turn_runtime.rs`:
  `ChatWidget::handle_non_retry_error` and its helpers show first-party
  terminal presentation choices.

Paths above are relative to `references/codex`. Do not use a floating `main`
checkout as evidence for the pinned runtime without first comparing its tag.

### Automatic retry pipeline

Automatic retry is not inferred from an error name. The app-server's
`ErrorNotification.willRetry` boolean is authoritative:

1. A retryable `CodexErr` reaches
   `handle_retryable_response_stream_error`.
2. Codex retries with backoff and may fall back from WebSockets to HTTPS.
3. For a visible retry, `Session::notify_stream_error` emits
   `EventMsg::StreamError` with message `Reconnecting... n/max`, the original
   error text in `additionalDetails`, and `responseStreamDisconnected` as the
   public error info.
4. App-server converts that to `error` with `willRetry: true` without marking
   the turn failed.
5. The first-party TUI routes it to `on_stream_error`, which updates the status
   pane rather than adding an error history row.

Release Codex may intentionally hide the first WebSocket retry notification to
avoid noisy transient reconnect messages. This helps explain why retries can
appear inconsistently in raw observations. Older/raw JSONL or event consumers
may expose `StreamError` as an event, but it is provider runtime status, not a
provider-authored conversation message or a completed failed turn.

YA converts `willRetry: true` into yellow Codex runtime status and renders its
live transcript row as a warning rather than a terminal error. It retains the
provider message and `additionalDetails` for diagnostics and clears retry state
when provider progress resumes. No retry countdown is invented: app-server
does not send the actual backoff delay.

### Terminal error pipeline and classification

Core `EventMsg::Error` values that affect turn status become app-server
`error` notifications with `willRetry: false`. App-server also repeats the
error in the following failed `turn/completed` payload. YA should use the
boolean for red/yellow recovery semantics and the error info only for reason,
copy, and suggested action.

| App-server `CodexErrorInfo` | Codex meaning | Suggested YA reason/action |
| --- | --- | --- |
| `contextWindowExceeded` | Model context is full. | `context`; suggest clearing earlier history or starting a new thread. |
| `sessionBudgetExceeded` | Configured shared rollout token budget is exhausted. | `budget`; do not describe it as subscription credits. |
| `usageLimitExceeded` | Usage, quota, or plan inclusion limit. | `rate_limit`; retain provider/account guidance. |
| `serverOverloaded` | Selected model is at capacity. Codex does not retry it automatically. | `overloaded`; changing model or retrying later is appropriate. |
| `cyberPolicy` | Cyber-safety policy ended the turn. | `policy`; mirror the first-party dedicated safety notice. |
| `httpConnectionFailed` | HTTP connection failed after retries. | `network`; retain `httpStatusCode`. |
| `responseStreamConnectionFailed` | Response stream could not be established after retries. | `network`; retain `httpStatusCode`. |
| `responseStreamDisconnected` | Response stream disconnected before completion. | `network`; normally intermediate when `willRetry` is true, terminal if false. |
| `responseTooManyFailedAttempts` | Codex exhausted response attempts. | `rate_limit` for HTTP 429; otherwise retry-exhausted/network/server copy. |
| `internalServerError` | Upstream internal failure or internal agent death. | `server_error`; retry requires a new user turn after Codex exhausts its own retry loop. |
| `unauthorized` | Auth refresh failed. | `auth`; offer authentication diagnostics or reauthentication. |
| `badRequest` | Unsupported operation, missing thread, agent limit, or another rejected request. | `request`; raw provider text is important because the category is broad. |
| `sandboxError` | Codex sandbox execution/setup failed. | `sandbox`; distinguish it from user denial and point toward the permission/environment boundary in [codex-permission-mode](codex-permission-mode.md). |
| `other` or absent | No stable public classification. | `unknown`; always preserve the provider message and request id. |

`threadRollbackFailed` and `activeTurnNotSteerable` explicitly return false
from `affects_turn_status`. App-server normally resolves or suppresses them as
request/control failures rather than failed-turn notifications. YA should
defensively avoid retaining either as a terminal turn incident if protocol
drift ever exposes one through the generic error path.

### Process failures and non-error notifications

YA's Codex app-server client synthesizes `error` with `willRetry: false` when
the child process exits. That notification intentionally has no thread or turn
id. The loose fallback conversion preserves its nested message, such as `Codex
app-server exited (code=..., signal=...)`, and marks its optional scope as a
provider-process failure. New clients can explain that the process stopped;
older clients safely render the same ordinary error envelope.

Codex also sends `warning`, `guardianWarning`, `configWarning`, and
`deprecationNotice`. YA's Codex SDK adapter currently drops these in the
default notification branch. They are not terminal incidents; a later
notification-surface pass should decide which belong in transient yellow/info
UI, diagnostics, or transcript display objects.

### Hosted-client compatibility

Provider runtime status crosses REST, session SSE, the activity bus, and remote
relay transports without a separately negotiated schema version. Evolve it
additively:

- keep `retrying` and `terminal` as the stable discriminants;
- add diagnostic fields such as retry message/details and terminal scope only
  as optional properties;
- keep normalized provider errors in the existing loose `SDKMessage`
  envelope, where older clients ignore new Codex metadata;
- make new clients treat absent optional fields as the older behavior (`error`
  remains terminal-looking when `codexWillRetry` is absent, and terminal scope
  defaults to the current turn);
- never require an older server to send the new scope/details fields for the
  composer or transcript to render safely.

This permits a newer hosted frontend to connect to an older YA server and an
older frontend to consume a newer server. Mixed versions may have less precise
copy or color, but must not crash, hide the provider message, or misread a new
wire discriminant.

## Surfaces

### Composer status

The composer status is the durable-within-the-running-YA explanation of why a
turn stopped. Retrying status may show a retry clock. Terminal status stays
visible while the user is deciding whether to retry or change models.

The status is available through session REST snapshots, live subscription
snapshots, and activity events so reconnecting clients converge.

### Live transcript

A provider error may also appear at the live transcript tail, where it explains
the exact turn boundary. Codex's first-party TUI renders `serverOverloaded` as
a warning history row. YA may choose its stronger terminal/danger tone while
preserving the provider message.

This row is live-only when the provider does not persist the notification. It
must have a stable message id, but YA must not write a shadow provider turn to
make it survive reload.

### Diagnostics

Process info may expose kind, reason, provider message, source notification,
turn id, timestamps, retry timing, and attempt counts. Diagnostic detail must
not be the only place the user can learn that a turn ended.

## Persistence and resource ownership

The observed `serverOverloaded` rollout contained `task_complete` with a turn
id and nullable last agent message, but no durable error event. Codex source
does support reconstructing a failed `Turn.error` when a core `ErrorEvent` is
present in app-server thread history. These are conditional facts, not a
guarantee that every rollout or YA JSONL reader can recover the error. YA must
not manufacture a pseudo-turn to bridge the gap; prefer native `thread/read`
data if it becomes reliably available, otherwise use bounded runtime status.

Terminal runtime status is retained in a bounded, in-memory Supervisor map
keyed by YA session id. It survives provider process reaping and client
disconnects, but not a YA server restart. It is not stored in
`session-metadata.json` and is not a transcript display object.

The map has a fixed entry cap and no timer or background loop. A retained
status must never retain a provider process, watcher, heartbeat, or client
subscription. The next user message clears the old incident before the new
turn proceeds; a repeated failure records a new terminal incident.

## Tests

Coverage should prove:

- retrying and terminal statuses have different color/copy semantics;
- changing models during retry applies the new model before interrupting the
  held turn and clears the retry status;
- changing models during an ordinary active turn does not interrupt it;
- Codex `willRetry: false` errors become terminal status with the right reason;
- terminal status survives `result`, idle transition, and idle process reap;
- the Supervisor serves retained terminal status without a live process;
- a new user message clears the retained incident;
- a following id-less/result message does not replace the live error row;
- subscriptions and REST snapshots carry both status kinds.

Codex coverage should additionally prove:

- `willRetry: true` becomes yellow retry status and is not styled as terminal;
- terminal classification covers the source table above without string
  matching the recovery decision;
- `sessionBudgetExceeded` is not called a subscription rate limit;
- app-server exit notifications preserve their real process error;
- non-turn control errors do not leave retained terminal status;
- warning/config/deprecation notifications follow an explicit surface policy.
