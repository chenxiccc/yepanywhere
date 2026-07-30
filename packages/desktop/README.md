# Yep Anywhere Desktop

Desktop v0 is a stable shell around the bundled Yep Anywhere server. The
installer includes the Tauri app, a private Bun runtime, and the matching
server/client build. First launch does not run a package manager or provider
login wizard.

Claude or Codex is expected to be managed outside Yep Anywhere. If neither
provider application is detected, the dashboard still opens and links to the
official [Claude download](https://claude.com/download) and
[Codex setup](https://openai.com/codex/get-started/) pages. Authentication is
checked only when the normal provider/session UI needs it.

## Windows installation

The signed `YepAnywhere_<version>_x64-setup.exe` NSIS artifact is the primary
installer. Interactive installation is the default. Quiet installation uses:

```powershell
.\YepAnywhere_<version>_x64-setup.exe /S
```

If the MSI artifact is used for managed deployment:

```powershell
# Run from an elevated deployment shell.
msiexec.exe /i .\YepAnywhere_<version>_x64_en-US.msi /qn
```

Tauri's WiX MSI is an all-users package and requires administrator
privileges. For quiet per-user installation without elevation, use the primary
NSIS executable with `/S`.

The NSIS uninstaller accepts `/S`; an MSI can be removed with
`msiexec.exe /x <product-code> /qn`. Ordinary update, reinstall, and uninstall
preserve the desktop data directory at `%USERPROFILE%\.yep-anywhere-desktop`.
Remove that directory only when an explicit full data reset is intended.

The tray menu provides Dashboard, Server Output, Desktop Diagnostics, update
checks, autostart, background behavior, startup view, restart, and quit. A
manual reinstall of a signed release is the v0 recovery path; automatic
downgrade is not supported.

## Local Windows build and smoke

From a prepared checkout:

```powershell
pnpm --dir packages/desktop prepare-runtime
pnpm --dir packages/desktop smoke-runtime
scripts\install-local-tauri-windows.bat
```

The local helper builds an unsigned NSIS package, installs it with `/S`, and
launches the installed app. Use `--no-launch` when only install behavior is
being tested.
