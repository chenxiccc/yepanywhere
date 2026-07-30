# Desktop App (Tauri)

Status: Windows-first v0 implementation complete; signed release validation
pending.

The owning behavior contract is
[`topics/desktop-v0.md`](../../topics/desktop-v0.md). Tactical 067 records the
accepted direction, compatibility audit, implementation slices, and release
matrix:
[`docs/tactical/067-v0-desktop-baseline.md`](../tactical/067-v0-desktop-baseline.md).

## Implemented V0

The desktop release is one atomic unit:

```text
Yep Anywhere Desktop
├─ Tauri shell and tray
├─ private, hash-verified Bun runtime
├─ commit-matched server/client production resource
└─ runtime manifest with versions and hashes
```

First launch starts that bundled resource directly. It does not install YA,
Bun, Claude, Codex, package managers, or provider credentials. Claude and
Codex remain externally managed; when neither application is detected the
dashboard opens normally with a dismissible warning and official links.

The dashboard remains on random-port loopback HTTP for v0. Native Rust passes
a master secret to the paired server through stdin, mints a short-lived
single-use navigation code, and the server exchanges it for a host-only
HttpOnly Strict cookie. Reload no longer depends on a bearer token retained by
renderer JavaScript.

Windows owns the bundled server and descendants with a kill-on-close Job
Object. The app provides a tray, stable/development runtime identification,
bounded server output, a startup diagnostic fallback, restart/quit controls,
and the existing prompted Tauri updater.

## Windows Distribution

The signed per-user NSIS executable is the primary download and supports `/S`
for quiet installation without elevation. The MSI is a secondary all-users
artifact for elevated managed deployment and supports `/qn`.

Release tags require the Tauri updater signing key and complete Windows
code-signing credentials. CI validates the Windows updater entries, signature,
and live artifact URLs before publishing.

## Deferred

- Installing, updating, or authenticating Claude/Codex.
- Unattended background update installation.
- Automatic rollback or downgrade.
- General Linux distribution polish.
- Replacing loopback HTTP with a native invoke/Channel application transport.

The preferred later transport keeps the bundled UI on the Tauri origin and
uses framed private native/server IPC, enabling loopback HTTP to be disabled
when browser, mobile, and remote access are not needed.
