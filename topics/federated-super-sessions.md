# Federated Super Sessions

> A federated super session is one canonical YA session whose provider state
> has exactly one active writer but can migrate between mutually trusted YA
> servers, letting an agent stop on one machine, copy its portable session
> bundle, resume on another machine, and continue in the same user-visible
> conversation.

Topic: federated-super-sessions

Status: proposal. The motivating cross-platform workflow is real, but provider
bundle portability, terminal jump semantics, peer transfer, and cache reuse
must be proven in focused experiments before implementation.

Related:
[remote executors](../docs/project/remote-executors.md),
[client source runtime topology](client-source-runtime-topology.md),
[source transport](source-transport.md),
[session ownership](session-ownership.md),
[provider context economics](provider-context-economics.md),
[prompt-cache keepalive](prompt-cache-keepalive.md),
[portable transcript compiler](portable-transcript-compiler.md), and
[vanilla defaults](vanilla-defaults.md).

## Motivation

Cross-platform development is most ergonomic when the agent harness itself runs
on the platform under test. Prefixing individual tool calls with `ssh`, or
asking an agent on one OS to reason about another OS remotely, leaves important
capabilities behind: the target shell, path semantics, installed SDKs, native
build tools, GUI automation, and platform-specific test environment.

The desired experience is not a manual handoff prompt and not a new visible
session:

1. An agent working on macOS realizes that native Windows testing is required.
2. It prepares a reproducible repository checkpoint and calls a terminal
   `jump` tool as its last action on the Mac.
3. The Mac YA server stops and flushes the provider session.
4. The provider session bundle moves to a registered Windows YA peer.
5. Windows resumes the same provider conversation from its mapped project
   directory.
6. The agent verifies or retrieves the code checkpoint and continues without
   waiting for another user message.
7. The user keeps one YA URL, one session row, one transcript, and one composer
   throughout.

This is potentially high-value because it turns a repetitive manual
stop/summarize/switch/paste/resume workflow into one agent-visible operation
while preserving native execution on every platform.

## Decision Summary

The proposal's center is a **federated, single-writer session**:

- YA's session id remains the stable, canonical, user-facing identity.
- Registered YA servers are equal peers; there is no permanent "home" server
  that must launch every provider process or proxy every tool call.
- Exactly one peer owns the right to resume or append to the provider
  transcript at a time.
- A jump transfers that ownership and a provider-specific portable session
  bundle to another peer.
- The target provider process runs locally on the target machine. Normal agent
  tools therefore use the target OS directly; SSH is not prefixed to ordinary
  commands.
- The agent knows it is migrating. It prepares repository state before the
  jump and receives target host/path/checkpoint facts after resume.
- The visible transcript is the continuing provider transcript, not a YA
  shadow transcript and not a presentation-time concatenation of replacement
  sessions.

```text
YA session ya_123
provider resume id p_abc
ownership generation 4

┌──────────────┐       terminal jump        ┌──────────────┐
│ Mac YA peer  │ ─────────────────────────▶ │ Windows peer │
│ active owner │   bundle + generation 5    │ active owner │
└──────────────┘                             └──────────────┘
       │                                            │
  provider runs                                provider runs
  locally on Mac                               locally on Windows
```

An inactive replica is not a fork. It is a recoverable copy that must refuse
provider writes while another peer owns a later generation.

## Distinction From Existing Remote Executors

Remote Executors keep one YA server authoritative while that server launches
Claude through an SSH subprocess and syncs provider files back with `rsync`.
That is useful for Unix-like remote execution, but it has different semantics:

- ordinary process I/O continues to traverse one SSH connection;
- the local YA server remains the process supervisor;
- the implementation assumes `bash`, `$HOME`, `test`, `mkdir`, `rsync`, and
  Unix-style remote paths;
- only the Claude provider is wired to the remote spawn hook; and
- the session does not become an object jointly understood by registered YA
  servers.

Federated super sessions instead move provider ownership to a target YA server
and let that server use its normal local provider adapter. Existing remote
session-file sync is useful evidence and may provide reusable primitives, but
Remote Executors are not the federation protocol.

## Product Contract

Federation is YA-novel and must be opt-in/default-off under
[vanilla defaults](vanilla-defaults.md). Configuring a peer does not silently
convert existing sessions. A user deliberately creates or converts a session
into a super session and chooses which peers the agent may target.

When enabled for a session:

- **One public identity.** The session keeps one YA session id in URLs,
  persisted YA metadata, REST/WebSocket payloads, activity, and UI copy.
  Provider-native resume ids remain internal provider facts even when the same
  provider id is portable across peers.
- **One visible conversation.** A successful jump does not create a second
  session row or ask the user to paste a handoff. Old provider turns remain in
  their original order and future turns append to the same logical transcript.
- **One active writer.** At most one peer may run or resume the provider
  session. A peer holding a stale replica must reject sends, resumes, and
  provider starts.
- **Terminal jump.** Once an agent's jump request is accepted, the source
  incarnation performs no further semantic work. The provider adapter reaches
  a safe transcript boundary, stops the source process, and transfers control.
- **Automatic continuation.** After import succeeds, the target resumes without
  requiring a fresh user message. The agent receives enough target facts to
  verify its environment and continue the interrupted plan.
- **Mapped project identity.** A stable logical project key resolves to a
  peer-local path. Different home directories, path separators, drive letters,
  and checkout layouts do not require rewriting historical transcript text.
- **No silent repository mutation.** YA does not invent commits, push branches,
  discard changes, overwrite a dirty checkout, or force-update a remote ref.
  The aware agent prepares the checkpoint under the configured policy; YA may
  verify mechanical facts and reports blockers.
- **Observable migration.** The session exposes source peer, target peer,
  migration phase, failure reason, and final owner in status/debug surfaces. A
  quiet viewer-only transcript marker may record a completed move, but it must
  not masquerade as provider-authored output.
- **No lost user messages.** Sends arriving during an accepted jump are either
  held in an explicitly ordered migration queue and delivered once to the new
  owner, or rejected before acceptance with visible retry guidance. They must
  not be delivered to both peers or disappear silently.
- **Failure is ownership-safe.** A failed preparation leaves the source owner
  resumable. A failure after ownership grant leaves the target as the sole
  owner with a visible retry/recovery state; the source does not resume
  automatically and create a split brain.
- **Cache warmth is never promised.** A compatible target can be labeled
  "warm-compatible," but only provider usage evidence after resume can establish
  a real cache hit. Migration correctness never depends on prompt-cache reuse.

Ordinary sessions, unregistered servers, and clients connected to older servers
retain today's behavior and never make federation requests.

## Stable Identity And Metadata

A possible durable manifest is:

```ts
interface FederatedSuperSessionManifest {
  schemaVersion: number;
  sessionId: string; // canonical YA-visible id
  provider: ProviderName;
  providerResumeId: string;
  projectKey: string;
  ownerServerId: string;
  generation: number;
  state:
    | "ready"
    | "preparing-transfer"
    | "transferring"
    | "importing"
    | "resume-failed";
  replicas: Array<{
    serverId: string;
    generation: number;
    bundleDigest: string;
    importedAt: string;
  }>;
  launchFingerprint: PortableLaunchFingerprint;
  lastTransfer?: {
    id: string;
    sourceServerId: string;
    targetServerId: string;
    startedAt: string;
    completedAt?: string;
    expectedCommit?: string;
  };
}
```

Names and storage are not frozen. The important separations are:

- YA identity versus provider resume identity;
- server identity versus connection route;
- authoritative generation versus cached replica;
- provider session state versus repository checkpoint state; and
- correctness compatibility versus cache compatibility.

A peer needs a stable server identity that survives direct/relay route changes.
The current client source model still mostly keys saved connection routes, not
logical servers; [client source runtime topology](client-source-runtime-topology.md)
already identifies the missing server-instance identity.

## Peer Registration And Trust

Peers are mutually trusted YA servers registered by an explicit pairing flow.
Registration should establish:

- a stable server id and display name;
- authenticated keys for server-to-server requests;
- reachable transports or relay routes;
- allowed incoming and outgoing session-transfer policy;
- target capabilities such as OS, architecture, provider availability, and
  portable-bundle protocol versions; and
- logical-project-to-local-path mappings.

Session transcripts can contain source code, tool output, credentials, and
other sensitive material. A bundle must have authenticated encryption in
transit and integrity protection independent of the transport. The existing
relay is a dumb E2E pipe, not automatically a peer registry or distributed
ownership service; reuse its cryptographic/transport primitives only if the
peer protocol keeps those boundaries honest.

Agent-initiated jumps are limited to the session's user-approved peer
allowlist. Peer registration alone does not authorize every agent to send
every session or repository to that machine.

## Logical Projects And Path Mapping

Literal cwd strings are not portable identities. Federation needs a logical
project key with a path mapping on each eligible peer:

```text
projectKey: yepanywhere

mac:
  /Users/kyle/code/yepanywhere
linux:
  /home/kyle/code/yepanywhere
windows:
  C:\Users\kyle\code\yepanywhere
```

The mapping has three jobs:

1. choose the target provider cwd;
2. choose the provider-specific transcript storage directory when that storage
   is derived from cwd; and
3. give the resumed agent an explicit old-root/new-root fact.

It must not globally search-and-replace old paths inside provider history.
Historical tool inputs and output should remain an accurate record of where
they ran. Future turns use the new root.

Project identity discovery by Git remote URL can be a convenience, but it
cannot be the canonical rule: repositories may have no remote, use different
remote names/URLs per host, or contain several checkouts. The user-approved
mapping is authoritative.

## Repository State Contract

Provider transcript migration and working-tree migration are separate.

For the motivating Git workflow, the agent's durable instructions should say:

1. before jumping, stop or settle platform-local commands;
2. inspect status and identify work that must move;
3. run appropriate source-host checks;
4. commit and push a reproducible checkpoint when changes exist;
5. call `jump` with the target and expected branch/commit; and
6. after resume, verify the target checkout and fetch/check out the expected
   commit before further edits or tests.

The jump request may carry:

```ts
interface JumpRequest {
  targetServerId: string;
  reason?: string;
  expectedCommit?: string;
  branch?: string;
}
```

YA can mechanically verify that a supplied commit exists locally, that the
target path is mapped, and later that the target reports the expected commit.
It should not silently perform semantic Git operations on the agent's behalf.

A first prototype may require a clean, pushed Git checkpoint because that is
the narrowest recoverable cross-platform workflow. Later policies may support
Git bundles, workstream checkouts, non-Git projects, or YA-managed artifact
transfer. Those are extensions, not requirements to make the first migration
experiment meaningful.

A dedicated super-session worktree on each peer is attractive because it
avoids colliding with a user's dirty canonical checkout, but it is not assumed
by the base protocol. If adopted, it should reuse the checkout ownership and
cleanup principles in [workstreams](workstreams.md).

## Provider Portable Session Bundles

The provider adapter, not generic federation code, defines what must move:

```ts
interface PortableSessionAdapter {
  inspectPortability(session: ProviderSessionRef): Promise<PortabilityReport>;
  quiesceForTransfer(session: ProviderSessionRef): Promise<QuiescedSession>;
  exportBundle(session: QuiescedSession): Promise<PortableSessionBundle>;
  importBundle(
    bundle: PortableSessionBundle,
    target: TargetProject,
  ): Promise<ImportedSession>;
  resumeImportedSession(session: ImportedSession): Promise<AgentSession>;
}
```

A bundle includes the main provider transcript plus every auxiliary file
required to resume faithfully: subagent records, media references, provider
metadata, compaction state, or other provider-owned sidecars. Copying "the
JSONL" is a hypothesis to verify for a particular provider/version, not a
provider-neutral contract.

The bundle envelope should record:

- provider and bundle schema;
- provider resume id;
- source harness/CLI/SDK versions;
- original and target logical project facts;
- complete file manifest with sizes and digests;
- transcript tail identity needed to detect a changed source;
- ownership generation and transfer id; and
- cache/launch fingerprint facts.

Import writes to a staging location, verifies every digest, then publishes the
provider files atomically enough that a scanner or provider resume cannot see a
partial bundle. Inactive copies are marked as replicas and must not appear as
independent normal sessions.

### Provider posture

- **Claude first.** Existing Remote Executor code already synchronizes Claude
  session files and resumes by the same session id. That makes Claude the
  strongest first experiment, not proof that one JSONL is the complete bundle
  across versions, subagents, compaction, media, or interrupted tools.
- **Codex unverified.** Codex rollout portability, resume behavior after moving
  between native OS paths, and any account/thread affinity must be established
  against the pinned Codex Rust source and matching runtime before claiming
  support.
- **Other providers unknown.** ACP, OpenCode, Gemini, Pi, and compatible
  endpoints need explicit provider contracts. A provider without a proven
  export/import/resume path simply does not advertise super-session
  portability.
- **No cross-provider jump.** Switching providers is a handoff/fork concern.
  It is not the same operation as moving one provider session between peers.

Provider refreshes must re-run the bundle compatibility fixture before
advancing a portable-through marker. A matching provider name alone is never
enough.

## Terminal Jump Semantics

The agent should understand that `jump` is the last operation performed by the
source incarnation. A normal MCP tool that returns and lets the model keep
sampling is insufficient.

The provider-specific implementation must prove one safe shape:

- the jump tool call and a completed tool result are durably represented, then
  the supervisor stops before another semantic model step; or
- the provider exposes a terminal control operation whose pending state can be
  resumed faithfully on the target.

YA must not leave a dangling tool call and assume the target provider will
repair it. It must not edit provider JSONL to synthesize a result unless that
write is explicitly supported and covered by provider fixtures. The existing
[session ownership](session-ownership.md) contract documents why concurrent or
unfinished transcript writers are unsafe.

The resumed agent receives target facts through the narrowest provider-valid
mechanism that appends after the preserved prefix, for example a completed
jump result or provider-supported system reminder:

```text
Migration complete.
Current peer: windows-dev
Platform: win32
Project root: C:\Users\kyle\code\yepanywhere
Previous root: /Users/kyle/code/yepanywhere
Expected Git commit: abc123
Verify the checkout, then continue the interrupted plan.
```

That content is deliberate future-visible provider context. It is permitted
only because super sessions are explicit/default-off; it must not be injected
into ordinary sessions.

## Ownership Transfer Protocol

Equal peers do not imply multi-writer replication. Ownership is an explicit,
monotonic generation:

```text
generation 4: owner = mac
generation 5: owner = windows
```

Only the owner named by the highest accepted generation may run the provider.
A useful transfer sequence is:

1. **Request.** The active agent asks the source peer to jump to an allowed
   target, with an idempotent transfer id.
2. **Target preflight.** The target proves reachability, capability,
   compatible bundle protocol, project mapping, storage capacity, and provider
   availability. It allocates a staging import but does not become owner.
3. **Quiesce.** The source reaches the provider-safe terminal boundary, stops
   the process, flushes provider files, and freezes local sends.
4. **Export and stage.** The source sends the signed/encrypted bundle for
   generation `n` plus the proposed generation `n + 1`. The target verifies and
   stages it without starting the provider.
5. **Grant.** The source durably records a signed ownership grant naming the
   target and generation `n + 1`. From this point the source permanently
   rejects provider writes at generation `n`.
6. **Accept and publish.** The target records the grant, atomically publishes
   the imported bundle, and becomes the only eligible owner.
7. **Resume.** The target starts its local provider adapter with the same
   provider resume id and mapped cwd.
8. **Follow.** Activity notifies clients and peers of the new owner; the
   session view rebinds without changing the YA session id.

Failure rules follow the grant boundary:

- failure before step 5 can unfreeze and resume the source;
- failure after step 5 belongs to the target, which exposes retry or explicit
  recovery without allowing the source to steal ownership; and
- network timeout alone never authorizes either peer to increment ownership.

Automatic time-based lease stealing is unsafe under partition. A manual
force-recovery flow may eventually exist, but it must name the split-brain
risk, inspect both manifests/bundle tails, and choose one branch explicitly.

## Client And Federation Routing

The user's route remains keyed by the super session's YA id, not by the current
server. A completed transfer changes the backing source runtime:

```text
route(session ya_123)
  -> federation manifest owner
  -> YaSourceRuntime(windows)
  -> target session stream
```

This depends on the direction in
[client source runtime topology](client-source-runtime-topology.md): more than
one YA source runtime can exist without global transport, cache, auth, or
activity collisions.

The first implementation need not build a merged multi-host dashboard. It does
need:

- a stable logical server identity;
- a way to resolve the new owner's saved/paired route;
- source-scoped authentication;
- a transfer activity event carrying session id, generation, old/new server
  ids, state, and timestamp;
- stream teardown on the old source and one subscription on the new source;
- no duplicate row from the old replica; and
- explicit unreachable-owner behavior rather than falling back to a stale
  local transcript as writable.

Whether an arbitrary peer proxies the active owner's transcript or tells the
client to connect directly remains open. Direct client rebinding is simpler
when the client is already paired with both peers; peer proxying may be needed
for clients that can reach only one server. Either route must preserve
end-to-end authentication and expose the real owner in diagnostics.

## Prompt/KV Cache Compatibility

Moving provider files does not move server-side KV tensors. Cache reuse happens
only when the target harness renders a provider request whose reusable prefix
matches a still-retained provider cache entry in the same provider cache scope.
Therefore:

> Byte-identical provider request prefix matters; byte-identical JSONL alone
> does not.

A portable launch fingerprint should cover at least:

```ts
interface PortableLaunchFingerprint {
  provider: ProviderName;
  model: string;
  effort?: string;
  harnessVersion: string;
  cliVersion?: string;
  sdkVersion?: string;
  staticSystemPromptHash: string;
  appendedInstructionsHash: string;
  toolDefinitionsHash: string;
  mcpAndPluginHash: string;
  authScopeHash: string;
  cachePolicyHash: string;
}
```

Exact field names are open. The comparison needs to distinguish:

- **resume-compatible**: target can import and continue correctly;
- **warm-compatible**: target is also expected to render the same reusable
  prefix; and
- **incompatible**: target must not import this bundle.

Warm compatibility additionally depends on provider TTL, routing, organization
or workspace scope, and facts the harness may not expose. It is never a
guarantee.

### Claude-specific opportunity

Claude Code documents that its default system prompt embeds cwd, Git state,
platform, shell, OS version, and auto-memory paths, making the default cache
effectively machine- and directory-scoped. The Agent SDK supports
`excludeDynamicSections: true`, which moves those dynamic fields from the
system-prompt prefix into the first user message so the static system prompt
can be shared across machines. YA's currently pinned Agent SDK version
supports the option, but YA's current Claude launch does not request it.

For super sessions:

- the portable prompt shape must be selected from the first turn; enabling it
  only during migration would itself change the prefix and force a cold read;
- the same model, effort, speed mode, static preset version, appended
  instructions, and relevant tool definitions must remain stable;
- target-specific host/path facts should append at the migration tail rather
  than rewrite the prefix;
- the exact copied-resume behavior must still be measured, because the SDK may
  perform resume-time injections not established by documentation alone; and
- changing the prompt shape has a documented trade-off: environment facts
  move from system-level to user-message authority.

Sources:

- <https://code.claude.com/docs/en/prompt-caching>
- <https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts#improve-prompt-caching-across-users-and-machines>

This option must be scoped to explicitly created super sessions until behavior
and quality are measured; it must not silently change all ordinary Claude
launches.

### OpenAI/Codex posture

OpenAI API prompt caching also requires exact reusable prefixes. Direct API
callers can keep a stable `prompt_cache_key` to improve cache routing, but YA's
normal Codex provider delegates to Codex app-server/CLI. The checked-in
app-server protocol exposes cached-input accounting but no cache-routing or
retention control. Codex super sessions must therefore preserve every
observable launch input they can and treat cross-peer warmth as measured,
provider-owned behavior.

Source:
<https://developers.openai.com/api/docs/guides/prompt-caching>.

### Evidence

The first target turn should record provider-reported usage:

- Claude: uncached input, cache-read input, and cache-creation input tokens;
- Codex/OpenAI-shaped providers: input and cached-input tokens, plus cache-write
  tokens when exposed; and
- unknown providers: latency and whatever bounded usage facts exist, without
  translating absence into a cache miss.

YA may report `warm hit`, `cold`, or `unknown` after the fact. It must not label
a target warm merely because fingerprints matched.

## Resource And Liveness Contract

Federation must preserve [architecture mandates](architecture-mandates.md):

- an inactive replica creates no provider process, per-session polling loop,
  file watcher, cache keepalive, or retry timer;
- peer health should use one bounded peer-level mechanism, not one recurring
  task per federated session;
- a transfer retry is bounded and owned by its visible migration operation;
- closing the last client releases old and new session streams as usual;
- client rebinding cannot leave subscriptions alive on both sources;
- a failed target resume does not spin indefinitely; and
- prompt-cache keepalive remains governed by
  [prompt-cache keepalive](prompt-cache-keepalive.md), including its live-client
  lease requirement. Federation does not justify keeping abandoned sessions
  warm across every peer.

Replica storage cleanup may be event-driven or part of a bounded global sweep.
It must not add a timer per replica.

## Compatibility And Rollout

Federated super sessions are optional. A future implementation will add
server-to-server routes/events and client behavior absent from released
servers. Before editing those contracts, follow
[server capabilities](server-capabilities.md) and
[remote hosted compatibility](remote-hosted-compatibility.md):

- inspect the then-current optional-feature release corpus (latest two stable
  releases and every stable release from the preceding 14 days);
- define a new federation capability rather than broadening an existing
  capability;
- use a dedicated federation/bundle protocol version for hard peer
  compatibility, not only a feature hint;
- hide creation/jump controls and make no federation requests when the
  capability is absent;
- keep ordinary session viewing/resume unchanged; and
- obtain maintainer approval for the named releases, routes, events, gates,
  fallback, and compatibility-level decision before implementation.

Peer protocol rollout also follows the grace principles in
[hard development rules](hard-development-rules.md). A newer peer may decline
a migration it cannot safely import, but it should remain usable for ordinary
YA sessions.

## Validation Plan

The user's cross-platform pain meets the trigger for a focused design and
prototype. It does not yet justify production federation without provider
evidence.

### Gate 1: Claude bundle portability

Using isolated credentials/config and disposable projects:

1. Start a Claude Agent SDK session on host A.
2. Stop only at a completed provider-safe boundary.
3. Copy the documented candidate bundle to host B.
4. Resume the same provider id under a mapped cwd.
5. Verify prior context, subsequent tool calls, transcript lineage, session
   discovery, and continued resume on both same-OS and different-path hosts.
6. Repeat with subagents, compaction, attachments/media, interrupted commands,
   approvals, and a near-context-limit transcript.

Record the exact CLI/SDK versions and every file required. A missing case
blocks the claimed bundle schema; it does not become a best-effort silent copy.

### Gate 2: Cache-preserving resume

Create the session with the proposed portable prompt shape from turn one:

1. Warm a long prefix on host A.
2. Transfer within the active cache TTL.
3. Resume on an otherwise matching host B.
4. Record rendered-launch fingerprints and provider usage counters.
5. Change one dimension at a time: path, OS, SDK version, CLI version, model,
   effort, global instructions, MCP set, plugin set, Git state, and auth scope.
6. Establish which changes preserve correctness, which preserve cache reads,
   and which must block migration.

A full prior-prefix cache read is the success target, not an assumption.

### Gate 3: Terminal tool boundary

Prove that an agent can call `jump` during an active turn and that:

- no source-side model sampling or tool call happens after acceptance;
- the transcript contains no unresolved synthetic tool state;
- the target resumes automatically with the migration result/facts;
- a user message racing the jump is delivered once or rejected visibly; and
- abort, provider error, and process crash at every boundary have deterministic
  ownership outcomes.

### Gate 4: Peer ownership and crash injection

Exercise failures before and after every transfer step:

- target unreachable or incompatible;
- source crash before quiesce, after quiesce, during upload, and after grant;
- target crash during staging, after grant, during publish, and during resume;
- duplicated requests and delayed acknowledgements;
- client reconnect during transfer; and
- network partition after both peers have seen different subsets of events.

No test may produce two eligible provider writers for the same generation.

### Gate 5: Native cross-platform proof

Run the motivating workflow:

1. develop and commit on macOS or Linux;
2. agent-initiated jump to native Windows;
3. verify the exact Git checkpoint and mapped cwd;
4. run a Windows-native build/test or PowerShell task;
5. commit/push any Windows-side changes;
6. jump back; and
7. continue in the same YA session and transcript.

Inspect provider cache evidence, session identity, UI continuity, repository
state, and the absence of stale background work on both peers.

## MVP Boundary

If the gates pass, the smallest useful product slice is:

- Claude only;
- two explicitly paired YA peers;
- one logical project with manually configured paths;
- exact compatible Claude CLI/Agent SDK versions;
- explicit/default-off super-session creation;
- Git projects with an agent-prepared pushed checkpoint;
- agent-visible terminal `jump`;
- one ownership generation protocol;
- direct bundle copy with authenticated integrity;
- automatic target resume and client source rebinding; and
- cache hit/miss evidence in diagnostics.

It excludes peer discovery, automatic path inference, cross-provider moves,
non-Git workspace transfer, merged multi-host dashboards, automatic conflict
resolution, lease stealing, and generalized distributed consensus.

## Open Questions

- Does Claude resume after a copied bundle preserve the complete request prefix
  when `excludeDynamicSections` was enabled at session creation?
- What files beyond the primary transcript are required for every supported
  Claude state?
- Can the terminal jump boundary be represented without provider transcript
  editing for each candidate provider?
- Should the target pull/checkout be performed by the resumed agent, a
  pre-resume YA verifier, or a user-selected policy?
- How should a client paired with only the source peer reach a target owner:
  direct re-pair, peer proxy, or relay-mediated source discovery?
- Where is the ownership grant replicated so a restarted or temporarily
  disconnected peer can prove the latest generation without a permanent
  coordinator?
- What explicit recovery action resolves a granted target that is permanently
  lost without allowing accidental split brain?
- Which target-specific tools can load after the cached prefix, and which tool
  changes necessarily make the first target turn cold?
- Should super sessions always use dedicated per-peer worktrees, or may a path
  mapping point at an existing user checkout after a cleanliness preflight?
- How are bundle/media retention and peer removal handled without leaving
  sensitive replicas indefinitely?
