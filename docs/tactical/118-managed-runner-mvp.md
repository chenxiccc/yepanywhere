# Managed Runner MVP

Topic: managed-runner-execution-targets

Status: deferred. Do not start this Machine Control integration until the
manual-SSH baseline in [tactical 119](119-managed-ssh-executor-baseline.md) and
[`topics/managed-remote-executors.md`](../../topics/managed-remote-executors.md)
has proven its injected runner, real Codex session, exact committed workspace,
controller-side Git fetch, and cleanup contracts. No route, capability, Machine
Control workload contract, runner artifact, Git writer, or UI in this document
is implemented or compatibility-approved yet.

This plan remains the follow-on for structured discovery, readiness, claims,
and VM lifecycle. Its provider/session, workspace, and source-return mechanics
must consume the established managed-remote-executor contracts rather than
develop parallel Machine Control-specific versions.

## Objective

After the managed-remote-executor prerequisite lands, extend that working
execution substrate with one useful Machine Control vertical slice:

- an explicitly enabled Linux YA controller lists sanitized Linux targets from
  Machine Control;
- the user selects a target and confirms a target-local Git repository anchor;
- YA creates a session worktree at the controller project's exact committed
  `HEAD`, injects one subordinate runner, and starts one supported provider;
- the existing reload-safe provider host keeps the remote provider owner alive
  across Hono replacement;
- commits created by the remote agent are fetched back into one
  controller-assigned remote-tracking ref; and
- Source Control shows that ref as project-level **Incoming work**, where the
  user can view its head, copy its ref, or reopen the originating session.

The MVP stops before integration. A user or ordinary local agent reviews and
merges, rebases, cherry-picks, or pushes the incoming head using normal Git.

Before resuming this tactical, reconcile its runner, provider-host, workspace,
and Git-head steps against the implementation that actually landed from the
manual-SSH baseline. Delete duplicated work and retain only Machine Control
adapter, readiness, claim, VM-lifecycle, and cleanup differences. The detailed
steps below preserve the earlier design reasoning; they are not instructions to
build a parallel runner stack.

## Owning Contracts And Existing Work

- [`topics/managed-remote-executors.md`](../../topics/managed-remote-executors.md)
  owns the prerequisite manual-SSH runner, Codex-first provider proof, managed
  Git workspace, controller fetch, and no-target-upstream-credential baseline.
- [`topics/managed-runner-execution-targets.md`](../../topics/managed-runner-execution-targets.md)
  owns the controller/runner topology, opt-in behavior, exact workspace
  coordinate, Git-head synchronization, and future collaboration boundary.
- [`topics/reload-safe-provider-runtimes.md`](../../topics/reload-safe-provider-runtimes.md)
  and [`topics/provider-host-api.md`](../../topics/provider-host-api.md) own the
  implemented provider-worker inspiration: complete provider ownership,
  controller-generation fencing, two-phase attach, sequenced replay, and
  verified cleanup.
- [`topics/source-control.md`](../../topics/source-control.md) keeps Source
  Control inspection- and agent-direction-first. Pull remains the configured
  upstream action; integration and conflict recovery remain agent work.
- [`topics/project-directory-storage.md`](../../topics/project-directory-storage.md)
  governs every YA-selected Git object/ref write. The exact managed-head
  authorization must be added there before a writer lands.
- [`topics/project-queue.md`](../../topics/project-queue.md) documents the
  current single-checkout scheduling unit, and
  [`topics/workstreams.md`](../../topics/workstreams.md) owns the proposed
  lane-aware successor. Managed placement does not enter Project Queue in this
  MVP.
- [`gaps/remote-session-project-views-use-local-files.md`](../../gaps/remote-session-project-views-use-local-files.md)
  proves that a session-entered remote file action cannot fall back to a
  similarly named local path. Ordinary project-level Source Control may remain
  local.
- [`gaps/session-worktree-file-links.md`](../../gaps/session-worktree-file-links.md)
  proves that even a local sibling worktree needs an exact source coordinate;
  suffix rewriting is not safe.
- [`gaps/committed-change-session-attribution.md`](../../gaps/committed-change-session-attribution.md)
  is adjacent but not absorbed. Managed-head metadata links one fetched head to
  its originating session in YA app data; it does not implement general Git
  notes attribution.
- Machine Control's
  [target lifecycle](https://github.com/kzahel/machine-control/blob/main/topics/target-lifecycle-and-readiness.md),
  [target-use claims](https://github.com/kzahel/machine-control/blob/main/topics/target-use-claims.md),
  and [VM workspace](https://github.com/kzahel/machine-control/blob/main/topics/vm-workspaces-and-storage-policy.md)
  contracts own target identity, readiness, arbitration, and VM cleanup. YA
  does not copy private target inventory into this repository.

No pending item under `docs/tasks/` already plans this vertical. The three gaps
above are constraints and follow-ups, not duplicate authorization for a remote
runner implementation.

## User Journey

1. The user explicitly enables **Managed execution targets**. While disabled,
   YA never invokes Machine Control, probes a target, installs a runner, or
   advertises remote placement in New Session.
2. New Session keeps **This server** selected by default. The user opens **Run
   on** and sees sanitized Machine Control target aliases from a local inventory
   read that contacted no target.
3. Selecting one target runs read-only inspection. Continuing explicitly
   acquires its claim and prepares it through Machine Control.
4. The first use of a project on that target asks the user to identify and
   confirm a target-local Git repository anchor. YA stores an opaque
   project/target binding in controller app data and revalidates it on every
   launch.
5. The launch preview names the exact local `HEAD` commit. If the local worktree
   is dirty, it says how many staged, unstaged, and untracked changes are not
   included. The user may continue from `HEAD` or cancel; there is no dirty
   snapshot action.
6. With explicit **Fetch commits back as incoming work** authorization, YA
   shows the tracking-ref pattern it will update. It then prepares a unique
   target-side worktree and starts the runner/provider.
7. The session looks ordinary except for a compact target/workspace badge.
   Unsupported project actions are absent or fail as remote-workspace actions;
   they never read the controller's matching local path.
8. At bounded provider activity and turn boundaries, a changed target `HEAD`
   triggers a controller-initiated Git-object fetch. The session shows the last
   synchronized short hash or a visible sync failure.
9. Source Control for the local project shows an **Incoming work** card with
   target, originating session, base/head relation, commit count, activity and
   sync state, plus **View head**, **Copy ref**, and **Open session**.
10. The user can start a normal local agent session and say, for example,
    `Review and integrate ya/linux-kvm/s_123 into main.` Cleanup stops the
    runner and releases the target claim without deleting the locally fetched
    incoming head.

## MVP Boundaries

### Included

- One controller-owned YA session and one subordinate runner per managed
  session.
- Linux controller running the compatible shared provider host and a Linux
  x64/arm64 target whose Machine Control adapter supports the runner workload.
- Machine Control inventory, read-only doctor, explicit readiness, exclusive
  target-use claim, renewal while owned work remains, and verified release.
- One target-local Git repository anchor confirmed by the user, plus one
  session-specific target worktree/branch created from an exact commit.
- Committed Git state only. Missing reachable Git objects may cross the runner
  channel; local dirty files do not.
- A provider-neutral runner protocol with one production provider advertised
  only after live acceptance. Claude is the first candidate because YA already
  has a released remote-executor path and target-side credential expectations;
  fake-provider coverage must not bake Claude into the protocol.
- Controller-initiated commit fetch into a YA-assigned remote-tracking ref and
  app-data metadata that records its project, target, session, base, head, and
  sync state.
- Project-level Incoming work presentation over locally present Git objects.
- Minimum remote source correctness for session-entered file links: route a
  supported read through the runner or present an explicit unavailable state.

### Excluded

- Dirty-worktree overlays, automatic temporary commits, stashes, patches,
  archives, untracked-file transfer, non-Git projects, submodule repositories,
  Git LFS materialization, and sparse-checkout fidelity.
- Automatic merge, rebase, cherry-pick, checked-out branch movement, conflict
  resolution, push, PR creation, or reuse of the upstream Pull button.
- Project Queue placement and lane-aware scheduling.
- Presenting the runner's live working tree in ordinary project-level Source
  Control. Only fetched committed heads appear there.
- Full remote file inventory, blame, live working-tree status, source review,
  media projection, or arbitrary remote shell/file access. Unsupported
  session-entered controls remain unavailable rather than reading locally.
- Disposable VM acquisition, retained candidate images, Windows/macOS target
  runners, multiple simultaneous writers in one target repository anchor, and
  provider parity beyond the accepted first provider.
- Target-side upstream credentials, forwarded SSH agents, credential helpers,
  package-registry credential brokering, or inbound public runner listeners.
- Peer YA servers, delegation grants, multiplayer principals, comments, and
  collaborator write access.
- Agent-initiated placement. Only the human New Session flow may choose a
  target in the MVP.

## Proposed Runtime Shape

```text
browser
  |
  v
Hono Supervisor / Process
  |
  | existing AgentSession surface
  v
HostedAgentSession proxy
  |
  | private same-user provider-host protocol
  v
Linux provider-host worker
  |
  | claim-bound Machine Control workload stream
  v
injected target runner
  +-- target-local provider AgentSession
  +-- exact session Git worktree
  +-- bounded file and Git-object operations
```

The Linux provider-host worker, rather than Hono, owns the Machine Control
carrier and remote runner connection. Hono reload therefore detaches and
reattaches through the existing hosted `AgentSession` path. The remote runner
owns the complete provider SDK/query, queue, callbacks, child transport, and
target-local workspace; keeping only its provider PID alive is insufficient.

Do not expose the current provider-host Unix socket or token over a network.
The new runner protocol is transport-neutral and claim-bound. The first
Machine Control carrier may be one controller-initiated duplex stream with no
inbound target listener, but that carrier is an implementation of the workload
contract rather than the contract itself.

## Proposed Persistent Records

Names are illustrative until the compatibility review freezes wire fields.
Controller app data needs three records:

```ts
interface ManagedProjectBinding {
  projectId: string;
  targetProvider: "machine-control";
  targetId: string;
  targetProjectRef: string;
  displayPath: string;
  repositoryEvidence: {
    rootCommit?: string;
    remotes: string[];
  };
  validatedAt: string;
}

interface ManagedRunnerSessionRecord {
  sessionId: string; // canonical YA id
  projectId: string;
  targetId: string;
  targetProjectRef: string;
  runnerId: string;
  workspaceRef: string;
  baseCommit: string;
  targetBranch: string;
  providerName: string;
  claimId: string;
  initialTargetPowerState: string;
  targetStartedByYa: boolean;
  targetCleanupDisposition: "restore" | "leave-running";
  state: "starting" | "active" | "detached" | "stopping" | "terminal";
}

interface ManagedIncomingHead {
  projectId: string;
  sessionId: string;
  targetId: string;
  trackingRef: string;
  baseCommit: string;
  headCommit: string;
  remoteDirty: boolean;
  runnerState: "active" | "terminal" | "unavailable";
  syncState: "syncing" | "current" | "failed";
  syncedAt?: string;
  error?: string;
}
```

Private endpoints, usernames, hostnames, provider object identifiers, target
paths not selected for display, credentials, registration secrets, and raw
Machine Control inventory never enter browser responses or these portable
records. Claim identifiers and runner lease material remain server-private.

## Implementation Order

### 1 — approve managed execution compatibility and Git-write authority

At implementation time, inspect the required optional-feature stable-release
corpus before changing any client/server route or session-create payload. Name
the exact new setting, capability, routes, fields, and events; prove that an
older server receives no managed-target request and that an older client can
open the transcript without being offered a locally backed remote file action.
Pause for the required maintainer approval before editing those contracts.

Update `topics/project-directory-storage.md` before adding the Git writer.
Define **Fetch commits back as incoming work** as an explicit, narrow
source-control authorization: disclose the exact remote-tracking namespace,
object/ref retention, removal behavior, non-fast-forward updates, and behavior
when project-local Git writes are not authorized. It must not enable unrelated
YA project storage, Git notes, source-review refs, excludes, or working-tree
mutation.

Allocate a permanent optional capability only after the behavior is settled.
Do not expand the existing SSH-executor or provider-host capability meanings.

### 2 — add a typed Machine Control workload boundary

In Machine Control, define a generic claim-bound workload/runner capability
instead of shipping YA against `os --`. The minimum typed operations are:

- read-only capability inspection with target OS/architecture and carrier
  support;
- artifact transfer with controller-verified protocol version and digest;
- one-time registration-secret delivery outside arguments, logs, and ordinary
  inherited environment;
- start, attach/status, stop, and verified cleanup by opaque workload handle;
- one bounded duplex carrier suitable for framed control and Git-object data;
- explicit claim/workspace requirements on every effectful operation; and
- distinguishable unsupported, unreachable, refused, expired-claim,
  uncertain-start, and uncertain-cleanup outcomes.

A spike may use the administration escape hatch against a disposable fixture,
but no released YA path may depend on it. Add dependency-free fake-provider
conformance before live target use.

### 3 — expose opt-in target inventory without contacting targets

Add a server-owned Machine Control execution-target provider. When the managed
feature is disabled, do not resolve or execute the CLI. When enabled, inventory
parses exactly one versioned JSON document and projects only sanitized target
identity, platform/profile, adapter availability, claim policy, and runner
capability summary.

Inspection remains a separate user-triggered operation. It runs doctor and
workload capability reads but never boots, repairs, installs, claims, or asks
for credentials. Acquisition begins only from an explicit launch attempt.
Missing CLI, invalid JSON, unsupported schema, unavailable adapter, and no
runner capability remain distinct visible states.

Persist project/target bindings in YA app data. Initial binding accepts an
explicit target path, asks the runner to validate it as a Git repository, shows
sanitized repository evidence, and requires user confirmation. Every launch
revalidates the opaque reference and fails closed after movement, replacement,
or identity mismatch.

### 4 — package the single-session Linux runner

Create a versioned runner artifact from existing server/provider modules rather
than a second YA server. It has no Hono routes, browser UI, project catalog,
relay account, remote-access password, peer grant, or arbitrary session-create
surface.

The runner accepts one lease and constructs one target-local `AgentSession`.
Its framed protocol carries handshake/capabilities, queue operations, sequenced
provider events and acknowledgements, approvals, control RPC, provider state,
workspace reads, Git head notices, bounded Git-object streams, completion, and
failure. It enforces message and byte limits before allocation.

The runner checks target-local provider availability and authentication without
copying controller credentials. The first production provider remains hidden
unless its target-side live smoke passes. Unsupported provider selection fails
before the session is created and never falls back to local execution.

### 5 — connect managed runners through the provider host

Teach the provider-host worker to create a managed-runner-backed
`AgentSession`. Preserve the existing `Process` and `HostedAgentSession`
surface; routing, transcript projection, queues, approvals, liveness, viewer
presence, and reload detach should not grow a second policy path in Hono.

Reuse controller-generation fencing, claim/confirm-attach, event sequencing,
acknowledgement after `Process` consumption, bounded replay, and verified
teardown. Extend source/build compatibility to cover the runner artifact and
runner protocol. A stale Hono generation, old workload handle, expired claim,
or incompatible runner cannot become a writer.

The provider host retains terminal ownership. Wrapper shutdown stops the remote
provider and runner, verifies Machine Control cleanup, restores target power
state when YA started it and the launch policy requested restoration, then
releases the claim. A target inherited running is not silently stopped.
Hono-only reload detaches without stopping owned work. Ambiguous cleanup remains
a visible retained failure and never frees the session identity for a second
writer.

### 6 — prepare an exact committed target worktree

Resolve local `HEAD` once during launch and include its full object id in the
confirmation. Read local staged, unstaged, and untracked counts only to explain
their exclusion. Do not serialize their contents.

After claim and readiness succeed, have the runner revalidate the mapped target
repository, import only missing objects needed for the exact base, and create a
unique session branch/worktree. Verify repository identity, effective cwd,
`HEAD`, branch ownership, and absence of a conflicting writer before starting
the provider. Reject unsupported repositories and Git states with exact
remediation.

The runner owns cleanup of the worktree and its target-local branch only after
the controller has fetched the final announced head or the user explicitly
chooses a result-discard path. Cleanup uses exact recorded identities, never a
path prefix or glob. Controller loss and claim expiry do not guess that a
possibly unique unfetched head is safe to delete.

Add the session workspace coordinate to canonical YA metadata. A supported
session-entered file read resolves through that coordinate. Unsupported source
controls are omitted or return a remote-workspace unavailable result; no code
path strips an absolute path to a matching local relative suffix.

### 7 — synchronize remote commits into managed tracking refs

At provider activity/turn boundaries and explicit refresh, compare the
runner's current `HEAD` with the last announced object id. A change emits one
idempotent head notice containing the runner-known base, branch, head, and dirty
indicator. Do not add an indefinite polling loop.

The controller verifies the announced object id and repository association,
fetches the reachable object graph through the bounded runner channel, checks
object connectivity, and updates only its assigned
`refs/remotes/ya/<target>/<session>` ref. Serialize updates per project/ref and
use compare-and-swap evidence so concurrent, stale, and rewritten heads are
distinguishable. A rebase or amend may force-update the tracking ref but never
a checked-out local branch.

Persist the managed-head association in app data and emit one project-scoped
change event. Ref write, metadata write, or fetch failure remains retryable and
visible; do not report `current` until both object import and ref verification
succeed. The target never receives upstream credentials and never pushes.

### 8 — render project-level Incoming work

Add an **Incoming work** section to Source Control only when the capability is
present and the selected project has managed heads. It is a compact project
surface, not a new Source Control mode and not a session/workspace selector.

Each card shows target, session title/link, active or terminal runner state,
base/head short hashes, commits ahead or divergence relative to current local
`HEAD`, remote dirty state, last sync, and a visible error when stale or
unavailable. Its first actions are:

- **View head** through the existing committed-revision browser;
- **Copy ref** using the user-facing shortened ref; and
- **Open session** using the canonical YA session id.

Do not add Merge, Rebase, Pull, Push, auto-integrate, or conflict UI. A later
**Integrate with agent** shortcut may prefill a normal local session, but the
MVP user can copy the ref and direct an agent manually. An incoming head already
reachable from local `HEAD` renders **Already integrated** without deleting its
record or ref.

### 9 — add the guarded New Session placement journey

Add **Run on** only after the server advertises the optional capability and the
feature is enabled. Keep **This server** selected on every fresh install and
for every existing project without an explicit user choice. Opening the target
picker reads inventory; selecting a target performs inspection; pressing Start
authorizes acquisition and mutation.

The launch review includes target, mapped repository, exact base commit, dirty
state exclusion, provider availability, incoming-head ref effect, and cleanup
policy. A failed preflight keeps the prompt and selections available for retry.
It never substitutes the local provider.

Hide Project Queue submission for a managed placement in the MVP. Preserve the
chosen execution coordinate through session-id remap, transcript metadata,
resume, restart, fork eligibility, and session list badges. Any derived action
without a supported managed-runner contract remains unavailable with an exact
reason rather than silently becoming local.

### 10 — prove reload, Git, cleanup, and inert defaults

Build deterministic fake Machine Control and fake runner fixtures before the
live smoke. Cover malformed and oversized frames, replay at the acknowledgement
boundary, stale generations, duplicate head notices, non-fast-forward head
movement, partial pack transfer, invalid objects, ref compare-and-swap failure,
claim expiry, controller loss, and uncertain cleanup.

Run a Linux provider-host smoke that starts a real target provider turn, commits
on the target, replaces Hono mid-turn, observes uninterrupted output after
reattach, fetches the final head, opens it in Source Control, and then proves
runner/process/worktree/claim cleanup. Record target alias only in private test
evidence; public fixtures use sanitized names.

On macOS and Windows, prove the unsupported target-runner gate and ordinary
local-session fallback without executing Linux process-group or Unix-socket
paths. A passing Linux smoke is not evidence for another target OS.

## Completion Contract

- Feature-disabled startup, Settings, New Session, project reads, and idle
  operation never execute Machine Control or allocate managed-runner resources.
- Inventory alone contacts no target; inspection is read-only; launch is the
  first claim/readiness/bootstrap mutation.
- Every managed session starts in the verified target worktree at the exact
  displayed commit, excluding local dirty state exactly as disclosed.
- Hono replacement during an active remote turn neither interrupts the target
  provider nor loses an acknowledged event suffix.
- Only one controller generation and one runner lease can write one managed
  session.
- A remote commit becomes a verified local tracking head without changing the
  controller working tree, local branch, upstream configuration, or remote
  credentials.
- Incoming work remains visibly associated with its target and canonical YA
  session and can be copied into a normal local-agent instruction.
- No project or session action displays controller-local bytes as though they
  came from the target workspace.
- Project Queue, automatic integration, push, multiplayer, and unsupported
  providers/platforms remain absent.
- Terminal cleanup reports provider, runner, target worktree, target lifecycle,
  Machine Control claim, and any retained uncertainty separately. A target
  inherited running remains running; a target started by YA follows its
  disclosed restoration policy.

## Verification Matrix

- Shared schemas and capability registry: focused unit tests plus capability
  audit after compatibility approval.
- Machine Control provider: fake CLI inventory/doctor/claim/readiness/workload
  conformance on Linux, macOS, and Windows controller test environments.
- Runner protocol: framing, limits, authentication, sequencing, replay,
  approvals, Git-object streaming, and teardown tests.
- Provider host: launch/claim/reattach/detach/terminate tests with a managed
  worker and a real Linux reload smoke.
- Git: clean and dirty controller trees, missing base objects, target worktree
  creation, multiple commits in one turn, amend/rebase, duplicate fetch,
  connectivity failure, ref collision, already-integrated and diverged states,
  and explicit ref removal.
- Source correctness: deliberately different local and target bytes prove that
  session-entered reads use the runner or fail explicitly.
- Client: capability absent/pending/present, feature off/on, target inspection,
  dirty-state disclosure, startup failure, Incoming work cards, copy/open/view
  actions, stale/error states, and Project Queue absence.
- Resource ownership: no idle polling after interest ends, no lingering claim
  renewal, bounded buffers and retained replay, wrapper shutdown cleanup, and
  visible uncertain cleanup.
- Final checks: touched package typechecks and tests, `pnpm lint`, targeted
  Biome formatting/check, `pnpm capabilities:audit`, `pnpm i18n:scan`,
  `pnpm console:scan`, and `pnpm css:touched`/`pnpm css:check` for client style
  changes.
- Final UI captures from a fresh isolated dev server at 1000×600 and 375×812,
  including feature-off New Session, dirty-tree remote launch review, active
  managed session, Incoming work current/error cards, and constrained phone
  layouts.

## Deferred Decisions

- Whether a later runner is retained briefly per target or remains strictly
  one artifact/process per session.
- Dirty-snapshot seeding and its full filesystem/Git semantics.
- Safe fast-forward of a chosen local branch and a one-click local integration
  agent session.
- Project Queue/workstream lane targeting and target-lane `HEAD` resolution at
  dispatch.
- Disposable VM workspaces and recovery of an unfetched head from an otherwise
  releasable VM.
- Windows and macOS runner packaging, process ownership, and provider smokes.
- Broader provider availability and private dependency credential brokering.
- Full remote Source Control/file/media/review parity.
- Peer delegation, participant identity, session grants, and multiplayer.
