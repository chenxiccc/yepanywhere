# V0 Desktop Baseline

Status: Implementation complete on 2026-07-30. Signed release-candidate and
updater round-trip validation remain release gates.

Topic: desktop-v0
Topic: security

## Origin

The current desktop app became centered on installing and authenticating Bun,
Yep Anywhere, Claude Code, and Codex CLI. That made first launch fragile and
turned provider/package management into the release blocker.

The v0 product is narrower:

> Install one stable Yep Anywhere desktop app. Use a Claude or Codex
> installation that is already on the machine when one can be found. Do not
> block installation or first launch when neither is found.

The primary initial target is Windows. A developer can keep running a checkout
from PowerShell for `git pull` plus hot reload while the signed desktop app
remains an independent, stable fallback that updates as one unit.

## Current Evidence

A Windows smoke of the signed v0.0.5 installer established that installation
itself works, but the installed app is not a viable release baseline:

- the bundled Bun 1.2.17 cannot run the current server's
  `CompressionStream` path;
- setup downloads the latest `yepanywhere` package at first run, so the shell,
  runtime, and server are not a tested release unit;
- setup installs separate Claude and Codex copies and drives Claude login
  through an obsolete `cli.js` assumption;
- reloading the dashboard loses the in-memory desktop bearer token and can
  produce a 401;
- disabling autostart can fail during the completion flow;
- Windows shutdown can leave descendants of the development server alive; and
- the app is locked to Tauri 2.10.2, has `csp: null`, exposes broad shell/PTY
  permissions, and loads the dashboard from a remote localhost origin. This
  matches the conditions of a remote-origin custom-command ACL issue fixed in
  Tauri 2.11.1. The issue has not been exploit-tested against YA, so it is a
  release-blocking hardening requirement rather than a claim of demonstrated
  compromise.

The existing local Windows helper already invokes the NSIS installer with
`/S`. That is useful evidence, but the signed release, uninstall, upgrade, and
post-install behavior still need a clean-machine acceptance test.

## Accepted V0 Decisions

1. The installer owns Yep Anywhere, its private JavaScript runtime, and the
   exact server build shipped with that desktop release.
2. The installer does not install Bun as a user-visible/system runtime.
3. The app does not install, update, or authenticate Claude Code or Codex.
4. Claude/Codex presence and authentication never gate install completion,
   first launch, server startup, or access to the dashboard.
5. Provider discovery is advisory. A detected desktop app or CLI is enough to
   suppress the global "no provider detected" warning; it is not a promise
   that the provider is authenticated or launchable.
6. The desktop shell does not run `claude auth status` or
   `codex login status` as an onboarding gate. Normal provider status checks
   may still run after YA starts, and a provider/session launch may report
   missing authentication in the ordinary product UI.
7. When neither Claude nor Codex is detected, YA opens normally and shows a
   non-blocking warning with official, platform-appropriate installation
   guidance.
8. The normal first launch has no multi-page setup wizard.
9. The signed desktop app and a PowerShell development server can run at the
   same time without sharing ports, processes, runtime files, or desktop
   configuration.
10. Automatic update checks remain part of v0. Installing an update continues
    to require the existing user confirmation; silent background replacement
    is not added in this tactical.
11. A full native Tauri-to-server application transport is desirable but is
    not a v0 release blocker. The v0 dashboard may remain on loopback HTTP
    after its bootstrap and command boundaries are hardened.
12. Windows is the release gate. macOS should keep building when practical,
    but Linux distribution and cross-platform release polish are deferred.

## V0 User Contract

### Install and first launch

- The primary download is a signed per-user NSIS installer. `/S` is the
  supported silent-install switch.
- If the MSI remains in the release, `/qn` is also tested and documented for
  managed installation. The MSI is secondary to the NSIS download for v0.
- Installation does not open a terminal, download npm packages, modify the
  user's global package managers, or start a provider login flow.
- The installed app can launch with the network unavailable. WebView2
  bootstrap requirements are satisfied by the installer configuration, not by
  YA's first-run code.
- First launch starts the bundled server and opens the dashboard. There is no
  Welcome -> Agent Selection -> Install -> Auth -> Ready sequence.
- A server-start failure opens a small native diagnostic surface with the
  actual error, recent bounded output, Retry, and Quit. It never falls back to
  the old component installer.
- Existing startup-view, close-behavior, port, and autostart choices remain
  authoritative. Legacy run-in-background choices migrate without silently
  enabling autostart.

### Provider discovery and guidance

Discovery is best effort and read-only. It may consider, in order:

1. an explicit provider executable path already configured in YA;
2. executable resolution through the environment inherited by YA;
3. documented Windows App Paths, uninstall registration, or official desktop
   application locations; and
4. existing provider-native data/config directories as a weak
   "application detected" signal.

The result presented by the desktop warning is deliberately coarse:

- **Detected** means a Claude/Codex application or runnable candidate was
  found;
- **Not detected** means the best-effort search found neither; and
- neither result asserts login state.

Only a validated provider CLI candidate may become a server launch path.
Finding a desktop executable or config directory can suppress the global
warning, but must not cause YA to execute an arbitrary adjacent binary or
rewrite an explicit provider path.

The desktop shell must not maintain a second provider truth model. After
startup, the existing server provider catalog remains the source of truth for
whether New Session can actually use a provider. Existing provider settings
and launch-path precedence remain authoritative.

If no provider is detected:

- show one non-blocking, dismissible dashboard notice;
- link only to official Claude/Codex pages selected for the current platform;
- keep the Providers settings page and server output reachable; and
- allow the user to try again after installing a provider without reinstalling
  YA.

If a provider is detected but fails to launch or authenticate, use the normal
New Session/provider error surface with an actionable message. Do not reopen
onboarding or mutate the provider installation.

### Stable and development coexistence

The stable app:

- uses a random loopback port by default;
- uses the desktop data root and bundled immutable runtime/server resources;
- does not attach to a server merely because port 3400 is occupied; and
- never rewrites a checkout or a developer server's dependencies.

A separately launched PowerShell server keeps its current checkout, port, and
reload behavior. Starting, quitting, repairing, updating, or uninstalling the
desktop app must not stop that process.

`YEP_DEV_DIR` currently makes an installed shell run a checkout. That can make
the supposed stable fallback non-deterministic. Before changing its
deployment-sensitive precedence, Slice 0 must present the exact compatibility
and migration behavior for maintainer approval. The intended end state is an
explicit development launch path with a visible development badge; a signed
release should not silently cease being the stable bundle because of an
ambient machine-level variable.

### Updates and data

- The Tauri update replaces the desktop shell, private runtime, and bundled YA
  server atomically.
- A desktop update does not update provider software.
- User data, sessions, relay settings, auth configuration, provider settings,
  and desktop preferences survive update and reinstall.
- Uninstall behavior must explicitly distinguish application files from user
  data. V0 should preserve user data unless the uninstaller offers a separate,
  explicit removal choice.
- The old downloaded server and desktop-owned provider copies may remain on
  disk through the first migration for rollback safety, but the new release
  does not execute them. Removal is a later explicit cleanup.

## V0 Runtime Package

The installed app must not run `bun install yepanywhere` at first launch.
Instead, CI produces one commit-matched desktop runtime package:

```text
signed desktop release
├─ Tauri shell
├─ private Bun sidecar
├─ YA server/client production artifact
└─ release manifest
   ├─ desktop version
   ├─ YA package version and commit
   ├─ Bun version
   └─ artifact hashes
```

The packaging step should reuse the workspace production build and create a
self-contained server resource with only its runtime dependencies. It must not
resolve `latest` from npm. The installed launcher resolves the entry point from
Tauri's immutable resource directory, not
`~/.yep-anywhere-desktop/node_modules`.

Keep the private Bun sidecar for v0, but:

- move its version to one shared source consumed by Windows, Unix, and CI
  preparation;
- upgrade it to a version that passes the complete bundled-server smoke;
- record its hash and verify the downloaded build input in CI; and
- never add it to PATH or advertise it as a system Bun installation.

The release manifest is diagnostic metadata, not an update mechanism. Tauri's
signed updater remains the only supported updater for this runtime package.

## Desktop Trust Boundary

### Current boundary

The Tauri shell starts Bun with a random 256-bit bearer token in
`DESKTOP_AUTH_TOKEN`, exposes that token to dashboard JavaScript through a
Tauri command and URL, and authenticates loopback HTTP, fetch, and WebSocket
traffic with it. The client removes the URL parameter and retains the value
only in module memory. A reload therefore loses the credential and returns
401.

The random port is discovery friction, not authentication. The bearer token
authenticates possession of the token, not execution inside the Tauri app.

### V0 bootstrap

V0 retains loopback HTTP but replaces JavaScript ownership of the long-lived
credential:

1. Rust generates a per-server master secret.
2. Rust passes it to the bundled server through an inherited private pipe. A
   single stdin startup frame is acceptable for the v0 production sidecar;
   command-line arguments, environment variables, files, logs, and Tauri
   JavaScript are not.
3. The server binds `127.0.0.1` on port zero and reports its actual port plus a
   versioned desktop-bootstrap protocol in a structured readiness record. This
   removes the current reserve-and-release port race.
4. Rust uses the master secret from native code to request a short-lived,
   single-use bootstrap code.
5. Rust navigates the dashboard to
   `http://127.0.0.1:<port>/desktop-bootstrap/<code>`.
6. The server consumes the code, sets a host-only, `HttpOnly`,
   `SameSite=Strict`, path-rooted session cookie, and redirects to `/`.
7. Subsequent fetch, SSE, and WebSocket requests use the cookie through normal
   WebView behavior. Reloading the dashboard continues to work.
8. Bootstrap codes expire quickly, are invalid after one attempt, and are
   invalidated with the server process. A restart causes Rust to bootstrap a
   new desktop session.

Use `Secure` on the cookie when the Windows WebView accepts it for the
loopback origin; otherwise record the tested WebView limitation and retain the
host-only, HttpOnly, Strict, session-lifetime cookie. The loopback-only
listener remains part of the security boundary in either case.

The master-secret and bootstrap routes:

- are accepted only on the loopback listener, never an optional LAN listener;
- reject forwarded host/address headers as proof of locality;
- use constant-time secret comparison;
- are rate-limited and omit secrets from errors, health, diagnostics, and
  server output;
- never set a cookie for a LAN hostname or address; and
- do not bypass separately configured password/SRP policy on remote or relay
  surfaces.

Passing the master secret through a pipe reduces accidental exposure in
environment dumps and renderer JavaScript. It does not defend against a
malicious same-user process that can inspect the YA or Bun process memory. The
v0 threat model must say so explicitly.

### Tauri command hardening

Before another public desktop build:

- update and lock Tauri and first-party plugins to an audited release no older
  than 2.11.5;
- add an explicit application/command manifest required by the fixed ACL path;
- replace the one broad capability with per-window capabilities;
- grant the remote `dashboard` window no custom Tauri commands;
- keep privileged commands on packaged Tauri-origin windows only;
- remove shell spawn/execute, installer, PTY, and provider-auth commands made
  obsolete by deleting the wizard;
- remove the release `devtools` feature unless a separately identified
  diagnostics build needs it;
- replace `csp: null` with a restrictive CSP for packaged desktop pages; and
- add tests that an arbitrary localhost/remote page cannot invoke native
  commands, even if it opens in or navigates the dashboard WebView.

The server-served dashboard needs its own HTTP CSP/header audit. A Tauri CSP
for packaged pages does not protect content after navigation to loopback.

## Compatibility And Release Ordering

The desktop bootstrap is core authentication behavior. The 2026-07-30 audit
covered server `v0.5.0`, `v0.5.1`, `v0.5.2`, `v0.6.0`, `v0.6.1`, `v0.6.2`,
and `v0.7.0`, plus desktop `desktop-v0.0.1` through `desktop-v0.0.5`. These are
the latest stable releases and every stable release from the preceding 60
days. All use the legacy bearer-token contract. The originating request
accepted the migration and its fallback, satisfying the maintainer approval
gate.

The proposed compatibility contract is:

- add a versioned private `desktop-bootstrap-v1` supervisor protocol;
- publish server support while retaining the existing
  `DESKTOP_AUTH_TOKEN` header/query path for the approved compatibility
  window;
- bundle that server with the first new desktop shell;
- let an old shell continue to use only the legacy path during the grace
  period;
- require the new shell to receive the v1 readiness record and fail closed
  with an "incompatible development server" diagnostic when it is absent;
- never let the new shell fall back to returning the master token to
  JavaScript; and
- remove the legacy route only after the support horizon and a separate
  maintainer security review.

This protocol is between the native supervisor and its paired server before
the hosted client is loaded. It should not reuse or broaden an existing
`/api/version` capability. The ordinary browser client makes no new request,
and the hosted remote compatibility level does not change solely for this
private bootstrap.

The provider warning should reuse the existing provider catalog when its
current fields are sufficient. If implementation requires a new server route,
field, event, or changed meaning, stop after the release-corpus audit and
present a separate capability-gated compatibility plan. Without that
capability, supported clients must make no unsupported request and retain the
existing provider UI.

The implemented provider compatibility contract adds the optional
`applicationDetected` field to existing provider records only when the server
is running as the bundled desktop runtime. Older clients ignore the field.
When it is absent, the new client falls back to the existing `installed`
signal and makes no additional request. The optional `desktopRuntime` version
marker similarly defaults to the ordinary browser behavior when absent.

## Implementation Evidence

The 2026-07-30 implementation includes:

- Bun 1.3.14 selected from one checked-in version/hash manifest;
- a commit-matched, lockfile-derived physical production dependency tree with
  no junctions, hidden virtual-store dependency, or first-run package install;
- desktop bootstrap protocol v1, 30-second one-use codes, an HttpOnly
  host-only Strict cookie, bounded in-memory sessions, and legacy old-shell
  support;
- Tauri 2.11.5, an explicit application manifest, packaged-origin command
  capabilities, restrictive packaged/server CSPs, and no remote dashboard
  native commands;
- direct first launch, the diagnostic fallback, bounded/redacted server
  output, random port readiness, and Windows Job Object ownership;
- advisory Claude/Codex application detection, focus/Retry refresh, official
  links, and no setup or authentication gate;
- an explicit three-tier dashboard close policy whose default releases the
  hidden WebView after five minutes while retaining the bundled server; and
- release workflow checks for signed updater artifacts and complete Windows
  signing credentials.

Local Windows acceptance used the real unsigned NSIS artifact:

- `/S` installed to `%LOCALAPPDATA%\YepAnywhere`;
- the installed app started its installed `bun.exe` and physical server
  resource, selected a dynamic loopback port, minted a one-use browser
  session, and reached an authenticated `/projects` page with no credential in
  the final URL;
- Quit removed the complete installed Bun worker tree (`remaining=0`);
- the MSI artifact built successfully; non-elevated `/qn` correctly failed
  with Windows Installer error 1925 because Tauri's MSI is an all-users
  package, so the elevated managed-install pass remains in the signed matrix;
  and
- the warning UI was inspected at 1920×1080 and 375×812. The reviewed captures
  are
  `.artifacts/ui-testing/2026-07-30-desktop-v0/provider-warning-desktop-1920x1080.png`
  and
  `.artifacts/ui-testing/2026-07-30-desktop-v0/provider-warning-mobile-375x812.png`.

Final source-state verification on 2026-07-30 also passed:

- `pnpm lint` with zero warnings;
- explicit server and client TypeScript checks (the root recursive filter
  matched no packages in PowerShell after building `shared`);
- 29 focused server tests and 3 focused client tests with no runtime warnings;
- the desktop frontend production build;
- `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, all 6 Rust
  tests, and the exact bundled-runtime smoke;
- `pnpm console:scan` at the existing 110/110 budget with no increase, plus
  `pnpm i18n:scan` with no new advisory findings; and
- a fresh final-source NSIS build followed by a successful non-elevated `/S`
  reinstall to `%LOCALAPPDATA%\YepAnywhere`.

The remaining release work requires external signing/release state rather than
source implementation: a signed clean-profile matrix, elevated MSI pass, and
signed N -> N+1 updater round trip with live `latest.json`.

## Numbered Implementation Plan

### 0. Freeze contracts and compatibility

1. Create `topics/desktop-v0.md` as the owning observable-behavior contract.
   Move the accepted install, onboarding, provider-warning, stable/dev
   coexistence, update, data-preservation, bootstrap, listener, and failure
   behavior from this tactical into that topic before runtime edits land.
2. Update `topics/security.md` with the desktop loopback/Tauri trust boundary,
   cookie bootstrap, and same-user-process limitation.
3. Inventory the required stable server and desktop release corpus. Record
   exact versions, the legacy auth contract, the new private protocol, and the
   old/new fallback matrix for maintainer approval.
4. Present the `YEP_DEV_DIR` precedence/migration proposal for approval under
   the hard development rules.
5. Confirm that no planned client change raises
   `remoteCompatibilityLevel`; add an exact capability only if later client
   work introduces a new optional server contract.
6. Turn the Windows smoke findings above into checked regression issues or
   tests so they are not lost when the wizard code is deleted.

Exit gate: the product contract, threat model, release corpus, compatibility
grace, and development override behavior are approved before client/server
contract edits.

### 1. Build one atomic desktop runtime

1. Add a deterministic production server-resource build from the current
   checkout.
2. Bundle that resource and its production dependencies in Tauri.
3. Add and validate the release manifest.
4. Centralize, upgrade, download, and hash-check the Bun sidecar.
5. Change production server resolution to the immutable resource directory.
6. Retain old downloaded components as inactive migration data; do not delete
   user files.
7. Delete first-run network installation from the normal launch path.
8. Add a CI smoke that starts the exact packaged resource with the exact Bun
   sidecar and reaches health before an installer can be published.

Exit gate: an offline unpacked release build starts its bundled server on
Windows without using npm, pnpm, a global Bun, or the old desktop
`node_modules`.

### 2. Establish the Tauri security floor

1. Upgrade and lock Tauri/plugins to the audited safe line.
2. Add the explicit app/command manifest and split capabilities by window.
3. Remove obsolete installer, PTY, auth, and broad shell permissions and
   commands.
4. Disable native commands in the remote dashboard window.
5. Add CSPs for packaged pages and security headers for the loopback page.
6. Add negative ACL tests using untrusted localhost and remote origins.
7. Verify external provider links open through a narrow trusted action rather
   than granting the dashboard general shell access.

Exit gate: the known remote-origin ACL conditions no longer exist, and a
loaded localhost page cannot call privileged Rust commands.

### 3. Make the Windows supervisor deterministic

1. Replace free-port reservation with bind-to-zero plus a structured readiness
   handshake.
2. Add bounded startup and health deadlines with actionable errors; use
   readiness polling/events, never fixed sleeps.
3. Put the server and all descendants in an app-owned Windows Job Object with
   kill-on-close semantics.
4. Use graceful stop first, then a bounded tree termination on restart, quit,
   crash recovery, update, and uninstall.
5. Make stop/restart idempotent and clear all bootstrap/session state.
6. Change NSIS hooks so they target Yep Anywhere's owned process/job only.
   The current broad `bun.exe` kill must not terminate unrelated Bun work.
7. Fix autostart enable/disable so either choice can complete first launch and
   repair safely.
8. Preserve the bounded, redacted server-output buffer and ensure all reader
   tasks terminate with the child.

Exit gate: repeated launch/restart/quit/update cycles leave no YA-owned Bun,
pnpm, shell, or provider descendants, and do not touch an unrelated Bun or
PowerShell development process.

### 4. Remove setup as an installation workflow

1. Start the bundled server and dashboard directly when no desktop config
   exists.
2. Migrate missing/false `setup_complete` to the new ready state only after
   bundled-server readiness succeeds.
3. Preserve existing `agents` data for compatibility but stop using it as a
   startup/install gate; mark it for a later schema cleanup.
4. Remove the normal Welcome, Agent Selection, Install, Auth, and Ready page
   path.
5. Replace `Setup / Repair` with a focused Desktop Diagnostics surface:
   bundled versions, server state, data directory, provider detection summary,
   recent output, Retry/Restart, and official help links.
6. Do not offer provider or package installation buttons in that surface.
7. Add the non-blocking "no Claude or Codex detected" notice using i18n copy
   and existing provider catalog state where possible.
8. Refresh detection after the app regains focus and through an explicit
   Retry action; do not add a permanent polling loop.

Exit gate: clean first launch reaches the dashboard without choices or network
package installs in all provider-presence cases.

### 5. Replace renderer bearer-token auth

1. Add the private startup-secret/readiness protocol and loopback-only
   bootstrap state.
2. Add short-lived single-use code mint and consume routes.
3. Establish the scoped HttpOnly desktop session cookie and clean redirect.
4. Authenticate fetch, SSE, and WebSocket upgrades through that session.
5. Remove `get_desktop_token`, `?desktop_token=`, module-memory token capture,
   `X-Desktop-Token` from the new desktop path, and token-bearing logs.
6. Retain the legacy header/query implementation only behind the approved
   compatibility path.
7. Add expiry, replay, wrong-listener, wrong-origin, restart, and redaction
   tests.
8. Verify password-auth-enabled, password-auth-disabled, optional LAN, and
   relay configurations do not weaken one another.

Exit gate: refresh, hard reload, window close/reopen, and server restart all
recover without a 401 or exposing a long-lived credential to JavaScript.

### 6. Close Windows installation and updater behavior

1. Make the signed NSIS artifact the clearly named primary Windows download.
2. Test interactive install, `/S`, interactive uninstall, and silent
   uninstall. Test MSI `/qn` too if MSI remains published.
3. Verify Start menu/desktop shortcuts, single-instance behavior, tray
   behavior, no sidecar console, and per-user install location.
4. Require Windows code signing and the Tauri updater signing key for a release
   tag. A tagged release must fail rather than silently omit updater artifacts.
5. Validate `latest.json` contains the expected Windows target, URL,
   non-empty signature, and downloadable signed artifact.
6. Run a signed version N -> N+1 updater test, including relaunch, data
   preservation, and recovery after an interrupted download.
7. Document manual reinstall as the v0 rollback/recovery path. Do not claim an
   automatic downgrade path unless one is implemented and tested.
8. Update release notes to describe the atomic shell/runtime/server unit and
   the fact that providers remain externally managed.

Exit gate: a normal user and a scripted deployment can install, launch,
update, reinstall, and uninstall the Windows app without a terminal or
post-install component wizard.

### 7. Run the release-candidate matrix

Use fresh Windows user profiles or disposable VMs for:

| Case | Machine state | Expected first-launch result |
| --- | --- | --- |
| A | neither provider detected | dashboard opens; one non-blocking official-install warning |
| B | Claude only | dashboard opens; no global absence warning |
| C | Codex only | dashboard opens; no global absence warning |
| D | Claude and Codex | dashboard opens; both appear through normal provider state |
| E | detected but logged out/broken | dashboard opens; provider/session surface reports the launch/auth problem |
| F | upgraded v0.0.5 data | settings/sessions survive; old managed components are not executed |
| G | PowerShell dev server on 3400 | stable app chooses its own port/data and both remain usable |
| H | password auth plus optional LAN listener | desktop cookie works only on loopback; LAN/relay keep their existing auth |

For every applicable case:

1. Install interactively and silently.
2. Launch without an attached console.
3. Open Dashboard and Server Output from the app/tray.
4. reload the dashboard at least five times;
5. create a real session with each installed/authenticated provider available
   on that machine;
6. exercise a logged-out provider failure;
7. restart and quit the app repeatedly;
8. inspect listeners and child processes;
9. update from the previous signed candidate; and
10. confirm the development server and unrelated Bun processes remain alive.

Automated coverage should include Rust supervisor/bootstrap units, server auth
integration tests, desktop React tests, installer artifact assertions, and a
Windows desktop smoke harness. UI work also requires final inspected captures
at 1920x1080 and 375x812, with the warning and diagnostics states represented.

Required warning-free checks for touched areas include:

```bash
pnpm lint
pnpm console:scan
pnpm i18n:scan
pnpm --filter @yep-anywhere/desktop build
cd packages/desktop/src-tauri && cargo fmt --check
cd packages/desktop/src-tauri && cargo clippy --all-targets -- -D warnings
cd packages/desktop/src-tauri && cargo test
```

Add the targeted server/client tests selected by the implementation and build
the real Windows NSIS bundle. Passing an unpacked dev build is not the release
gate.

### 8. Cut the v0 desktop release

1. Update `docs/roadmap/desktop-app.md` to describe the implemented architecture
   and link the owning topic rather than the original tray-only concept.
2. Update tactical 012/013 future-work notes where this plan supersedes
   downloaded managed components and unsigned updater artifacts.
3. Update `packages/desktop/CHANGELOG.md`, install/help documentation, silent
   install commands, provider prerequisites, data location, and recovery
   instructions.
4. Publish a signed Windows release candidate and complete the full matrix.
5. Publish the v0 release only after the updater endpoint serves its signed
   metadata and an installed previous candidate successfully consumes it.
6. Record macOS build status and any intentional platform gaps without
   delaying the Windows release for unimplemented Linux packaging.

Exit gate: every Definition of Done item below has evidence attached to the
release or recorded in this tactical.

## Definition Of Done

V0 desktop is complete when:

- one signed Windows installer contains everything YA itself needs;
- clean install and first launch require no terminal and no wizard;
- first launch works offline except for provider-backed actions and links;
- provider absence is advisory, not a gate;
- YA never installs or authenticates Claude/Codex;
- the bundled server is from the same tested release commit as the shell;
- the desktop dashboard survives reload without 401;
- the master desktop credential is absent from JavaScript, URLs, environment,
  command lines, files, health responses, and logs;
- remote localhost content cannot invoke privileged Tauri commands;
- desktop bootstrap works only over the loopback listener;
- stable desktop and a PowerShell development server coexist;
- quit, restart, update, and uninstall leave no owned descendants and do not
  kill unrelated Bun processes;
- interactive and silent install/uninstall are verified;
- a signed updater round trip preserves user data and configuration; and
- all focused checks, repo checks, runtime tests, and UI captures are
  warning-free and reviewed.

## Explicitly Deferred

- Installing or updating provider CLIs, Bun, package managers, or provider
  desktop apps.
- Driving Claude/Codex login inside YA.
- Treating `claude auth status` or `codex login status` as a setup gate.
- A headless/background desktop updater mode that installs without the normal
  desktop UI.
- A provider health wizard or compatibility/version certification system.
- Automatic rollback/downgrade.
- General Linux distribution polish.
- Replacing the Bun server with an in-process Rust service.
- RSTorrent-style native application transport:

  ```text
  bundled Tauri UI
    -> invoke / Channel
      -> Rust supervisor
        -> framed private stdin/stdout
          -> Bun application service
  ```

  That remains the preferred post-v0 direction. It would keep the WebView on
  the Tauri origin and allow the loopback listener to be disabled unless
  browser/mobile/remote access is explicitly enabled. V0 deliberately secures
  the current loopback boundary first instead of combining onboarding,
  packaging, authentication, process lifecycle, and a complete client
  transport replacement in one release.
