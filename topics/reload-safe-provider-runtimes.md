# Reload-Safe Provider Runtimes

> Reload-safe provider runtimes are a proposal for active provider turns to
> survive a development backend reload under the same canonical YA session by
> moving provider protocol ownership outside the replaceable Hono server; a
> detached provider PID without its protocol owner does not satisfy the
> contract.

Topic: reload-safe-provider-runtimes

Status: **proposal; Codex-first Linux experiment recommended.** The current
safe-restart path already avoids interruption by waiting for active work to
drain. Immediate reload without interrupting a turn is not implemented. The
pinned Codex app-server supplies promising native rejoin mechanics, but YA has
not yet run the end-to-end reload smoke described here.

Related:
[server message routing](../docs/project/server-message-routing.md),
[session liveness](session-liveness.md),
[provider state machine](provider-state-machine.md),
[session ownership](session-ownership.md),
[session sandboxing](session-sandboxing.md),
[subprocess environment](subprocess-environment.md),
[core service API](core-service-api.md), and
[federated super sessions](federated-super-sessions.md).

## Verdict

There is a viable path, but it is not raw process detachment.

The process that survives must own the complete live provider connection:
stdin/stdout or socket transport, SDK iterator, request correlation, pending
approval callbacks, current-turn snapshot, control methods, and a bounded event
log for reconnect. The new YA server can then attach to that owner and rebuild
its `Process` projection. Keeping only the provider PID alive loses the state
needed to interpret or control it.

The recommended sequence is:

1. Prove a Linux-only Codex path using the pinned app-server's supported Unix
   socket transport and running-thread `thread/resume` behavior.
2. Put lifecycle and discovery under a small runtime host owned by
   `scripts/dev.js`, which already survives backend reloads.
3. Generalize the YA-to-runtime protocol only after the Codex smoke exposes
   the actual attach, replay, approval, and teardown requirements.
4. Add Claude by running the Claude Agent SDK `Query` inside a YA runtime
   worker. A Claude CLI PID cannot be adopted by a new SDK `Query`.

The existing **Reload When Safe** flow remains the required fallback. The
observed reload interruption is enough to trigger the Codex experiment, not a
whole-provider migration of `Supervisor` before any narrow proof exists.

## Current Ownership And Failure Path

Today one server process owns all of the state that makes a provider child
useful:

- `Supervisor` owns each in-memory `Process`.
- `Process` owns the provider `AsyncIterator<SDKMessage>`, direct and deferred
  queues, pending approval promises, control callbacks, liveness state,
  streaming catch-up text, and the 15–30 second replay buckets.
- Claude's adapter owns an SDK `Query`, `AbortController`, `MessageQueue`, and
  `canUseTool` callback. Its local CLI child uses three parent-owned pipes.
- Codex's adapter owns a `CodexAppServerClient`, JSON-RPC request map,
  notification queue, active thread/turn ids, approval handler, and a stdio
  app-server child.

`scripts/dev.js` is already a stable wrapper: it keeps Vite running, observes
the backend child exit, and starts a replacement backend. It does not currently
own provider runtimes. `/api/server/restart` marks the one-shot reload request
and exits the backend; it does not transfer any `Process` or provider adapter
state to the wrapper or replacement server. The replacement reconstructs
ordinary durable session history later, but that is provider resume after
owner loss, not continuation of the active turn.

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

## Proposed Runtime Boundary

The development wrapper should own a small **provider runtime host** beside the
replaceable server:

```text
scripts/dev.js (stable for one dev-server launch)
  |
  +-- Vite
  +-- Hono server generation N     <--- exits on Server changed / Reload
  +-- provider runtime host
       |
       +-- Codex app-server for session A
       +-- YA AgentSession worker for session B

scripts/dev.js starts Hono server generation N+1
                              |
                              +--- attach to A and B by YA session id + cursor
```

The host is a registry and lifecycle owner, not another public YA server. It
does not expose browser routes, relay transport, project discovery, or a second
session identity system. The canonical YA session id remains the public key;
provider-native ids and runtime instance ids stay internal.

For Codex, the first runtime may be the provider's app-server itself. For a
provider without a reconnectable native service, a YA worker owns the
`AgentSession` object and speaks a small local protocol to the Hono server. The
same host may supervise both without pretending their reconnect mechanics are
identical.

### Runtime registry

Each live entry needs at least:

```ts
interface ReloadSafeRuntimeEntry {
  schemaVersion: number;
  runtimeProtocolVersion: number;
  runtimeId: string;
  runtimeGeneration: string;
  sessionId: string; // canonical YA-visible id
  provider: ProviderName;
  providerResumeId?: string;
  projectId: string;
  projectPath: string;
  launchFingerprint: string;
  state: "starting" | "in-turn" | "waiting-input" | "idle" | "closing";
  lastSequence: number;
  startedAt: string;
}
```

The public shape is not frozen. The separations are load-bearing:

- YA session identity versus provider resume identity;
- server generation versus runtime generation;
- discovery metadata versus the secret needed to control a runtime;
- live event sequence versus provider transcript position; and
- provider process liveness versus active-turn liveness.

Registry files, when needed for crash discovery, live in a user-private runtime
directory and contain no bearer secret. The attach secret travels through an
inherited private pipe or an owner-only file separate from diagnostics and
process arguments. A local socket must be owner-only and must never bind a LAN
interface.

### Attach and fencing

One server generation may control a runtime at a time. Attach uses a monotonically
increasing lease or epoch:

1. The replacement server lists compatible runtime entries.
2. It proves the runtime id, session id, provider, project, launch fingerprint,
   and protocol version match its persisted YA facts.
3. It requests control with the last acknowledged event sequence.
4. The runtime fences the previous control connection, replays later events,
   then sends an authoritative state snapshot.
5. The server registers one `Process` projection and resumes ordinary client
   subscription catch-up under the same YA session id.

The attach snapshot must contain active-turn items, pending input, applied and
selected configuration, liveness evidence, provider runtime status, queue
facts owned by the runtime, and provider control capabilities. Replaying only
assistant text would recreate the current split-brain failure in a subtler
form.

The runtime event sequence is for short restart catch-up, not a shadow
transcript. Provider persistence remains authoritative for completed history.
The log is bounded by the current turn plus a short acknowledged tail, and old
entries are released after the new server acknowledges them.

### Control protocol

The smallest useful YA worker protocol mirrors the live `AgentSession`
surface rather than HTTP routes:

- attach/detach with epoch and event cursor;
- normalized provider events and an authoritative current-turn snapshot;
- queue one user turn, steer, interrupt, and abort;
- answer one provider input request;
- read/probe liveness and capabilities;
- change supported live configuration such as model, effort, or permission
  mode; and
- release at a verified idle boundary.

The server remains responsible for public authorization, REST/WS contracts,
session lists, and client fan-out. The runtime owns only state that must remain
next to the live provider connection.

## Turn Completion And Teardown

The survivor should not become an immortal provider daemon.

When the turn reaches a verified idle boundary, the runtime:

1. finishes provider-native persistence and captures its final event sequence;
2. waits for the replacement server to attach and acknowledge the final state;
3. releases the provider child when ordinary YA idle policy says it may; and
4. exits its per-session worker after a bounded attach grace if no server
   returns.

An implementation may retain a lightweight shared host for the lifetime of
`scripts/dev.js`; the resource mandate applies to each session runtime and its
recurring work, not to one idle control socket. A host with no sessions has no
per-session polls, watches, heartbeats, or retry loops.

If the server does not return before the grace expires, the provider child is
stopped after the active turn settles and the host removes the entry. A later
YA server may read the provider's durable transcript and normally reactivate
the session, but it must not claim it reattached to a still-live owner. If the
runtime dies mid-turn, YA surfaces owner loss as a real interruption or
needs-attention state; it does not silently resume and risk two writers.

Pending approval is a special case: the runtime keeps the provider callback
pending and replays the request after attach. It never auto-approves. A
provider-imposed approval timeout is reported as the provider's real failure.

The dev wrapper's own exit remains a terminal boundary. It gracefully stops
the runtime host and then verifies or terminates only its owned provider
process tree. Backend reload survival must never turn `pnpm dev` shutdown into
an orphan leak.

## Runtime Generations And Fresh Code

A survivor necessarily finishes the active turn using the code and provider
version under which it started. Loading half of a provider adapter from the new
server into an old live turn is less safe than letting that turn drain.

The runtime handshake therefore carries a code/protocol generation:

- compatible replacement servers may attach to an older draining runtime;
- new sessions use the current runtime generation;
- an incompatible runtime remains visible but forces **Reload When Safe**;
- a source change inside the runtime boundary starts a new host/worker
  generation for new sessions while the old generation drains; and
- the old generation exits once it has no live or unacknowledged sessions.

This rule also prevents a fresh UI test server from silently exercising stale
runtime code. A fresh backend plus an incompatible old runtime is not called
fresh and must not clear the Server changed state as though every changed
module had reloaded.

## Provider Feasibility

### Codex: recommended first experiment

YA 0.7.0 currently pins Codex CLI 0.145.0. That source exposes several pieces
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

These claims are verified from the pinned checkout under
`references/codex/codex-rs/app-server/` and
`references/codex/codex-rs/app-server-protocol/`, especially the app-server
README, `ThreadResumeParams`, the running-thread resume path, and WebSocket
disconnect tests. They establish upstream capability, not YA integration.

The first implementation should keep one app-server per YA runtime entry, or
prove an equivalent isolation partition before sharing one daemon. YA's outer
Bubblewrap session sandbox, environment, executor, launch fingerprint, and
owned-tree teardown are currently process-scoped. A global app-server must not
silently collapse those boundaries or relaunch a sandboxed session without its
outer sandbox.

The remaining Codex work is meaningful but bounded: connect
`CodexAppServerClient` to the socket instead of spawning stdio, discover the
same thread after server replacement, normalize the running snapshot without
duplicates, restore control callbacks, and retire the app-server after idle.

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

## Platform Gate

The first Codex experiment is enabled on Linux only. Its capability requires
all of the following, not merely a successful spawn:

- `process.platform === "linux"`;
- launch through the recognized development wrapper/runtime host;
- the exact compatible runtime protocol and Codex capability;
- a private, connectable runtime socket;
- a supported local executor and sandbox configuration; and
- successful attach/replay self-checks.

macOS, Windows, direct `pnpm --filter server dev` launches, unsupported Linux
environments, and failed probes do not attempt the mechanism and do not show a
seamless-reload action. They keep the existing safe-restart and explicit
interrupting-restart choices.

Any later use of `systemd-run --user`, Linux abstract sockets, `/proc`, cgroup
inspection, `PR_SET_PDEATHSIG`, or Linux signal/process-group assumptions is
separately guarded by `process.platform === "linux"` and an actual capability
probe. Linux does not imply a working systemd user manager. Such mechanisms
must never execute on macOS or Windows through a best-effort fallback.

The existing wrapper is preferable for the initial dev-only owner because it
already spans the reload and has a clear shutdown boundary. `systemd-run`
remains an optional Linux deployment mechanism, not a prerequisite and not a
substitute for the runtime protocol. If used, the transient service owns the
whole worker/provider process tree; systemd's default control-group kill policy
is retained rather than leaving descendants outside lifecycle management.

## Reload UX And Compatibility

The server reports reload continuity as a capability plus a blocker-specific
decision, not one global boolean. A backend reload is seamless only when every
active blocker can survive and no volatile queue fact would be lost.

The banner behavior should remain conservative:

- **eligible active turns, no volatile queue blockers:** offer immediate
  reload without stopping those turns;
- **any unsupported/incompatible active turn:** offer **Reload When Safe** and
  the existing explicitly interrupting reload;
- **queued work not owned durably by a survivor:** keep it as a blocker; and
- **continuity state unknown:** hide the seamless action rather than guess.

The client must capability-gate any new route, field, or action under
[server capabilities](server-capabilities.md). A future implementation needs
the normal stable-release compatibility review before changing this client/
server contract. Older servers and clients retain today's behavior.

## Codex-First Smoke

The experiment is successful only if it proves continuity, not merely a
surviving PID:

1. Start a fresh Linux dev wrapper and a Codex session through a private Unix
   socket app-server.
2. Begin a turn that remains active long enough to reload, with visible text or
   tool progress before and after the boundary.
3. Record YA server PID, runtime/app-server PID, canonical YA session id,
   Codex thread id, active turn id, and last event sequence.
4. Trigger **Server changed → Reload** while the turn is active.
5. Prove the YA server PID changed while the runtime/app-server PID and Codex
   turn id did not.
6. Reconnect and `thread/resume` from the new server. Assert the active snapshot
   includes all completed items and accumulated agent text through the attach
   point, then observe later deltas and one final `turn/completed`.
7. Exercise an approval that is pending across the disconnect or arrives while
   no server is attached; prove it appears once and its response reaches Codex.
8. Compare the final live projection with provider persistence and assert no
   duplicate user row, tool item, assistant text, result, interrupt marker, or
   terminal runtime status.
9. Let the process reach verified idle, release it, and prove the runtime entry,
   socket, timers, and owned process tree disappear.
10. Repeat on a non-Linux test target and prove no runtime host/socket launch is
    attempted and **Reload When Safe** remains available.

Record at least:

- server-down interval;
- attach handshake duration;
- replay item/byte count and duration;
- time from new server readiness to first correct session snapshot;
- whether the provider emitted any interrupt/failure; and
- process/socket state after idle and wrapper shutdown.

The smoke should use a deterministic fake or pinned provider fixture for CI and
one real Codex run for integration confidence. Upstream's own rejoin tests are
evidence for app-server behavior but do not cover YA identity, normalization,
fan-out, sandboxing, or teardown.

## Rejected Or Deferred Alternatives

### Raw provider PID adoption — reject

It preserves execution at best, not the provider protocol owner. It cannot
recover SDK queries, request promises, approvals, queues, replay, or safe
control authority.

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

**Approved next research slice if implementation is requested:** the
Codex-first Linux smoke and the smallest wrapper-owned runtime registry needed
to run it.

**Not approved by this proposal alone:** migrating every provider, changing
production restart semantics, enabling a mechanism outside Linux, sharing one
app-server across sandbox boundaries, or replacing the existing safe-restart
flow.
