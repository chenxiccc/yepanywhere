# Desktop V0

> Desktop v0 is one stable, self-contained YA installation that uses
> externally managed provider software and starts without an onboarding gate.

Topic: desktop-v0

## Distribution Contract

The signed desktop installer owns one tested release unit:

- the Tauri shell;
- a private JavaScript runtime that is not added to the user's `PATH`;
- the server and client artifacts built from the same commit; and
- a manifest that identifies those versions.

First launch must not download or install YA, Bun, Claude Code, Codex, or a
package manager. A desktop update replaces the shell, runtime, and bundled YA
artifact together. Provider software remains externally managed.

Desktop application files and user data have separate lifecycles. Update,
reinstall, and ordinary uninstall preserve sessions, settings, auth state, and
provider configuration unless the user explicitly chooses a data-removal
operation.

## First-Launch Contract

A clean installation starts the bundled server and opens the dashboard. It
does not require a Welcome, provider selection, component installation,
provider login, or Ready step.

Provider presence and provider authentication never gate installation, server
startup, or access to the dashboard. If neither Claude nor Codex is detected,
the running app shows non-blocking platform-appropriate guidance to the
official installers. A coarse application detection result is advisory and
must not be presented as proof that a provider is authenticated or launchable.

The existing provider catalog may include optional `applicationDetected`
booleans while `desktopRuntime` is active. Older clients ignore the field.
New clients treat an absent field as the existing `installed` signal, so they
do not require a new route or capability from older supported servers. The
notice refreshes when the browser regains focus and through an explicit retry;
it does not add a polling loop.

The server provider catalog remains authoritative for actual provider
availability. Provider launch and authentication failures use the ordinary
provider/New Session error surfaces; they do not reopen desktop onboarding or
mutate provider installations.

An unavailable bundled server opens a bounded diagnostic surface with the
startup error, recent redacted output, Retry, and Quit. It must not fall back
to downloading runtime components.

Desktop startup is single-flight. Rapid cold launches join the same server
startup attempt and open at most one dashboard. A second operating-system
launch while the server is starting waits for that attempt; it does not spawn
another server or reveal the hidden recovery surface. A second launch while
the server is running focuses the existing dashboard without reloading it.
Concurrent callers receive the same startup failure and do not turn a failed
attempt into an implicit retry. A later explicit Retry may start a new
attempt, while a launch queued during shutdown must not resurrect the server.

The packaged launcher is a recovery surface, not an ordinary application
window or onboarding step. It stays hidden during normal startup and repeat
launches. `starting`, `running`, `stopping`, `stopped`, and `error` are
distinct supervisor states; the launcher must not describe an in-progress
startup as stopped.

## Stable And Development Coexistence

The signed app uses its own immutable runtime resources, desktop data root,
owned process tree, and random loopback port. It does not attach to an
unrelated server because a familiar port is in use.

A server launched separately from a checkout remains independent. Desktop
start, restart, quit, update, reinstall, and uninstall must not terminate or
modify that development server or an unrelated Bun process.

Development overrides must be explicit and visible. A signed stable app must
not silently become checkout-backed because of an ambient machine-level
development variable.

## Local Dashboard Authentication

The desktop dashboard may use loopback HTTP in v0, but JavaScript must not own
the long-lived desktop credential.

The native supervisor and server establish a versioned private startup
protocol:

1. native code creates a per-process master secret and sends it through a
   private inherited pipe;
2. the server reports readiness and its selected loopback port;
3. native code mints a short-lived, single-use bootstrap code;
4. navigation consumes the code and establishes a host-only, HttpOnly,
   SameSite=Strict desktop session cookie; and
5. fetch, SSE, and WebSocket requests use that cookie.

The bootstrap/master-secret route is available only through the loopback
listener. It is not accepted by optional LAN, relay, or internally forwarded
requests. Codes are short lived, single use, rate limited, and invalidated on
server restart. Credentials never appear in renderer JavaScript, URLs after
the bootstrap redirect, environment variables, command lines, files, health
responses, or logs.

Reload, dashboard close/reopen, and server restart must recover without a 401.
Password, LAN, and relay authentication keep their existing boundaries.

Bootstrap v1 holds at most 16 active codes for 30 seconds, allows at most 30
invalid attempts per minute, and keeps at most 32 in-memory desktop sessions
for 30 days. The browser cookie itself has no persistent expiry and therefore
also ends with browser cookie-state removal. Plain loopback HTTP cannot use a
`Secure` cookie because browsers would not return it; the v0 cookie remains
host-only, HttpOnly, SameSite=Strict, and path-rooted.

The legacy `DESKTOP_AUTH_TOKEN` header/query contract remains server-side only
for the approved old-shell support window. A new shell never falls back to
returning the master secret to JavaScript when bootstrap v1 is absent.

## Tauri Boundary

Packaged Tauri-origin windows receive only the native commands required by
their surface. The loopback dashboard window receives no custom Tauri command
capability. Remote content must not be able to install software, spawn a shell
or PTY, read desktop secrets, control the server, or change desktop settings.

Packaged pages and server-served pages each carry an explicit CSP appropriate
to their origin. Release builds do not expose development tools by default.

The private pipe protects against accidental disclosure through renderer code,
URLs, child environments, and diagnostics. It does not protect against a
malicious same-user process able to inspect YA or Bun process memory.

## Windows Lifecycle And Install Contract

The NSIS executable is the primary v0 Windows installer and supports quiet
installation. If an MSI is published, its quiet installation path is tested
too.

NSIS is a current-user install and `/S` does not require elevation. Tauri's
WiX MSI is an all-users managed-deployment artifact; `/qn` therefore runs from
an elevated deployment context.

The server and every descendant belong to an app-owned Windows process group
or Job Object. Quit, restart, update, and uninstall attempt graceful shutdown
and then terminate only that owned tree within a bounded deadline. No
unqualified `bun.exe`, provider, shell, or PowerShell process kill is allowed.

The installed app has no sidecar console window. Interactive and quiet
installation, update, reinstall, and uninstall are release-tested from a clean
Windows user profile.

## Update Contract

The app checks the signed Tauri updater automatically and asks before
installing/relaunching. A tagged release fails if its signed updater artifact
or Windows entry in `latest.json` is missing.

The v0 recovery path is a manual reinstall of a signed release. Automatic
downgrade and unattended background update installation are not claimed.

## Compatibility Corpus

The bootstrap migration was reviewed on 2026-07-30 against the core 60-day
support corpus:

- server `v0.5.0`, `v0.5.1`, `v0.5.2`, `v0.6.0`, `v0.6.1`, `v0.6.2`, and
  `v0.7.0`; and
- desktop `desktop-v0.0.1` through `desktop-v0.0.5`.

Every release in the corpus uses the legacy desktop token header/query
contract. Bootstrap v1 is a private native-supervisor/server protocol and does
not broaden an existing `/api/version` capability or raise the hosted remote
compatibility level.

Old shells retain the legacy server fallback for this support window. New
shells require bootstrap v1 and fail closed with an incompatible-runtime
diagnostic when it is absent.

## Deferred

- Installing, updating, or authenticating provider software.
- Silent background update installation.
- Automatic downgrade.
- General Linux distribution polish.
- Replacing the server with an in-process Rust implementation.
- Moving the bundled dashboard to a native invoke/Channel transport and
  disabling loopback HTTP when browser/mobile/remote access is off.
