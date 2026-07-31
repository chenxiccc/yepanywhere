# Super-Session Testbed Appliance

Status: proposed direction with a local MacVM prototype in progress.

Topic: federated-super-sessions

This plan turns the cross-platform motivation in
[`topics/federated-super-sessions.md`](../../topics/federated-super-sessions.md)
into a contained proving ground: one always-on Apple-silicon lab host runs
native macOS, Windows, and Linux guests, each eligible to become a YA peer,
while a host-owned testbed layer retains out-of-band control of every VM.

Public reference implementations:

- [winvm-testbed](https://github.com/kzahel/winvm-testbed) controls a Windows
  11 VM through UTM lifecycle APIs, PowerShell, WinApp UI Automation, and
  hypervisor-level screenshot/input recovery.
- [chromeos-testbed](https://github.com/kzahel/chromeos-testbed) controls a
  physical Chromebook through SSH, browser and desktop accessibility trees,
  screenshots, and injected input.

The immediate experiment is
[macvm-testbed](https://github.com/kzahel/macvm-testbed), using Tart's macOS
guest agent and Virtualization.framework window as the equivalent macOS
control surface. The repository may exist locally before that public URL is
published.

## Desired Shape

```text
always-on Mac lab host
  |
  +-- host testbed control plane
  |     lifecycle, health, capture, input, snapshots, recovery
  |
  +-- macOS VM  ---- YA peer + provider harness + native checkout
  +-- Windows VM -- YA peer + provider harness + native checkout
  +-- Linux VM  ---- YA peer + provider harness + native checkout
  |
  +-- physical ChromeOS, Android, and attached-device testbeds

one canonical YA session
  -- terminal jump --> exactly one active peer/provider writer
```

Physical centralization and logical federation are separate decisions. The
first appliance may colocate every peer on one Mac, but YA session identity,
provider-bundle ownership, path mapping, and single-writer fencing retain the
federated contracts. A later peer on real x86 hardware or a hardware-attached
machine must not require a different session model.

## Division Of Responsibility

### Super sessions own continuity

Federation owns the canonical YA session id, provider bundle transfer,
ownership generation, target resume, client rebinding, and the agent-visible
terminal `jump`. It does not own VM input, guest provisioning, repository
mutation, or snapshot policy.

### Guest peers own native execution

The active provider harness runs inside the target OS. Normal shell commands,
paths, SDKs, build tools, and provider tools are local to that guest. Each peer
uses a native checkout; shared folders may transfer explicit artifacts but do
not replace platform-native Git state.

### Testbeds own machine control

The host-side testbed layer is deliberately independent of the provider and
YA process inside the guest. It remains usable when guest SSH, the provider,
the accessibility service, or the desktop session is broken.

Use two complementary computer-control paths:

```text
semantic path
  guest shell + native accessibility API + named elements/actions

out-of-band path
  hypervisor screenshot + keyboard/mouse injection + lifecycle control
```

The semantic path is preferred because it is inspectable and stable. The
out-of-band path covers login windows, menus and system chrome, permission
dialogs, inaccessible applications, damaged guest services, and visual
recovery. Provider-packaged computer-use exclusions do not define this tool
surface; the user's authorization and the testbed's explicit safety contract
do.

### Physical devices own hardware truth

ChromeOS, USB/Bluetooth peripherals, GPUs, cameras, secure elements, native
drivers, and architecture-specific behavior stay on appropriate hardware.
The appliance may orchestrate those devices but must not claim that a VM
proves their behavior.

## Common Computer-Control Vocabulary

Do not force every guest to use one implementation. Converge on a small
agent-facing vocabulary after at least Windows and macOS have proved the
overlap:

```text
doctor
status | up | ip | suspend | shutdown
exec | shell
screenshot
windows | tree | find
invoke | click | set-value
type | key
launch
```

The contract should preserve several distinctions:

- a semantic selector versus a guest-display coordinate;
- a guest action versus a host lifecycle action;
- read-only inspection versus state-changing input;
- normal shutdown/suspend versus explicitly authorized force-stop or revert;
- a live semantic desktop versus an out-of-band image that may show login,
  recovery, or secure UI; and
- durable identifiers versus ephemeral accessibility element references.

A peer inside a VM may receive a narrow host-control capability for its own
testbed. It must not receive unrestricted host SSH. Self-suspend, revert, or
restart is terminal control work: the active provider turn cannot continue as
if the guest remained alive.

## VM Lifecycle And Capacity

The lab host stays available; every guest need not stay running. A jump target
preflight may resume its VM, wait for the guest agent and semantic desktop,
and report readiness before the source is quiesced. Routine suspend preserves
logged-in desktop state and reduces steady memory pressure.

VM snapshots are recovery artifacts, not session-ownership truth. Restoring
an old snapshot can resurrect stale provider files and an obsolete ownership
generation. Every restored peer must revalidate current ownership before YA
may start or resume the provider. A snapshot never authorizes lease stealing
or rollback of the canonical session generation.

An Apple-silicon appliance is an ARM test matrix. Windows-on-ARM application
emulation and Intel-binary translation inside ARM Linux do not prove an x64
kernel, driver, installer, or native guest. Keep an x86 peer available when
the product surface requires that evidence.

## Tactical Sequence

### 1 — prove the Mac lab topology

Run macOS, Windows, and Linux guests on an existing Mac before sizing a
dedicated machine. Record host memory pressure, guest working sets, disk I/O,
suspend/resume latency, concurrent build behavior, and whether active GUI
sessions survive routine host operation.

Acceptance:

- each guest has stable lifecycle and health discovery;
- inactive guests can suspend without losing the intended desktop state;
- each guest uses a native project checkout; and
- the measurements distinguish one active guest from truly concurrent work.

### 2 — establish MacVM out-of-band control

Build the Tart/macOS analogue of winvm-testbed. Prefer `tart exec` for command
execution, Tart lifecycle/IP operations for machine state, and host capture
plus injected input for recovery. Treat host Screen Recording and input
consent, and guest Accessibility, as explicit testbed bootstrap state. The
prototype should not acquire an Automation dependency merely to drive System
Events.

Acceptance:

- `doctor` distinguishes VM, guest-agent, login-session, host capture/input,
  and guest Accessibility readiness;
- screenshots and guest-coordinate input work without guest accessibility;
- system commands execute without SSH when the Tart guest agent is healthy;
- semantic inspection can enumerate applications, windows, and actionable
  elements after its explicit TCC grant; and
- the operating guide gives the outer recovery path when a permission dialog
  blocks semantic setup.

### 3 — extract the shared computer contract

Compare the proven Windows and macOS commands, then name only their real
common semantics. Keep host providers and guest drivers separate so Tart,
UTM, a later Linux hypervisor, and physical devices can implement different
mechanisms without lying about capabilities.

Acceptance:

- agents can use one small vocabulary across the two testbeds;
- capability discovery exposes missing semantic or visual operations;
- coordinates are defined in guest-display space; and
- provider-specific escape hatches remain available for recovery and
  diagnosis.

### 4 — add the Linux peer and driver

Use native shell and AT-SPI where a GUI is required. Reuse the host provider
contract rather than copying Windows or macOS policy. A headless Linux guest
may honestly omit GUI capabilities.

Acceptance:

- the guest reports its shell, desktop, architecture, and control
  capabilities;
- headless operation does not fabricate a desktop control surface; and
- ARM versus x86 evidence remains explicit.

### 5 — prove provider portability inside the appliance

Run the provider bundle gates from the super-session topic between local VM
peers before building broad federation. Claude remains the first candidate.
Exercise different OS paths, subagents, compaction, attachments, approvals,
interrupted tools, and near-window transcripts with pinned provider versions.

Acceptance is the Gate 1 and Gate 2 evidence in the parent topic, including
complete bundle contents, correct resume, stable transcript lineage, and
measured rather than assumed prompt-cache behavior.

### 6 — prove one local terminal jump

Implement the smallest two-peer, direct-transfer experiment on the lab host:
one logical project mapping, one canonical YA id, one ownership generation,
one provider, and one automatic target continuation. VM readiness belongs in
target preflight; repository checkpoints remain agent-prepared and explicit.

Acceptance is the parent topic's terminal-boundary and native cross-platform
proof: no source work after accepted jump, no unresolved tool call, one user
message delivery, one eligible provider writer, exact Git checkpoint, and the
same visible YA conversation.

### 7 — widen from appliance to federation

Only after the local proof passes, add peer registration, authenticated
bundle transfer, remote routing, client rebinding, and crash-injection across
separate physical hosts. Do not make the colocated Mac a permanent coordinator
assumption in the peer protocol.

Acceptance remains the ownership, compatibility, liveness, and rollout
contract in the parent topic. The appliance is a deployment topology, not an
exception to federation correctness.

## Deliberate Non-Goals

This plan does not authorize:

- silent VM creation, deletion, revert, or force-stop;
- automatic TCC database modification or bypass of guest consent surfaces;
- unrestricted guest access to the lab host;
- shared-folder working trees as the cross-platform source of truth;
- keeping abandoned provider processes or all guests alive for speculative
  cache warmth;
- claiming native x64, GPU, driver, peripheral, or secure-hardware coverage
  from Apple-silicon VMs; or
- weakening the single-writer protocol because the first peers share a
  physical host.

## Review Point

After MacVM control and manual provider portability are proven, review:

- the actual common computer-control vocabulary;
- which actions require a host broker when the provider runs inside a guest;
- the measured memory/storage requirement for a dedicated Mac mini or Mac
  Studio;
- the minimum x86 and physical-device peers still needed; and
- whether the evidence is strong enough to begin the super-session MVP rather
  than extend testbed-specific orchestration further.
