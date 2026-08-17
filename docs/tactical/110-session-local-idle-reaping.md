# Bound Idle Provider Processes By Session Interest

> Replace the server-global browser courtesy lease with a per-session idle
> deadline so an always-open YA dashboard cannot keep every provider harness
> alive indefinitely.

Status: complete (2026-08-17).

Topic: session-local-idle-reaping

Related contracts:

- [`topics/architecture-mandates.md`](../../topics/architecture-mandates.md)
- [`topics/session-liveness.md`](../../topics/session-liveness.md)
- [`topics/reload-safe-provider-runtimes.md`](../../topics/reload-safe-provider-runtimes.md)
- [`topics/session-context-actions.md`](../../topics/session-context-actions.md)

## Reported problem and live baseline

YA's idle reaper currently treats browser presence as server-global. Every
authenticated app activity stream clears every idle provider deadline, and the
last global viewer release starts a fresh full grace for every eligible
process. A user who habitually leaves Inbox, Agents, Settings, or any other YA
page open therefore prevents all idle harness cleanup even when none of those
sessions has been viewed for days.

The live production-profile source server supplied the following baseline at
2026-08-17 08:53:37 UTC:

| Observation | Value |
| --- | ---: |
| Server build | `0.7.0-804-g4ab4adb7` |
| Hono process | PID 14245; uptime 5d 21h 08m |
| Hono root RSS | 2.61 GiB |
| Effective idle-reap grace | 24 hours; built-in default |
| Worker capacity | unlimited (`MAX_WORKERS` unset) |
| Supervised provider processes | 41 total; 40 idle; 1 in turn |
| Provider split | 40 Codex; 1 Claude |
| Idle beyond 24 hours | 31 |
| Provider-retained idle processes | 0 |
| Oldest idle boundary | 2026-08-11 14:48:21 UTC |
| Aggregate provider tree RSS | 12.74 GiB |
| Aggregate idle provider tree RSS | 12.39 GiB |
| Aggregate idle Codex tree RSS | 12.06 GiB across 39 processes |
| Aggregate idle root RSS | 1.86 GiB |
| Five largest idle process trees | 722.4, 672.8, 515.1, 492.4, 443.8 MiB |

The host-process sampler's tree RSS is an attribution sum, not unique
proportional-set memory: shared pages may be counted once in several process
trees. Even with that caveat, 40 verified-idle harnesses surviving for nearly a
week under an ordinary open browser tab demonstrates an unbounded ownership
policy rather than useful cache warmth.

The persisted server settings contained no `idleReapHours` override, and the
server process had neither `IDLE_TIMEOUT` nor `MAX_WORKERS` configured. The
observed result therefore comes from built-in behavior rather than a local
Never-reap preference.

## Decision

Viewer retention is session-local. A process is eligible for idle teardown only
when all existing safety gates agree:

- process state and conservative liveness are both verified idle;
- no feature, prompt-cache lease, provider retention, or teardown fence owns
  the process;
- the configured `idleReapHours` grace is enabled and has expired; and
- that same session has no mounted live-session viewer.

The deadline anchor is session-specific. An unseen process receives its grace
from the later of process creation and its idle transition. Opening that
session clears its idle deadline; after the last viewer of that same session
leaves, it receives a fresh full grace. A user turn moves the process out of
idle and its later verified-idle transition starts a new grace. Merely opening
YA, browsing another session, or keeping a global activity stream connected
does not affect the deadline.

Active and waiting-input sessions remain immune to viewer-absence reaping.
Reaping still removes only the provider process and cache warmth; provider
transcripts remain the durable resume source. Positive provider teardown
verification and reload-safe host fencing remain unchanged.

## Implementation slices

### 1 — make viewer ownership session-local

Give each `ProcessViewerLifecycle` its own `SessionViewerPresence`. Stop
injecting one Supervisor-wide registry into every process. Preserve the current
session subscription lease so multiple tabs viewing the same session are
reference-counted together for that process.

### 2 — remove global activity-stream retention

Stop registering provider viewer presence from the app activity subscription.
The activity stream continues to own browser connection tracking and global
session-summary events, but it is not evidence of interest in any particular
provider process.

### 3 — preserve reload-safe per-runtime anchors

Continue publishing viewer attached/detached state through each process's
existing provider-host callback. Reattach keeps the runtime's own unviewed
anchor, while a real viewer of that session refreshes only that runtime.

### 4 — prove isolation and safety

Cover these outcomes:

- viewing idle session A suspends A's deadline but does not suspend idle
  session B;
- releasing A gives A a fresh full grace;
- activity subscriptions do not acquire provider viewer ownership;
- active, waiting-input, retained, and disabled-reaper cases remain unchanged;
- reload-safe viewer publication remains per runtime; and
- focused lifecycle, subscription, route, and provider-host tests pass without
  warnings.

## Acceptance

- With a YA dashboard left open, an unviewed verified-idle session is reaped
  after its configured grace.
- A mounted view of that session prevents reaping, and its final unmount resets
  only that session's grace.
- Viewing or interacting with another session does not extend this session's
  deadline.
- Active, waiting-input, explicitly retained, and teardown-unverified work is
  never made eligible by this change.
- The wire protocol, `idleReapHours` setting shape/default, provider transcript
  persistence, and positive teardown-verification contract do not change.

## Completion evidence

Each provider `Process` now owns its own viewer-presence registry. Live-session
subscriptions still acquire and release that process's lease, while the global
activity subscription no longer touches provider ownership. The lifecycle
regression proves that an unviewed idle process reaches its deadline while a
different viewed process remains alive, and that releasing the viewed process
starts its fresh full grace.

Validation completed without warnings:

- server Vitest: 293 files passed, 4,097 tests passed;
- workspace `pnpm test`: passed across every non-Android package;
- `pnpm typecheck`;
- `pnpm lint`; and
- `pnpm format:check`.
