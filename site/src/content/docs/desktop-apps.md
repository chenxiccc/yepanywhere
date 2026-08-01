---
title: Desktop apps
description: Install the experimental signed macOS or Windows app from GitHub Releases and understand its bundled runtime.
---

Yep Anywhere publishes experimental desktop installers for macOS and Windows.
They are close to release-ready, but the public status remains **Experimental**
until a separate release-readiness decision promotes them.

[Open Yep Anywhere releases](https://github.com/kzahel/yepanywhere/releases)

## What the desktop app includes

The installer bundles the Yep Anywhere server, web client, and a private Bun
runtime as one tested unit. First launch opens the local dashboard without
running npm or a package manager.

Claude Code and Codex are managed separately. If neither provider is detected,
the dashboard still opens and links to the providers' official setup pages.

## macOS

Choose the `.dmg` that matches your Mac:

- **Apple Silicon** for M-series Macs.
- **Intel** for Intel-based Macs.

Tagged releases are signed with Developer ID and notarized. Move Yep Anywhere
to Applications and launch it normally. macOS may still show ordinary first-run
security confirmation for an app downloaded from the internet.

## Windows

The signed `x64-setup.exe` installer is the normal choice. A signed `.msi` is
also published for managed, all-users deployment and requires administrator
privileges.

Use the `.exe` unless you specifically need MSI deployment tooling.

## Tray behavior and data

The tray menu exposes the dashboard, server output, diagnostics, update checks,
startup behavior, restart, and quit. Closing the dashboard hides it and, by
default, unloads the hidden web view after five minutes while leaving the tray
app, server, and active provider sessions running.

Desktop data uses a separate desktop profile so it does not silently overwrite
an existing command-line installation's state.

## Updates and recovery

Use the desktop update check when offered. A manual reinstall of a newer signed
release is the supported recovery path. Automatic downgrade is not supported.

If the app cannot start its bundled server, open **Desktop Diagnostics** and
**Server Output** before filing an issue. Include the app version, bundled Yep
Anywhere version, operating system, and the bounded error output—never provider
credentials or session contents.

## Mobile app status

The Android app is in development and is not published. It is not part of the
desktop download and no public APK or store listing is currently offered. Use
the [mobile browser connection](/docs/remote-access) today.
