# Reload-Safe Provider Runtimes

> Reload-safe Codex runtimes let explicitly opted-in local Linux sessions keep
> an active turn running across replacement of YA's Hono server while a stable
> lifecycle host retains the complete provider protocol owner; terminal wrapper
> shutdown still reaps every owned runtime within a bounded deadline.

Topic: reload-safe-provider-runtimes

Status: **implemented as a default-off Linux Codex feature.** New eligible
sessions launched under the stable development wrapper use the lifecycle host;
ordinary and unsupported sessions retain the existing ownership contract.
The extended hardening matrix below remains useful coverage, but the initial
contract has been proved with real active-turn reloads through both the API and
wrapper `SIGHUP`, a second turn after reattach, terminal wrapper cleanup, and
deterministic owner-loss tests.

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

There is a viable path, but it is neither raw process detachment nor a generic
provider-runtime extraction.

The process that survives must own the complete live provider connection:
stdin/stdout or socket transport, SDK iterator, request correlation, pending
approval callbacks, current-turn state, control methods, and a supported rejoin
mechanism. The new YA server can then attach to that owner and rebuild its
`Process` projection. Keeping only the provider PID alive loses the state needed
to interpret or control it.

The first implementation is deliberately Codex-specific:

1. A stable lifecycle host owned by `scripts/dev.js` launches one Codex
   app-server per eligible session through a private Unix socket.
2. The replaceable Hono server connects directly to that app-server. After a
   reload it uses native `thread/resume` to recover the active snapshot and
   replay pending provider requests.
3. A server-persisted **Providers → Codex** setting controls this launch path,
   applies only to new sessions, and defaults off.
4. The wrapper treats API restart and `SIGHUP` as Hono-reload intent, while
   `SIGINT`, `SIGTERM`, wrapper/host loss, and exhausted recovery are terminal
   paths with bounded, verified reaping.
5. A generic YA worker protocol and Claude support remain later proposals. A
   Claude CLI PID cannot be adopted by a new SDK `Query`.

The existing **Reload When Safe** flow remains the required fallback for
ordinary, already-running, queued, remote, unsupported, or incompatible
sessions. Enabling the setting never attempts to adopt a live stdio session.

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
proposal is solely for the other useful choice: replace the backend now while
the current turn continues elsewhere.

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

## Implemented Runtime Boundary

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
the registry must atomically bind the startup runtime id to the final YA session
id and Codex thread id before reporting launch success.

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
  detachedAt?: string;
  attachDeadlineAt?: string;
  idleDeadlineAt?: string;
}
```

The wrapper-lifetime v1 registry keeps the smaller subset required for direct
reattach: runtime and YA session ids, project path, socket path, PID/process
group, attachment generation/state, launch time, reattach settings, cleanup
paths, and its bounded attach timer. The private runtime directory and token
fence entries to one wrapper instance. A host protocol bump fences Hono code
that can no longer interpret the registry. The broader separations remain
load-bearing for any future persistence beyond one wrapper lifetime:

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

YA-only launch facts—selected configuration, applied permission mode, sandbox
and executor fingerprint, initial canonicalization mapping—must be durable
before reload eligibility is advertised. Direct, deferred, or other volatile
queue state remains a blocker unless a later change moves that state under a
durable owner. Replaying only assistant text would recreate the current split-
brain failure in a subtler form.

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

The combined lifecycle owner keeps four independent deadlines:

- the ordinary verified-idle reap deadline, using YA's configured idle policy;
- the replacement-server attach deadline after an intentional Hono detach;
- the shorter recovery deadline after an unexpected Hono exit; and
- the terminal drain deadline after wrapper shutdown or owner loss.

No deadline is renewed merely because the app-server PID or socket remains
alive. Provider events may update liveness evidence, but only a successful
reattach or a real state transition changes the applicable lifecycle state.

When an attached turn reaches verified idle, Hono's normal YA idle retention
timer continues to apply. Once Hono detaches or disappears, the host's bounded
attach deadline becomes authoritative, so server absence cannot leave the
runtime alive indefinitely. Terminal expiry terminates the app-server, verifies
its owned process group is gone, removes its socket and registry entry, and
leaves provider persistence as the later resume source.

After intentional reload detach, the runtime may preserve an active turn or
pending provider request only through the bounded attach grace. If no compatible
replacement attaches, the host requests interruption when possible and enters
the same terminal signal ladder. It never waits without a deadline for a turn,
retry, background tool, or approval to settle. Pending approval is replayed
after a successful attach and is never auto-approved; after attach timeout it is
interrupted/terminated rather than kept forever.

If the runtime dies mid-turn, YA surfaces owner loss as a real interruption or
needs-attention state. It does not silently resume and risk two writers.

### Reload versus terminal shutdown

The wrapper owns one explicit state machine:

| Input | Wrapper transition | Codex runtime action |
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
environment, outer sandbox, and launch fingerprint under which it started. The
replacement Hono generation may change YA normalization or fan-out code, but it
must not mutate process-scoped launch facts while adopting the existing thread.

The handshake therefore carries the host protocol, wrapper instance, Codex
version, and launch fingerprint. A compatible replacement may attach. An
incompatible replacement leaves the runtime fenced, reports needs-attention,
and lets the host's attach deadline terminate it; it never starts a second
writer.

Source changes inside `scripts/dev.js`, the lifecycle host, its control
protocol, or process-launch/sandbox boundary are not reload-safe. The banner
must offer **Reload When Safe** or explicit interrupting wrapper restart for
those changes. V1 does not run overlapping old/new host generations merely to
claim that every source edit hot-reloaded.

This also prevents a fresh UI test server from silently exercising stale host
code. A fresh Hono process attached to an incompatible host is not called fresh
and must not clear the Server changed state.

## Provider Feasibility

### Codex: recommended first experiment

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
Bubblewrap session sandbox, environment, executor, launch fingerprint, and
owned-tree teardown are process-scoped. Sharing one daemon is outside v1; it
would require a separately proven isolation partition and teardown contract.

The implementation connects `CodexAppServerClient` to a host-launched socket,
discovers the same thread after server replacement, normalizes the running
snapshot, restores control callbacks, and retires the app-server after idle or
any bounded terminal path. Ordinary Codex sessions still use stdio.

### Claude: YA worker required

Claude's CLI process is not the owner YA needs to recover. The Claude Agent
SDK `Query` in `ClaudeProvider.startSession` owns message streaming, dynamic
model/effort controls, `interrupt`, liveness probes, and the `canUseTool`
callback. The query and its promises cannot be recreated around an arbitrary
surviving CLI PID.

A Claude-capable runtime worker must therefore run the provider adapter and SDK
query itself. The replacement server attaches to that YA worker. Once the
current turn is idle and acknowledged, the worker may shut down; future sends
can use Claude's ordinary durable resume path. This is a larger change than the
Codex socket experiment and should follow it.

### Other providers and remote executors

Every other provider starts unsupported. An adapter earns reload survival only
after a provider-specific smoke proves:

- the turn continues with the server connection absent;
- current-turn state and pending input can be reconstructed;
- control is single-writer after reconnect;
- completed output is neither lost nor duplicated; and
- idle teardown leaves no provider or transport process behind.

Remote executor sessions are out of the first scope. An SSH PID continuing on
the remote host does not keep the local SSH stdio owner or YA callback state
alive. They retain **Reload When Safe** until the runtime worker itself can run
at the correct side of that boundary.

## Provider Setting And Platform Gate

The feature is a server-persisted setting under **Settings → Providers →
Codex**, default off. Current copy:

> **Keep Codex sessions through server reloads**
>
> New eligible local Linux Codex sessions keep their provider runtime while
> Yep Anywhere reloads, then reconnect automatically. Ordinary shutdown still
> ends them.

"Persistent sessions" is not the UI term: idle Codex sessions are already
durably resumable from provider persistence. This option changes ownership of
the live app-server so an active turn can cross Hono replacement.

The setting is read at session launch. Enabling it does not adopt a live stdio
session; disabling it does not kill an already-running external runtime. Such a
runtime keeps its original contract until verified idle or terminal teardown,
while subsequent launches use the newly saved value.

The settings row is capability-gated for hosted clients. A capable server
reports Linux/host availability separately from the saved preference. When an
eligible local launch is explicitly requested and the lifecycle host, socket,
sandbox, or attach self-check fails, YA returns a clear launch error rather than
silently starting a session that lacks the promised reload behavior. Remote and
otherwise unsupported sessions remain ordinary and are visibly ineligible for
seamless reload.

The first Codex experiment is enabled on Linux only. Its capability requires
all of the following, not merely a successful spawn:

- `process.platform === "linux"`;
- launch through the recognized development wrapper/lifecycle host;
- the exact compatible host protocol and Codex capability;
- a private, connectable runtime socket;
- a supported local executor and sandbox configuration; and
- successful attach/replay and owner-loss cleanup self-checks.

macOS, Windows, direct `pnpm --filter server dev` launches, unsupported Linux
environments, and failed probes do not attempt the mechanism and do not show a
seamless-reload action. They keep the existing safe-restart and explicit
interrupting-restart choices.

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

The client gates the setting field with
`reload-safe-codex-runtime-settings` and enables it only when the current host
also advertises `reload-safe-codex-runtime`. The approved compatibility corpus
was stable releases `v0.7.0` and `v0.6.2`: neither knows the new field, so a new
client hides it and makes no unsupported write. Older clients omit the field
and retain the server's default-off behavior.

## Codex-First Verification Matrix

Continuity must be proved rather than inferred from a surviving PID. Initial
checks cover a new eligible runtime; API-triggered active-turn reload with the
same app-server, YA session, thread, and turn identities; active snapshot
completion; a second post-reload turn; no duplicate transcript rows; an active
turn crossing wrapper `SIGHUP`; terminal idle teardown; and deterministic
attach-timeout and owner-loss teardown. The remaining cases are an extended
hardening matrix:

1. With the setting off, prove new Codex sessions retain the current stdio
   ownership and restart behavior.
2. Enable the setting, start a fresh Linux dev wrapper, and launch a new local
   Codex session through a private Unix-socket app-server. Prove enabling the
   setting cannot adopt an already-running stdio session.
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
   its original contract and the next session launches through stdio.
10. Let the process reach verified idle, release it, and prove the registry
    entry, socket, timers, and owned process tree disappear.
11. Exercise terminal wrapper `SIGINT` and `SIGTERM` against idle, active,
    pending-approval, and deliberately hung turns. Prove the bounded signal
    ladder ends with no host/app-server PID, process group, timer, or socket.
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
default-off setting must choose socket ownership when the session launches;
changing it later affects only future sessions.

### Generic YA event-proxy runtime in Codex v1 — defer

Codex already owns the active snapshot, running-thread rejoin, pending-request
replay, and durable transcript. Adding a second normalized event log, generic
`AgentSession` control protocol, and YA queue owner before the direct socket
smoke would duplicate state and enlarge the split-brain surface. Revisit only
when a proved observable gap or a second provider requires it.

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

**Implemented scope:** the server-persisted, default-off provider
setting; Codex-specific Linux lifecycle host; direct Unix-socket attach/rejoin;
explicit wrapper reload/shutdown state machine; bounded owner-loss and terminal
reaping; and the fake plus real smokes above.

**Not approved by this proposal alone:** migrating every provider, changing
production/full-wrapper restart semantics, enabling a mechanism outside Linux,
sharing one app-server across sandbox boundaries, adding a generic provider
runtime protocol, or replacing the existing safe-restart flow.
