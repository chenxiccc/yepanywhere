# Managed Remote Executors

> A controller-owned YA session may run through an explicitly configured SSH
> host in a YA-managed remote Git workspace, using an injected subordinate
> runner and controller-mediated source transfer. Manual SSH is the baseline;
> machine discovery and VM lifecycle are later target-provider concerns.

Topic: managed-remote-executors

Status: product direction with its Gate A injectable runtime, Gate B
manual-SSH/disposable-workspace foundation, Gate C controller-authenticated
Codex diagnostic, and Gate D isolated-transcript proof accepted. YA's released
SSH Remote Executors remain Claude-family process transports that assume a
matching remote checkout and sync Claude transcripts with `rsync`. The new
carrier, workspace service, remote `AgentSession`, Supervisor bridge, and
bounded app-data transcript mirror remain operator-only: YA does not yet
publish managed placement, persist a browser-visible managed execution
coordinate, integrate managed records into server discovery/routes, or fetch
remote heads into user-project refs.

The staged implementation and research gates are tracked in
[`docs/tactical/119-managed-ssh-executor-baseline.md`](../docs/tactical/119-managed-ssh-executor-baseline.md).

Related:
[SSH Remote Executors](../docs/project/remote-executors.md),
[managed SSH executor tactical](../docs/tactical/119-managed-ssh-executor-baseline.md),
[managed runner execution targets](managed-runner-execution-targets.md),
[deferred Machine Control tactical](../docs/tactical/118-managed-runner-mvp.md),
[reload-safe provider runtimes](reload-safe-provider-runtimes.md),
[provider host API](provider-host-api.md),
[remote-session project-view gap](../gaps/remote-session-project-views-use-local-files.md),
[provider-neutral remote-executor gap](../gaps/provider-neutral-remote-executors.md),
[source control](source-control.md),
[project directory storage](project-directory-storage.md),
[session sandboxing](session-sandboxing.md),
[security](security.md),
[vanilla defaults](vanilla-defaults.md), and
[architecture mandates](architecture-mandates.md).

## Decision

Manual SSH is the first managed execution-target provider. The useful baseline
must work without Machine Control, a second YA server, a hosted account, a
remote Git forge, or matching controller and target checkout paths.

Codex is the only provider advertised by the first managed-runner release.
Provider-neutral framing is an implementation boundary, not a product claim:
Claude and every additional provider remain unavailable until their own auth,
session, resume, transcript, and cleanup contracts have live acceptance.

The baseline combines two independent mechanisms:

1. **Managed provider execution.** The controller injects a version-matched
   subordinate runner and supervises it through a controller-initiated SSH
   stdio channel. The runner owns the complete target-local provider adapter,
   provider process, and session workspace for one lease.
2. **Managed Git workspace transfer.** The controller sends one exact committed
   base through Git over the already-authorized SSH account, creates a unique
   target worktree, and fetches commits back into a controller-assigned
   tracking ref. The target needs no upstream repository credentials.

Machine Control may later discover a target, start or resume a VM, arbitrate a
claim, and establish a runner carrier. Those are valuable additions, but they
must build on a working managed-runner and workspace contract rather than be
prerequisites for proving it.

## Why This Is Not The Released SSH Executor

The released executor is a Claude SDK spawn hook:

```text
local Claude adapter
  -> system ssh process
  -> remote claude CLI in a path derived from the local cwd
  -> rsync remote Claude session files back to the controller
```

It has useful SSH configuration, validation, quoting, path-translation, and
shutdown behavior, but its central assumptions do not generalize:

- the provider adapter remains on the controller and relies on a
  provider-specific remote-spawn hook;
- the project already exists at a corresponding target path;
- provider-native transcript synchronization is Claude-specific;
- the session workspace is represented only by a local project plus an
  executor string; and
- project file and Source Control surfaces still resolve against the local
  checkout.

Managed remote execution instead gives the session an exact target workspace
coordinate and moves the complete provider adapter behind a provider-neutral
runner protocol. The old `executor` metadata and released server capability
must not acquire this new meaning retroactively. Existing executor-backed
sessions retain their historical resume path until a separate migration and
compatibility decision is approved.

## Product Shape And User Journey

The feature is YA-novel and explicitly default-off. With it disabled, YA does
not inspect SSH configuration, test hosts, transfer artifacts, create remote
repositories or worktrees, or add managed placement to New Session.

The first user journey is intentionally small:

1. In Settings, the user enables **Managed remote executors** and adds one SSH
   config alias. The existing system SSH configuration remains the source of
   hostname, account, key, jump-host, and transport policy.
2. New Session keeps **This server** selected by default. The user explicitly
   chooses the configured host under **Run on**.
3. YA tests non-interactive SSH, target platform, Git, runner runtime, target
   Codex, and supported controller subscription auth. Inspection makes no
   workspace or installation changes.
4. The launch review names the exact local `HEAD` commit. If the controller
   worktree is dirty, YA reports that staged, unstaged, and untracked content
   is excluded. The user continues from the committed base or cancels.
5. YA prepares a target-side repository anchor and a unique session worktree,
   injects or reuses the exact runner artifact by digest, and launches the
   Codex adapter in the verified remote cwd. The controller projects its
   file-backed ChatGPT subscription access token to the runner without sending
   the refresh credential.
6. The conversation behaves like an ordinary controller-owned YA session and
   carries a compact execution-target marker. It does not become a second YA
   source or account.
7. When the remote branch head changes, the controller fetches its Git objects
   into a namespaced local tracking ref without changing the local worktree or
   checked-out branch.
8. Project-level Source Control presents the fetched head as **Incoming work**
   with links to its originating host and YA session. A user or ordinary local
   agent reviews and integrates it using normal Git.

No ordinary local-session action silently changes execution target. Resume,
restart, fork, and handoff either preserve the managed workspace coordinate or
remain unavailable with a precise reason.

## Runtime Topology

```text
browser
  |
  v
controller Hono Supervisor / Process
  |
  | existing AgentSession surface
  v
system SSH client
  |
  | versioned framed protocol over stdio
  v
injected single-session runner
  +-- target-local provider AgentSession
  +-- exact managed Git worktree
  +-- bounded workspace and Git observations
```

The remote runner should reuse the provider-runtime worker's semantics and
provider modules, but not expose its private same-user Unix socket or token.
The shared provider-worker core needs transport adapters: the current local
socket adapter and a smaller framed stdio adapter for the injected runner.

The first release keeps the same direct Hono-owned topology on macOS and Linux.
A graceful Hono or development-wrapper reload cooperatively stops the provider,
runner, SSH child, and target lease. Opening or sending later starts a new
runner and explicitly resumes the recorded target-native thread in the same
workspace. An abrupt disconnect leaves ownership uncertain and cannot start a
second writer until recovery proves the old runner dead or fenced.

Active-turn survival through the Linux reload-safe provider host is an optional
later enhancement, not part of this baseline. If it is added, the retained
owner must include the complete provider adapter/RPC state, queue, approvals,
sequenced output, and SSH transport; retaining only a remote provider PID is
insufficient.

## Manual SSH Target Contract

The baseline target identifier is a configured SSH alias, not a raw browser-
supplied hostname or command. Only the YA server invokes the system SSH client.
The browser receives a sanitized display name and capabilities, never expanded
SSH options, identity-file paths, proxy commands, environment, or credentials.

Read-only inspection establishes at least:

- non-interactive SSH access to the configured account;
- target OS and architecture;
- compatible Git and runner-runtime availability;
- artifact transfer and execution support;
- a compatible Codex CLI plus controller-side file-backed ChatGPT subscription
  authentication that can produce a sanitized access-token projection; and
- a writable, containment-checked YA app-data/workspace root.

SSH is the target-account authentication and carrier for the first version.
The runner opens no inbound listener and accepts no unrelated session-create or
machine-administration request. A per-launch nonce or lease binds frames to the
intended session and prevents accidental cross-attachment, but it is not a
replacement for SSH account authentication.

Host-key verification, `BatchMode`, connection timeouts, literal remote-path
quoting, bounded stderr, cancellation, and child cleanup retain or strengthen
the current SSH executor's security behavior. YA never weakens the user's SSH
policy to make target setup easier.

The implemented diagnostic adapter uses a byte-clean non-PTY SSH child for
each bounded inspection or transfer and for the one owned runner lease. It
passes only `-T`, `BatchMode=yes`, and a bounded connection timeout before the
literal configured alias. It never supplies a host-key bypass or expands SSH
configuration for logs. The controller child environment is an allowlist of
system, locale, temporary-directory, and SSH-agent coordinates; provider keys,
OAuth values, YA settings, and unrelated controller state are absent even when
the SSH configuration names a broad `SendEnv` policy. Inspection is read-only.
Artifact mutation is refused until the observed Linux platform, target
architecture, Node version, managed root, and cache state match the selected
artifact.

Runner installation verifies the controller file first. A warm lookup verifies
the target file by size and SHA-256 without retransmission. A cold transfer is
bounded by the manifest size, stays in a private incoming directory, and is
atomically published only after target-side verification. Interrupted staging
is removed. The long-lived carrier distinguishes exit before the controller
observes launch acceptance from uncertainty afterward; only an observed
cooperative shutdown plus exit zero is clean. EOF, SIGHUP, SIGTERM, timeout,
and output-bound cleanup use bounded escalation and leave no ownerless timer.

## Runner Injection And Ownership

The runner is a versioned artifact produced from YA's existing provider
runtime, not a full YA server. It has no Hono API, UI, project catalog, Remote
Access password, relay account, public-share route, target registry, or peer
grant surface.

A likely launch sequence is:

1. Build or select the runner matching the controller's source/protocol
   generation and target platform.
2. Transfer it to a YA-owned target cache using SSH/SFTP-compatible machinery.
3. Verify its digest and protocol version before execution.
4. Launch it for one recorded session lease with stdin/stdout reserved for the
   framed protocol and stderr treated as bounded diagnostics.
5. Exchange capabilities before sending provider options or workspace handles.
6. Start exactly one target-local `AgentSession` after workspace verification.
7. Fence controller generations, sequence events, acknowledge only after
   controller consumption, and retain bounded replay for reattachment.
8. Stop the provider and runner on explicit termination or terminal cleanup;
   preserve result-bearing workspace state until its disposition is known.

Gate A selected a single Linux-targeted ESM bundle. It includes YA's Codex
adapter and JavaScript dependency closure; Node built-ins and the target Codex
executable are its only deliberate runtime externals. Its manifest binds
artifact, runner-protocol, and provider-session protocol versions to YA Git and
source identities, Linux OS/architecture, entrypoint, Node range, byte size,
and SHA-256 digest. The initial supported runtime prerequisite is Node.js 20.12
or newer. This is a target capability, not an implicit installation step: YA
must never run a package manager or modify shell startup files merely because
the user selected a host.

Before transfer, the controller verifies manifest size and digest. Target
installation occurs below a private temporary directory, verifies the same
bytes through Node, and atomically publishes a digest-named private cache
entry. A cache hit is trusted only after re-verification. The selected Gate A
artifact and installer probe work without a YA checkout, dependency tree,
pnpm, `tsx`, or target package-manager mutation. Bounded cache reclamation and
product integration remain later gates.

Runner cache retention is bounded by artifact digest and may be reclaimed when
unused. Session processes, output buffers, reconnect state, and target Git
checks must not retain an idle timer or polling loop after their owning lease,
provider work, and controller interest end.

## Codex-Only Provider And Subscription-Auth Boundary

The wire protocol is provider-neutral, but support is earned one provider at a
time. Changing a client-side provider-name set is not evidence that a provider
works remotely.

Codex is the sole baseline provider because its app-server exposes both a
stdio protocol and the external-token contract needed for low-friction
subscription auth. The remote runner owns YA's complete Codex adapter and
starts `codex app-server` in the managed target worktree; the controller does
not merely substitute an SSH child for one local `spawn()` call and leave the
rest of the adapter's filesystem assumptions local.

A provider is advertised on a particular target only after live coverage of:

- availability and authentication probing;
- new session, input, streaming, approval, interrupt, and clean termination;
- provider-native public/resume identity without replacing the YA session id;
- restart or reattachment behavior promised by that controller platform;
- transcript/checkpoint availability after the active stream is gone;
- target-local cwd and child environment;
- provider activity, liveness, and retention signals; and
- target/provider process cleanup with no duplicate writer.

The controller is the sole owner of the baseline ChatGPT subscription login.
One controller-local managed Codex auth owner serializes refreshes against the
normal file-backed credential store. YA reads the resulting `accessToken`,
`chatgptAccountId`, and `chatgptPlanType` projection and supplies it to the
target app-server through Codex's experimental `chatgptAuthTokens` login. The
refresh token, complete `auth.json`, API keys, provider environment, and
controller configuration never cross the runner boundary.

The target keeps the access-token projection only in the owned runner and
app-server memory. It does not receive it in process arguments or environment,
write it to target storage, or reuse it for another lease. A target account can
still use that bearer token until it expires, so the runner protocol, logs,
errors, diagnostics, and cleanup treat it as a secret.

When target Codex receives a `401`, its
`account/chatgptAuthTokens/refresh` request is relayed to the controller auth
owner. The controller serializes a managed refresh, validates that the account
id did not change, and returns only the replacement projection before Codex's
callback deadline. Timeout, account mismatch, controller auth loss, protocol
incompatibility, or broker failure terminates the turn visibly. None may fall
back to copying the refresh credential, target-local login, an API key, or
local execution.

The first release supports Codex's default file credential store only. A
configured OS keyring store, API-key login, missing ChatGPT login, or
incompatible Codex version produces a distinct read-only preflight failure.
Supporting another credential store or login mode requires its own explicit
contract and acceptance evidence.

Gate C implements this boundary in the runner protocol. The controller auth
owner verifies the exact Codex version and account projection before SSH
launch, serializes forced refreshes, enforces account continuity and a callback
deadline, and never returns the refresh credential. The target Codex adapter
requires experimental external-auth capability, strips provider API keys and
base URLs from its child environment, uses a workspace-owned private
`CODEX_HOME`, and writes no `auth.json`. An auth, protocol, or callback failure
is terminal for that managed launch or turn and never selects another auth or
execution path.

Gate C also implements one internal `RemoteAgentSession` proxy over the
version-2 runner protocol. It projects queue depth/yield, normalized sequenced
events and acknowledgement, approvals, interrupts, provider RPCs, liveness,
activity, retention, identity binding, and cooperative shutdown onto the
existing `AgentSession` surface. `Process` retains an internal discriminated
execution coordinate; managed placement never populates or changes the meaning
of the released legacy `executor` string. The fixed diagnostic provider is
absent from provider discovery and HTTP routes and rejects controller paths,
environment, and sandbox configuration.

Exactly one active runner may own a managed workspace. The target atomically
creates a workspace-local lease before provider start; a conflict fails before
launch acceptance and cannot start a second Codex writer. Orderly shutdown
removes the lease. A channel failure after acceptance remains uncertain and
does not authorize a competing resume.

Claude is not part of this baseline. The released Claude SSH executor remains
intact, and a future managed-runner Claude adapter requires a separate plan and
provider-specific subscription-auth, resume, transcript, and cleanup proof.
Other providers likewise earn support rather than inheriting it from Codex.

## Managed Git Workspace

The remote cwd is created from source identity, not guessed from path
symmetry. The controller project supplies a repository and exact commit; the
target supplies a YA-owned workspace root.

A simple Git-over-SSH shape is:

```text
controller repository at exact HEAD
  -- controller-initiated Git push --> target YA repository anchor
                                          |
                                          +-- session branch
                                          +-- session worktree

target agent commits on session branch
  -- controller-initiated Git fetch --> refs/remotes/ya/<target>/<session>
```

The controller invokes both transfer directions using the SSH access it
already possesses. The target never pushes to GitHub/GitLab, needs no upstream
SSH key or repository token, and receives no forwarded controller credential.

The implemented Gate B service proves this shape only with disposable
repositories. It records the exact source `HEAD` and dirty counts, creates a
UUID-named private target anchor/branch/worktree plus identity and writer-lease
markers, and verifies target identity, branch, cwd, and `HEAD` before returning.
The source push and result fetch use ordinary Git-over-SSH with the same
non-interactive SSH policy as the runner carrier. The fetch destination must be
a service-created bare repository carrying the Gate B fixture marker, so this
foundation cannot write a user project's objects or refs.

Cleanup rechecks target head and dirty counts. It retains dirty,
committed-but-unfetched, or concurrently advanced state; otherwise it deletes
only the marker-verified UUID workspace after a verified fetch. Explicit
discard is the only override. Observations happen only when called—there is no
workspace poller or ref watcher.

Every workspace record binds at least:

- controller project identity;
- sanitized target identity;
- canonical YA session id;
- opaque target repository/worktree handles and diagnostic display path;
- exact base commit and target session ref;
- current announced and fetched heads;
- target dirty state and synchronization state; and
- cleanup/retention disposition.

The target branch and worktree are unique per session. Setup verifies effective
cwd, `HEAD`, ref ownership, containment, and absence of a conflicting writer
before the provider starts. Cleanup addresses exact recorded identities, never
globs or inferred path prefixes.

### Committed state only

The baseline transfers committed Git state. A dirty controller tree does not
block launch, but its contents are not included. YA does not create a temporary
commit, stash, patch, archive, or overlay, and does not modify submitted prompt
text to tell the provider to commit.

The runner observes `HEAD` at existing provider-activity and turn boundaries
and emits a notice only when it changes. It does not poll an idle worktree. The
controller then performs an idempotent fetch and advances only its assigned
tracking ref. Amend and rebase may move that ref non-fast-forward after explicit
verification; neither operation changes a checked-out local branch.

If the provider stops with uncommitted target changes, YA reports the dirty
state and retains the workspace according to a visible recovery policy. It
must not call a fetched commit a complete result or delete the only remaining
copy. Dirty-result artifact capture is later work with explicit semantics for
untracked and ignored files, modes, symlinks, submodules, LFS, and size limits.

### Controller Git effects

Importing Git objects and advancing `refs/remotes/ya/...` are YA-managed writes
inside the controller repository's Git metadata. Before implementation, the
exact authorization, namespace, retention, non-fast-forward behavior, removal,
and App-data-only fallback must be added to
[project directory storage](project-directory-storage.md).

The baseline never merges, rebases, cherry-picks, advances the checked-out
branch, edits the working tree, pushes upstream, or overloads the existing
**Pull** action. Those remain explicit user or local-agent operations.

## Transcript, Resume, And Session Identity

The canonical visible id is always the controller's YA session id. The target
may retain a Codex thread id or another provider-native resume handle, but it
never substitutes that value in YA URLs, metadata, or client contracts.

For the accepted Codex diagnostic, the provider thread and rollout remain in a
private workspace-owned target `CODEX_HOME`. An orderly new runner resumes that
thread only in the same recorded target workspace. A missing target rollout
therefore produces the target app-server's resume failure; it does not create a
replacement local thread.

While active, the runner owns provider-native persistence and sends normalized
events through the controller's ordinary `Process`. At completed-turn,
explicit-refresh, and graceful-shutdown boundaries, the controller copies the
target rollout incrementally into a YA-owned app-data mirror. It asks for the
latest complete JSONL byte watermark and transfers only bytes after the last
recorded local offset. An unchanged target produces no transcript payload and
an idle session creates no poller or watcher.

The mirror is provider-native Codex JSONL, not a normalized YA shadow
transcript. It lives below the YA data directory in an isolated root outside
the user's ordinary `~/.codex/sessions` tree. Codex Desktop, the Codex CLI, and
YA's ordinary provider scanner therefore cannot discover or resume it as a
local session with remote absolute paths. YA reuses `CodexSessionReader` only
after managed metadata resolves the one isolated root to open.

A durable managed-session registry supplies discovery and routing. Each record
binds at least:

- canonical YA session id and provider-native thread id;
- controller project, target, workspace, and target rollout identity;
- exact isolated mirror root and rollout generation;
- transferred byte offset, remote complete-line watermark, and target file
  size;
- last synchronization/activity time and `current`, `behind`, `unavailable`,
  or `error` state; and
- runner generation and ownership/recovery facts needed for safe resume.

The registry, not a recursive mirror-root scan, contributes managed sessions to
discovery. Opening one record may narrowly scan only its referenced isolated
Codex root to locate the recorded provider thread. A later direct-file reader
seam may remove even that bounded scan; it is not required for correctness.
Registry-without-mirror remains discoverable with history unavailable or
behind. Mirror-without-registry is an orphan cache candidate and never creates
a session row.

Transfer is one-way and bounded. Each chunk is integrity-checked before durable
append, synchronizations are serialized per canonical session, and per-chunk,
per-pass, and total-mirror limits fail visibly. Bytes after the latest complete
target line are not copied. A local partial line caused by the transfer budget
is retained and ignored by the existing reader until a later pass completes it.
A target rollout path or file-identity change starts a new isolated mirror
generation rather than appending incompatible bytes.

The target remains authoritative for resume. The mirror is never copied back,
never supplied to local `thread/resume`, and never considered fresher than its
recorded watermark. Resume returns to the same target workspace unless a
separately implemented portable provider bundle proves migration safe. Active
streaming still follows the existing stream-versus-durable parity contract;
cold history comes from the latest verified mirror prefix.

## Location-Correct Project Surfaces

A managed session carries an explicit workspace coordinate rather than only a
local `projectId` and host string. Every session-entered project action either
uses that coordinate or is unavailable:

- transcript file and source links;
- file content, raw bytes, and media;
- Git status, history, diff, blame, and changed files;
- source review and revision browsing;
- fork, restart, resume, and handoff; and
- any YA-owned shell or filesystem operation.

No operation may strip a remote path to a relative suffix and read the local
project. A disconnected runner produces a remote-workspace failure or uses an
explicitly captured immutable result.

The first useful slice may intentionally expose conversation plus fetched
commits and only a bounded runner-backed file read. Unsupported remote
workspace controls remain absent or visibly unavailable. This is preferable
to displaying controller-local data that appears to describe the remote
session.

Ordinary project-level Source Control remains local. Fetched managed heads
appear in an **Incoming work** section because their objects are now local;
that section does not claim to show the remote worktree's live status. Each
head retains target, session, base/head, dirty, sync, and availability metadata
with actions to view the committed head, copy its ref, and open its session.

## Security And Trust Boundary

A managed SSH executor runs with the authority of the selected remote SSH
account. It is not a hostile multi-user sandbox and does not make a shared
session safe merely because the worktree was created by YA.

The controller must assume the target account can read prompts, provider
output, source transferred to its workspace, the projected Codex access token
until it expires, and other resources accessible to that account. Conversely,
a compromised target runner must not receive the subscription refresh token,
complete controller credential store, general controller shell, controller SSH
agent, upstream repository credential, provider-host token, YA password, relay
secret, or browser session.

Project-write restrictions must be installed and enforced on the target;
confining the controller's local SSH process does not confine remote code. A
future collaboration-safe VM additionally requires explicit outside-read,
network, IPC, mount, device, credential, and cleanup guarantees. Machine
Control lifecycle or a VM label alone is not such an attestation.

## Failure And Cleanup Contract

Failures distinguish at least:

- SSH configuration/authentication failure;
- unreachable or host-key failure;
- unsupported target platform or missing prerequisite;
- incompatible or unverifiable runner artifact;
- Codex unavailable or protocol-incompatible;
- missing or unsupported controller ChatGPT credential store;
- subscription projection, refresh, timeout, or account-continuity failure;
- repository transfer or workspace verification failure;
- runner started but attachment uncertain;
- SSH disconnect with target process state uncertain;
- transcript/checkpoint or managed-head synchronization failure; and
- provider, runner, or workspace cleanup uncertainty.

A failed managed launch never falls back to local execution. An SSH disconnect
must not permit a second provider writer until the prior runner is confirmed
dead or fenced. A new connection may resume from retained target provider state
only through the recorded session/workspace identity.

Committed but unfetched work and dirty-only work block automatic workspace
deletion. Cleanup reports provider, runner, target worktree, target repository
anchor, local tracking ref, and any uncertainty separately. Removing a host
from Settings prevents new selection but neither revokes SSH access nor erases
retained result state.

## Relationship To Machine Control

Machine Control is a later managed-executor provider, not part of the manual
SSH baseline. It may add:

- structured inventory and sanitized target capabilities;
- target readiness and repair diagnostics;
- VM start/resume/snapshot/restore lifecycle;
- target-use claims and arbitration;
- transport/bootstrap adapters where direct SSH is insufficient; and
- verified restoration of target power and disposable workspace state.

It should produce the same conceptual inputs—execution target, runner carrier,
workspace root/capabilities, and cleanup lease—so New Session and the session
UI retain the same **Run on** model. It must not redefine provider session,
workspace, Git-head, or controller ownership semantics.

The Machine Control implementation in
[`docs/tactical/118-managed-runner-mvp.md`](../docs/tactical/118-managed-runner-mvp.md)
is therefore deferred until this topic's manual-SSH runner, Codex session, and
managed Git round trip have been proven. Its target discovery, claims, and VM
lifecycle then become an extension of a working execution substrate rather
than simultaneous prerequisites.

## Compatibility And Rollout

This topic approves no route, request field, capability id, protocol version,
setting key, or migration of released executor sessions. Before client/server
implementation, inspect the required stable-release corpus and obtain approval
for:

- a new optional managed-remote-executor capability;
- feature enablement and sanitized manual-target inventory;
- the session-create target/workspace request and missing-capability fallback;
- runner artifact and framed protocol versions;
- session workspace identity on every affected project operation;
- managed-head metadata and Git-write authorization; and
- behavior when an older client opens a managed remote session.

A client connected to a server without the new capability hides managed
placement and sends no new fields. Existing local and legacy SSH-executor
sessions continue unchanged. The managed feature remains default-off on fresh
and upgraded installations.

## Baseline Completion Contract

The manual-SSH baseline is proven only when all of these are externally
testable:

- With the feature disabled, YA does no managed SSH inspection, runner
  transfer, remote workspace mutation, or background work.
- A launch explicitly selects a configured SSH target and exact committed base;
  local dirty state is disclosed and excluded.
- YA creates and verifies a unique target worktree without requiring a
  pre-existing corresponding checkout or path mapping.
- Managed placement advertises Codex only; Claude and other providers remain
  unavailable through this runner contract.
- A real Codex session runs through the injected provider-neutral runner while
  retaining the controller's YA session identity.
- A file-backed controller ChatGPT subscription can start the target Codex
  app-server without target login; a forced `401` rotates credentials only on
  the controller, retries once with a fresh access-token projection, and leaves
  no target credential file.
- On macOS and Linux controllers, a graceful Hono or wrapper reload terminates
  the active managed runner cooperatively. A later explicit resume uses the
  recorded target workspace and provider-native thread without a second writer.
- A stopped managed session is discoverable from durable YA metadata and
  viewable from a bounded, incrementally synchronized Codex rollout mirror that
  is invisible to the ordinary Codex scanner and native Codex applications.
- The remote account receives no upstream repository or forwarded SSH
  credential, subscription refresh token, complete Codex credential store, or
  API key from YA. Its per-lease access-token projection is kept in memory and
  discarded during teardown.
- A remote commit is fetched into only the assigned local tracking ref without
  changing the local working tree, branch, upstream configuration, or remote.
- Source Control presents the fetched head as incoming work associated with
  its target and originating session.
- Remote dirty state, disconnect, sync failure, and cleanup uncertainty remain
  visible and never masquerade as a complete result.
- Session-entered project actions use the exact remote workspace or report
  unavailability; none display controller-local bytes as remote state.
- Idle sessions and disconnected clients leave no unbounded polling, watcher,
  retry, heartbeat, process, or replay-buffer work.

## Recommended Proof Order

This is ordering guidance, not a tactical authorization to implement the whole
surface at once:

1. Extract a transport-neutral provider-worker core and prove a bounded stdio
   runner with a fake provider over localhost SSH.
2. Prove exact-commit push, isolated remote worktree creation, remote commit,
   and controller fetch using Git over SSH, with no upstream credentials.
3. Run and resume one real Codex session in that worktree and prove provider
   identity, transcript/checkpoint, approvals, interrupt, and cleanup.
4. Incrementally mirror the target Codex rollout into isolated YA app data,
   reconstruct metadata as after a controller restart, cold-load it through the
   existing reader, and resume only against the target-native rollout.
5. Add the guarded New Session placement and project-level incoming-head UI
   after compatibility and project-Git-write approval.
6. Expand location-correct file/Git surfaces and additional target platforms
   or providers only after each earns its own acceptance evidence.

## Deferred Decisions

- Standalone runner binaries versus a documented target-side Node runtime.
- Linux-target-only first support versus an early Windows OpenSSH adapter.
- Per-session runner injection versus bounded digest-cached artifacts with one
  runner process per active session.
- Transcript-mirror retention and cleanup controls beyond the bounded Codex
  baseline, and provider-specific mirrors for later providers.
- Active-turn survival through the Linux reload-safe provider host.
- Dirty controller snapshot seeding and dirty target result capture.
- Existing target checkout adoption as an optimization over managed workspaces.
- Safe fast-forward of a chosen local branch or one-click local integration
  agent sessions.
- Project Queue/workstream placement on remote execution lanes.
- Full live remote Source Control, file, media, and source-review parity.
- Target-side private dependency credential brokering.
- Machine Control discovery, claims, VM lifecycle, and non-SSH carriers.
- Restricted collaborator principals and isolated session write grants.
