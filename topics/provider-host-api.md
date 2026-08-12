# Provider host API

> The provider host API is YA's versioned, same-user control boundary for
> discovering, launching, addressing, and exchanging turns with
> wrapper-lifetime provider workers independently of the Hono/UI lifetime.

Topic: provider-host-api

Status: stable same-user discovery, foreground headless bootstrap,
attach-or-start recovery, bounded auxiliary session turns, and an authenticated
Hono adapter are implemented on Linux. The non-watch development wrapper
attaches to a compatible incumbent host or starts one, and Codex uses the
shared provider host rather than a separate native host. Public feature copy
labels this source-checkout surface experimental and points back to this exact
availability and fallback contract.

Related:
[reload-safe provider runtimes](reload-safe-provider-runtimes.md),
[session ownership](session-ownership.md),
[provider state machine](provider-state-machine.md),
[core service API](core-service-api.md),
[architecture mandates](architecture-mandates.md), and
[server capabilities](server-capabilities.md).

## Why this is a YA layer

The provider worker is useful without a web UI. It owns the complete live
provider relationship: adapter, SDK query or protocol client, provider child,
message queue, approvals, controls, current-turn state, and sequenced output.
Hono currently projects that owner into a YA `Process`; a local agent tool can
instead submit one bounded turn and observe its result without acquiring the
full UI/server controller role.

This is provider-neutral control, not an alternate transcript format or a raw
stdin escape. Provider adapters retain their native responsibilities and YA's
normalized `SDKMessage` remains the shared event vocabulary.

## Observed pressure for a first-class control surface

On 2026-08-12 a working agent converted a YA session URL into direct REST
control without operating the JavaScript UI. Its first message POST omitted
`X-Yep-Anywhere: true` and failed before delivery with `Missing required
header`. The agent searched the installed YA distribution for that error,
resent the unchanged packet with the header, then polled the session process
route until completion. No duplicate provider turn began.

That trace disproved the expectation that agents would be unlikely to infer
and use YA's internal HTTP surface. It also exposed the wrong abstraction for
same-host tools: the custom header is a browser/HTTP boundary, while the
provider host already owns the reusable session queue and event stream. The
local control API makes that owner intentionally reachable; the Hono adapter
remains useful for authenticated remote callers.

## Current topology and protocols

On Linux, `pnpm provider-host` starts
`scripts/provider-runtime-host.mjs` in the foreground without Hono or Vite.
The host publishes `host.json`, `token`, `host.lock`, and `control.sock` under
`$YEP_PROVIDER_HOST_RUNTIME_DIR`, then `$XDG_RUNTIME_DIR`, with a private
per-user temporary-runtime fallback. The directory is mode 0700 and the
descriptor, token, and socket are mode 0600. The descriptor records owner and
worker process identities plus source/build identity without exposing the
token value.

The Linux non-watch `scripts/dev.js` path probes that descriptor before
starting Hono. It attaches to a compatible host, starts one when absent, or
performs verified bounded recovery when an identified host is nonresponsive.
Hono receives the discovered endpoint and token through private environment
state. A host started by the wrapper retains wrapper IPC as its terminal-owner
channel; a separately started foreground host retains its terminal instead.

Host protocol version 2 is newline-delimited JSON over the control socket.
Every request carries a request id, token, Hono generation, and protocol
version. The implemented operations are:

- `status` and `registerServer`;
- `launch`, `launchOrClaim`, `bind`, `list`/`inventory`, `claim`, and
  `confirmAttach`;
- streamed `sessionTurn`, `sessionTurnStatus`, and `interruptSessionTurn`;
- `setViewerPresence`, `release`, and `terminate`; and
- `retainProcessGroup` for host-owned auxiliary provider resources.

The host permits one registered Hono controller generation per worker. It
fences stale/concurrent controllers and keeps a canonical provider-session-id
to worker mapping until verified cleanup.

Each worker opens a separate private Unix socket using worker protocol version
1. Hono attaches with the same private token and its registered generation.
The stream carries queue pushes, queue-depth/removal state, sequenced
`SDKMessage` events and acknowledgements, provider controls/RPC, permission
state, approvals, completion, and failure. Acknowledgement advances only after
the Hono `Process` consumes an event, so reload replay can repeat a boundary but
cannot silently discard an unacknowledged suffix.

These are real local listeners rather than anonymous provider pipes. Stable
discovery remains same-user local: the token stays in an owner-only file, the
host never binds TCP, worker sockets remain undiscoverable private endpoints,
and auxiliary callers reach workers only through the host's bounded turn
operation.

## Same-session and fork contract

Submitting through a hosted worker uses that worker's existing `MessageQueue`
and provider connection. It never invokes a second provider resume. This is the
mechanism that avoids Claude different-parent branches for hosted interaction;
watching transcript JSONL only establishes receipt.

YA's existing Hono message route has the same relevant safety property for a
live session: it requires an existing `Process`, enters its queue, and returns
`No active process for session` rather than starting a second resume. Provider
hosting and the route are separate ownership layers.

Native Claude resume does not fork merely because it is a resume. Concurrent
interactions against one provider session can create different-parent
branches. A future caller may deliberately accept that risk when no host is
available; the host protocol itself never manufactures that fallback.

## Reachable local protocol

The stable local surface extends the host control socket rather than exposing
worker sockets or raw provider-child stdin. A client first authenticates to the
host descriptor, negotiates a protocol version, then issues one streamed
`sessionTurn` operation. The initial version has this conceptual request shape:

```json
{
  "id": "request-correlation-id",
  "submissionId": "client-generated-retry-id",
  "op": "sessionTurn",
  "protocolVersion": 2,
  "token": "local-capability",
  "target": {
    "harness": "claude",
    "providerSessionId": "durable-provider-id",
    "yaSessionId": "optional-canonical-ya-id"
  },
  "message": { "text": "one user turn" }
}
```

The stream flushes records as they occur:

```json
{"id":"...","type":"accepted","runtimeId":"...","submissionId":"..."}
{"id":"...","type":"providerEvent","sequence":42,"message":{}}
{"id":"...","type":"terminal","outcome":"completed","receipt":{}}
```

Additive fields remain backward-compatible within the negotiated version. The
implemented meanings are:

- `accepted` means the worker queue durably accepted the identified
  submission; a caller must not fall back to another transport afterward;
- `providerEvent` is an ordered observation scoped to this turn, normally a
  normalized `SDKMessage`, with an optional provider-native record;
- `terminal` distinguishes completed, provider-failed, interrupted,
  uncertain-after-acceptance, and host-recovery outcomes and includes the best
  provider-transcript watermark/receipt available; and
- a disconnect before `accepted` is safe to retry, while a disconnect after it
  requires receipt lookup rather than automatic duplicate submission.

The caller-generated `submissionId` is the retry identity. Reusing it with the
same target, message, and launch request replays the current host's retained
records; reusing it with different content returns
`submission-id-conflict`. The host retains up to 1,000 submissions and receipt
rows for 24 hours. After a host restart, use `sessionTurnStatus` to inspect the
persisted receipt rather than resubmitting the id.

Acceptance has a 15-second deadline. The default whole-turn deadline is 30
minutes and callers may request between one second and two hours. Provider
output is bounded at 10,000 records or 64 MiB; crossing either limit requests
interruption and terminates the observable result as
`uncertain-after-acceptance`. Socket backpressure pauses writes to that
listener while records remain bounded in the submission ledger. Disconnecting
a listener never cancels an accepted turn; `interruptSessionTurn` is the
explicit cancellation operation.

An auxiliary submission is accepted only while the incumbent worker is alive,
idle, has an exactly observable queue-yield boundary, and has no pending
approval. While it is active, Hono may remain the approval controller but
cannot queue or steer another provider turn. Without an attached Hono
controller, a new provider approval is reported, denied, and terminates the
auxiliary result as `provider-approval-required`. The auxiliary stream observes
provider events but never acknowledges Hono's replay buffer.

Local `launchOrClaim` and the optional `sessionTurn.launch` object may resume a
matching provider worker when no incumbent exists. The requested harness must
match the provider adapter, and worker startup must report the exact requested
durable provider id. The HTTP adapter deliberately has no launch authority. An
auxiliary-launched worker returns to a 30-second idle teardown deadline after
its turn; an uncertain accepted result reaps that worker immediately.

The structured control outcomes include `unavailable`, `incompatible`,
`ownership-unknown`, `busy`, `timed-out-before-acceptance`,
`uncertain-after-acceptance`, `provider-approval-required`, and
`interrupted-by-host-recovery`. A verified nonresponsive-host replacement
rewrites every persisted accepted receipt to the recovery outcome before the
replacement starts.

Harness plus durable provider session id is the portable address. A supplied
YA session id is a stronger cross-check, not a replacement; disagreement is a
structured ownership error. The host may claim or launch only one worker for
the resolved provider session. An auxiliary turn client is a bounded
producer/observer and never becomes the Hono controller, answers unrelated
approvals, or acknowledges/reorders Hono's replay stream.

## Hybrid access

The Unix socket is the primary same-host API. Unix-domain transport avoids HTTP
parsing and network exposure, but latency is not the design reason: provider
inference and YA processing dominate either local transport. Filesystem
ownership, narrow capability scope, headless availability, and direct access to
the runtime owner are the reasons to keep it.

Authenticated Hono routes adapt remote and relayed clients to the same host:

- `GET /api/provider-host/status`;
- `GET /api/provider-host/runtimes`;
- `POST /api/provider-host/session-turn`, returning newline-delimited records;
- `GET /api/provider-host/session-turn/:submissionId`; and
- `POST /api/provider-host/session-turn/:submissionId/interrupt`.

The adapter applies YA's ordinary `/api/*` admission, authorization,
host/origin, and custom-header checks. It limits a request to 1 MiB, turn text
to 900 KiB, and the timeout to the host's one-second through two-hour range.
It has no provider-launch authority: a remote caller can address only an
incumbent worker. Provider-host failures before acceptance map to unavailable;
an adapter failure after acceptance is reported as uncertain rather than
inviting a second submission.

The permanent `provider-host-control` server capability uses id 30 and is
advertised only while the Hono generation is registered with the compatible
host. Clients that do not see it hide the control surface and make none of
these requests. This preserves the approved `v0.7.0` and `v0.6.2` fallback and
does not widen either retained Codex-native capability id.

The route is not required by the planned `~/agents` helper, which uses the
local socket and may choose its own native provider-resume fallback.

The provider host is never directly exposed on TCP. Worker endpoints stay
private even to local helper clients.

## Headless bootstrap and discovery

A foreground headless launcher starts the provider host without Vite or Hono.
It publishes one atomic descriptor in a stable same-user runtime directory:

- host protocol version and feature bits;
- control-socket path;
- token-file path, with token bytes kept out of logs and command arguments;
- owner PID and process-start identity; and
- source/build identity needed to decide whether provider code is current.

The directory is mode 0700 and descriptor, token, and socket are no broader
than mode 0600. The launcher remains the terminal owner: SIGINT/SIGTERM and
owner loss shut down and verify every worker/provider descendant. A headless
host with no workers has no per-session timers or polling loops.

The Hono launcher uses attach-or-start:

1. Read the expected descriptor and complete a bounded authenticated `status`
   handshake.
2. Register with a live compatible host.
3. If no host exists, acquire a single-instance start right, start one host,
   publish the descriptor atomically, then register.
4. If the recorded host is nonresponsive, verify its PID/start identity,
   terminate the host and all known worker/provider process groups with bounded
   TERM-to-KILL escalation, verify absence, remove stale endpoint state, then
   start exactly one replacement.
5. If identity or cleanup cannot be proved, fail closed rather than unlinking a
   socket and creating a concurrent owner.

Replacing a nonresponsive host may interrupt active provider turns and reports
that outcome. Endpoint absence alone never authorizes killing an unverified
process.

## Reload, code adoption, configuration, and defaults

Safe Reload is a Hono-generation operation. It intentionally preserves shared
provider workers and therefore does not update provider code inside workers
that already exist. A new worker launched after reload uses current code; a
targeted worker relaunch updates one session; a full wrapper/host reboot
guarantees adoption across all hosted sessions. UI and operator documentation
must not equate `Server changed` or `Reload` with provider-runtime refresh.

Shared provider hosting is automatic when its launch capability is present. It
has no user-facing enable setting. Unsupported platforms, watch mode, direct
server launches without a host, failed capability probes, or explicit
provider-host disablement use ordinary in-Hono ownership; headless session
control then reports unavailable.

The `codexReloadSafeSessions` setting remains in the server schema and storage
for old-client compatibility, but is ignored for routing. New clients hide the
selector, and new servers do not advertise native-host availability. Its
capability ids remain reserved and their old meanings are not widened into this
provider-neutral API.

## Retirement compatibility

The latest two stable server releases are `v0.7.0` and `v0.6.2`; as of
2026-08-12 there is no additional stable release in the preceding 14 days.
Both predate the unreleased 0.7.1 capability ids for the Codex-native runtime
and setting.

The server preserves the settings field on reads and writes, the client hides
it, and native-host availability is no longer advertised. Older clients may
continue to send the inert field; no unsupported route or field is introduced
for them. The provider-host-control capability uses a new id and protocol
version, while the permanent capability ledger retains all prior assignments.

## Observable acceptance contract

- A local client can start the headless host, discover it, negotiate the
  protocol, and exchange a turn without Hono listening.
- Starting Hono attaches to the expected live host and does not create a second
  host. With no host it starts one; with a nonresponsive verified owner it
  performs bounded verified replacement.
- A hosted Claude turn uses the incumbent worker and creates no second resume
  process. Codex uses the same shared-host path after native-host retirement.
- An accepted submission is never automatically retried through another
  transport after a control connection fails.
- Hono reload preserves eligible active turns but does not claim that retained
  workers loaded changed provider code.
- Full wrapper shutdown and nonresponsive-host replacement leave no host,
  worker, provider process group, socket, descriptor, or token artifact behind.
- Host absence degrades to ordinary in-Hono sessions; it never weakens network
  admission or makes the provider-host socket remotely reachable.

## Verification evidence

On 2026-08-12 an isolated non-watch wrapper started from the current source
tree published a private protocol-v2 descriptor and registered its fresh Hono
generation. A local socket submission launched the deterministic Claude-labeled
worker, emitted accepted plus three ordered provider events, and completed with
watermark 3. A second submission through the authenticated Hono adapter reached
the same runtime id and completed with the same record sequence. The version
route advertised `provider-host-control` during registration. Terminal wrapper
shutdown closed the server, maintenance, and Vite ports; removed the descriptor,
token, lock, and control socket; and left no smoke descendant.

This is end-to-end integration evidence for wrapper, host, worker queue,
adapter, receipt, and cleanup behavior. Provider-specific real-runtime smokes
remain release confidence for each upstream adapter; the same-worker queue and
identity fencing are the non-forking mechanism rather than transcript
observation.
