# Reload-Safe Provider Runtimes

> Reload-safe provider runtimes keep active local Linux sessions running across
> replacement of YA's Hono server by placing each live provider protocol owner
> under a wrapper-lifetime host; terminal wrapper shutdown still reaps every
> hosted provider process within a bounded deadline.

Topic: reload-safe-provider-runtimes

Status: **implemented for the Linux non-watch development wrapper.** The
existing default-off Codex setting continues to select the Codex
app-server/socket host exactly as shipped. When that setting is off, Codex
participates in the shared host just like Claude, Gemini, Grok, OpenCode, Pi,
and Codex OSS. The selection is made on each new or resumed provider launch;
it never converts an already-live runtime.

The Codex-native contract has been proved with real active-turn reloads through
both the API and wrapper `SIGHUP`, a second turn after reattach, terminal
wrapper cleanup, and deterministic owner-loss tests. The shared host has
deterministic worker replacement, replay, pending-callback, attach-timeout,
terminal worker, and wrapper-resource cleanup coverage. The provider-specific
real-runtime smokes in the verification matrix remain release evidence rather
than missing architecture. An isolated wrapper smoke also proves that both
hosts survive `SIGHUP` while the Hono PID changes, then both exit on terminal
wrapper `SIGTERM`.

Related:
[server message routing](../docs/project/server-message-routing.md),
[session liveness](session-liveness.md),
[provider state machine](provider-state-machine.md),
[session ownership](session-ownership.md),
[session sandboxing](session-sandboxing.md),
[subprocess environment](subprocess-environment.md),
[settings placement](settings-ui-placement.md),
[core service API](core-service-api.md), and
[federated super sessions](federated-super-sessions.md).

## Verdict

There are two reload-safe runtime backends. Both preserve the complete
provider protocol owner rather than attempting to adopt a bare child PID.

The process that survives must own the complete live provider connection:
stdin/stdout or socket transport, SDK iterator, request correlation, pending
approval callbacks, current-turn state, control methods, and a supported rejoin
mechanism. The new YA server can then attach to that owner and rebuild its
`Process` projection. Keeping only the provider PID alive loses the state needed
to interpret or control it.

The already-shipped backend is deliberately Codex-specific:

1. A stable lifecycle host owned by `scripts/dev.js` launches one Codex
   app-server per eligible session through a private Unix socket.
2. The replaceable Hono server connects directly to that app-server. After a
   reload it uses native `thread/resume` to recover the active snapshot and
   replay pending provider requests.
3. A server-persisted **Providers → Codex** setting controls this launch path,
   applies whenever YA starts an eligible new or resumed provider process, and
   defaults off.
4. The wrapper treats API restart and `SIGHUP` as Hono-reload intent, while
   `SIGINT`, `SIGTERM`, wrapper/host loss, and exhausted recovery are terminal
   paths with bounded, verified reaping.
5. This path remains selected only when the existing Codex provider setting is
   enabled. Its implementation and native rejoin semantics are not rewritten
   as part of the shared-host extension.

The shared backend places one provider worker around one `AgentSession`:

1. `scripts/dev.js` owns one provider host for its complete wrapper lifetime.
2. The host owns a dedicated worker process for each hosted YA session. The
   worker imports the provider adapter, owns its SDK query/client, message
   queue, child transport, callbacks, and sandbox, and continuously drains the
   provider iterator whether or not Hono is attached.
3. Hono owns the ordinary `Supervisor` and `Process`, but receives an
   `AgentSession` proxy whose iterator, queue, approvals, liveness probes, and
   control methods cross a private authenticated Unix socket.
4. On wrapper `SIGHUP`, Hono detaches that proxy without aborting the worker.
   The replacement generation claims the same worker under the same canonical
   YA session id and resumes from the worker's sequenced event buffer.
5. On terminal wrapper shutdown or wrapper/host ownership loss, the host closes
   every worker and the worker closes its provider session; bounded TERM/KILL
   cleanup remains authoritative if cooperative shutdown fails.

This is not provider-native process adoption. A Claude CLI PID still cannot be
adopted by a new SDK `Query`; the point is that the original `Query` survives
inside the provider worker and Hono adopts only YA's explicit proxy protocol.

The existing **Reload When Safe** flow remains the required fallback for
already-running ordinary sessions, volatile queued work, an unavailable or
incompatible host, and any session that cannot detach cleanly. Changing the
Codex setting never attempts to adopt a live process.

## Baseline Ownership And Failure Path

Without the reload-safe launch path, one server process owns all of the state
that makes a provider child useful:

- `Supervisor` owns each in-memory `Process`.
- `Process` owns the provider `AsyncIterator<SDKMessage>`, direct and deferred
  queues, pending approval promises, control callbacks, liveness state,
  streaming catch-up text, and the 15–30 second replay buckets.
- Claude's adapter owns an SDK `Query`, `AbortController`, `MessageQueue`, and
  `canUseTool` callback. Its local CLI child uses three parent-owned pipes.
- Codex's adapter owns a `CodexAppServerClient`, JSON-RPC request map,
  notification queue, active thread/turn ids, approval handler, and a stdio
  app-server child.

Before this feature, `scripts/dev.js` kept Vite running and replaced Hono after
an exit, but did not own provider runtimes or distinguish acknowledged reload
intent from terminal shutdown. The implementation replaces that ambiguity with
an explicit wrapper state machine and private control request. The legacy
marker-and-exit path remains only when Hono is not running under that wrapper.

The replacement server currently reconstructs ordinary durable session history
later, but that is provider resume after owner loss, not continuation of the
active turn.

YA already has the conservative answer. `SafeRestartService` pauses project
queue dispatch, waits for active sessions and volatile session queues to drain,
preserves eligible patient queue entries, and only then restarts. This prevents
an active-turn interruption but delays loading the changed server code. The new
reload-safe hosts provide the other useful choice: replace the backend now
while the current turn continues under its wrapper-lifetime owner.

## Why `detached` Or `setsid` Alone Cannot Work

Node's `detached` spawn option changes process-group/session ownership on Unix,
and `unref()` merely stops the parent event loop from waiting for the child.
Node's own documentation also requires a long-lived detached child not to keep
stdio connected to its exiting parent. Pipes have bounded capacity; if nobody
continues reading output, the provider can block once the pipe fills.

Those mechanics do not preserve JavaScript state:

- an anonymous stdio pipe is not a named endpoint that a later server can open;
- a `ChildProcess` object, SDK `Query`, promise resolver, iterator, or
  `AbortController` cannot be reconstructed from a PID;
- Node's parent/child IPC channel is tied to the original processes, while
  handle passing covers network servers/sockets rather than an arbitrary live
  provider protocol object;
- provider output emitted between servers would have no replay owner;
- provider-initiated approval requests would have nobody able to answer them;
  and
- PID reuse makes a PID file an unsafe control capability by itself.

`tmux`, `nohup`, `setsid`, `systemd-run`, or a surviving shell can keep bytes
executing, but none supplies the missing protocol and replay semantics. They
can supervise a real runtime owner; they cannot replace one.

## Shared Provider-Host Architecture

The wrapper, not a Hono generation, is the terminal owner:

```text
scripts/dev.js (one operator-started YA lifetime)
  |
  +-- Hono generation N       <--- replaced on API Restart / SIGHUP
  +-- shared provider host
  |    |
  |    +-- worker A
  |    |    +-- AgentSession + provider child/transport
  |    +-- worker B
  |         +-- AgentSession + provider child/transport
  +-- Codex lifecycle host    <--- only Codex setting = enabled
       +-- app-server + private socket per Codex session
```

`SIGHUP` means "replace Hono" only. `SIGINT`, `SIGTERM`, ordinary wrapper exit,
wrapper/host control loss, and terminal cleanup mean "end the complete YA
lifetime" and therefore end every provider worker and provider descendant.
Neither host is a machine daemon and neither survives the wrapper that created
it.

### Stable host and per-session workers

The shared host is deliberately provider-neutral. It authenticates Hono,
tracks canonical YA session identity, fences controller generations, launches
workers, applies attach deadlines, and reaps worker process groups. It does not
import provider adapters or normalize messages.

One canonical YA session id has at most one claimable worker. The host reserves
that identity while a worker starts and until terminal cleanup succeeds. A
closing or dead worker is never returned by list or claim; launch or late bind
may reuse its identity only after the stale owner is successfully reaped. A
failed cleanup attempt remains explicit but does not memoize failure forever:
later bind, launch, attach-timeout, or terminal shutdown retries the same
bounded cleanup before another worker can own the session.

Each worker is the smallest complete live provider owner. It imports the
provider implementation in its own process and constructs the real
`AgentSession`, including its `MessageQueue`, iterator, SDK query or protocol
client, pending request promises, sandbox runtime, and spawned children. A
worker started after a reload therefore uses current provider code; an existing
worker finishes its current lifetime with the code and launch facts it started
with.

One worker per session is an isolation boundary, not merely an implementation
convenience. A provider crash or stuck event loop cannot corrupt another
session's replay or request ledger, and the host can reap one complete process
group without knowing the provider's internal child topology.

### Hono proxy contract

The replacement-sensitive Hono server keeps the existing `Supervisor` and
`Process` policy layer. It receives an `AgentSession` proxy with the same
surface as an in-process adapter:

- `queue.push` sends a user message to the worker-owned `MessageQueue`;
- the async iterator yields sequenced `SDKMessage` records from the worker;
- `abort`, `interrupt`, `steer`, model/effort/thinking controls, provider
  commands, liveness probes, retention snapshots, and inventory reads are
  request/response operations on the worker;
- provider activity and retention changes are cached snapshots plus explicit
  notifications; and
- `publishAgentctlSessionId` records a newly discovered canonical YA-visible
  session id synchronously in Hono, then binds it in both the worker and host
  registries before the asynchronous publication finishes.

The proxy adds one lifecycle operation that ordinary providers do not need:
detach the current Hono generation without calling the provider's `abort`.
`Process.detachForServerReload` uses that operation only after confirming the
YA-owned direct queue is empty and no volatile deferred message would be lost.

### Sequenced replay and acknowledgement

Every worker event receives a monotonically increasing sequence number before
it can be exposed to Hono. The worker retains unacknowledged events in order.
The proxy acknowledges an event only when its iterator advances past the event,
which means `Process.processMessages` finished applying it to the YA projection.
After reattach, the replacement starts at the last acknowledged sequence and
receives the remaining suffix in its original order. An event being applied
exactly when Hono exits may be replayed once because acknowledgement follows
application; existing provider-item identity and transcript reconciliation
deduplicate that boundary. The transport cursor prevents loss and broad
replay, but does not pretend distributed exactly-once delivery exists.

Replay is bounded. The worker may discard an acknowledged prefix, but it must
never discard an unacknowledged event to stay alive. If the retained suffix
exceeds its byte or item limit, the runtime becomes non-reattachable and is
terminated with an explicit continuity failure rather than silently dropping
output. An attached Hono continues consuming during ordinary operation, so the
bound covers the short replacement interval rather than complete transcripts.

### Provider-initiated requests

Tool approvals and other provider callbacks are reverse requests with stable
worker-generated ids. The worker keeps each request and its unresolved promise
until Hono responds, terminal shutdown cancels it, or the bounded attach grace
expires. Disconnect does not imply denial and replacement does not allocate a
new request id. A new Hono generation receives the same pending request once
and routes it through the new `Process.handleToolApproval` callback. If the
provider cancels the request, the worker aborts that callback's signal so the
UI cannot wait on a request that no longer exists. YA never auto-approves
across a reload.

Callbacks that are observations rather than questions are represented as
state: the worker records the most recently applied permission mode, provider
activity, and retention snapshot. It keeps provider deltas enabled while Hono
is absent so reconnect cannot discard current-turn progress. Reattach begins
with the current snapshot before later change notifications, so absence of
Hono does not lose a policy transition.

### Launch facts and sandbox ownership

Only cloneable launch facts cross into a worker: provider name, project path,
resume identity, model/permission/thinking settings, executor and environment,
provider runtime configuration, and the session-sandbox preparation request.
Functions and open descriptors do not cross the boundary.

Hono first runs the existing sandbox preparation as a preflight and to retain
the enforcement/state metadata used by `Process`. The worker independently
calls `prepareSessionSandbox` from the same deterministic request and passes
that resulting runtime to the provider. This keeps Bubblewrap's
`--die-with-parent` attached to the durable worker rather than the replaceable
Hono process. Either setup failure fails the launch; neither side falls back to
an unsandboxed provider.

Provider process-scoped configuration is snapshotted at launch. Settings
changes affect later workers but do not mutate a surviving runtime under a new
Hono generation. For Claude Gateway, the worker may launch the configured
gateway and then transfers its process group to the shared host because later
workers may share that endpoint. Hono must not tear it down during reload.
Terminal wrapper/host shutdown still reaps it.

The live worker snapshot and the server-owned per-session launch-settings
record cover different lifetimes. Hono reattach adopts the surviving worker's
snapshot as authoritative. When the provider runtime has ended, a cold launch
instead inherits `SessionMetadata.effectiveLaunchSettings`. Persisting an
identical reattach snapshot is an equality-aware no-op, so a Hono generation
change does not manufacture a settings revision or rewrite metadata.

### Attachment, fencing, and deadlines

One server generation controls a worker at a time. Attach and detach use the
wrapper-issued server generation plus the private wrapper-lifetime credential.
The host refuses concurrent controllers, stale generations, unknown canonical
session ids, and incompatible protocol versions.

Intentional Hono detach, controller-socket loss, and an unconfirmed claim each
start a bounded replacement attach deadline. Claiming alone does not clear the
deadline: the replacement must finish the worker attach and explicitly confirm
it to the host. A claimed worker is also subject to YA's ordinary verified-idle
policy through its `Process`; if no replacement completes the attach, the host
deadline is authoritative. An empty host has no per-session polling or retry
loop.

Terminal cleanup is layered:

1. ask the worker to abort its `AgentSession` and settle pending callbacks;
2. wait a bounded cooperative grace;
3. TERM the worker process group;
4. KILL it if still alive; and
5. verify the group and its registry/socket artifacts are gone.

The wrapper receives every worker process-group id from the host and performs
the same final sweep if the host itself fails. EOF on the host's inherited IPC
channel is terminal owner loss, never a reload signal.

Each reported Linux process group is paired with the start time of its leader
from `/proc`. The host and wrapper verify that identity before signaling it, so
a stale registry entry cannot kill an unrelated process after PID reuse. If a
leader exits while its original descendants remain in the group, the missing
leader does not prevent cleanup of those descendants.

### Routing decision

Routing is evaluated on every provider launch, including a durable resume:

| Launch | Runtime backend |
|---|---|
| Codex, already live | backend that originally launched that runtime |
| Eligible Codex, setting enabled, specialized host available | existing Codex app-server/socket host |
| Codex, setting disabled | shared provider host |
| Every other provider | shared provider host |
| Shared host unavailable or incompatible | ordinary in-Hono provider only when reload continuity was not explicitly promised |

The Codex setting therefore remains a gate around the current specialized
implementation, not a gate around whether Codex participates in reload-safe
hosting at all. A runtime keeps the backend selected when it launched until it
reaches terminal cleanup.

## Codex-Native Runtime Boundary

The development wrapper owns a small **Codex lifecycle host** beside the
replaceable server:

```text
scripts/dev.js (stable for one dev-server launch)
  |
  +-- Vite
  +-- Hono server generation N       <--- replaced on API Restart / SIGHUP
  +-- Codex lifecycle host
       |
       +-- app-server + private socket for session A
       +-- app-server + private socket for session B

scripts/dev.js starts Hono server generation N+1
                              |
                              +--- claim A/B, connect, thread/resume
```

The host is a private registry, launcher, watchdog, and reaper. It is not
another public YA server and does not proxy normalized provider events. The
Hono generation connects directly to Codex app-server over its supported Unix-
socket WebSocket transport. Provider-native running-thread state is the v1
replay mechanism; no parallel YA event log or generic `AgentSession` protocol
is introduced.

The host is a dedicated child process so it can observe an inherited owner pipe
and reap runtimes if the wrapper disappears. The wrapper must also observe host
exit and retain enough PID/process-group facts to reap an app-server if the
host fails. The feature is advertised only when this two-sided owner-loss
cleanup and its capability probe succeed.

The canonical YA session id remains the public key. Codex thread ids, runtime
ids, socket paths, PIDs, and wrapper/server generations stay internal. Starting
a new Codex thread may temporarily precede canonical session-id resolution, so
Hono records the final YA session id synchronously and binds it to the host
runtime before exposing the completed `Process` launch. The Codex client keeps
its provider-native thread id inside the surviving protocol owner.

### Runtime registry

The registry is scoped to one wrapper lifetime. It is not restart persistence:
ordinary provider history remains the durable resume source after the wrapper
has ended. The design shape below names information that later production-grade
or cross-wrapper persistence could require:

```ts
interface ReloadSafeCodexRuntimeEntry {
  hostProtocolVersion: number;
  runtimeId: string;
  wrapperInstanceId: string;
  attachedServerGeneration?: string;
  sessionId?: string; // canonical YA-visible id after launch canonicalizes
  codexThreadId?: string;
  projectId: string;
  projectPath: string;
  launchFingerprint: string;
  appServerPid: number;
  appServerProcessGroupId: number;
  socketPath: string;
  state: "starting" | "attached" | "detached" | "closing";
  startedAt: string;
  viewerAttached: boolean;
  unviewedSince?: string;
  detachedAt?: string;
  attachDeadlineAt?: string;
  idleDeadlineAt?: string;
}
```

The implemented wrapper-lifetime registry keeps the smaller subset required
for direct reattach: runtime and YA session ids, project path, socket path,
PID/process group, attachment generation/state, launch time, viewer state and
no-viewer anchor, reattach settings, cleanup paths, and its bounded attach
timer. The private runtime directory and token fence entries to one wrapper
instance. A host protocol bump fences Hono code that can no longer interpret
the registry. The broader separations remain load-bearing for any future
persistence beyond one wrapper lifetime:

- YA session identity versus Codex thread identity;
- wrapper, Hono server, and provider process generations;
- discovery metadata versus the secret needed to control the host;
- provider transcript position versus YA projection/dedup state; and
- provider process liveness versus active-turn liveness.

Registry and socket state live in a mode-`0700` runtime directory owned by the
YA user. Socket creation and stale-socket cleanup must resist symlink/path
replacement. Control secrets travel through an inherited private pipe or an
owner-only file, never process arguments or public diagnostics. Nothing binds a
LAN interface.

Viewer-state retention is an additive lifecycle capability under host protocol
v1. A replacement Hono can still attach to an already-running v1 host that
lacks it, using generation-local no-viewer timing until the wrapper is
terminally restarted and loads the capable host. New hosts advertise the
capability and older Hono generations ignore the extra runtime fields.

### Attach and single-controller fencing

One Hono generation controls a runtime at a time:

1. The wrapper accepts reload intent, stops admitting a second reload, and asks
   generation N to quiesce public work and detach its Codex socket clients.
2. The wrapper waits for generation N to exit before starting generation N+1.
   It never overlaps two YA controllers for one runtime.
3. Generation N+1 claims each compatible registry entry using its server
   generation id and the host control credential.
4. It validates the runtime id, YA session id, current controller generation,
   and host protocol, then returns the original project path and reattach
   settings. The command, environment, and Codex process remain fixed inside
   the same wrapper lifetime rather than being relaunched.
5. It connects to the private app-server socket and calls `thread/resume`.
   Codex returns the running-thread snapshot and replays pending server
   requests, including approvals.
6. YA reconstructs one `Process` projection, reconciles the snapshot with
   durable provider history by provider item identity, and resumes ordinary
   client subscription catch-up under the same canonical YA session id.

Codex supplies no YA event cursor. Events emitted while Hono is absent must be
present in the running-thread snapshot or subsequent provider persistence; the
smoke must prove this before the path is called reload-safe. If the native
snapshot lacks a required observable state, v1 stops there rather than adding
an implicit shadow transcript.

YA-only launch facts needed for reattach—selected configuration, permission
mode, project path, and initial canonicalization mapping—stay in the
wrapper-lifetime registry or surviving owner. Direct, deferred, or other
volatile Hono queue state remains a blocker unless a later change moves that
state under a durable owner. Replaying only assistant text would recreate the
current split-brain failure in a subtler form.

### Wrapper/host control protocol

The private control surface is deliberately smaller than `AgentSession`:

- launch one eligible Codex app-server and atomically bind its final identities;
- list compatible runtimes for one Hono generation;
- claim and release a runtime connection;
- record verified runtime lifecycle transitions and their deadlines;
- read process/socket ownership and bounded-lifecycle status;
- terminate one runtime with verified process-tree cleanup;
- request Hono reload through the wrapper; and
- shut down the host and every runtime within a bounded deadline.

The Hono server remains responsible for public authorization, REST/WebSocket
contracts, provider normalization, approvals, session lists, queues, and client
fan-out. The lifecycle host owns only spawn, discovery, wrapper-lifetime
continuity, and teardown.

## Turn Completion And Teardown

The survivor should not become an immortal provider daemon.

The combined lifecycle owner keeps three independent deadline classes:

- the ordinary verified-idle reap deadline, using YA's configured idle policy;
- the replacement-server attach deadline after detach, controller loss, or an
  unconfirmed claim; and
- the terminal drain deadline after wrapper shutdown or owner loss.

Active and waiting-input sessions are presumed live. They remain visible in
the sidebar and are never terminated by a viewer-absence deadline, including
when an active turn runs unattended for days. Provider silence may change the
session's liveness diagnosis and UI, but it is not an idle boundary and does
not make the process eligible for this reaper. Explicit provider retention
likewise blocks idle reaping.

Only a truly idle process is eligible: its process state and conservative
liveness result are both idle, and no feature, prompt-cache lease, or provider
retention owns it. Expiry uses the same provider abort path as explicit session
teardown; a hosted proxy therefore enters the host's bounded
cooperative/TERM/KILL cleanup rather than leaving the worker alive.

Viewer presence is server-global rather than session-local. Every mounted app
activity stream holds a viewer lease, so a tab viewing a historical session
still protects every live provider process. Mounted live-session streams also
hold leases across transient activity-stream reconnects, independently of
whether they request live provider deltas. A mounted background browser tab
counts; browser document visibility is not a termination signal. The first
global viewer cancels all pending idle deadlines. After the last global viewer
leaves, each eligible idle process receives a fresh full grace period; a
process that becomes idle later receives its full grace from that idle
transition. Thus any visit or open session tab refreshes the dead-man switch
for all sessions.

Both reload-safe hosts retain the global first/last-viewer transition with
their runtime entries. Reattach returns the existing no-viewer anchor to the
replacement `Process`; claiming a runtime or losing its controller preserves
the viewer-absence evidence. The replacement generation re-establishes idle
eligibility from its attached provider state, so the best-effort idle grace may
restart across reload. A real viewer reconnect still refreshes every idle
runtime.

### Configurable idle-reap courtesy

`idleReapHours` is the server-wide number of idle hours after which a harness
process may be reaped. It is a finite floating-point value and defaults to
`24`. Negative values disable idle reaping. Zero makes a truly idle process
immediately eligible, but this remains a best-effort cleanup threshold rather
than a promise to terminate at an exact wall-clock instant.

Settings > Providers exposes synchronized numeric and range controls. The
slider's `-1` position is visibly labeled **Never**, followed by the numeric
`0–72` hour range; the synchronized numeric field displays `-1` at that notch.
The numeric field accepts fractional hours within the same range. All negative
input is normalized to the canonical `-1` value, keeping the discoverable hint
and persisted representation stable.

An explicitly configured legacy `IDLE_TIMEOUT` remains authoritative until the
user deliberately saves `idleReapHours`; that save is the opt-in that moves
the deployment to the persisted setting. Changes apply to existing processes:
idle timers are recalculated, while active and waiting-input processes remain
unaffected.

An idle process that is temporarily ineligible because another owner retains
it is rechecked periodically. An explicit retention-release signal starts a
fresh full grace; the periodic check is the backstop for retention sources
without such a signal. Rechecks use a nonzero interval even when the configured
grace is zero, avoiding a busy timer loop.

The optional Settings contract is capability-gated. Stable releases `0.7.0`
and `0.6.2` (the latest two, including every stable server from the preceding
14 days) have neither the field nor the capability. A new permanent
`idle-reap-hours-setting` capability owns `GET /api/settings`,
`PUT /api/settings`, and `settings.idleReapHours`. Without it, a newer client
omits the Providers row and never sends the field; older server behavior and
all existing capability meanings remain unchanged.

Once Hono detaches or disappears for reload, its `Process` no longer owns the
no-viewer timer. The host's 30-second replacement attach deadline becomes
authoritative, so server absence cannot leave the runtime alive indefinitely.
Terminal expiry terminates the app-server, verifies its owned process group is
gone, removes its socket and registry entry, and leaves provider persistence as
the later resume source.

After intentional reload detach, the runtime may preserve an active turn or
pending provider request only through the bounded attach grace. If no compatible
replacement attaches, the host requests interruption when possible and enters
the same terminal signal ladder. It never waits without a deadline for a turn,
retry, background tool, or approval to settle. Pending approval is replayed
after a successful attach and is never auto-approved; after attach timeout it is
interrupted/terminated rather than kept forever.

If the runtime dies mid-turn, YA surfaces owner loss as a terminal provider
error/interruption. It does not silently resume and risk two writers.

### Reload versus terminal shutdown

The wrapper owns one explicit state machine:

| Input | Wrapper transition | Provider runtime action |
|---|---|---|
| API Restart | `running` → `reloading` | keep eligible runtimes alive |
| `SIGHUP` to wrapper | same as API Restart | keep eligible runtimes alive |
| unexpected Hono exit | `running` → bounded `recovering` | keep alive only through recovery deadline |
| `SIGINT` / `SIGTERM` | any state → `shutting-down` | interrupt/drain, then reap |
| wrapper/host control loss | any state → bounded owner-loss shutdown | reap |

The in-app API uses an acknowledged private request to the wrapper. `SIGHUP` is
an operator alias for that transition, not the whole protocol. The wrapper
coalesces repeated reload requests, and each selected `Process` synchronously
rejects new input once its volatile-queue blocker check passes. The wrapper
waits for the old generation to detach and exit, then starts exactly one
replacement. It never forwards HUP to Codex app-server.

### Development bind takeover

Every process spawned beneath `scripts/dev.js` carries a non-secret dev
instance marker: one random instance id, the normalized main-server bind, and
the canonical source root from which that process was launched. Bind identity,
not source identity, decides cleanup eligibility. A test server on another
port is unrelated; a prior YA process carrying the bind claimed by the new
server is obsolete even when it came from another worktree or checkout.

Intent alone does not authorize cleanup. The new Hono generation reports its
actual localhost `onReady` bind through the authenticated wrapper control
channel. The wrapper verifies that the reporting PID and generation are the
registered backend and that the acquired host/port normalizes to the launch
bind. A failed or different bind reaps nothing. After successful acquisition,
Linux startup finds same-user processes carrying the same bind marker, excludes
the current instance id, and revalidates each PID, start time, instance id, and
bind immediately before signaling it. No project-local registry or PID file is
created.

Prior processes first receive `SIGTERM`. Same-source survivors enter the
ordinary bounded shutdown escalation after 10 seconds. Processes from a
different or unknown source root receive up to 60 seconds from the first TERM
before `SIGKILL`; source identity affects grace only and never grants an
exemption. The wrapper verifies that no matching marked process survives the
force deadline and logs cleanup failure if one does.

YA-owned work must tolerate this bounded terminal treatment. No provider,
indexer, test helper, or future background facility may make correctness or
user-data safety depend on a development process being indefinitely
unkillable. Cooperative shutdown may persist durable state and interrupt work;
after its deadline, provider persistence and ordinary resume are the recovery
source. Legacy processes launched before the marker contract require explicit
operator cleanup, but every newly marked descendant—including persistent
runtime hosts and their provider children—is in scope for a later bind
takeover.

On terminal shutdown the wrapper first disables respawn and new runtime
launches. It gives a live Hono generation a short opportunity to flush durable
state, interrupt active turns, and close provider connections, then orders the
host to stop every runtime. For each Unix-socket Codex app-server the bounded
escalation is:

1. request `turn/interrupt` when a turn is known active;
2. send `SIGTERM` and wait a configured grace;
3. send a second `SIGTERM`, using Codex's forceable socket-server shutdown;
4. send `SIGKILL` only if the process group still exists; and
5. positively verify the process group and socket are gone.

The wrapper awaits host, Hono, and Vite cleanup up to its own outer deadline;
it does not call `process.exit` immediately after sending signals. A failed
verification is logged as a shutdown failure with the surviving PID/process
group, never reported as clean success.

The host watches an inherited wrapper-liveness channel. EOF enters the same
bounded terminal path. The wrapper watches host exit and can reap reported
runtime process groups if the host fails. A stronger systemd/cgroup or Linux
parent-death mechanism may reinforce this, but it does not replace the explicit
protocol and verification.

A host with no sessions has no per-session polls, watches, heartbeats, or retry
loops. One idle control socket for the wrapper lifetime is permitted.

## Runtime Generations And Fresh Code

The app-server necessarily finishes an active turn using the Codex binary,
environment, outer sandbox, and launch configuration under which it started. The
replacement Hono generation may change YA normalization or fan-out code, but it
must not mutate process-scoped launch facts while adopting the existing thread.

The implemented handshake carries a protocol version, a private
wrapper-lifetime credential, and the Hono generation. The host retains the
original launch snapshot with the runtime. A compatible replacement may
attach; an incompatible replacement cannot claim the runtime, and the host's
attach deadline terminates the unclaimed owner rather than starting a second
writer.

Source changes inside `scripts/dev.js`, the lifecycle host, its control
protocol, or process-launch/sandbox boundary are not reload-safe. The banner
cannot replace those wrapper-lifetime components; applying such changes
requires an explicit terminal wrapper restart. V1 does not run overlapping
old/new host generations merely to claim that every source edit hot-reloaded.

## Provider Backends

### Codex native host

YA 0.7.0 currently pins Codex CLI 0.146.0. That source exposes several pieces
that substantially lower the first experiment's risk:

- `codex app-server --listen unix://PATH` is a supported WebSocket-over-Unix-
  socket transport; the ordinary loopback WebSocket listener remains marked
  experimental/unsupported.
- `ThreadResumeParams` says that resuming a running thread rejoins the live
  thread rather than loading a second copy.
- the running-thread resume response merges the active-turn snapshot into
  returned history and replays pending server requests, including approvals,
  to the new connection;
- connection cleanup removes the subscriber but leaves the thread listener
  consuming provider events; and
- the listener's unload path explicitly refuses to unload while the agent is
  running, then unloads an idle thread with no subscribers after its delay.
- for non-stdio transports, first `SIGINT` or `SIGTERM` enters a graceful drain
  and a second forceable signal exits even with active turns; `SIGHUP` is
  graceful-only, and repeated HUP deliberately never forces exit.

These claims are verified from the pinned checkout under
`references/codex/codex-rs/app-server/` and
`references/codex/codex-rs/app-server-protocol/`, especially the app-server
README, `ThreadResumeParams`, the running-thread resume path, and WebSocket
disconnect tests. They establish upstream capability, not YA integration.

The first implementation keeps one app-server per YA runtime entry. YA's outer
Bubblewrap session sandbox, environment, executor, launch configuration, and
owned-tree teardown are process-scoped. Sharing one daemon is outside v1; it
would require a separately proven isolation partition and teardown contract.

The native implementation connects `CodexAppServerClient` to a host-launched socket,
discovers the same thread after server replacement, normalizes the running
snapshot, restores control callbacks, and retires the app-server after idle or
any bounded terminal path. When the Codex option is off, the shared worker owns
the ordinary Codex adapter instead.

### Shared worker providers

Claude's CLI process is not the owner YA needs to recover. The Claude Agent
SDK `Query` in `ClaudeProvider.startSession` owns message streaming, dynamic
model/effort controls, `interrupt`, liveness probes, and the `canUseTool`
callback. The query and its promises cannot be recreated around an arbitrary
surviving CLI PID.

A Claude-capable runtime worker therefore runs the provider adapter and SDK
query itself. The replacement server attaches to that YA worker. The same
boundary applies to ACP clients, Pi's RPC client, OpenCode's HTTP/SSE server,
and turn-scoped Gemini and Codex OSS transports: the worker owns the adapter's
complete state while Hono owns only the proxy.

The shared architecture is implemented for each adapter. Each adapter earns a
completed provider-specific reload-safe validation claim only after its smoke
proves:

- the turn continues with the server connection absent;
- current-turn state and pending input can be reconstructed;
- control is single-writer after reconnect;
- completed output is neither lost nor duplicated; and
- idle teardown leaves no provider or transport process behind.

For remote executor sessions, the local worker owns the SSH transport and its
provider SDK state. The remote provider PID alone remains insufficient. The
local worker boundary is complete; its release validation still needs to prove
terminal SSH/provider cleanup.

## Codex Setting And Platform Gate

The existing server-persisted setting under **Settings → Providers →
Codex** remains default off and selects the Codex-native backend. Its copy must
describe that selection rather than imply that disabling it disables shared
reload continuity:

> **Use the Codex-native reload host**
>
> Use Codex app-server's native reconnect path for eligible new and resumed
> Linux sessions. When off, Codex uses the shared provider host. Already-running
> sessions keep their launch backend; ordinary shutdown ends both.

"Persistent sessions" is not the UI term: idle Codex sessions are already
durably resumable from provider persistence. This option selects which reload-
safe owner Codex uses; it does not change the terminal wrapper-lifetime
contract.

The setting is read whenever YA starts a Codex provider process, including a
durable-session resume. Enabling it does not adopt a live stdio process;
disabling it does not kill an already-running external runtime. Such a runtime
keeps its original contract until verified idle or terminal teardown, while
subsequent new-thread and resume launches use the newly saved value.

The settings row is capability-gated for hosted clients. A capable server
reports Linux/host availability separately from the saved preference. A saved
native preference does not make an ineligible executor or sandbox eligible:
the existing Codex adapter then uses its ordinary in-Hono path. When either
host is unavailable, ordinary sessions remain visibly ineligible for seamless
reload.

Both hosts are initially enabled on Linux under the non-watch development
wrapper only. Host capability requires:

- `process.platform === "linux"`;
- launch through the recognized development wrapper/lifecycle host;
- the exact compatible host protocol;
- a private, connectable runtime socket;
- wrapper-generation registration; and
- bounded owner-loss cleanup owned by the wrapper and host.

Per-session Codex-native eligibility additionally requires a local launch with
no executor or YA outer session sandbox. An ineligible Codex launch stays on
the existing in-Hono adapter even when the native preference is saved.

macOS, Windows, direct `pnpm --filter server dev` launches, unsupported Linux
environments, and failed probes retain ordinary in-Hono provider ownership and
the existing safe-restart/explicit-interruption choices.

Any later use of `systemd-run --user`, Linux abstract sockets, `/proc`, cgroup
inspection, `PR_SET_PDEATHSIG`, or Linux signal/process-group assumptions is
separately guarded by `process.platform === "linux"` and an actual capability
probe. Linux does not imply a working systemd user manager. Such mechanisms
must never execute on macOS or Windows through a best-effort fallback.

The existing wrapper is the initial dev-only owner because it already spans
Hono reload and has a clear terminal boundary. `systemd-run` remains an
optional Linux reinforcement, not a substitute for the host protocol. If used,
the transient service owns the whole host/provider process tree; systemd's
default control-group kill policy is retained rather than leaving descendants
outside lifecycle management.

## Reload UX And Compatibility

The server reports reload continuity as host capability plus a blocker-specific
decision, not merely the saved provider setting. A backend reload is seamless
only when every active blocker was launched reload-safe, can reattach to the
current host protocol, and has no volatile queue fact that would be lost.

The banner behavior should remain conservative:

- **eligible active turns, no volatile queue blockers:** offer immediate
  reload without stopping those turns;
- **any unsupported/incompatible active turn:** offer **Reload When Safe** and
  the existing explicitly interrupting reload;
- **queued work not owned durably by a survivor:** keep it as a blocker; and
- **continuity state unknown:** hide the seamless action rather than guess.

Both the authenticated API action and wrapper `SIGHUP` enter this same decision
path. HUP is sent only to the wrapper. Codex app-server interprets HUP as a
request to drain and exit after active work, so forwarding it would retire the
very runtime that Hono reload is meant to preserve.

The client gates the Codex backend-selector field with
`reload-safe-codex-runtime-settings` and enables it only when the current host
also advertises `reload-safe-codex-runtime`. The approved compatibility corpus
was stable releases `v0.7.0` and `v0.6.2`: neither knows the new field, so a new
client hides it and makes no unsupported write. Older clients omit the field
and retain the server's default-off behavior.

## Verification Matrix

Continuity must be proved rather than inferred from a surviving PID. Existing
Codex-native checks cover new-thread and durable-resume launches through its host;
API-triggered active-turn reload with the same app-server, YA session, thread,
and turn identities; active snapshot completion; a second post-reload turn; no
duplicate transcript rows; an active turn crossing wrapper `SIGHUP`; terminal
idle teardown; and deterministic attach-timeout and owner-loss teardown. The
shared host repeats the lifecycle proof with a deterministic fake worker and
provider-specific integration smokes. The remaining cases are an extended
hardening matrix:

1. With the Codex setting off, prove new and resumed Codex sessions use the
   shared worker; with it on, prove they retain the current native socket host.
2. Enable the setting, start a fresh Linux dev wrapper, then launch a new local
   Codex thread and resume an existing one through private Unix-socket
   app-servers. Prove enabling the setting cannot adopt an already-running
   stdio process, but its next resume uses the host.
3. Begin a turn that remains active long enough to reload, with visible text or
   tool progress before and after the boundary. Record wrapper, host, Hono, and
   app-server PIDs; canonical YA session id; Codex thread and turn ids; launch
   fingerprint; and socket path.
4. Trigger **Server changed → Reload** while the turn is active. Repeat once via
   wrapper `SIGHUP`, and prove repeated reload requests coalesce rather than
   spawning overlapping Hono generations.
5. Prove the Hono PID changed while the wrapper, host, app-server, canonical YA
   session, Codex thread, and Codex turn did not.
6. Reconnect and `thread/resume` from the new server. Assert the active snapshot
   includes all completed items and accumulated agent text through the attach
   point, then observe later deltas and one final `turn/completed`.
7. Exercise an approval that is pending across the disconnect or arrives while
   no Hono server is attached; prove it appears once and its response reaches
   Codex. Expire the attach grace in a second run and prove the approval is
   interrupted/terminated rather than retained forever.
8. Compare the final live projection with provider persistence and assert no
   duplicate user row, tool item, assistant text, result, interrupt marker, or
   terminal runtime status.
9. Prove direct/deferred volatile queue state blocks seamless reload. Toggle the
   setting off while an external runtime exists; prove that runtime drains under
   its original contract and the next new or resumed process launches through
   the shared worker.
10. Let the process reach verified idle, release it, and prove the registry
    entry, socket, timers, and owned process tree disappear.
11. Exercise terminal wrapper `SIGINT` and `SIGTERM` against idle, active,
    pending-approval, and deliberately hung turns. Prove the bounded signal
    ladder ends with no host/worker/app-server PID, process group, timer, or
    socket.
12. Kill the Hono process unexpectedly and prove bounded recovery or teardown.
    Break wrapper/host control independently and prove the surviving owner reaps
    the app-server rather than leaking it.
13. Force an incompatible host/server generation and prove no second writer is
    started. Repeat on a non-Linux target and prove no host/socket launch is
    attempted and **Reload When Safe** remains available.

Record at least:

- server-down interval;
- attach handshake duration;
- active-snapshot item/byte count and duration;
- time from new server readiness to first correct session snapshot;
- whether the provider emitted any interrupt/failure; and
- attach/recovery/terminal deadline selected and elapsed; and
- process-group/socket state after idle, owner loss, and wrapper shutdown.

The smoke should use a deterministic fake or pinned provider fixture for CI and
one real Codex run for integration confidence. Upstream's own rejoin tests are
evidence for app-server behavior but do not cover YA identity, normalization,
fan-out, sandboxing, or teardown.

## Rejected Or Deferred Alternatives

### Raw provider PID adoption — reject

It preserves execution at best, not the provider protocol owner. It cannot
recover SDK queries, request promises, approvals, queues, replay, or safe
control authority.

### Adopt a stdio app-server when Restart is clicked — reject

The old Hono process owns the anonymous pipes and JSON-RPC client state. The
default-off setting must choose socket ownership when a provider process
launches; changing it later affects subsequent new-thread or resume launches,
not a process already running.

### Replace the Codex-native host with the shared worker — reject

Codex already supplies a proved active snapshot, running-thread rejoin,
pending-request replay, and durable transcript through its socket app-server.
The shared worker is now justified by the other providers, but replacing the
working specialized path would discard provider-native recovery and needlessly
change the option the user already verified. Codex uses the shared worker only
when that option is disabled.

### Exit code or marker file as reload intent — reject

A clean process exit is not proof that the operator requested reload, and a
one-shot file has stale/race cleanup semantics without acknowledgement. The
stable wrapper accepts structured reload requests; `SIGHUP` is an external
alias for the same state transition.

### Forward HUP to Codex app-server — reject

In the pinned socket app-server, HUP is graceful-only shutdown: it waits for
active turns and then exits, while repeated HUP never forces a hung turn. HUP
belongs at the wrapper reload boundary. Terminal provider cleanup uses the
bounded interrupt/TERM/TERM/KILL ladder.

### Keep the old Hono server draining beside the new one — defer

A blue/green Hono handoff could leave old sessions on the old server while new
requests use the new one, but clients would need routing across two servers,
the old server would retain all unrelated services/watchers, and every server
generation would need a drain registry. Moving only provider runtime ownership
is the narrower invariant.

### Provider-native resume after restart — keep as recovery, not continuity

Starting a new provider process from the durable session id is correct after an
idle or interrupted owner is gone. It cannot make an already interrupted turn
continuous, and concurrent resume against an actually surviving owner risks a
second writer.

### Systemd as the architecture — reject

A transient user service is a useful Linux parent and reaper, but process
supervision is not session reattachment. The portable contract is the runtime
protocol; systemd is one explicitly Linux-gated way to host it.

## Research Sources

- [Node child process documentation](https://nodejs.org/api/child_process.html)
  — detached/unref behavior, stdio lifetime, pipe capacity, IPC channels, and
  handle-passing limits.
- [Node net documentation](https://nodejs.org/api/net.html) — local IPC uses
  Unix-domain sockets on Unix and named pipes on Windows; their lifetime and
  path behavior differ.
- [Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
  — transports, running-thread lifecycle, notifications, and approvals. YA's
  pinned `references/codex` checkout remains authoritative for the exact
  supported version.
- Pinned Codex `app-server/src/lib.rs` and
  `connection_handling_websocket_unix.rs` tests — socket-server `SIGHUP`,
  `SIGINT`, and `SIGTERM` drain/force behavior for the exact audited version.
- [systemd-run manual](https://man7.org/linux/man-pages/man1/systemd-run.1.html)
  and [systemd kill behavior](https://man7.org/linux/man-pages/man5/systemd.kill.5.html)
  — transient service ownership and control-group teardown.
- [Linux `PR_SET_PDEATHSIG` manual](https://man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html)
  — Linux-only parent-death signaling, useful only when attached to the
  durable runtime owner rather than the replaceable server.

## Trigger And Scope Decision

**Trigger met:** a real active agent turn is interrupted by an ordinary
development backend reload, and the existing safe-restart delay is not always
acceptable.

**Implemented foundation:** the server-persisted, default-off Codex backend
setting; Codex-specific Linux lifecycle host for new-thread and durable-resume
launches; direct Unix-socket attach/rejoin; explicit wrapper reload/shutdown
state machine; and bounded owner-loss and terminal reaping.

**Implemented extension:** the wrapper-owned shared host, one complete provider
worker per session, the `AgentSession` proxy and sequenced replay/request
protocol, two-phase claim/attach across Hono generations, worker-owned provider
sandboxing, terminal wrapper-resource reaping, and the exact Codex routing
decision above.

**Still not implied:** survival across terminal/full-wrapper restart, a
machine-persistent daemon, enabling the mechanism outside Linux, sharing one
provider process across sandbox boundaries, or replacing the existing safe-
restart flow.
