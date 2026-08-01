---
title: Troubleshooting
description: Diagnose startup, provider detection, remote connection, notification, and desktop-app problems safely.
---

Start with the smallest failing boundary: host server, provider, browser,
remote transport, or optional feature. Preserve the first useful error instead
of repeatedly restarting every component.

## Server does not start

Check the terminal output and confirm the configured ports are free. The main
server defaults to `3400`; the maintenance server uses `3401` and the Vite
development server uses `3402`.

Server logs live in the `logs` folder under the active data directory. The
defaults are:

- npm/source on macOS or Linux: `~/.yep-anywhere/logs/`
- npm/source on Windows: `%USERPROFILE%\.yep-anywhere\logs\`
- desktop app on macOS: `~/.yep-anywhere-desktop/logs/`
- desktop app on Windows: `%USERPROFILE%\.yep-anywhere-desktop\logs\`

Profiles use a suffixed directory such as `.yep-anywhere-dev` under the user
home directory. `YEP_DATA_DIR` can override the npm/source location.

## Provider is missing or cannot start

Run the provider's official CLI directly on the same host and user account.
Confirm it is installed, authenticated, and usable before debugging Yep
Anywhere. Desktop installs do not bundle Claude Code or Codex credentials.

If `ENABLED_PROVIDERS` is set, confirm the provider is included. Experimental
providers may need additional executables, endpoints, or Settings values.

## Local works, remote does not

1. Open `http://localhost:3400` on the host.
2. Confirm **Settings → Remote Access** shows a connected relay.
3. Re-enter the exact username and remote URL.
4. Check clock, proxy, and firewall behavior if authentication repeatedly
   restarts.
5. Inspect the server log for a transport or origin error.

Do not solve a relay problem by exposing the unauthenticated local server to
the public internet.

## Notifications do not arrive

Check browser site permission, operating-system notification settings, the
subscribed browser profile, and service-worker status. Use the test-notification
control before waiting for a real approval event.

## Desktop app cannot open the dashboard

Open **Desktop Diagnostics** and **Server Output** from the tray menu. Record
the desktop version, bundled Yep Anywhere version, operating system, and the
bounded startup error. A manual reinstall of the current signed release is the
supported v0 recovery path.

## File or source action is unavailable

A file path may sit outside configured allowed roots. A Source Control action
may be withheld because the repository is detached, diverged, dirty, or lacks
an expected remote. Read the visible blocker; do not bypass it with a more
destructive Git command unless you understand the repository state.

## File a useful issue

Open an issue at [GitHub](https://github.com/kzahel/yepanywhere/issues) with:

- Yep Anywhere and desktop-app versions, if applicable.
- Operating system and installation method.
- Provider and provider version.
- Exact expected and observed behavior.
- The smallest relevant log excerpt.
- Whether the problem reproduces locally or only remotely.

Remove credentials, passwords, remote usernames, session contents, private
paths, and repository secrets before posting.
