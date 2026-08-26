# Managed Runner Execution Targets

> A controller-owned YA session may run its provider and project workspace on
> an explicitly selected subordinate machine or disposable VM without turning
> that target into an independent YA peer. Target discovery, runner injection,
> and agent placement are opt-in and default-off.

Topic: managed-runner-execution-targets

Status: broader product direction proposal, deferred behind the manual-SSH
baseline in [managed remote executors](managed-remote-executors.md). Machine
Control already exposes useful target, readiness, claim, and VM-workspace JSON,
and YA already has SSH Remote Executors plus a same-host provider-worker
boundary. YA does not yet have a managed-runner protocol, a target-provider
registry, location-correct remote project views, or restricted collaborator
principals. Nothing in this topic authorizes treating those missing boundaries
as implemented.

The Machine Control implementation plan in
[`docs/tactical/118-managed-runner-mvp.md`](../docs/tactical/118-managed-runner-mvp.md)
is deferred until the manual-SSH runner, Codex execution, managed Git workspace,
and controller fetch loop tracked by
[`docs/tactical/119-managed-ssh-executor-baseline.md`](../docs/tactical/119-managed-ssh-executor-baseline.md)
are working. Machine Control then extends that execution substrate with
inventory, claims, readiness, and VM lifecycle.

Related:
[managed remote executors](managed-remote-executors.md),
[cross-host delegation](cross-host-delegation.md),
[reload-safe provider runtimes](reload-safe-provider-runtimes.md),
[provider host API](provider-host-api.md),
[SSH Remote Executors](../docs/project/remote-executors.md),
[remote-session project-view gap](../gaps/remote-session-project-views-use-local-files.md),
[client source runtime topology](client-source-runtime-topology.md),
[source transport](source-transport.md),
[source control](source-control.md),
[project queue](project-queue.md),
[workstreams](workstreams.md),
[session sandboxing](session-sandboxing.md),
[project directory storage](project-directory-storage.md),
[security](security.md),
[vanilla defaults](vanilla-defaults.md), and
[architecture mandates](architecture-mandates.md).

Machine Control's public companion contracts are
[target lifecycle and readiness](https://github.com/kzahel/machine-control/blob/main/topics/target-lifecycle-and-readiness.md),
[delegation and agent placement](https://github.com/kzahel/machine-control/blob/main/topics/delegation-and-agent-placement.md),
[target-use claims](https://github.com/kzahel/machine-control/blob/main/topics/target-use-claims.md),
and
[VM workspaces and storage](https://github.com/kzahel/machine-control/blob/main/topics/vm-workspaces-and-storage-policy.md).

## Motivation

One operator may run YA across several native or virtual machines: a Linux KVM
host, a Windows GPU machine, a macOS guest, or disposable test appliances. The
operator wants one authoritative YA UI and session catalog while choosing the
hardware or operating system on which a particular provider session executes.

Installing a complete independent YA server on every target and pairing every
server as a peer is more authority and product surface than this use case
requires. The target may instead host a small runner that is injected just in
time, connects back to the controller, owns one bounded execution lease, and
cannot operate as a standalone YA installation.

The same topology can support a future collaborative session. The controller
may create an isolated VM workspace, run one session there, and grant another
person narrowly scoped access to that session. The guest participant can work
with the agent inside the isolated checkout without receiving ordinary access
to the controller's machine or other YA sessions.

## Three Independent Coordinates

"Run on" is not a complete placement model. Coordination must resolve three
different coordinates:

1. **Execution target** — the machine or VM where the provider process runs.
2. **Session workspace** — the exact target-local checkout and working
   directory the provider uses.
3. **System under test** — the machine or device the agent may inspect or
   control, when different from its execution target.

For an ordinary Linux coding task all three may name one VM. For iOS work the
provider and checkout may live on a Mac while the system under test is an
attached phone. A Machine Control logical target describes a controllable
machine or device; it does not by itself identify the provider placement or
project cwd.

Machine Control's **VM workspace** and YA's **session workspace** are also
different resources. The first selects or derives a whole machine. The second
selects or creates a repository checkout inside that machine.

## Controller And Runner Topology

```text
browser / future collaborator
          |
          | YA session access
          v
controller YA server
  owns YA session identity, catalog, policy, and participant grants
          |
          | versioned runner lease and encrypted control stream
          v
managed runner in target or VM workspace
  owns live provider process and target-local session workspace
          |
          +--> provider CLI / SDK
          +--> target-local files and Git
          +--> optional target-native computer control
```

The controller is the only YA server in this topology. The managed runner:

- has no Projects page, browser login, Remote Access password, relay username,
  public-share surface, or server-to-server delegation grants;
- cannot create unrelated sessions, delegate to another target, or act as a
  general authenticated proxy into the controller;
- accepts work only through one versioned, controller-issued lease;
- exposes target-local provider, workspace, file, Git, and artifact operations
  needed for that lease; and
- stops accepting new work after revocation, expiry, incompatible controller
  state, or terminal cleanup.

The canonical user-facing session id remains the controller's YA session id.
The runner may retain provider-native ids and opaque execution handles for
resume and debugging, but neither replaces the YA-visible id.

## Distinct From Peer Delegation

| Concern | Managed runner | YA peer delegation |
| --- | --- | --- |
| YA session owner | Controller | Target YA server |
| Target software | Subordinate runner | Complete independent YA |
| Target standalone use | No | Yes |
| Trust record | Controller-issued execution lease | Durable directional peer grant |
| Project identity | Controller-approved target workspace | Target-owned opaque project reference |
| Browser presentation | Ordinary controller catalog with execution location | Cross-source navigation to a target-owned session |
| Primary use | One operator's machines and disposable VMs | Independent servers, people, and administrative domains |

A single physical machine may support both modes. Choosing managed execution
must not silently pair it as a YA peer; pairing it as a peer must not give the
controller machine-administration or runner-bootstrap authority.

The normalized local/remote coordination application service may share
provider-control vocabulary with managed runners and peers. Ownership,
identity, grant, and failure semantics remain different and must not be hidden
behind one ambiguous remote target flag.

## Explicit Opt-In And Vanilla Default

Managed execution targets are YA-novel behavior and remain default-off. The
eventual setting name and storage field are not frozen, but the observable
contract is:

- a fresh or upgraded installation performs no managed-target discovery;
- YA does not probe for Machine Control, enumerate its registry, contact a
  target, run SSH discovery, acquire a claim, create a VM workspace, install a
  runner, or add placement tools or prompt text while the feature is off;
- Settings exposes one explicit enable action rather than automatically
  turning an installed Machine Control checkout into YA product state;
- enabling discovery makes eligible targets available to the human New
  Session flow but does not select one automatically;
- every managed session explicitly selects an execution environment before
  the provider starts; existing local defaults remain local;
- enabling human placement does not arm agents to create managed workers.
  Agent-initiated placement is a separate default-off grant; and
- disabling the feature stops new discovery and launch, releases idle
  discovery resources, and leaves existing active-session shutdown/recovery
  visible rather than silently abandoning it.

An operator-controlled environment or deployment policy may remove the feature
entirely. An explicit stored disable remains authoritative over later software
updates or newly installed discovery providers.

## Execution Environments And Project Resolution

The UI selects an **execution environment**, not a machine alone:

```text
yepanywhere
  This server       /local/path/yepanywhere
  Linux target      /target/path/yepanywhere
  Windows GPU       C:\source\yepanywhere
  Isolated Linux    new checkout at the selected commit
```

Conceptually:

```ts
type ExecutionEnvironment = {
  target: ExecutionTargetRef;
  workspace: ExistingTargetProjectRef | CheckoutRecipe;
};
```

`ExistingTargetProjectRef` is opaque and target-scoped. A displayed path is
diagnostic evidence, not its durable identity or an authorization credential.
YA never maps a local path to another host merely because the home-relative
suffix matches.

### Existing checkout

After a runner is available, YA may inspect authorized target-local candidate
checkouts. Matching evidence may include normalized Git remotes, root/history
commits, repository name, current branch and HEAD, dirty state, worktree facts,
and the target-local path. These facts can suggest a candidate but cannot prove
one unique identity: forks, clones, and worktrees commonly share them.

The first successful match requires explicit user confirmation. YA may then
remember a controller-owned association between the controller project and the
opaque target project reference. A later launch revalidates the reference and
reopens resolution when it is missing, ambiguous, or inconsistent with the
requested commit or cleanliness expectations.

### Prepared checkout

An isolated or otherwise empty target uses a checkout recipe instead of a
remembered mapping. The controller identifies one exact Git commit, transfers
missing Git objects through the runner channel when necessary, and creates a
target-local checkout or worktree at that commit. The provider starts only
after YA verifies the effective cwd and `HEAD`.

The first experiment supports committed Git state only. A dirty controller
worktree does not block launch, but the confirmation names the exact base commit
and reports that local staged, unstaged, and untracked changes are excluded.
YA does not silently manufacture a temporary commit, patch overlay, archive, or
stash. Explicit dirty-snapshot seeding is a possible later feature with its own
semantics for staging, untracked and ignored files, submodules, Git LFS, sparse
checkouts, symlinks, and file modes.

## Target Discovery Provider Boundary

YA should not grow its own private machine inventory. The YA server owns an
execution-target registry of provider adapters:

```text
local provider
manual SSH provider
Machine Control provider
future YA peer provider
```

Only the sanitized YA projection crosses to the browser. Provider commands,
private endpoints, environment, credentials, hypervisor identifiers, and
Machine Control inventory files remain server-side and owned by their source.

### Machine Control as the first structured provider

Machine Control currently emits JSON from `machine-control targets` with a
logical target, platform/profile, controller compatibility, adapter
availability, claim policy, and optional default VM-workspace intent. It
intentionally omits private adapter commands and environment.

Before YA treats that output as a stable dependency, Machine Control needs a
separate checked-in schema for its sanitized inventory projection. Its current
`machine-control-targets/v0` tag is also used by the private input registry,
whose checked-in schema has a different `targets` shape and includes adapter
commands. YA must not freeze that accidental collision into its own protocol.
A likely split is:

```text
machine-control-target-registry/v0     private input
machine-control-target-inventory/v0    sanitized coordinator output
```

This is a generic Machine Control contract, not a YA-specific API. The first
integration may invoke the dependency-free CLI and parse one JSON document;
no resident HTTP service is required. A later SDK, local IPC service, or
authenticated carrier may preserve the same semantics.

Discovery is staged to avoid waking or probing every configured machine:

1. **Inventory** lists configured logical targets and whether the current
   controller can dispatch their authoritative adapters. It contacts no
   target.
2. **Inspection** runs read-only doctor and capability operations only after
   the user opens or selects a target. Doctor never boots, repairs, logs in,
   installs, or grants consent.
3. **Acquisition** begins only after an explicit session launch. YA obtains the
   applicable target-use claim and optional VM-workspace handle, then requests
   readiness through the target's declared lifecycle.

A target alias is a selector, not bearer authority. Machine Control's
cooperative target-use claim is resource arbitration, not runner
authentication; the YA-issued runner lease remains a separate credential.

### Missing runner capability contract

No current Machine Control field proves that a target can host an injected YA
runner. `adapterAvailable`, SSH reachability, target readiness, and Machine
Control's own resident-controller state are insufficient.

Before product integration, the target boundary needs a typed generic runner
or workload capability which states at least:

- supported target OS and architecture;
- whether an artifact can be transferred and executed;
- whether one-time secret delivery avoids arguments, logs, and ordinary
  inherited environment;
- whether an outbound encrypted runner channel can be established;
- start, status, cancel, termination, and verified cleanup operations;
- artifact retrieval limits and behavior when the runner channel never forms;
  and
- which machine-workspace and target-use claim must accompany each operation.

YA must not make the product depend on Machine Control's `os --` or another
arbitrary administration escape hatch. A spike may use one to prove the path,
but the supported boundary is typed, capability-described, and independently
cleanable. Machine Control owns target transport and bootstrap mechanics; YA
owns the runner artifact, session semantics, and lease.

## Runner Bootstrap And Supervision

A likely explicit launch sequence is:

1. Resolve a target provider and sanitized logical target.
2. Acquire a persistent or isolated machine workspace and its exclusive-use
   claim where required.
3. Request ordinary readiness and recheck runner-bootstrap capabilities.
4. Transfer a version-matched runner whose digest and protocol version the
   controller verifies.
5. Deliver a short-lived, one-time registration secret through the target's
   declared secret channel.
6. Attach the runner through a claim-bound duplex carrier and exchange a fresh
   session key. A later carrier may use an outbound direct or relay-compatible
   encrypted circuit; the carrier is not the runner contract.
7. Resolve or create the exact session workspace.
8. Launch the provider and attach its normalized event/control stream to the
   controller-owned YA session.
9. Renew the machine claim only while bounded session ownership requires it.
10. Stop the provider and runner, capture the requested results, release or
    retain the workspace under its declared policy, and release the claim.

The managed-runner boundary is directly inspired by YA's implemented
[reload-safe provider runtimes](reload-safe-provider-runtimes.md). The existing
provider-host API supplies useful local semantics: one provider owner, fenced
controller generations, sequenced events, acknowledgement after consumption,
bounded auxiliary control, and verified cleanup. Its private same-user Unix
socket and token must not simply be exposed over TCP. A managed runner uses a
separately authenticated remote protocol with a smaller surface and an explicit
network threat model.

The runner must not hold a repeating poll, heartbeat, or resource-renewal loop
after its lease, active provider work, and controller interest have ended.
Controller loss, reconnect, bounded output replay, accepted-but-uncertain
submissions, claim expiry, and runner/VM cleanup require exact state-machine
semantics before implementation.

## Location-Correct Project Surfaces

Remote execution is not complete while project UI still means the controller's
local filesystem. Every session carries an explicit workspace coordinate:

```ts
type SessionWorkspace =
  | { kind: "local"; projectId: string }
  | { kind: "runner"; runnerId: string; workspaceRef: string }
  | { kind: "captured"; artifactId: string }
  | { kind: "peer"; peerId: string; projectRef: string };
```

The names are illustrative, not frozen wire types. The invariant applies to
session-entered operations over:

- file inventory, content, raw bytes, and media;
- transcript-derived file and source links;
- Git status, history, changed files, diff, blame, and search;
- Markdown/HTML projection assets;
- source review and session/file navigation;
- YA-owned shell or file operations; and
- fork, resume, restart, and other derived-session launch paths.

An operation entered from a runner-backed session resolves against that exact
runner workspace. If the runner is unavailable, the operation reports a
remote-workspace failure or uses an explicitly captured immutable artifact. It
never falls back to a local project with a similar path.

Ordinary project-level Source Control remains anchored to the controller's
selected local project. It does not acquire an implicit session selector.
Commits fetched from a managed runner are local Git objects and may appear there
as project-level incoming heads with origin metadata; that is different from
presenting the runner's live working tree as local project state.

Capability differences must be visible and conservative. An early experiment
may expose conversation plus a final changes artifact while withholding live
file and Source Control controls. It must label that reduced surface and must
not show locally backed controls that appear to work. Full ordinary-session
presentation requires location-correct coverage of the core project surfaces.

The client source-runtime topology remains the owner of YA-server transport
and cache isolation. A runner workspace is not automatically a second YA
server/source runtime; it is a resource behind the controller's session and
workspace service.

## Git Commit Transfer And Managed Heads

The target does not need GitHub, GitLab, or upstream SSH credentials. YA must
not forward the controller's SSH agent, credential helper, repository token,
or ambient cloud credentials merely so the guest can publish its result.

The preferred source flow is controller-mediated and Git-native:

```text
controller HEAD commit
  -- missing Git objects -----------> runner checkout/worktree
runner commits
  -- commit-head notice ------------> controller
  <-- controller-initiated fetch ---- Git objects over runner channel
controller tracking ref; local agent or user integrates and pushes
```

The runner checks `HEAD` at bounded provider-activity and turn boundaries and
emits a notice only when the commit changes. It may serve Git upload-pack or a
bounded pack/bundle stream over the existing runner channel; the encoding is
plumbing, not a completion-time export workflow. An inbound SSH server is not
required.

With explicit managed-head synchronization authorization, the controller
imports the verified objects and advances a controller-assigned remote-tracking
ref such as `refs/remotes/ya/<target>/<session>`. The ref is never a checked-out
local branch and may move non-fast-forward after an amend or rebase. Source
Control shows it in an **Incoming work** section with target, originating
session, base and head, commit relation to local `HEAD`, sync state, and actions
to view the head, copy the ref, and open the remote session.

The Git-object and ref writes are a separately disclosed source-control/storage
effect; implementation must reconcile their exact authorization with
[project directory storage](project-directory-storage.md) before the first
writer lands. Without that authorization, YA may retain a bounded app-data
result but must not imply that a locally usable ref exists.

Merging, rebasing, cherry-picking, updating a checked-out branch, and pushing
remain user or local-agent work. A later explicit **Fast-forward when safe**
option may advance a named local branch only after verifying cleanliness,
expected branch and base, ancestry, and absence of another checkout owner.
Automatic rebase and overloading the existing upstream **Pull** action are not
part of the MVP.

Untracked files, LFS objects, submodule repositories, large generated outputs,
and non-Git content require a bounded artifact manifest in addition to Git
objects. The UI must report omitted or unavailable content rather than treating
a partial Git bundle as the complete workspace.

Private dependency fetching is a separate credential problem. A VM without
upstream Git credentials may still need access to private package registries or
services. Any later credential broker or per-service grant must be explicit,
scoped, revocable, and absent from the base runner contract.

## Project Queue And Lane Boundary

The current Project Queue treats one project checkout as one scheduling unit.
A target checkout or worktree is another execution lane, even when it belongs
to the same repository. The managed-runner MVP therefore does not expose
Project Queue placement. Adding it requires the lane-aware scheduler direction
in [workstreams](workstreams.md): a queued item identifies its target lane and
resolves that lane's committed `HEAD` at dispatch so sequential work can build
on preceding commits. Local dirty state never becomes implicit input to a
remote lane.

## Future Restricted Collaboration

A controller-owned runner makes one-session collaboration easier to reason
about, but a VM alone does not create multiplayer authorization. A future guest
participant needs a new principal and an exact-session server-side grant. At
minimum, permissions distinguish:

- view catalog entry and transcript;
- view the runner workspace and captured changes;
- send provider input;
- interrupt or restart provider work;
- answer input or permission requests;
- upload content; and
- import or publish changes.

The default guest grant is read-only. Write access means provider input and
isolated-workspace mutation, not controller-machine access, YA settings,
machine administration, local-repository import, or upstream push.

The future `Locked to this session` boundary in
[session sandboxing](session-sandboxing.md#future-locked-to-this-session-share)
already records the admission and execution requirements. Its current
`project-write` level is not a confidentiality or hostile-multiuser boundary:
it permits outside reads and network access. A share-safe VM must also avoid
host mounts, SSH-agent forwarding, control sockets, Docker sockets, broad
credentials, and other escape or disclosure paths; stronger network, read,
IPC, and secret isolation must be stated and attested rather than inferred from
the word VM.

Today's public read-only bearer links must never be widened into write
authority. Restricted collaboration uses a new authenticated principal and
grant contract.

## Compatibility And Rollout Boundary

This topic approves no route, field, capability id, protocol version, or
retirement of SSH Remote Executors. Before implementation, the normal
client/server compatibility review must identify the supported stable release
corpus and approve:

- the execution-target inventory route and sanitized fields;
- the optional managed-runner server capability;
- the exact missing-capability UI and no-request fallback;
- target-provider, runner, and workspace protocol versions;
- session workspace identity carried by every affected project operation; and
- behavior when an older client opens a runner-backed session.

The feature is optional. A client connected to a server without its capability
hides managed placement and sends no target, workspace, or runner fields.
Existing local sessions and explicitly configured SSH Remote Executors retain
their released behavior until a separate compatibility decision changes them.

## Observable Contract

Before managed execution can be called implemented, the following outcomes are
externally testable:

- With the feature disabled, YA performs no target discovery, runner install,
  machine claim, workspace acquisition, or background target work, and New
  Session behaves exactly as before.
- Enabling discovery alone contacts no machine and changes no machine or
  project state.
- A managed launch requires an explicit execution environment and settles an
  exact target-local cwd before provider work begins.
- A managed Git launch names and verifies one exact base commit. When the
  controller worktree is dirty, launch reports that its uncommitted state is
  excluded and transfers no hidden overlay.
- The controller's YA session id remains stable while the provider executes on
  the runner.
- Runner bootstrap and requested isolation fail closed; YA never substitutes a
  local or unlocked provider launch.
- Every project/content action entered from the session uses the runner or an
  explicitly captured result and never displays a plausible local substitute.
- The guest receives no controller upstream-push credential by default.
- An authorized managed-head sync fetches only the announced Git objects,
  advances only its controller-assigned remote-tracking ref, and never changes
  the controller working tree or checked-out branch.
- Source Control distinguishes fetched incoming heads from the local working
  tree and links each one to its originating target and session.
- Merge, rebase, cherry-pick, checked-out branch movement, and push occur only
  through explicit user or local-agent source-control actions.
- Revocation, controller loss, runner failure, target shutdown, and claim
  expiry produce distinguishable states and cannot create a second provider
  writer or leave indefinite runner work.
- Cleanup reports whether the provider, runner, machine claim, and disposable
  workspace were actually released; uncertain cleanup remains visible and is
  never reported as success.

## Open Questions

- What exact setting and availability probe expose the default-off feature
  without probing Machine Control while disabled?
- What sanitized Machine Control inventory schema replaces the current shared
  input/output tag, and how does YA version its adapter independently?
- Should the generic bootstrap contract be called runner, workload, or agent
  placement, and which repository owns its portable schemas?
- Is the runner always injected per session, retained per machine for a bounded
  idle period, or available in both modes?
- Which side stores the authoritative provider transcript and resume bundle
  while a runner is active, and what checkpoint is required before a
  disposable workspace may be released?
- What event acknowledgement and bounded replay contract survives controller
  reconnect without duplicating a provider turn?
- What later demand, if any, justifies explicit dirty-snapshot seeding beyond
  the MVP's exact committed base?
- How are remembered project mappings invalidated after clone replacement,
  worktree movement, repository rewrite, or runner reprovisioning?
- Which file/Git/source-review operations are required for the first
  full-fidelity runner-backed session rather than a clearly reduced experiment?
- How does an operator recover a result when the runner channel fails but
  Machine Control can still retrieve bounded artifacts?
- Which credentials, if any, may be brokered for private dependency access
  without giving the guest general repository or account authority?
- What exact participant identity and grant model enables a future
  collaborator, and which actions remain owner-only?
- When does managed-runner coverage become sufficient to deprecate rather than
  merely coexist with the current SSH Remote Executor implementation?
