# Changelog

## [0.1.0] - Unreleased

### Added
- A commit-matched bundled server/client resource and hash-verified private Bun runtime.
- Reload-safe loopback dashboard authentication using one-time bootstrap codes and an HttpOnly session cookie.
- Desktop diagnostics with bounded server output, retry, quit, and stable/development runtime identification.
- Advisory Claude/Codex application detection with links to the official installers when neither is found.
- Windows Job Object ownership for the bundled server process tree.
- A packaged-runtime smoke test that exercises dynamic-port readiness, health, bootstrap, and authenticated API access.

### Changed
- First launch now opens the bundled dashboard directly; the multi-page component installer and provider login wizard have been removed.
- Desktop updates replace the shell, Bun runtime, and YA server/client as one tested unit.
- Production builds ignore ambient `YEP_DEV_DIR`; debug builds retain the explicit checkout-backed development path.
- Tauri is pinned to 2.11.5 with explicit command manifests, per-window capabilities, and packaged/server content security policies.
- Windows installer shutdown targets only Yep Anywhere's process tree and never kills unrelated `bun.exe` processes.
- Tagged releases now require updater signing and complete Windows code-signing credentials.

### Removed
- First-run downloads of Yep Anywhere, Bun, Claude Code, and Codex.
- Desktop PTY, general shell, provider authentication, and component installer commands.

## [0.0.5] - 2026-06-27

### Fixed
- Task and plan lists no longer render an undersized in-progress indicator.
- Patient message queue no longer merges multiple queued messages into a single turn.

### Changed
- Release builds are pinned to the macOS 26 CI runner image for reproducible signing and notarization.

## [0.0.4] - 2026-06-27

### Added
- Desktop auto-update checks and updater endpoint.
- Server output surface for viewing server logs in the desktop app.
- Codex CLI support wired into the desktop server.

### Changed
- Canonicalized startup environment variables to the `YEP_` prefix, with migration from legacy names.
- macOS builds are now signed with Developer ID and notarized; Windows builds are signed via Azure Trusted Signing.

## [0.0.3] - 2026-06-01

### Fixed
- Allow unsigned macOS desktop builds when Developer ID signing secrets are not configured.

## [0.0.2] - 2026-06-01

### Added
- Windows local installer script for testing the desktop app from a normal per-user installation.
- Claude child-process diagnostics for Windows session startup failures.

### Fixed
- Desktop startup health probe and allowed-host handling for Windows Tauri origins.

## [0.0.1] - 2026-06-01

### Added
- Disposable desktop release for validating CI artifacts, signing fallback, and release publishing.
