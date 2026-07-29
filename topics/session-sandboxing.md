# Session Sandboxing

> A YA session sandbox is a default-off, all-provider launch-time toggle whose
> enabled policy uses host-OS enforcement to keep ordinary persistent
> agent-controlled filesystem mutations inside the canonical session project.
> Fixed YA-private provider-state, cache, and temporary roots support provider
> replay and common tools; provider-native controls are additional defense.

Topic: session-sandboxing

Status: **implemented Linux v1 contract.** Local Claude-family and Codex
sessions use trusted Bubblewrap; other providers, remote executors, and
non-Linux hosts fail an enabled launch before provider work begins.

See also:

- [session-defaults](session-defaults.md) — the saved all-provider value that
  seeds New Session.
- [permission-mode](permission-mode.md) — approval policy is independent from
  filesystem confinement.
- [security](security.md) — authenticated, public, and future delegated-access
  trust boundaries.
- [subprocess-environment](subprocess-environment.md) — process-creation
  environment and inheritance boundaries.
- [agent-working-directory-tracking](agent-working-directory-tracking.md) —
  the effective project directory must remain explicit.
- [provider-child-sessions](provider-child-sessions.md) — provider-launched
  child work must inherit the parent boundary.
- [bang-commands](bang-commands.md) — YA-owned command execution is a separate
  path and is not automatically covered by a provider process sandbox.
- [remote-hosted-compatibility](remote-hosted-compatibility.md) — clients must
  capability-gate any new launch field against older servers.

## Product Decision

YA should expose one provider-independent **Sandbox session** toggle at new
session creation. Settings > Session Defaults exposes the matching **Sandbox
new sessions** toggle. Both are off by default.

The toggle appears only when the server advertises an actively available
session-sandbox backend and the selected execution target is an implemented
local Claude-family or standard Codex backend. New Session hides it on macOS,
Windows, Linux hosts whose trusted Bubblewrap preflight fails, and while a
remote executor is selected. Unsupported hosts, providers, and executors do
not get explanatory placeholder copy.

The toggle has short informational text:

> Limits persistent writes to this project; other host files stay readable.
> Keep installable environments here (e.g. `.venv` or `.pixi`).
>
> Requires Linux + Bubblewrap.

More detailed help may explain that the sandbox also supplies private temporary
and cache space. This is product/UI guidance, not a message injected into the
provider conversation.

The controls are toggles, not level pickers or path-policy editors. The two
conceptual and persisted states are:

```ts
type SessionSandboxLevel = "none" | "project-write";
```

Toggle mapping:

- off — `none` (provider behavior, with no YA filesystem boundary);
- on — `project-write` (Project writes only, plus fixed private
  scratch/cache).

`project-write` means the agent may mutate the selected project tree but may
not mutate filesystem objects outside it. It does not mean read-only, and it
does not by itself disable network access, process signaling, or reads outside
the project.

The value is an all-provider session default:

```ts
interface NewSessionDefaults {
  // Existing fields...
  sandboxLevel?: SessionSandboxLevel;
}
```

Settings > Session Defaults configures the standing toggle. New Session shows
the effective toggle and lets the user settle it for that session before the
provider process is created. It is not provider-keyed merely because providers
offer different native sandbox mechanisms. The initial scope has no
project-level default; adding one later would follow
[project-settings-overrides](project-settings-overrides.md).

The first version is deliberately one fixed policy, not a path-policy editor.
It has no per-session exceptions for additional writable roots, even when a
session's purpose would make one convenient. Such exceptions would complicate
the security claim, status, persistence, and test matrix before the base
boundary is proven.

The built-in and legacy fallback is `none` until a separate product decision
promotes a sandboxed default. This follows [vanilla-defaults](vanilla-defaults.md):
the feature is visible and selectable, but an absent value on an existing
installation must not unexpectedly change provider behavior.

Configuration precedence is:

1. explicit selection in New Session;
2. `newSessionDefaults.sandboxLevel`; then
3. built-in `none`.

An invalid value is rejected. A requested `project-write` level that the
selected execution host cannot enforce blocks process creation with an
actionable error; it never falls back to `none`.

## Compatibility Boundary

The setting, launch field, and effective-status fields use the permanent,
dynamically advertised `session-sandboxing` server capability, introduced in
0.7.1. A server advertises it only while its local host preflight reports an
available backend. Without it, a client hides the control, sends no sandbox
field, and retains existing launch behavior. Existing clients omit the field
and therefore resolve to `none` on a new server.

The separate permanent `session-sandboxing-status` capability gates the
structured `version.sessionSandboxing` preflight result. A client requires
both capabilities plus an `available` result before rendering or sending the
control. This deliberately hides the feature against intermediate development
servers that advertised only protocol understanding on unsupported hosts.
Missing status support has the same no-field fallback as a missing sandbox
capability.

Preflight is advisory and cached briefly for routine version reads; it has no
background polling loop. A fresh version request rechecks it. Every requested
`project-write` launch repeats the authoritative checks with the final project
and private-state bind policy. Capability or preflight staleness must therefore
produce a closed launch failure, never an unlocked provider process.

The pre-implementation stable-release audit covered v0.7.0 and v0.6.2. Neither
release has the YA `sandboxLevel` launch field or capability. The exact routes,
request and response fields, and no-capability fallback are pinned in
`SERVER_CAPABILITIES.sessionSandboxing`.

## Distinct From Permission Mode

Permission mode answers whether a provider or YA asks before a tool action.
Session sandbox level answers what the operating system will allow even after
the action is approved.

The two policies compose by intersection:

- `Bypass` + `Project writes only` auto-approves actions but keeps the project
  write boundary.
- `Plan` + `Project writes only` remains effectively read-only where the
  provider honors Plan.
- A provider denial remains a denial even when the OS sandbox would have
  allowed the write.
- An approval can never widen the OS sandbox.

Prompt instructions, approval callbacks, tool-name deny rules, and setting the
provider `cwd` are cooperative controls. None satisfies `project-write` on its
own.

The first version also does not inject an informational message about the
restriction into the provider conversation. Ordinary denied operations expose
the boundary through normal command/tool failures. A later opt-in notification
could avoid wasted attempts, but it must be weighed against encouraging an
agent to search for a surprising bypass and against changing provider context.

## Existing Sandbox Vocabulary

YA already has two related but narrower mechanisms:

1. `SessionSandboxPolicy` in session summaries is a read-only projection of
   Codex `turn_context.sandbox_policy`. It records what a provider transcript
   reported; it is not a YA launch request or enforcement proof.
2. `CodexProvider.mapPermissionModeToThreadPolicy` currently maps ordinary
   modes to provider-native `workspace-write`, Plan to `read-only`, and Bypass
   to `danger-full-access`. That mapping is coupled to permission mode and does
   not define a cross-provider sandbox level.

Do not repurpose either as the new source of truth. A later implementation
should keep separate concepts:

- **requested YA sandbox level** — the persisted session choice;
- **effective YA enforcement** — what the execution host actually installed;
  and
- **provider-reported policy** — optional provider-native status, including the
  existing Codex projection.

Process Info should label the last item **Provider-reported sandbox** once YA
also has its own sandbox status, so a `workspace-write` transcript value is not
mistaken for verified host confinement.

## Project-Write Filesystem Contract

### Boundary root

Before process creation, YA resolves and validates the selected project
directory. Enforcement anchors to that canonical directory, not to a textual
prefix and not merely to the child process's current working directory.

If the selected project path is itself a symlink, its target becomes the
canonical root. Replacing or retargeting the path after validation must not
move the active boundary; the backend needs an inode-, mount-, handle-, or
equivalently stable anchor.

### Allowed mutations

The agent-controlled execution domain may create and mutate ordinary files and
directories beneath the canonical project root, subject to normal OS
permissions and the stricter permission/provider policies in effect.

The backend should consume a normalized, canonical writable-root policy rather
than provider- or mechanism-specific path flags. Each root needs an explicit
lifetime:

- **persistent** — host data that survives the session; v1 contains only the
  canonical project root; or
- **private** — sandbox-owned scratch/cache state that is discarded or retained
  under a bounded YA lifecycle and cannot name an arbitrary host path.

The list is an internal enforcement input, not a v1 user-facing path editor.
Every root is resolved before launch and passed to the backend through an
argument-safe API, never concatenated into a shell command.

The write boundary covers at least:

- create, open-for-write, truncate, append, and memory-mapped writes;
- remove, rename, exchange, and move;
- symbolic link and hard-link creation;
- permission, ownership, timestamp, extended-attribute, and ACL changes;
- Unix-domain socket and named-pipe creation; and
- equivalent provider-native edit/write operations that do not happen through
  a visible shell command.

### Denied mutations

The same operations are denied outside the canonical project root, including
when reached through:

- absolute paths;
- `..` traversal;
- a symlink inside the project whose target is outside it;
- a symlinked parent exchanged after validation;
- a helper process, shell, compiler, package script, language runtime,
  provider subagent, or other descendant; or
- a provider's in-process edit tool.

A path such as `project/link-to-home/.ssh/config` is outside the allowed write
tree after symlink resolution even though its first component is inside the
project.

Creating a new hard link across the boundary is denied. A pre-existing regular
file with one name inside and another outside is different: writing either
name mutates the same inode. The first Bubblewrap backend may reject such
multiply-linked project files or document them as an explicit v1 limit; it
must not claim that a mount-path policy can discover which existing link is
the “outside” object.

Reads outside the project remain permitted in this first level. The UI must say
so; **Project writes only** is not a confidentiality boundary.

### Runtime state and scratch space

Provider CLIs commonly write transcripts, caches, sockets, and state outside
the project. A whole-process sandbox that simply makes every other host path
read-only may therefore break startup or resume, while a broad exception for
the provider's home directory gives agent-controlled children a bypass.

Ordinary scripts also assume writable temporary and cache locations. The
enabled v1 policy provides fixed, sandbox-private writable locations and
redirects `TMPDIR`, `TMP`, `TEMP`, `XDG_CACHE_HOME`, and established
HuggingFace, pip, uv, npm, and Yarn cache variables to them. A later backend
may mount a private writable view over conventional cache paths such as
`~/.cache` when that is more compatible than environment rewriting. These
roots must be:

- private to one canonical project sandbox or an equivalently isolated
  execution domain;
- retained under YA's data directory so every sandboxed session and fork for
  that project remains replayable across server restarts;
- unable to resolve, rename, link, or mount their way to host-persistent paths;
  and
- reported as private scratch/cache rather than as another persistent writable
  root.

Globally shared persistent caches are not part of v1. They add cross-project
poisoning, quota, ownership, and cleanup questions. V1 does share its private
cache among sandboxed sessions for the same canonical project; the project
boundary is the isolation and retention unit.

Conda, Pixi, and similar environments need the same distinction. An
environment beneath the project is already writable. An environment outside
the project remains read-only unless a backend can present a private writable
overlay or copy to that session. YA must not grant write access to a shared
external environment merely so package installation succeeds: replacing code
that the owner later executes would be a durable boundary escape. Package
installation into an outside environment may therefore fail on a backend that
cannot isolate it.

An acceptable backend must resolve that control-plane/tool-plane tension
explicitly. Possible shapes include:

- provider cooperation that sandboxes tool/edit execution below an
  unsandboxed control process;
- a broker that owns provider persistence while the provider execution domain
  stays confined;
- private per-session runtime state that is writable by the control plane but
  not addressable by agent tools; or
- a stronger OS process split.

Linux v1 gives each canonical project that has used sandboxing one YA-owned
private provider-state, temporary, and cache root beneath the YA data
directory. Its stable key is derived from the canonical project path and is
persisted in session metadata so a YA server restart keeps using the same
state. Claude and Codex have separate provider subtrees within that root:
Claude receives a private `CLAUDE_CONFIG_DIR`; Codex receives a private
`CODEX_HOME`.

Those provider trees contain the authoritative live transcripts. Each session
and explicit fork still has its own provider transcript file; they share the
project's provider configuration, agents/skills, cache, and temporary space,
not one JSONL. YA does not copy or append a concurrently written JSONL into the
provider's global tree.

The first initialization bootstraps a narrow provider-specific set of auth,
configuration, plugin, rule, and skill entries. Regular mutable files are
copy-on-write filesystem clones when supported, with a normal-copy fallback.
They are never hard links: a hard link would be the same inode and would grant
the sandbox write access to the original. Symlinks may be preserved for
deliberately read-only assets; the Bubblewrap contract keeps an outside target
read-only, and the regression suite verifies both the target and bootstrap
source remain unchanged. Session transcripts, logs, cache, and temporary files
start private rather than being linked from global state.

A generic writable exception for the real `$HOME`, provider state directory,
`/tmp`, cache root, or shared language environment is not equivalent to
Project writes only. If a provider cannot function with the private-state
shape, it is unsupported for this level until the boundary is redesigned.

Project-local temporary/cache directories may be used when doing so preserves
provider behavior and does not rewrite unrelated user configuration.

### Future global transcript integration

V1 keeps Claude and Codex transcripts in their project-private provider-state
directories and merges those directories into YA's ordinary session readers.
This preserves one authoritative file while providing list, detail, replay,
resume, and same-session process recreation after a YA server restart.

A follow-up should continuously integrate sandboxed Claude and Codex
transcripts into each provider's conventional global session tree. Besides the
main YA view, that makes provider-native discovery, external diagnostics, and
manual session identification work normally. Do not implement this as an
assumed-safe copy or second writer. First establish each provider version's
actual locking and persistence protocol using available source plus targeted
decompilation and `strace`/`truss`-style filesystem tracing. The evidence must
cover open flags, advisory or mandatory locks, append behavior, rename/replace,
flush and close boundaries, sidecar/index files, crash recovery, and concurrent
reader behavior. The integration design must then preserve the provider's
single-writer and lock semantics while a transcript is live, and its regression
tests must detect provider upgrades that invalidate those findings.

There is also a retention-policy knowledge gap. YA does not yet know what
sunset, age, total-disk, per-session quota, compaction, or index-pruning policy
Claude and Codex currently apply to their global session state, nor what a
future harness release may add. Private v1 transcripts are deliberately outside
those conventional trees, which reduces their exposure to provider rotation;
YA's private-state retention policy is therefore a separate decision. V1 keeps
that state rather than aging it out automatically and may report its disk usage.
Before later publishing transcripts into conventional provider trees, establish
how provider cleanup recognizes live, indexed, and removable state so that the
integration does not make a replayable sandbox session unexpectedly eligible
for provider rotation.

## OS Enforcement Contract

The quality target is basic OS-enforced containment: the kernel or another OS
security primitive makes the decision, rather than instructions asking the
model to behave. Plain `chroot` is not the target or a security boundary. The
policy preserves outside reads and is not represented as hostile multi-tenant
container isolation.

Linux v1 uses Bubblewrap. A future non-Linux backend may use a restricted
process launcher, filesystem policy, namespace/container helper, capability
system, or another native facility. Regardless of mechanism, it must:

1. install the restriction before provider- or agent-controlled code runs;
2. apply to direct edits and every descendant execution path;
3. be non-widenable by the child, its permission mode, or later prompts;
4. close or narrowly account for inherited writable file descriptors;
5. prevent path-resolution, symlink-swap, mount, and rename escapes within the
   claimed filesystem contract;
6. report setup success from the execution host rather than assuming it from a
   requested flag;
7. fail process creation closed when setup is unavailable or incomplete; and
8. clean up per-session mounts, namespaces, helpers, and runtime directories
   after termination without leaving a privileged background process.

The sandboxed execution domain must also have no path back to the host
identity's privilege-escalation authority. This includes `sudo` under a
passwordless sudo policy, setuid/setgid executables, file capabilities,
retained capabilities, and inherited control sockets or file descriptors that
can ask an unsandboxed YA process to act on its behalf. A backend may use a
separately installed, narrowly scoped privileged helper, but the
agent-controlled child must not be able to widen or directly invoke that
authority.

Whole-YA privilege hardening is a separate precaution: YA should attempt to
disable later privilege gain by default, with an explicit operator opt-out,
even when every session selects `none`. It is therefore not part of the
meaning of `project-write`. Linux v1 drops capabilities and installs
no-new-privileges for the sandboxed provider domain; applying the precaution
to the already-running YA server and every unsandboxed provider launch remains
separate work.

For an SSH or other remote executor, enforcement must be installed and
attested by the remote execution host. Sandboxing the local SSH client does not
confine the remote provider.

Provider-native sandboxing is welcome as defense in depth and may be necessary
to cover provider-internal edit APIs. It does not replace the OS-enforcement
requirement, and YA must not claim `project-write` merely because a provider
accepted a flag named `workspace-write`.

## Session Lifetime

The selection is settled before the first provider process is created and
persisted as session-scoped metadata. Every process creation for that session,
including idle resume and crash recovery, must reapply the same level before
the provider receives work.

The level is not a live toolbar toggle. Changing the write boundary of a
running process would create an ambiguous interval and provider-specific
state. A different level requires a deliberately created replacement session
or another future restart flow that terminates the old process before applying
the new boundary.

Existing sessions with no stored value resolve to `none`. A process discovered
as externally owned has no verified YA sandbox level, even if its provider
transcript reports a native sandbox policy.

New-session derivatives must not silently weaken confinement:

- an explicit transcript fork, fork-after-summary target, retitle helper,
  recap fork, handoff, or restart-as-new flow inherits the source level;
- an explicit fork cannot override the source level;
- a separately created New Session settles its own visible pre-launch choice;
  and
- resuming the same session uses its persisted level, not the user's newer
  global default.

Provider children created beneath the provider process inherit its Bubblewrap
namespace. Same-session process recreation reloads the persisted level and
private state key. Every derivative for the same canonical project uses that
project's same private provider-state root while its provider-native transcript
file remains distinct.

Linux v1 runs explicit transcript forks, retitle-via-fork, fork-summary
generation and target creation, and fork-mode recaps through the inherited
private provider-state launcher. Host-side Claude transcript copying opens the
private transcript directory component by component without following
agent-controlled symlinks. YA-simulated `side-session` recaps remain
unavailable and are rejected before launch; Off, Native, and fork recaps remain
available.

## Status And Evidence

A requested value is not enough for security-facing UI. The server exposes a
normalized host-availability concept before launch:

```ts
interface SessionSandboxAvailability {
  state:
    | "available"
    | "unsupported-platform"
    | "missing-bubblewrap"
    | "untrusted-bubblewrap"
    | "unsupported-version"
    | "probe-failed";
  platform: string;
  backend?: "bubblewrap";
  version?: string;
}
```

Only `available` permits the `session-sandboxing` capability. Separately, an
enabled process exposes normalized enforcement evidence:

```ts
interface SessionSandboxEnforcement {
  requested: SessionSandboxLevel;
  effective: SessionSandboxLevel;
  state: "enforced" | "unsupported" | "setup-failed";
  hostBackend?: string;
  providerPolicy?: string;
}
```

- configured vs. active;
- YA host enforcement vs. provider-reported policy; and
- local vs. remote execution host.

Agents and Process Info may show **Project writes only** only for `enforced`.
They should show setup failure rather than an unlocked process row, because a
requested confined session must never launch unlocked.

The server persists the requested level, project-scoped state key, canonical
project path, and effective backend status. It does not expose or persist the
full provider or Bubblewrap command line as sandbox status.

## Threat Model

Assume a frontier model or agent-generated program may intentionally search for
an escape, and that model competence will improve. Cooperative prompting is
not a control.

The initial level protects one narrow asset: filesystem integrity outside the
session project against ordinary agent-controlled filesystem mutations. It
trusts:

- the host kernel and selected enforcement primitive;
- YA's pre-exec launcher and policy construction;
- the canonical project root supplied by the authenticated owner; and
- any privileged helper that the selected backend requires.

It does not promise protection against:

- kernel or sandbox-primitive vulnerabilities;
- reads or secret disclosure outside the project;
- network exfiltration or mutation through remote APIs;
- signaling or debugging unrelated processes;
- pre-existing writable file descriptors or privileged IPC unless the backend
  explicitly closes/blocks them;
- Docker/container sockets, desktop automation, databases, or other indirect
  mutation channels;
- devices and kernel interfaces outside the ordinary filesystem policy;
- a compromised YA server or authenticated owner; or
- hard-linked files, nested mounts, and other aliasing cases until the chosen
  backend's contract and tests define them.

These are not reasons to replace OS enforcement with warnings. They are the
line between a useful basic project-write boundary and a product claim of
general host isolation.

## Future “Locked To This Session” Share

The motivating future surface lets a novice or delegated guest interact with
one session/project pair without receiving ordinary authenticated YA access.
Project-write confinement is a prerequisite for that surface, not the whole
authorization design.

Before a share may be described as **locked to this session**, it must also:

- admit requests only to one exact session and project;
- require the session's sandbox status to be actively `enforced`;
- prevent navigation and API access to other sessions, projects, settings,
  devices, host diagnostics, and source-control surfaces;
- make any guest-visible YA-owned execution path, including `!!` commands,
  run inside the same boundary or remain unavailable;
- define whether the guest may answer approvals, interrupt, restart, upload,
  or create files;
- be revocable and auditable; and
- state plainly that Project writes only still permits outside reads and
  network access.

If the future guest threat model includes confidentiality or malicious
prompting, it needs a stronger level that restricts reads, network, IPC, and
host APIs. Do not overload `project-write` or its UI copy to imply those
protections.

This future share is distinct from today's public read-only bearer links. It
requires a new authenticated/delegated admission contract and must not turn an
existing public-share secret into session write authority.

## Verification Contract

Deterministic backend tests must attempt real mutations, not only inspect
configuration:

- a normal create/edit/delete inside the canonical project succeeds;
- absolute and relative writes outside fail;
- a project-local symlink to an outside file or directory cannot be used to
  mutate it;
- rename, new hard-link, metadata, and memory-mapped write variants cannot
  escape;
- a pre-existing hardlink alias is either rejected at launch or reported as a
  known unenforced case rather than counted as protected;
- descendant shells, package scripts, provider children, and direct provider
  edits receive the same boundary;
- inherited descriptors and writable IPC do not provide an undeclared escape;
- permission mode Bypass cannot widen the boundary;
- provider transcript/state persistence and same-session resume still work;
- the production launch policy works with Bubblewrap 0.4.0 and does not assume
  an unprobed newer option;
- unsupported local and remote hosts fail before the first provider turn;
- macOS, Windows, missing, untrusted, outdated, and runtime-unusable
  Bubblewrap preflights do not advertise the usable capability;
- a missing `bwrap` error names Bubblewrap and includes the detected
  distribution's installation command, while a failed runtime probe reports
  its different cause;
- setup failure leaves no provider child or privileged helper running; and
- the server reports requested/effective/backend state accurately.

Keep an outside sentinel tree and verify its contents and metadata are
byte-for-byte unchanged after the escape suite. Add adversarial agent runs as
supplemental evidence, not as a replacement for syscall-level tests: a model
failing to discover an escape does not prove the boundary.

The current automated Linux baseline in
`packages/server/test/session-sandbox.test.ts` executes the production
Bubblewrap wrapper. It proves project, provider-state, and temporary writes
succeed while direct outside writes, project-to-outside symlink writes, and
bootstrap-symlink writes fail. It also proves that each provider launch mounts
the already-open project directory descriptor, refusing a launch when the
configured pathname has been renamed and replaced after preflight. It verifies
copied configuration has a different inode, missing, untrusted, and unusable
Bubblewrap diagnostics stay distinct,
unsupported providers and remote executors fail, project state keys are
stable, Claude forks create separate JSONL in the inherited private root,
agent-controlled transcript-directory symlinks are rejected, and persisted
metadata reconstructs a replayable private reader after service reload.
The escape case also verifies no-new-privileges, empty effective and permitted
capability sets, and refusal to create an outside-file hard link through the
writable project mount.

## Linux Backend Evidence

The dated Rocky 8 mechanism survey, Bubblewrap source notes, and rejected
backend candidates live in
[`session-sandboxing.evidence.md`](session-sandboxing.evidence.md). Read that
evidence before changing the Linux backend, its minimum Bubblewrap version, or
the Rocky/RHEL support claim. The product contract and current backend decision
remain below.

### Linux v1 decision

Linux v1 requires trusted non-setuid Bubblewrap 0.4.0 or newer. Use it when the
version check and runtime probe pass; otherwise fail an enabled launch before
provider process creation with an actionable error. Absence of `bwrap` includes
an installation command, while an old version or failed runtime probe names
the relevant prerequisite.

Never substitute provider cooperation, plain chroot, PRoot, or an unlocked
process merely because Bubblewrap is missing.

The implemented provider matrix is intentionally small:

- local `claude`, `claude-gateway`, and `claude-ollama` sessions use the
  Claude private-state launcher;
- local standard `codex` sessions use the Codex private-state launcher;
- `codex-oss`, Gemini, OpenCode, Grok, Pi, ACP, and other providers reject
  `project-write`;
- SSH/remote executors reject it because confinement must run on the remote
  host; and
- non-Linux hosts reject it until a backend satisfies the same contract.

YA accepts only a root-owned Bubblewrap binary at a fixed system path that is
not group- or world-writable. Host preflight checks the trusted path, version,
and baseline namespace/mount policy before advertising availability. The
launcher then probes the complete final mount shape with `/bin/true` before it
starts the provider. The enabled process gets a read-only host root, writable
canonical project and private state binds, private `/tmp` and `/var/tmp`, a
private `/run`, new process/device views, a
dropped capability set, a new terminal session, parent-death coupling, and
sanitized broker environment variables. The argument set is exercised against
Rocky 8's Bubblewrap 0.4.0. Each provider launch opens and identity-checks the
project directory, mounts that descriptor rather than resolving the pathname
again, and changes to the project only after the mount is installed.

## Backend Integration Gate

Before changing the Bubblewrap policy or adding a future platform backend,
validate it on:

- unprivileged availability and installation burden;
- Linux, macOS, Windows, and remote-host coverage;
- symlink/rename/mount/file-descriptor semantics;
- direct provider edit and descendant inheritance coverage;
- provider transcript, cache, and resume compatibility;
- whether a privileged long-lived daemon is required;
- auditable setup success and fail-closed behavior; and
- maintenance risk as kernels and provider launch paths evolve.

Record each chosen backend and provider matrix here before code claims
`project-write`. A provider-cooperative-only prototype may be useful for
learning, but its UI/status must say provider policy rather than YA-enforced
Project writes only.

## Open Questions

- Which OS primitive gives the simplest reliable write-only boundary on
  non-Linux platforms without a privileged always-on daemon?
- Can provider control-plane state be separated from agent-controlled tool
  execution for every provider YA launches?
- Should a later stronger level hide outside reads and disable network, or
  should those be independent capabilities?
- How should ordinary repositories, linked worktrees whose Git directory is
  outside the project, nested mounts, and pre-existing hard links behave?
- Which temporary/cache locations can be made project-local without changing
  provider semantics?
- Would an optional provider-context notification about the active boundary
  save enough failed attempts to outweigh context churn and bypass-seeking
  behavior?
- What exact admission, approval, and audit contract should the future locked
  share use?
