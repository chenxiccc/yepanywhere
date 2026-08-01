# Host Awake

> YA may hold a process-lifetime operating-system power assertion so an
> explicitly opted-in host remains reachable while the server is running,
> without keeping its display on, draining a portable host through its
> configured battery floor, or persistently changing its power plan.

Topic: host-awake

Status: implemented for ordinary idle-sleep prevention on macOS and Windows,
default-off and guarded by the battery-floor policy. Windows desktop validation
is recorded below; portable Windows and macOS hardware validation remains.
Stronger macOS closed-lid behavior and Linux support remain follow-on work.

Related topics: [vanilla-defaults](vanilla-defaults.md),
[architecture-mandates](architecture-mandates.md),
[settings-ui-placement](settings-ui-placement.md),
[hard-development-rules](hard-development-rules.md), and
[server-capabilities](server-capabilities.md).

## Decision Summary

Host-awake support is in scope for YA because remote supervision depends on the
host remaining reachable between user interactions. It is a server-wide host
availability setting, not provider/session behavior and not a browser-local
preference.

The first implementation should follow these rules:

- ship configurable and default-off;
- prevent automatic idle system sleep while YA runs, on battery or external
  power, while leaving display sleep alone;
- pause the assertion when a portable host is running on battery at or below a
  configurable battery floor, defaulting to 10%, so ordinary system sleep can
  protect the remaining charge;
- continue to respect the operating system's lid, explicit sleep, low-power,
  and thermal policies in the ordinary mode;
- reserve a separate macOS-only best-effort option for a future request to
  operate closed-lid while connected to external power; do not expose it until
  the hardware matrix has been validated;
- never mutate persistent operating-system power plans;
- never require administrator/root privileges for the ordinary mode;
- bind every assertion/helper lifetime to the YA server process so a crash,
  forced exit, or disabled setting releases it;
- treat an unavailable backend as a visible, nonfatal degraded state: YA still
  starts and serves requests.

The ordinary setting intentionally remains active without a live browser tab or
provider process. The explicit server setting is the owner of this single
global policy lease, including any power-source observation required for the
battery floor. It must not create a per-client or per-session timer, watcher,
or poll loop.

## Motivation

YA is useful from another room, another device, or away from the host. A host
that automatically sleeps can silently suspend an active agent, make approvals
unreachable, and disconnect direct or relayed clients. Requiring each operator
to remember a separate `caffeinate`, PowerToys Awake, browser extension, or
desktop setting makes host availability less reliable than the server-owned
agent processes YA is supervising.

There are two distinct needs:

1. **Idle-sleep prevention.** The lid is open, but the user is not typing. This
   should work on battery above a user-configured reserve as well as on
   external power. It is the common case and has a supported OS-level
   implementation on the main desktop platforms.
2. **Closed-lid operation.** The host should keep working headlessly after a
   laptop lid closes. Operating systems treat this as a stronger, more
   safety-sensitive request. macOS exposes a stronger external-power assertion,
   but Apple does not promise the no-external-display configuration across all
   hardware and OS releases. This behavior must therefore remain separate and
   visibly best-effort.

Keeping an assertion active until the battery is exhausted defeats macOS's
ordinary idle-sleep protection and can leave a remotely operated Mac fully
discharged. YA should preserve reachability while useful charge remains, then
get out of the way before the host reaches its critical-battery behavior.

## Product Contract

### Ordinary mode

When **Keep host awake while the server is running** is enabled:

| Power source | Battery charge | Laptop lid | Requested behavior |
| --- | --- | --- | --- |
| Battery | Above configured floor | Open | Prevent automatic idle system sleep |
| Battery | At or below configured floor | Open | Release the assertion and allow normal system sleep |
| External power | Any | Open | Prevent automatic idle system sleep |
| Battery | Any | Closed | Follow the operating system's lid policy |
| External power | Any | Closed | Follow the operating system's lid policy |

The display may dim or turn off in every row. YA does not simulate input, move
the pointer, or request a display-required assertion.

The battery floor defaults to 10% and is configurable from 1% through 100%.
It applies only when the host has an internal battery and the operating system
reports that the host is drawing from it. Reaching the floor releases YA's
assertion; it does not issue a forced-sleep command, so the operating system's
configured idle timer, low-battery policy, and current activity still decide
when sleep occurs.

After a low-battery pause, YA reacquires the assertion immediately on external
power or after battery charge rises at least two percentage points above the
configured floor. This fixed hysteresis is not another user setting. It avoids
repeated helper start/stop transitions when the reported percentage moves
around the boundary.

### Future macOS closed-lid-on-power mode

If the macOS-only **Also stay awake with the lid closed on external power**
option is added after platform validation, YA will additionally request the
stronger macOS system-sleep assertion:

| Power source | Battery charge | Laptop lid | Requested behavior |
| --- | --- | --- | --- |
| Battery | Above configured floor | Open | Prevent automatic idle system sleep |
| Battery | At or below configured floor | Open | Release the assertion and allow normal system sleep |
| External power | Any | Open | Prevent automatic idle system sleep |
| Battery | Any | Closed | Sleep according to macOS policy |
| External power | Any | Closed | Best-effort continued operation |

This is not equivalent to an Apple guarantee of headless closed-lid operation.
Apple's supported closed-display instructions still assume an external display
and input devices. YA should describe the no-display result as best effort and
test it on each maintained Intel/Apple-silicon and macOS family before claiming
compatibility.

External power is only one safety boundary. A USB-C battery pack in a closed
bag may still count as external power, so the stronger mode needs explicit copy
warning that the computer must remain ventilated. macOS retains authority to
sleep for thermal emergencies and other hardware policy.

## Suggested UI

### Placement

Add a **Host availability** group to the existing **Remote Access** settings
category. Reachability is the user concept, and this small control group does
not earn a new category under [settings-ui-placement](settings-ui-placement.md).
The setting remains useful for LAN/direct access even when relay access is not
configured, so the group must not be hidden behind relay enablement.

If a later host-management cluster grows around startup-at-login, service
installation, wake-on-network, or power state, it may justify a dedicated Host
or Server category. Do not create that category for this feature alone.

### Primary control

**Label:** Keep host awake while the server is running

**Description:** Prevent automatic system sleep while this server is running,
including on battery power above the configured reserve. The display may still
turn off, and closing a laptop lid follows the normal system policy.

This switch is off by default. It is server-persisted and applies regardless of
which browser or remote client changed it.

### Battery floor control

Show this when the connected server reports an internal battery and the primary
control is enabled.

**Label:** Allow automatic sleep at

**Value:** A whole-number percentage from 1% through 100%, defaulting to 10%.

**Description:** When this host is running on battery at or below this level,
stop preventing automatic sleep to preserve the remaining charge.

Changing the floor applies live. The control configures the server, not the
viewing device; a phone editing a Mac server changes the Mac's floor. Do not
describe the action as forcing immediate sleep.

### macOS subordinate control

Show this only when the connected server's support status reports
`closedLidOnExternalPower` and the primary control is enabled.

**Label:** Also stay awake with the lid closed on external power

**Description:** Request continued operation when this Mac is connected to
power and its lid is closed. Support varies by Mac and macOS version. Keep the
computer ventilated; closing the lid on battery still allows sleep.

The subordinate control is independently default-off. It should not be folded
silently into the ordinary keep-awake toggle.

### Status and errors

Show quiet inline status only in the settings group:

- **Active — preventing automatic sleep**
- **Active — closed-lid operation on external power requested**
- **Paused — battery at or below 10%; automatic sleep is allowed**
- **Unavailable on this server: `<bounded reason>`**
- **Could not enable: `<bounded reason>`**

Substitute the effective configured percentage in the paused status. The
status may also show the last observed battery percentage, but it must not imply
that YA controls the operating system's estimate or guarantee when sleep will
begin.

Do not add a first-run prompt, global banner, session toolbar control, or
notification. A backend failure should remain visible when the user visits the
setting, but it must not make unrelated server health appear failed.
Unsupported status includes the server's bounded, scrubbed reason so a missing
runtime or managed-device policy can be distinguished from an unknown platform.

All new copy belongs in `packages/client/src/i18n/en.json` and must be rendered
through `useI18n().t(...)`.

## Configuration Model

Prefer one enum over two independent booleans so invalid combinations cannot be
persisted:

```ts
export type HostAwakeMode =
  | "off"
  | "idle"
  | "idle-and-closed-lid-on-external-power";

interface ServerSettings {
  hostAwakeMode?: HostAwakeMode;
  hostAwakeBatteryFloorPercent?: number;
}
```

Semantics:

- missing or `"off"`: no assertion;
- `"idle"`: ordinary cross-platform idle-sleep prevention;
- `"idle-and-closed-lid-on-external-power"`: ordinary prevention plus the
  macOS stronger request where supported; on other platforms, reject the mode
  rather than silently broadening or weakening it.
- `hostAwakeBatteryFloorPercent`: whole number from 1 through 100; while
  drawing from an internal battery, pause the assertion at or below this
  percentage.

`DEFAULT_SERVER_SETTINGS.hostAwakeMode` is `"off"`, and
`DEFAULT_SERVER_SETTINGS.hostAwakeBatteryFloorPercent` is `10`. The settings
route accepts only the exact enum values and an integer percentage in range,
and applies a successful update live. Store the floor while the mode is off so
reenabling restores the operator's choice. Missing stored state needs no
migration beyond the default merge.

Do not add an environment-variable override in the first pass. If headless
deployment later needs one, define its precedence explicitly under
[hard-development-rules](hard-development-rules.md), expose the effective
source in UI/status, and do not let the UI appear to change an env-pinned value.

## Runtime Architecture

Add one server-global `HostAwakeService`. It owns no provider or client state.

```ts
interface HostAwakeFeatureSupport {
  idleSleepPrevention: boolean;
  batteryFloor: boolean;
  closedLidOnExternalPower: boolean;
}

interface HostAwakeBackend {
  readonly platform: NodeJS.Platform;
  readonly support: HostAwakeFeatureSupport;
  acquire(request: HostAwakeRequest): Promise<HostAwakeLease>;
}

interface HostAwakeRequest {
  mode: Exclude<HostAwakeMode, "off">;
  batteryFloorPercent: number;
}

interface HostAwakeLease {
  status(): HostAwakeBackendStatus;
  release(): Promise<void>;
}
```

The concrete API may differ, but preserve these responsibilities:

1. initialize after `ServerSettingsService` has loaded;
2. apply the persisted mode and battery floor before reporting the feature
   active;
3. serialize live mode or floor changes so overlapping PUT requests cannot
   leak helpers or power observers;
4. retain exactly one current policy lease, even while its assertion is paused
   for low battery;
5. release it when disabled and from `gracefulShutdown`;
6. bind helper cleanup to parent-process death for ungraceful exits;
7. record an unexpected helper exit as `error` without a retry loop;
8. expose a read-only status snapshot for the settings UI and diagnostics.

Battery-floor enforcement requires observing power-source and charge changes.
Prefer a platform-native change notification, such as macOS IOKit's
`IOPSNotificationCreateRunLoopSource`. Where Node cannot consume a native
notification without disproportionate packaging cost, one server-global
fixed-cadence observer is acceptable: no more than one sample per minute,
bounded work and output per sample, no overlapping reads, and immediate
teardown when the mode is disabled or the server exits. It must never become a
per-client or per-session poll.

The observer is policy work, not an acquisition-retry loop. An unexpected
assertion-helper exit still records `error` without fast or indefinite retry.
Normal power-source changes may start or stop a healthy helper as required by
the policy.

### Status API and capabilities

Add `GET /api/settings/host-awake/status` as a focused read-only response:

```ts
interface HostAwakeStatus {
  requestedMode: HostAwakeMode;
  state:
    | "disabled"
    | "active"
    | "paused-low-battery"
    | "unsupported"
    | "error";
  platform: NodeJS.Platform;
  support: HostAwakeFeatureSupport;
  hasInternalBattery: boolean | "unknown";
  powerSource?: "battery" | "external" | "unknown";
  batteryPercent?: number;
  powerObservedAt?: number;
  batteryFloorPercent: number;
  reason?: string;
}
```

`reason` must be bounded and scrubbed of command lines, environment values, or
other sensitive host data. `powerObservedAt` is an epoch-millisecond timestamp
for the battery and power-source sample, allowing clients to label stale data
rather than presenting it as a live gauge.

Register one transitional `host-awake-control` string in the existing
`/api/version` capability array on servers that implement the settings and
status API, so a newer hosted client does not call those routes on an older
server. The existing version hook fetches this coarse discovery data on mount
and again after reconnect; it is not battery telemetry. Follow
[server-capabilities](server-capabilities.md) for lifecycle metadata rather
than adding raw capability strings.

Do not add one capability string per platform behavior. The status support map
is the authoritative per-installation feature matrix: it tells the client
whether ordinary idle inhibition, battery-floor enforcement, and stronger
closed-lid operation are available from this backend. The client must not infer
support from `platform` alone.

Battery awareness remains mandatory when a supported host has an internal
battery and irrelevant on a mains-only desktop. `hasInternalBattery`,
`powerSource`, and `batteryPercent` are runtime facts used with the support map.
A portable host with `batteryFloor: false`, or whose battery presence is still
`unknown`, must not enable ordinary keep-awake. A desktop with
`hasInternalBattery: false` may enable it using only
`idleSleepPrevention: true`.

### Status sampling cadence

The UI fetches host-awake status when its settings pane mounts and after a
mutation. It exposes manual refresh only while host-awake is disabled, when a
request can perform the bounded on-demand platform probe. While enabled, the
policy lease owns the at-most-once-per-minute sampling cadence, so the UI does
not claim that an ordinary status read refreshed the live power sample. The
first implementation does not add a client polling loop or WebSocket event; the
percentage is a timestamped snapshot, not a promised live gauge.

The server owns sampling:

- service initialization performs one bounded platform probe to determine the
  support map and whether an internal battery is present;
- while host-awake is enabled on a portable host, the event-driven or at-most-
  once-per-minute global observer updates the cached snapshot and enforces the
  floor;
- while host-awake is disabled, no recurring observer remains active. A status
  request refreshes the platform sample only when the cached sample is older
  than 30 seconds;
- concurrent or overlapping status requests share one in-flight platform read;
- every read has bounded output and duration, and a failed refresh returns
  `unknown`/`error` status rather than stale data labeled as current.

This lets any authenticated client request the current best-effort battery
value without making battery monitoring client-owned. If a later UI needs a
visibly live level, it may poll no faster than the server's one-minute cadence
only while the settings pane is visible, with teardown on unmount; that is not
part of the first implementation.

## Platform Strategy

### macOS

Use the OS-provided `/usr/bin/caffeinate` through `execFile`/`spawn` with fixed
arguments and no shell:

- ordinary mode: `caffeinate -i -w <ya-pid>`;
- stronger mode: `caffeinate -i -s -w <ya-pid>`.

`-i` creates an idle-system-sleep assertion and works on battery or external
power. `-s` creates the stronger system-sleep assertion and is valid only on
external power. `-w` binds the helper assertion to YA's PID, so it releases if
YA disappears even when graceful shutdown did not run.

Before starting `caffeinate`, read whether the Mac is using external or battery
power and, on a portable Mac, its remaining percentage. While the assertion is
requested, refresh that state through either an IOKit power-source notification
or the single bounded observer described above. The dependency-minimal first
implementation may run fixed `/usr/bin/pmset -g batt` reads with no shell: once
at acquisition and then no more than once per minute. Bound captured output,
time out a stuck read, and coalesce rather than overlap ticks.

At or below the configured floor on battery, terminate `caffeinate`, wait for
the child to release its assertion, and report `paused-low-battery`. Reconnect
to external power or exceed the hysteresis boundary before starting the
appropriate helper again. A power disconnect in stronger mode must drop `-s`;
if charge remains above the floor, ordinary `-i` inhibition may continue.

Do not use `-d` because YA does not need the display. Do not use `-u`, fake
input, or cursor movement. The read-only `pmset -g batt` query above is the only
first-pass `pmset` exception. Never use `pmset` to change settings, especially
undocumented or persistent `disablesleep` settings. Those alter machine policy
beyond the YA process lifetime, generally require privilege, and can survive a
crash.

The stronger mode remains experimental until manual testing answers:

- Does it keep the YA process and network reachable with the lid closed, on
  external power, without an external display?
- Is behavior consistent across power disconnect/reconnect?
- Do Intel and Apple-silicon targets behave consistently?
- Does explicit Apple-menu Sleep still behave acceptably while the assertion
  is held?
- Does reopening the lid restore the ordinary mode without restarting YA?

If the answers vary, report the tested compatibility rather than compensating
with privileged power-policy changes.

### Windows

Use a process-lifetime Windows power request for
`PowerRequestSystemRequired`; do not request `PowerRequestDisplayRequired` or
`PowerRequestAwayModeRequired`. Microsoft's power-request contract leaves the
display free to turn off and releases ordinary requests for user-initiated
Sleep, lid close, or the power button.

Node does not expose the Win32 power APIs directly. The dependency-minimal
first option is a small source-owned PowerShell helper, supplied as fixed
command text over stdin rather than as a `.ps1` file, that:

1. loads the fixed `Kernel32` P/Invoke definitions;
2. reads `GetSystemPowerStatus` at a fixed cadence while the request is enabled;
3. creates a reason context identifying Yep Anywhere;
4. calls `PowerCreateRequest` and holds `PowerSetRequest(SystemRequired)` only
   while external power is present or battery charge is above the floor;
5. opens a handle to the YA parent process and waits for it to exit;
6. calls `PowerClearRequest` and closes the request handle in `finally`.

Spawn Windows PowerShell with `-NoProfile -NonInteractive -Command` and a fixed
bootstrap that reads all of stdin before creating and invoking one script
block. Write the fixed helper source to stdin and close it after the complete
command has been delivered. Windows PowerShell 5.1 does not reliably evaluate
a multiline script supplied directly through `-Command -`; it can exit zero
without executing the complete helper. Do not use `-File`, `-ExecutionPolicy
Bypass`, mutate the machine's execution policy, or interpolate user-controlled
input. Reading the source from stdin avoids the ordinary `.ps1`
execution-policy failure without asking YA users to weaken their PowerShell
configuration.

Allow up to 20 seconds for a cold PowerShell process and `Add-Type` compilation
to produce the first complete snapshot or status payload. If that startup bound
expires, terminate the helper and report the probe or acquisition failure. This
is one bounded startup allowance, not an acquisition-retry loop.

This is not an attempt to bypass stronger application policy. AppLocker or App
Control may place PowerShell in Constrained Language mode, where `Add-Type`
cannot load arbitrary Win32 declarations, and managed policy may block
PowerShell entirely. A stripped Windows image may also lack the executable. In
those environments, return `unsupported`; do not request elevation, change
policy, download a helper, or require PowerToys automatically.

A later packaged native helper is preferable only if real deployments show
that PowerShell policy is a recurring blocker and the binary build/signing
cost is justified. If PowerToys Awake is already installed, it is useful
reference behavior and supports PID-bound execution, but YA must not take an
undeclared runtime dependency on it.

Windows Modern Standby can constrain power requests on DC/battery power, and
lock-screen behavior also varies by request path and policy. The Windows UI
therefore promises that YA requests idle-sleep prevention, not that it can
override every OEM or enterprise power policy. Validate at least Windows 10
and 11 on Traditional Sleep and Modern Standby hardware before marking the
backend fully supported. The helper must still honor the same battery-floor and
hysteresis contract; Modern Standby's own restrictions do not substitute for
releasing YA's request at the configured floor.

YA must not run `powercfg` to rewrite power-plan timeouts or lid actions.

### Future Linux with systemd/logind backend

Use `systemd-inhibit` when available. Request only idle inhibition:

```text
--what=idle
--mode=block
--who=Yep Anywhere
--why=Keep the Yep Anywhere host reachable while the server is running
```

Do not accept `systemd-inhibit`'s broad default of
`idle:sleep:shutdown`. Do not request `sleep`, `shutdown`,
`handle-lid-switch`, or power-key inhibition. This keeps the ordinary feature
focused on automatic idle handling and leaves explicit/lid actions to system
policy.

Because `systemd-inhibit` wraps another command, spawn it around a tiny
source-owned lease holder whose stdin is a pipe owned by YA. The holder exits
on EOF; parent death closes the pipe; `systemd-inhibit` then releases the lock.
This avoids a polling parent-PID watcher and orphaned inhibitors. Use fixed
arguments and no shell.

The backend is unsupported when `systemd-inhibit` is absent, the logind bus is
unavailable, or the current service/user context cannot acquire the inhibitor.
Headless services and containers need explicit testing because a binary being
present does not prove an active logind session/bus.

On a Linux host with an internal battery, do not mark the backend supported
until it can reliably distinguish external power from battery power and report
remaining percentage through a bounded platform source. Release the inhibitor
at the configured floor under the same product contract. A mains-only host may
use the backend without a battery observer.

### Linux without systemd

Return `unsupported` in the first release. Desktop-specific D-Bus APIs and
other init systems can become separate backends after a real target requires
them. Do not add a runtime D-Bus dependency or simulate input merely to claim
generic Linux coverage.

## Failure and Lifecycle Rules

- Enabling on a server without a supported ordinary backend returns a bounded
  unsupported response and does not persist a non-`off` mode. An upgrade must
  not silently activate an old request that could not work when it was made.
- If the platform backend is supported but acquisition fails transiently,
  persist the operator's requested mode and expose `error`; return the updated
  settings and status together so the UI does not claim `active`. Startup and
  later explicit updates may retry that persisted intent, but there is no
  automatic acquisition-retry loop in the running service.
- Disabling is idempotent and succeeds even if the helper already exited.
- `paused-low-battery` is a healthy policy state, not an acquisition failure.
  The policy lease and power observer remain alive while the OS assertion does
  not.
- If power-source or charge observation fails on a host with a detected or
  not-yet-classified internal battery, release the assertion and expose
  `error`. Do not keep the host awake on a stale external-power reading. A
  subsequent normal observer tick may clear this observation error and apply
  the policy again; this bounded sampling is not a helper restart loop.
- An unexpected helper exit produces one warning and an in-memory `error`
  status. No fast restart loop.
- Graceful shutdown releases the lease before `process.exit`.
- Parent-death coupling is required even though graceful shutdown exists.
- Helper stdout/stderr must be bounded or ignored; it must not become a new
  unbounded logging source.
- The setting must never create provider-visible messages, session activity,
  or client notification events.

## Safety and Security

- The settings mutation and status response remain behind the existing
  authenticated server settings boundary, including over encrypted relay
  transport.
- No implementation requires administrator/root privileges in the supported
  path.
- Never rewrite persistent sleep timers, lid actions, or power plans.
- Never hold YA's sleep assertion while an internal battery is the active power
  source at or below the configured floor.
- Never keep the display on by default.
- Never use mouse movement, synthetic keys, or user-activity simulation.
- Preserve explicit OS policy where the ordinary API allows it. The macOS
  stronger mode is separate because it intentionally asks for more.
- Treat battery pack/external-power detection as a policy hint, not proof that
  a closed computer is safely ventilated.
- OS thermal shutdown, critical battery behavior, managed-device policy, and
  explicit shutdown remain authoritative.

## Verification Plan

### Automated tests

- settings parser accepts only the three modes and defaults missing state to
  `off`;
- battery floor defaults to 10 and accepts only whole-number percentages from
  1 through 100;
- settings API persists intent and invokes the service exactly once per real
  transition;
- unsupported servers reject and do not persist a non-`off` mode, while a
  transient acquisition failure on a supported backend persists intent and
  returns `error` status;
- concurrent updates serialize and leave one lease;
- repeated enable/disable calls are idempotent;
- crossing down to the battery floor releases the assertion without forcing
  sleep and reports `paused-low-battery`;
- charge movement around the floor does not reacquire until two percentage
  points above it, while external power reacquires immediately;
- raising the configured floor above the current on-battery percentage pauses
  live, and lowering it below the resume boundary reacquires live;
- a power-observation failure releases the assertion, reports one bounded
  error, and does not use stale state to remain active;
- the global power observer coalesces ticks and is torn down on disable and
  shutdown;
- status reads return `powerObservedAt`, reuse samples no older than 30 seconds,
  and coalesce concurrent stale-sample refreshes;
- requesting status while the mode is disabled performs at most one bounded
  read and leaves no timer or observer behind;
- unexpected helper exit changes status to `error` without retrying;
- graceful shutdown and simulated parent-channel closure release the lease;
- each backend produces exact fixed executable paths/arguments and bounds any
  power-state sample output;
- macOS ordinary mode includes `-i` and not `-d`; a future stronger mode must
  add `-s` without adding `-d`;
- macOS starts no `caffeinate` child at or below the floor on battery and never
  uses a mutating `pmset` invocation;
- a future Linux backend requests only `idle`, never the default broad
  inhibitor set;
- Windows requests SystemRequired, never DisplayRequired or AwayModeRequired;
- Windows supplies fixed helper text through stdin to a fixed whole-input
  script-block bootstrap, never a `.ps1` `-File` invocation or an
  execution-policy override;
- capability-gated clients hide controls for older servers, while the support
  map controls each current-server affordance without client platform checks;
- the battery-floor control requires `support.batteryFloor` and a true
  `hasInternalBattery` status, and a portable backend unable to enforce the
  floor reports `unsupported`;
- a mains-only desktop can enable ordinary keep-awake with
  `support.idleSleepPrevention` even when `support.batteryFloor` is false;
- UI toggle mapping cannot produce a stronger mode while the primary switch is
  off;
- UI copy and aria text use English i18n keys.

Mock the backend in ordinary unit/integration tests. CI must not actually alter
the runner's sleep state.

### Manual platform matrix

For each supported platform, verify:

- enable/disable live;
- server restart with the setting persisted;
- display timeout still works;
- open-lid idle behavior above the floor on battery and on external power;
- assertion release at the floor, no forced immediate sleep, and assertion
  reacquisition after the hysteresis boundary or connection to external power;
- explicit Sleep and lid close behavior;
- server SIGINT/SIGTERM cleanup;
- forced server termination cleanup;
- helper termination and visible error status;
- remote reachability during the expected awake interval.

On Windows, additionally test the default Windows 10/11 execution-policy
configuration, a user configuration that rejects unsigned `.ps1` files, and a
simulated Constrained Language failure. The first two should work through
stdin; the last should report `unsupported` without changing policy.

### Recorded Windows desktop validation

On 2026-07-31, a Windows 11 Home 64-bit desktop (build 26200, Gigabyte Z790 UD
AC, no internal battery) validated the dependency-minimal backend without
elevation:

- the real Windows PowerShell 5.1 probe reported external power and no internal
  battery;
- acquisition reported `active`, which is emitted only after
  `PowerSetRequest(SystemRequired)` succeeds;
- `HostAwakeService.shutdown()` terminated the helper; and
- forced helper termination removed the process and produced one bounded
  `error` status without a restart loop.

`powercfg /requests` could not independently enumerate the request from the
ordinary user account because this Windows installation requires elevation for
that diagnostic. Portable battery-floor, Traditional Sleep/Modern Standby,
display-timeout, lid, and physical remote-reachability validation remain open.

Additionally test macOS stronger mode with no external display, with and
without external power, across power transitions, and under a long enough run
to cross the normal sleep timer. Record model, architecture, and macOS version
with the result.

## Suggested Landing Sequence

1. Land shared mode/status types, settings validation, the global service with
   a fake backend, lifecycle integration, and tests.
2. Add the macOS ordinary backend, battery-floor observer, primary UI toggle,
   and floor control, capability-gated and default-off.
3. Add the Windows 10/11 power-request helper behind the same UI and contract,
   including execution-policy and platform tests.
4. Manually validate ordinary mode and the battery floor on maintained macOS
   and Windows 10/11 hardware before declaring the initial feature supported.
5. As follow-on work, validate the macOS stronger assertion and expose the
   subordinate control only if the tested behavior is useful and its
   limitations are accurately described.
6. Leave Linux unsupported initially. Revisit a systemd/logind backend only
   after real demand justifies owning another platform power observer.

The initial supported scope is ordinary idle-sleep prevention on macOS and
Windows 10/11. Their backends can land independently behind the same
service/status contract, but both require platform validation before being
advertised as supported. Unsupported platforms degrade cleanly throughout the
series.

## Open Questions

- Which currently maintained Mac models and macOS versions honor the stronger
  assertion with no external display?
- Does macOS external-power reconnect restore the same assertion reliably, or
  is an event-driven reacquire needed?
- Does the stronger macOS mode interfere with deliberate Apple-menu Sleep in a
  way that makes it unsuitable for YA?

## Primary Platform References

- Apple:
  [`kIOPMAssertionTypePreventUserIdleSystemSleep`](https://developer.apple.com/documentation/iokit/kiopmassertiontypepreventuseridlesystemsleep)
  and
  [`kIOPMAssertionTypePreventSystemSleep`](https://developer.apple.com/documentation/iokit/kiopmassertiontypepreventsystemsleep)
- Apple:
  [`IOPowerSources`](https://developer.apple.com/documentation/iokit/iopowersources_h),
  including power-source change notifications and battery capacity/state keys
- Apple:
  [sleep and wake settings](https://support.apple.com/guide/mac-help/set-sleep-and-wake-settings-mchle41a6ccd/mac)
- Microsoft:
  [`PowerCreateRequest`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powercreaterequest),
  [`PowerSetRequest`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powersetrequest),
  and
  [`PowerClearRequest`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powerclearrequest)
- Microsoft:
  [PowerToys Awake behavior](https://learn.microsoft.com/en-us/windows/powertoys/awake)
- systemd:
  [`systemd-inhibit`](https://www.freedesktop.org/software/systemd/man/latest/systemd-inhibit.html)
