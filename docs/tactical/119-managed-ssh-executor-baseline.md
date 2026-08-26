# Managed SSH Executor Baseline

Topic: managed-remote-executors

Status: Gate A completed and accepted on 2026-08-26. The injectable runner
artifact, shared provider-session owner, released-protocol Unix-socket adapter,
and framed-stdio fake-provider adapter are implemented. No SSH carrier, managed
workspace, production Codex target session, route, capability, setting, session
metadata, or UI described here is implemented or compatibility-approved.

This tactical deliberately has stop/go gates. A normal implementation request
should complete and record one gate at a time rather than treating the whole
document as one unattended change. Later steps consume the evidence and code
landed by earlier gates; they do not maintain parallel experimental and product
stacks.

## Objective

Deliver the least-common-denominator managed remote executor that is useful to
the maintainer:

- a macOS or Linux YA controller explicitly selects a configured SSH alias;
- YA transfers a version-matched subordinate runner to a Linux target without
  requiring a YA checkout, pnpm, `tsx`, or a second YA server there;
- the controller creates an isolated remote Git worktree at one exact committed
  base without requiring a matching target checkout or path;
- a real Codex session runs in that worktree through YA's provider-neutral
  `AgentSession` contract;
- Codex is the only managed-runner provider advertised by this baseline;
- the controller's file-backed ChatGPT subscription supplies a per-lease
  access-token projection without sending its refresh credential, and the
  target needs no provider login or upstream Git credential;
- agent-created commits are fetched into one namespaced controller tracking ref
  without changing the controller worktree or branch; and
- Linux controllers additionally retain the SSH-backed session across Hono
  replacement through the existing reload-safe provider host.

The user-visible feature remains experimental, explicit, and default-off.
Machine Control inventory, claims, readiness, and VM lifecycle remain deferred
to [tactical 118](118-managed-runner-mvp.md) until this baseline works.

## Owning Contracts And Existing Constraints

- [`topics/managed-remote-executors.md`](../../topics/managed-remote-executors.md)
  owns the manual-SSH product shape, injected-runner boundary, exact committed
  workspace, Codex-first proof, source return, trust model, and observable
  completion contract.
- [`topics/reload-safe-provider-runtimes.md`](../../topics/reload-safe-provider-runtimes.md)
  and [`topics/provider-host-api.md`](../../topics/provider-host-api.md) own the
  implemented Linux host/worker lifecycle, generation fencing, sequenced
  replay, Hono acknowledgement, and cleanup semantics.
- [`docs/project/remote-executors.md`](../project/remote-executors.md) owns the
  released Claude-family SSH/rsync executor. Its `executor` field, path mapping,
  capability, session synchronization, and resume semantics are not widened by
  this plan.
- [`gaps/provider-neutral-remote-executors.md`](../../gaps/provider-neutral-remote-executors.md)
  records why provider support requires real adapter coverage rather than a
  client-maintained provider-name set.
- [`gaps/remote-session-project-views-use-local-files.md`](../../gaps/remote-session-project-views-use-local-files.md)
  and [`gaps/session-worktree-file-links.md`](../../gaps/session-worktree-file-links.md)
  require every session-entered project action to retain an exact workspace
  coordinate and prohibit plausible local-path fallback.
- [`topics/project-directory-storage.md`](../../topics/project-directory-storage.md)
  governs controller-side Git objects and refs written by YA. A production
  incoming-head writer requires an explicit authorization amendment before it
  lands.
- [`topics/architecture-mandates.md`](../../topics/architecture-mandates.md)
  requires bounded ownership and teardown for every retry, reconnect,
  heartbeat, watcher, session, and output buffer.
- [`topics/vanilla-defaults.md`](../../topics/vanilla-defaults.md) requires the
  product surface and behavior to remain configurable and default-off.

No existing `docs/tasks/` entry plans this implementation. The three gaps
above constrain the work; they are not independent authorization to broaden
the feature.

## Current Code Findings

The implementation should build from current seams rather than copying them:

- `provider-runtime-host.ts` rejects every non-Linux controller before reading
  host state. Porting that host is not a prerequisite for remote execution.
- `provider-runtime-worker.ts` already owns a complete provider-neutral
  `AgentSession`, including queue, approvals, controls, activity, retention,
  event sequencing, acknowledgement, replay bounds, and cleanup.
- That worker currently reads one JSON launch request until stdin EOF, then
  opens a private Unix socket. A remote runner needs a long-lived framed stdin
  and stdout adapter instead of this launch-then-socket assumption.
- `provider-runtime-host.mjs` starts the worker through the current Node binary,
  `tsx`, and a TypeScript path inside the controller checkout. A clean target
  cannot run that command. Artifact construction and dependency closure are the
  first real feasibility unknown.
- `remote-spawn.ts` supplies useful SSH alias validation, `BatchMode`, timeout,
  quoting, stderr, and cancellation precedent, but its process rewrite and
  PTY behavior are deliberately Claude-specific.
- Codex's adapter owns the complete `codex app-server` JSON-RPC session around
  a local child. Moving only that child behind SSH would leave provider
  filesystem, transcript, liveness, environment, and cleanup assumptions split
  across machines. The remote runner therefore owns the entire Codex adapter.

## Locked Baseline Decisions

The tactical may refine mechanics but should not reopen these product choices
without updating the owning topic:

1. Manual SSH is the first target provider; Machine Control is a later adapter.
2. The runner owns one complete provider `AgentSession`, not only a provider
   CLI PID or one provider-specific spawn hook.
3. Codex is the first production provider proof. Fake-provider coverage keeps
   transport and workspace code provider-neutral.
4. The source base is one exact Git commit. Dirty controller state is disclosed
   and excluded, never silently serialized.
5. The controller pushes the base and fetches target commits through its own
   SSH access. The target receives no upstream repository credential.
6. Managed sessions use a new execution-target/workspace identity. The released
   `executor?: string` contract retains its old meaning.
7. A failed managed launch never falls back to local execution.
8. The feature is default-off and performs no target inspection or background
   work while disabled.
9. The first managed-runner release advertises Codex only and uses the
   controller-owned file-backed ChatGPT subscription projection defined in the
   owning topic. Claude and other providers require separate acceptance.

## Platform Matrix

Controller and target support are separate coordinates:

| Coordinate | Baseline claim | Initial behavior |
| --- | --- | --- |
| macOS controller | supported | Hono owns the remote `AgentSession`; Hono restart may interrupt it |
| Linux controller | supported | same baseline plus existing provider-host reload survival |
| Windows controller | not yet supported | feature gate remains unavailable; portable pure-unit coverage still runs |
| Linux SSH target | supported | first real runner, Git, cleanup, and Codex acceptance target |
| macOS SSH target | follow-up | use the POSIX adapter only after a native smoke proves process and path behavior |
| Windows SSH target | follow-up | separate OpenSSH/PowerShell bootstrap and process-ownership adapter |

Do not hide POSIX commands behind a nominally portable target interface and
then advertise every platform. Target inspection returns an explicit platform
and adapter capability. Unsupported combinations fail before artifact transfer
or workspace mutation.

## Intended Runtime Shape

Without the Linux provider host:

```text
Hono Process
  -> RemoteAgentSession proxy
  -> system SSH child
  -> injected stdio runner
  -> target-local Codex AgentSession
  -> codex app-server in managed worktree
```

With the Linux provider host:

```text
Hono Process
  -> HostedAgentSession
  -> existing local provider-runtime worker
  -> RemoteAgentSession proxy
  -> system SSH child
  -> injected stdio runner
  -> target-local Codex AgentSession
```

The existing local worker remains the replay and Hono-generation owner. The
first remote runner protocol does not need a second transparent reattachment
system while its SSH channel remains owned by that worker. If SSH itself
disconnects, the baseline ends the live attachment, records uncertainty, and
allows a later explicit resume through the same target workspace only after the
old runner is dead or fenced. This avoids two competing replay ledgers in the
first version.

On macOS the Hono process owns the same `RemoteAgentSession` directly. This
makes managed execution useful there without porting Linux process discovery,
`/proc` identity, process-group recovery, and wrapper ownership. Porting Safe
Reload to macOS is a separate project justified by broader demand, not a hidden
requirement of managed SSH.

## Gate A — Prove The Injectable Runtime

Gate A changes no route, setting, session metadata, project Git state, or UI.
It ends with a local/localhost-SSH fake-provider runner and an explicit artifact
decision.

### 1 — package a clean-target runner artifact

Inventory the actual transitive module and runtime requirements for a
Codex-capable worker. Compare only practical artifact shapes:

- compiled JavaScript plus a pruned production dependency tree;
- one or more bundles with deliberate externals for provider packages and
  native/optional modules; or
- a small platform-neutral archive assembled from the existing npm bundle
  machinery.

Do not require a YA checkout, pnpm install, `tsx`, TypeScript sources, or a
target-side package-manager mutation. Avoid adding a runtime dependency merely
to make the spike convenient. A target-side Node runtime may be a documented
initial prerequisite; record the exact supported version range.

Produce a manifest containing artifact format version, runner protocol version,
YA source/build identity, target OS/architecture, entrypoint, Node requirement,
byte size, and SHA-256 digest. The controller verifies local bytes before
transfer; target installation uses a private temporary path, verifies the
digest through the declared target runtime, then atomically publishes a
content-addressed cache entry.

Exercise the artifact in a clean Linux fixture that has no repository checkout
and no YA dependencies. The initial proof may use a fake provider only. Record
artifact size, cold transfer time, cold start time, warm cached start time, and
every target prerequisite.

**Gate condition:** select one artifact form that starts reliably on the clean
fixture and has a credible production dependency/update story. If no form does,
stop and update the topic before extracting more worker code.

### 2 — extract the provider-session core and stdio adapter

Refactor the current provider worker into:

- a transport-independent session owner that starts one provider
  `AgentSession`, observes its queue and callbacks, controls it, and emits
  normalized state/events; and
- adapters for the released private Unix-socket worker protocol and the new
  remote framed-stdio protocol.

The local Unix-socket adapter must retain its existing protocol and observable
behavior. Do not combine this extraction with a provider behavior change or a
wholesale import/export reorder.

The remote adapter treats stdin as a persistent control stream and stdout as a
protocol-only event stream. Logs and diagnostics go to bounded stderr. Frames
are versioned, newline-delimited JSON initially unless measurement proves that
binary framing is required, and reject oversized input before allocation.

The minimum fake-provider protocol covers:

- hello/version/capability negotiation and one launch lease;
- launch accepted or structured pre-start failure;
- queue push/remove/depth/yield;
- sequenced normalized events and acknowledgement;
- approval request/result/cancel;
- interrupt, liveness, activity, retention, and supported controls;
- completion/failure and cooperative shutdown; and
- explicit stdin EOF/controller-loss handling.

Use dependency-injected streams and a deterministic fake provider to cover
partial frames, malformed JSON, unknown versions, stale lease ids, duplicate
controls, backpressure, output bounds, controller EOF, provider failure, and
cleanup without opening SSH.

**Gate condition:** the same session-owning core passes both the existing local
worker contract and the stdio fake-runner contract. There is no copied remote
provider state machine.

### Gate A result — accept the single-bundle injectable runtime

Gate A passed on 2026-08-26 and selected one Linux-targeted ESM bundle. The
artifact includes YA's Codex adapter and its JavaScript dependencies while
leaving only Node built-ins and the target Codex executable external. The
builder uses 209 bundled inputs and emits a versioned manifest with YA Git and
source identities, target OS and architecture, entrypoint, Node range, byte
size, and SHA-256 digest. The supported runtime prerequisite is Node.js 20.12
or newer; a Codex session will additionally require the compatible target
Codex executable. Gate A added no target-side installation policy.

The final x86_64 proof artifact was 1,226,530 bytes
(`dc848e12ff34278f53d9838f2f8f7e15cb527186201ed9fd48d24da3d3502216`).
The controller verified those bytes before transfer. The target probe copied
them through a mode-0700 private staging directory, reverified size and digest
with Node, and atomically published the bundle into a digest-named mode-0700
cache directory; the staged artifact was mode 0600 and the cached executable
was mode 0700. A second installation was a verified cache hit.

The clean Ubuntu x86_64 VM had no Node executable, YA checkout, YA dependency
tree, pnpm, or `tsx`. The proof unpacked official Node.js 25.2.0 into the test's
private temporary directory without invoking a target package manager. The
1,226,530-byte runner transfer took 0.94 seconds through the available VM file
carrier. Target measurements were:

| Measurement | Cold | Warm cache hit |
| --- | ---: | ---: |
| Verify and install | 4.55 ms | 2.00 ms |
| Process start through `helloAck` | 115.49 ms | 115.22 ms |
| Process start through launch acceptance | 116.91 ms | 117.08 ms |
| Process start through first fake-provider turn | 118.93 ms | 118.31 ms |
| Full protocol probe and clean shutdown | 129.21 ms | 126.81 ms |

The same deterministic fake session owner passed the version-1 private Unix
socket attach path and the version-1 framed stdio path. Coverage includes
queue depth and yield, event sequencing and acknowledgement, replay after
reattach, approvals, liveness, retention, interrupt, partial and malformed
input, version and lease rejection, duplicate control suppression, bounded
input/output/backpressure, launch and provider failure, controller EOF,
cooperative shutdown, and cleanup. The VM proof exercised 27 protocol frames
per cold and warm run, then removed the runner, cache, probe, and temporary Node
runtime and released its Machine Control claim.

Gate A therefore selects the single-bundle form and authorizes proceeding to
Gate B. The measured VM carrier was used only as a clean Linux fixture; it does
not implement or substitute for Gate B's manual-SSH target adapter.

## Gate B — Prove SSH And Source Transfer

Gate B remains a server-side diagnostic/harness path. It does not advertise a
capability or expose managed placement in the browser.

### 3 — inject and supervise the runner through SSH

Add a manual-SSH target adapter around configured, server-owned SSH aliases.
Reuse the current alias validation and safe command/path quoting where their
contracts apply, but do not route through the Claude `createRemoteSpawn`
function.

The framed runner uses a byte-clean non-PTY SSH channel (`-T` or equivalent),
not the released Claude executor's PTY. The remote bootstrap must `exec` the
runner so the SSH channel observes the actual owner. Runner stdin EOF,
SIGTERM/SIGHUP, and explicit shutdown all request target-local provider
termination with bounded escalation and verified exit.

Use separate bounded SSH operations for inspection and artifact transfer. A
transfer writes a private temporary file, verifies its expected digest, and
atomically promotes it into the runner cache. It must tolerate interruption
without treating a partial file as installed. Host keys, jump hosts, identity
selection, and other SSH policy remain owned by the user's SSH configuration;
YA keeps `BatchMode=yes` and never supplies a host-key bypass.

Inspection is read-only and returns sanitized facts for controller logs/tests:
target platform/architecture, Node, Git, artifact-cache readiness, and provider
availability. It never installs Node, Git, Codex, shell configuration, or
credentials.

Distinguish failure before launch acceptance from uncertain failure after the
remote runner or provider may have started. A disconnect cannot authorize a
second writer until exact cleanup or fencing is proven. No reconnect, retry,
heartbeat, or cache-maintenance loop remains active without an owning launch or
explicit inspection.

### 4 — round-trip an exact Git workspace over SSH

Build a standalone managed-workspace service and exercise it against disposable
repositories before connecting it to a provider. A controller-generated opaque
`workspaceId` survives YA session-id remap and names target resources; the
canonical YA session id is associated later and remains the user-facing id.

For one clean local repository:

1. Resolve and hold one full base commit id plus staged, unstaged, and untracked
   counts for disclosure.
2. Create or validate a private target repository anchor below the managed
   target workspace root.
3. Use controller-initiated Git over SSH to send the exact base and create a
   unique target session ref/worktree.
4. Verify target repository identity, ref ownership, effective cwd, `HEAD`, and
   absence of another writer.
5. Make one and several commits in the fixture worktree, including an amend.
6. Fetch the announced head into a disposable controller ref, verify object
   connectivity and expected ancestry/rewrite relation, and leave the
   controller worktree and checked-out branch byte-for-byte unchanged.
7. Retain dirty-only or committed-but-unfetched target state; delete only exact
   recorded clean resources after verified fetch or explicit discard.

The spike uses disposable repositories and may write their refs. It does not
write managed refs in a user project until the project-directory-storage
contract and product authorization land. Do not tunnel Git object bytes through
the runner protocol when ordinary Git-over-SSH already supplies the bounded,
verified object exchange needed by the baseline.

Head observation occurs on explicit refresh and existing provider turn/activity
boundaries. It does not create a per-workspace poller or native ref watcher.

**Gate condition:** a macOS and a Linux controller fixture can independently
prepare, commit, amend, fetch, and clean up a Linux target workspace without
target upstream credentials, local branch movement, or leaked processes. An
unavailable OS testbed is recorded rather than inferred from another host.

## Codex Subscription Authentication Feasibility Spike

Evidence recorded 2026-08-26 against the pinned Codex CLI `0.149.0` changed
the credential assumption that Gate C tests. The maintainer approved the
controller-owned subscription projection on 2026-08-26, and the owning topic
now carries it as the Codex-only baseline contract.

Codex app-server has an experimental `chatgptAuthTokens` login intended for a
host application that owns the ChatGPT authentication lifecycle. The client
supplies an access token and account projection. After a `401`, app-server
sends `account/chatgptAuthTokens/refresh`, waits about ten seconds for a fresh
projection, and retries the failed request. It does not need or accept the
subscription refresh token in that mode. See the
[official app-server authentication contract](https://learn.chatgpt.com/docs/app-server#auth-endpoints).

[`scripts/probe-codex-external-auth.mjs`](../../scripts/probe-codex-external-auth.mjs)
exercised that contract with two isolated roles:

- a controller-local, managed-auth Codex app-server remained the sole owner of
  the normal subscription login and performed a forced OAuth refresh through
  `account/read { refreshToken: true }`;
- an isolated app-server used only `accessToken`, `chatgptAccountId`, and
  `chatgptPlanType`; its initial token signature was deliberately made invalid
  so a real low-cost turn had to enter the refresh callback and retry; and
- after the controller rotated the access token, the isolated turn completed,
  exactly one refresh request had occurred, the refresh token had never been
  sent to the isolated process, and its private `CODEX_HOME` contained no
  `auth.json`.

The access-only half also ran on the disposable Linux VM through Machine
Control. The clean target temporarily downloaded exact Node and Codex runtime
artifacts, initialized app-server, read live subscription rate limits, entered
the forced-`401` refresh callback, completed the retried turn, and was cleaned
back to its ready state. The access projection was a mode-`0600` temporary
test carrier and was deleted; a product runner should carry this projection in
its authenticated protocol and memory, not an environment variable or durable
target file. A first attempt to transfer the hundreds of megabytes of runtime
artifacts through the guest-agent carrier temporarily stalled machine control;
target-side download worked for the spike, but neither path is a Gate A
artifact decision.

This proof avoids the refresh-token conflict that copying `auth.json` to every
target would create: only the controller rotates the refresh credential, while
each active target receives a replaceable bearer token. The bearer token still
grants subscription access until it expires and must be redacted, scoped to the
owned runner connection, kept out of process arguments and environment, and
dropped on teardown.

The baseline Codex-specific broker is therefore:

1. keep one controller-local managed Codex auth owner per credential store and
   serialize forced refreshes there;
2. validate account continuity, read only the resulting access-token
   projection, and send it to the selected runner during external-token login;
3. answer each app-server refresh request with a newly resolved projection or
   fail the remote turn visibly before Codex's callback timeout; and
4. never fall back to copying the refresh credential or silently starting a
   target-local login.

The public app-server API does not return the managed access token after
refresh. The tested broker projects it from Codex's default file credential
store. A user-selected OS keyring store is not externally readable through
this API and receives a distinct preflight failure in the first release; there
is no target-login or API-key fallback. The experimental protocol also gets an
exact Codex-version/capability gate.

This contract replaces the earlier target-owned-Codex-login wording in the
objective, Gate C, completion contract, and
`topics/managed-remote-executors.md`. Claude is outside this tactical and
requires its own provider-specific subscription-auth proof before a future
managed-runner plan may advertise it.

## Gate C — Make Codex Usable Without Product UI

Gate C proves the actual provider and ownership model through a guarded
server-side diagnostic path. It still makes no new client depend on an
unreleased server contract.

### 5 — run Codex inside the managed workspace

Add the Codex target launch and auth projections. Do not send controller-local
provider paths, refresh credentials, complete auth storage, API keys,
environment, settings paths, or installation coordinator state to the runner.
The target runner discovers its own Codex CLI and reports a sanitized
availability/version result. The controller auth owner resolves only
`accessToken`, `chatgptAccountId`, and `chatgptPlanType`; the runner supplies
them through `chatgptAuthTokens` and keeps them only in app-server/runner
memory for the owned lease.

Serialize refreshes through one controller-local managed Codex auth owner. On
`account/chatgptAuthTokens/refresh`, validate account continuity and return a
fresh projection before Codex's callback timeout. A missing file-backed
ChatGPT login, configured keyring store, incompatible external-token protocol,
refresh failure, timeout, or account mismatch is a distinct preflight or turn
failure. Do not fall back to target-local login, API-key auth, copied
`auth.json`, copied refresh tokens, or local execution.

Start YA's complete Codex adapter on the runner in the verified managed cwd.
Prove with a real low-cost session:

- app-server initialization and one user turn;
- target-local cwd and tool execution;
- normalized streaming and terminal result;
- approval request/result and interrupt;
- effort/model behavior supported by the target version;
- provider-native thread id bound behind the canonical YA id;
- a committed source change and controller fetch; and
- provider/app-server/runner/SSH cleanup.

Resume the same Codex thread on the same target workspace after an orderly
runner stop. Determine the exact target-native rollout/checkpoint needed for
historical viewing and resume. The controller may retain a verified projection
or explicit unavailable state, but it must not scan controller-local Codex
files as though they belonged to the remote session and must not invent a new
canonical transcript format.

Record behavior when controller subscription auth is absent or keyring-backed,
the Codex version is incompatible, the auth callback times out or changes
account, the workspace is dirty, the provider exits before binding an id, SSH
drops during a turn, and a resume finds missing or conflicting target state.

**Gate condition:** the diagnostic can start, control, stop, view, and resume a
real remote Codex session with stable YA identity and recover its committed
result. If transcript/resume ownership is unresolved, stop before product
metadata or UI.

### 6 — expose one internal RemoteAgentSession path

Implement one controller-side `RemoteAgentSession` proxy that satisfies the
existing `AgentSession` surface over the SSH runner protocol. On macOS and on
Linux without an available provider host, Hono may own this proxy directly.

Introduce an internal structured execution coordinate such as:

```ts
type SessionExecution =
  | { kind: "local" }
  | { kind: "legacy-ssh"; executor: string }
  | {
      kind: "managed-ssh";
      targetId: string;
      workspaceId: string;
      runnerGeneration: string;
    };
```

Names remain internal until compatibility review. Do not overload truthiness of
the legacy `executor` string. Carry the coordinate through create, provider-id
binding, session-id remap, metadata, resume, restart, termination, and process
diagnostics. Unsupported fork/handoff/side-session operations fail with an
exact managed-target reason rather than silently starting locally.

Use an internal test-only or operator diagnostic launch door guarded against
ordinary clients. It exists to prove full Supervisor/Process routing,
acknowledgement, queue state, and shutdown before adding a public client/server
contract.

## Gate D — Add Reload Survival And The Opt-In Product

Gate D begins only after the runner artifact, SSH transport, Git round trip,
Codex resume, and direct Hono path have evidence recorded in this tactical.

### 7 — retain managed SSH through the Linux provider host

Teach the existing local provider-runtime worker to create the same
`RemoteAgentSession` proxy when launch options carry an internally validated
managed execution coordinate. The provider host continues to spawn and own one
local worker; that worker owns the SSH child and remote runner.

Do not teach Hono a second hosted-session policy and do not expose the host or
worker token remotely. The current local Unix-socket protocol, Hono generation
fencing, acknowledgement boundary, replay limits, attach deadline, viewer
presence, and wrapper terminal ownership remain authoritative.

Exercise a real Linux controller smoke:

1. Start a managed remote Codex turn.
2. Replace Hono while provider output continues.
3. Attach the new Hono generation to the same local worker.
4. Observe exactly the acknowledged/unacknowledged event boundary with no
   second remote runner or Codex writer.
5. Commit and fetch the result.
6. Shut down the full wrapper and prove local worker, SSH child, target runner,
   Codex process, and owned clean workspace cleanup.

macOS retains the direct Hono-owned behavior and does not advertise Safe
Reload for managed sessions. Do not port the provider host as part of this
step.

### 8 — approve the optional compatibility and storage contracts

Before editing a browser-visible route, response, session-create payload, or
Git writer, perform the required optional-feature compatibility review against
the then-current stable release corpus. Present for maintainer approval:

- the permanent managed-executor server capability and introducing release;
- the exact default-off setting and authoritative stored-disable behavior;
- sanitized target inventory/inspection routes and fields;
- the managed execution coordinate in session create/metadata/events;
- missing-capability behavior that hides the UI and sends no new requests;
- older-client behavior when it encounters a managed session;
- runner/artifact/workspace protocol versions; and
- confirmation that no existing SSH-executor or provider-host capability gains
  a new meaning.

Amend `topics/project-directory-storage.md` with the exact managed-head
authorization before writing a user project's Git metadata. Name the assigned
ref namespace, object/ref retention, non-fast-forward updates, removal,
project-local opt-in interaction, and App-data-only behavior.

Do not allocate final route names, fields, setting keys, or capability ids in
this tactical. The compatibility review freezes them after the server behavior
exists behind internal coverage.

### 9 — add default-off manual SSH placement

Add one explicit Settings enable action for managed remote executors. While it
is false or absent:

- no SSH config alias is enumerated for managed use;
- no target is contacted or inspected;
- no artifact, cache, workspace, Git ref, timer, or background observer is
  created; and
- New Session remains identical to the released provider UI.

The first target inventory may project the existing configured SSH aliases
through the new managed-target capability rather than create a competing host
list. Selecting a host triggers read-only inspection. Pressing Start is the
first artifact-cache or workspace mutation.

New Session keeps **This server** selected. For a managed target, the launch
review shows target, Linux platform support, Codex availability, exact base
commit, excluded dirty counts, target workspace effect, incoming-ref effect,
and cleanup policy. A failed preflight retains the prompt and selection and
never substitutes local Codex.

Keep Project Queue placement absent. Preserve managed location through session
lists, open-session routing, resume, restart eligibility, and process
diagnostics. User-facing copy uses i18n keys and describes observed capability,
not merely configured host presence.

### 10 — synchronize and present incoming committed work

At Codex result/activity boundaries and explicit refresh, ask the runner for
its current branch `HEAD` and dirty state. A changed head emits one idempotent
notice. The controller fetches through Git over SSH, verifies object
connectivity, and advances only the assigned managed tracking ref using
serialized compare-and-swap evidence.

Persist target, canonical YA session, workspace, base, announced head, fetched
head, dirty state, runner availability, sync state, time, and error in app data.
Do not report `current` until object import, ref update, and verification all
succeed.

Add project-level **Incoming work** only when the optional server capability is
present and the project has managed heads. Each entry provides target/session,
base/head relation to local `HEAD`, dirty and sync state, and actions to:

- view the committed head;
- copy the tracking ref; and
- open the originating session.

Do not add Merge, Rebase, Cherry-pick, Pull, Push, branch movement, automatic
integration, or conflict UI. Ordinary project Source Control remains the local
working tree; it never claims to show live remote status.

### 11 — make the reduced remote workspace surface honest

Carry the structured workspace coordinate into transcript-derived file links
and the minimum supported file-read route. A supported read is bounded,
containment-checked on the target, and brokered through the controller/runner;
an unavailable runner returns a remote-workspace error.

Hide or disable live remote Git status, arbitrary file inventory, blame, media,
source review, shell, fork, and other project controls until each has a
location-correct contract. No path rewriting or local project fallback is
allowed. The useful baseline is conversation, bounded remote file reads, and
locally fetched committed heads.

## Gate E — Validate And Decide The Next Platform

### 12 — prove supported platforms and inert fallbacks

Run the warning-free deterministic suites on Linux, macOS, and Windows
controllers. Pure protocol, manifest, execution-coordinate, and Git planning
tests remain host-independent. Native SSH/Git smokes run only where the declared
controller/target capabilities exist.

Required live evidence:

- macOS controller to clean Linux target: direct Hono-owned Codex, commit,
  fetch, resume, and cleanup;
- Linux controller to clean Linux target: the same flow plus Hono replacement;
- target without Node, Git, or Codex, and controller without supported
  file-backed ChatGPT auth: distinct read-only preflight failures and no
  mutation;
- target without local Codex auth but with a supported controller subscription:
  external-token login, forced-`401` refresh/retry, and no target auth file;
- target with a partial/stale runner artifact: verified replacement without
  executing unverified bytes;
- SSH loss before and after launch acceptance: safe retry versus visible
  uncertainty and no duplicate writer; and
- disabled/unsupported Windows controller: no managed requests or background
  work and unchanged local/legacy session behavior.

After the Linux-target baseline is stable, choose the next target from measured
demand. A macOS target may reuse the POSIX bootstrap only after native process,
path, provider, and cleanup validation. A Windows target gets a separate
OpenSSH/PowerShell bootstrap and process-tree adapter; it never enters through
POSIX quoting by accident. If the Windows GPU host is the immediate high-value
case, run an early read-only Node/Git/Codex/OpenSSH viability probe after Gate B
without delaying the Linux correctness baseline.

## Completion Contract

- Feature-off startup, Settings, New Session, and idle operation perform no
  managed target work.
- A clean target with documented prerequisites runs a digest-verified runner
  artifact without a YA checkout or target package installation.
- One provider-session core owns local-socket and remote-stdio adapters; the
  implementation contains no copied remote provider state machine.
- Managed-runner placement advertises Codex only; Claude and every other
  provider remain unavailable through this feature.
- macOS and Linux controllers can create a verified Linux target worktree at
  the displayed exact commit while excluding disclosed dirty local state.
- A real remote Codex session retains its canonical YA identity, supports its
  promised controls, and resumes only through its recorded target workspace.
- Linux Hono replacement preserves an active managed turn through the existing
  provider host without duplicate output or provider writers.
- The target receives only its per-lease Codex access-token projection. It
  receives no upstream Git credential, forwarded SSH agent, YA account secret,
  provider-host token, subscription refresh token, complete controller Codex
  credential store, or API key, and writes no provider auth file.
- A remote commit becomes only the assigned local managed tracking ref; no
  local worktree, checked-out branch, upstream, or remote configuration moves.
- Dirty-only, unfetched, disconnected, incompatible, and uncertain-cleanup
  states remain visible and are never reported as a complete clean result.
- Session-entered file reads use the exact target workspace or fail explicitly;
  unsupported remote project controls do not display local substitutes.
- Feature disablement, session termination, controller loss, and wrapper
  shutdown release every owned timer, listener, stream, SSH child, runner,
  provider process, and safely disposable workspace.

## Verification And Documentation

Each gate updates this tactical with measured findings, chosen mechanics,
commands, platform evidence, failures, and remaining stop conditions. Durable
behavioral decisions also update `topics/managed-remote-executors.md`; tests and
commit history are evidence, not substitutes for that contract.

Before implementation commits finish, run the focused server/provider/SSH/Git
tests plus warning-free `pnpm typecheck`, `pnpm lint`, and `pnpm format:check`.
Client steps additionally run `pnpm i18n:scan`, `pnpm console:scan`,
`pnpm css:touched`, `pnpm css:check`, and the relevant unit/E2E tests. Final UI
work receives fresh 1000x600 and 375x812 captures from an isolated server and
data directory.

Native test targets and credentials remain private evidence. Public fixtures
use sanitized aliases and disposable directories with exact cleanup. No test
for this feature modifies or stops the user's live YA server, checkout, SSH
configuration, provider account, or unrelated VM.

## Deferred Beyond This Tactical

- Machine Control inventory, readiness, claims, VM lifecycle, snapshots, and
  non-SSH runner carriers.
- Porting the reload-safe provider host to macOS or Windows.
- Windows and macOS targets before their platform-specific acceptance.
- Claude managed-runner planning, migration from the released SSH executor,
  and additional providers; each requires separate provider-specific
  acceptance.
- Dirty controller snapshot seeding and dirty target artifact capture.
- Existing target checkout adoption and multiple simultaneous writers in one
  target repository anchor.
- Project Queue/workstream remote lanes and agent-initiated placement.
- Automatic fast-forward, merge, rebase, cherry-pick, push, or PR creation.
- Full remote Source Control, inventory, media, blame, search, and source-review
  parity.
- Credential brokering beyond the approved Codex file-backed ChatGPT
  access-token projection, including keyring, API-key, Claude, and private
  dependency credentials.
- Restricted collaborator principals, session grants, comments, and shared
  write access.
