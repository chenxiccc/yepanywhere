# Server app tests scan the live Codex session tree

Several tests that call `createApp()` provide an isolated Claude
`projectsDir` but omit `codexSessionsDir`. `createApp()` therefore constructs a
`CodexSessionScanner` over the developer's real `~/.codex/sessions`; on this
host, the warning-free server suite emits repeated `CODEX_SCANNER: slow scan`
warnings while reading more than 500 unrelated rollout files.

The affected surface includes `packages/server/test/api/files.test.ts` and
`packages/server/test/api/projects.test.ts`. The hermetic environment setup
deletes inherited `CODEX_HOME` / `CODEX_SESSIONS_DIR` values, so a shell
override cannot isolate these tests. The clean fix is a shared app-test factory
that supplies empty temporary provider directories by default, while tests
that exercise provider discovery opt into explicit fixtures.

This was not fixed in place because it spans app-level tests unrelated to the
local-file viewer behavior; suppressing the logger would hide the
non-hermetic scan rather than repair it.

Found 2026-07-27 while verifying rendered Markdown source-line navigation.
