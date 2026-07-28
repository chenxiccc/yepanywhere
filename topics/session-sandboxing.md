# Session Sandboxing

> A YA session sandbox is a default-off, all-provider launch-time toggle whose
> enabled policy uses host-OS enforcement to keep persistent
> agent-controlled filesystem mutations inside the canonical session project,
> with provider-native controls serving only as additional defense.

Topic: session-sandboxing

Status: **design contract; Linux v1 requires Bubblewrap, while non-Linux and
provider-state mechanics remain open.** This topic does not authorize an
implementation by itself.

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

The toggle has short informational text:

> Limits persistent writes to this project. Keep installable environments in
> the project (for example, `.venv` or `.pixi`).

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

The future setting, launch field, and effective-status fields require one
permanent server capability. Without it, a new client hides the control, sends
no sandbox field, and retains existing launch behavior. Existing clients omit
the field and therefore resolve to `none` on a new server.

The protocol capability means “this server understands and preserves the YA
sandbox contract,” not “this execution host can enforce every level.” Host,
platform, provider, and remote-executor support are runtime facts checked
before launch. Advertising the capability must never make an unsupported
`project-write` request fall back to an unlocked process.

Before implementation, perform the stable-release corpus audit required by
[server-capabilities](server-capabilities.md) and
[remote-hosted-compatibility](remote-hosted-compatibility.md), then pin the
exact capability and fallback contract there.

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
enabled v1 policy may therefore provide fixed, sandbox-private writable
locations and redirect `TMPDIR`, `TMP`, `TEMP`, `XDG_CACHE_HOME`, and
well-established tool cache variables to them. It may mount a private writable
view over conventional cache paths such as `~/.cache` when that is more
compatible than environment rewriting. These roots must be:

- private to the session or an equivalently isolated execution domain;
- bounded in size and cleaned up under a defined lifecycle;
- unable to resolve, rename, link, or mount their way to host-persistent paths;
  and
- reported as private scratch/cache rather than as another persistent writable
  root.

Shared persistent caches are not part of v1. They add cross-session poisoning,
quota, ownership, and cleanup questions.

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

The provider-state mechanism is deliberately not selected here. A generic
writable exception for the real `$HOME`, provider state directory, `/tmp`,
cache root, or shared language environment is not equivalent to Project writes
only. If a provider cannot function without such an agent-visible persistent
exception, it is unsupported for this level until the boundary is redesigned.

Project-local temporary/cache directories may be used when doing so preserves
provider behavior and does not rewrite unrelated user configuration.

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

Whole-YA privilege hardening is a separate precaution: it should apply even
when a session selects `none`, and is therefore not part of the meaning of
`project-write`.

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

- a fork, handoff, or restart-as-new flow inherits the source level by default;
- a visible pre-launch control may change it for the new session; and
- resuming the same session uses its persisted level, not the user's newer
  global default.

Provider children and YA-simulated side sessions inherit the parent level
unless they are visibly created as separate sessions with their own
pre-launch choice. A helper must never escape merely because it uses a
different provider.

## Status And Evidence

A requested value is not enough for security-facing UI. The server should
expose a normalized status concept along these lines:

```ts
interface SessionSandboxEnforcement {
  requested: SessionSandboxLevel;
  effective: SessionSandboxLevel;
  state: "enforced" | "unsupported" | "setup-failed";
  hostBackend?: string;
  providerPolicy?: string;
}
```

Names are directional, not final wire design. The important distinctions are:

- configured vs. active;
- YA host enforcement vs. provider-reported policy; and
- local vs. remote execution host.

Agents and Process Info may show **Project writes only** only for `enforced`.
They should show setup failure rather than an unlocked process row, because a
requested confined session must never launch unlocked.

The server must persist enough evidence to explain how a session was launched
without persisting sensitive command lines, environment variables, or mount
contents.

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
- a missing `bwrap` error names Bubblewrap and includes the detected
  distribution's installation command, while a failed runtime probe reports
  its different cause;
- setup failure leaves no provider child or privileged helper running; and
- the server reports requested/effective/backend state accurately.

Keep an outside sentinel tree and verify its contents and metadata are
byte-for-byte unchanged after the escape suite. Add adversarial agent runs as
supplemental evidence, not as a replacement for syscall-level tests: a model
failing to discover an escape does not prove the boundary.

## Linux Mechanism Survey: Rocky 8 And Later

Surveyed 2026-07-28 against upstream documentation and a Rocky Linux 8.10
host. RHEL/Rocky 8's practical baseline is Linux 4.18 and glibc 2.28
([RHEL 8 kernel documentation](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/8/html/managing_monitoring_and_updating_the_kernel/assembly_the-linux-kernel_managing-monitoring-and-updating-the-kernel),
[RHEL 8.0 release notes](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/8/pdf/8.0_release_notes/red_hat_enterprise_linux-8-8.0_release_notes-en-us.pdf)).

### Required Linux v1 backend: Bubblewrap

Use a trusted system `bwrap` outside the project when it is installed and a
runtime probe proves that unprivileged user and mount namespaces work.
Presence on `PATH` alone is not support. Never select a project-local binary,
and do not fall back from a failed probe to an unlocked provider process.

Linux v1 supports Bubblewrap 0.4.x rather than requiring a recent upstream
release. The launcher may use newer options only after probing for them; the
baseline policy must be expressible with the Rocky 8 `0.4.0` interface verified
below.

Missing-Bubblewrap launch errors must name the dependency and offer an
installation command appropriate to the detected host family. For example:

```text
Sandboxed sessions require Bubblewrap (bwrap).
Install it with: sudo dnf install bubblewrap
```

Known guidance includes `sudo dnf install bubblewrap` for Rocky/RHEL/Fedora and
`sudo apt install bubblewrap` for Debian/Ubuntu. If `bwrap` exists but the
runtime probe fails, the error must instead report the failed prerequisite,
such as disabled unprivileged user namespaces; reinstalling the package is not
useful advice. YA never runs the install command itself.

The basic mount shape is a read-only host view followed by a writable bind of
the canonical project at the same path. The
[Bubblewrap manual](https://github.com/containers/bubblewrap/blob/v0.4.0/bwrap.xml)
states that filesystem operations are applied in argument order and provides
both `--ro-bind` and `--bind`; the current
[OpenAI Codex Linux sandbox](https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md)
uses the same read-only-root plus writable-roots construction. This preserves
ordinary reads of host tools and files instead of building a tiny chroot.

A bare `--ro-bind / /` plus project bind is only a mechanism probe, not the
complete YA policy. The production argument set must also:

- install a new safe `/proc` and `/dev` view and make `/sys` appropriately
  read-only or private;
- replace or mask host runtime paths such as `/run`, `/tmp`, and `/var/tmp`
  before adding fixed private scratch/cache;
- hide pathname and abstract Unix sockets, D-Bus, container-engine sockets,
  SSH agents, and other brokers that could perform outside writes on the
  child's behalf;
- close inherited file descriptors and sanitize environment variables that
  point to host control channels;
- use `--new-session`, because Bubblewrap documents terminal injection as an
  escape when neither that flag nor an equivalent seccomp rule is present;
- use `--die-with-parent`, a PID namespace, no new privileges, and no retained
  host capabilities; and
- account for submounts below the project and the read-only host view.

This policy construction remains YA's responsibility; Bubblewrap explicitly
describes itself as a low-level tool rather than a complete sandbox and warns
that anything mounted into the sandbox, including D-Bus sockets, can become an
escape path
([upstream security notes](https://github.com/containers/bubblewrap/blob/main/README.md#sandbox-security)).

Rocky 8 provides `bubblewrap-0.4.0-2.el8_10` in BaseOS
([binary packages](https://download.rockylinux.org/pub/rocky/8/BaseOS/x86_64/os/Packages/b/),
[source package](https://download.rockylinux.org/pub/rocky/8.10/BaseOS/source/tree/Packages/b/)).
On the surveyed host that non-setuid `0755` binary:

- started successfully under kernel 4.18/glibc 2.28 with unprivileged user
  namespaces;
- allowed an ordinary create beneath the writable project bind;
- denied a direct outside create and a write through a project symlink to an
  outside directory; and
- reported `NoNewPrivs: 1` in the child.

It did not prevent mutation through a pre-existing hardlink alias, confirming
the explicit v1 limit above. These are mechanism probes, not evidence that the
full provider/control-plane policy is solved.

The distro binary requires no glibc symbol newer than 2.14. Current upstream
Bubblewrap is small C code and declares Meson 0.49+, libcap, and optional
libselinux as its build dependencies. A fresh current-upstream build was not
completed on the surveyed host because its development dependencies were not
installed, so the verified Rocky 8 claim is the maintained distro package,
not an untested promise about every future release.

Do not make Bubblewrap setuid as a fallback. Current upstream builds disable
historical setuid support by default, and its security history includes
setuid-only privilege-escalation defects
([security policy](https://github.com/containers/bubblewrap/blob/main/SECURITY.md),
[advisories](https://github.com/containers/bubblewrap/security/advisories)).
If unprivileged user namespaces are disabled, Linux v1 reports the enabled
policy unsupported. A later narrowly scoped helper/service would be a separate
backend requiring the full contract suite.

Bubblewrap is also the relevant agent-industry choice rather than merely a
desktop sandbox. OpenAI Codex prefers system Bubblewrap while retaining a
compatibility path for old versions that lack `--argv0`.

Anthropic's
[sandbox runtime](https://github.com/anthropic-experimental/sandbox-runtime)
(SRT) is a useful policy reference and may become an optional adapter after it
passes YA's contract suite, but it is not a Linux fallback. SRT itself requires
Bubblewrap, plus `socat` and Ripgrep, and removes the child's network namespace
in favor of host proxy processes and domain policy. That network behavior is
stronger but observably different from v1's unchanged-network contract. YA
therefore drives Bubblewrap directly in v1 rather than automatically selecting
SRT merely because `srt` is installed. A future SRT adapter must preserve the
requested YA filesystem and network semantics and must not weaken setup
failures into warnings.

### Secondary candidates

- **systemd 239 transient/system services.** Rocky 8's systemd already
  supports `ProtectSystem=strict`, `ReadWritePaths=`, `NoNewPrivileges=`, and
  transient `--property=` values. Its v239 documentation describes exactly the
  read-only hierarchy plus writable subdirectory shape, but also warns that
  privileged processes can undo it, later-created submounts are not covered,
  and capability/syscall restrictions must accompany it
  ([v239 execution policy](https://github.com/systemd/systemd/blob/v239/man/systemd.exec.xml),
  [v239 transient units](https://github.com/systemd/systemd/blob/v239/man/systemd-run.xml)).
  This is a credible installed-service backend when YA has a prearranged
  system-manager policy, not a portable unprivileged fallback for an arbitrary
  native launch.

- **Landlock.** Landlock is an unprivileged, inherited kernel access-control
  layer and is attractive on newer Linux systems
  ([kernel documentation](https://www.kernel.org/doc/html/v5.13/security/landlock.html)).
  It first appears in the Linux 5.13 documentation, so a stock Rocky 8 kernel
  4.18 cannot be the v1 baseline. Later distributions still require a runtime
  ABI/feature probe. Landlock also does not retroactively constrain
  already-open file descriptors, and its handled rights vary by ABI.

- **Firejail.** Firejail is C, low-dependency, and available from EPEL on the
  surveyed Rocky 8 host, but upstream describes it as an SUID sandbox with a
  broad desktop/profile feature surface
  ([upstream README](https://github.com/netblue30/firejail)). That privileged
  and higher-complexity integration is a worse fit than non-setuid Bubblewrap,
  especially alongside default whole-YA `no_new_privs` hardening.

- **NsJail and Minijail.** Both provide capable namespace/seccomp launchers.
  NsJail adds C++, protobuf, libnl, Kafel, and a larger isolation/configuration
  surface
  ([NsJail README](https://github.com/google/nsjail)); Minijail is smaller C
  code requiring libcap and kernel headers, but is primarily an Android/Chrome
  OS library/tool and is not a Rocky package
  ([Minijail](https://android.googlesource.com/platform/external/minijail/),
  [build requirements](https://android.googlesource.com/platform/external/minijail/+/add50186ecbe274faa395ce13a790e94a524b408/HACKING.md)).
  Neither offers a clear v1 advantage over Bubblewrap's package availability
  and demonstrated policy shape.

- **runc/crun or rootless Podman.** Rocky/RHEL 8 AppStream provides Podman and
  OCI runtimes, but they are installable packages rather than a guaranteed
  base-system facility. The surveyed Rocky host offered Podman `4.9.4` through
  AppStream but did not have it installed. RHEL's own setup requires installing
  `podman` or the `container-tools` module and provisioning `/etc/subuid` and
  `/etc/subgid` for rootless users
  ([RHEL 8 container tools](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/8/html/building_running_and_managing_containers/assembly_starting-with-containers_building-running-and-managing-containers)).
  Upstream lists packages in the ordinary repositories of Debian 11+, Ubuntu
  20.10+, CentOS Stream 9+, Arch, Alpine, and openSUSE, but generally still
  instructs the operator to install them
  ([Podman installation](https://podman.io/docs/installation)). Rootless mode
  also depends on subordinate-ID mappings and helper/storage/network setup;
  runc supports rootless user-namespace containers
  ([runc documentation](https://github.com/opencontainers/runc)). These tools
  bring an OCI bundle/rootfs/image/state lifecycle and substantially more
  policy than YA needs. They remain reasonable deployment-level isolation when
  YA already runs in containers, not an embedded v1 fallback.

- **Plain `chroot`.** `chroot(project)` hides the outside reads this product
  wants and requires constructing a usable root; `chroot("/")` supplies no
  write boundary. More importantly, the Linux manual says chroot alone is not
  intended as a security mechanism and documents escape conditions
  ([chroot(2)](https://man7.org/linux/man-pages/man2/chroot.2.html)). A future
  backend could include chroot or `pivot_root` only as one layer within a
  private mount namespace, capability drop, no-new-privileges policy, safe
  mount table, and descriptor/IPC cleanup. “Just chroot” is not a conforming
  backend.

- **PRoot.** PRoot emulates chroot and bind mounts through `ptrace`
  ([project documentation](https://proot-me.github.io/)). It is useful for
  compatibility without privilege, but it is not the kernel-enforced security
  boundary required here.

### Linux v1 decision

Linux v1 requires trusted non-setuid Bubblewrap. Use it when the binary and
runtime probe pass; otherwise fail an enabled launch before provider process
creation with an actionable error. Absence of `bwrap` should include an
installation command, while a failed runtime probe should name the relevant
host prerequisite.

Never substitute provider cooperation, plain chroot, PRoot, or an unlocked
process merely because Bubblewrap is missing.

## Backend Integration Gate

Before implementation, validate the Bubblewrap policy and any future platform
backend on:

- unprivileged availability and installation burden;
- Linux, macOS, Windows, and remote-host coverage;
- symlink/rename/mount/file-descriptor semantics;
- direct provider edit and descendant inheritance coverage;
- provider transcript, cache, and resume compatibility;
- whether a privileged long-lived daemon is required;
- auditable setup success and fail-closed behavior; and
- maintenance risk as kernels and provider launch paths evolve.

The chosen backend and provider matrix should be recorded here before code
claims `project-write`. A provider-cooperative-only prototype may be useful for
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
- Which derivative flows inherit the level automatically, and which should
  reopen New Session for an explicit choice?
- What exact admission, approval, and audit contract should the future locked
  share use?
