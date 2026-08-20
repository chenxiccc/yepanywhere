# Make Windows Provider CLI Launches Executable

> Detect every path reported by Windows `where`, but advertise a provider as
> installed only when YA can launch the selected target safely.

Topic: windows-provider-cli-launches

Status: Implemented and validated on 2026-08-20. Issue 117 was reproduced on
the Windows 11 machine-control target with OpenCode 1.18.18 and Pi 0.84.2.

Related contracts:

- [`topics/provider-authoring.md`](../../topics/provider-authoring.md)
- [`topics/pi-provider.md`](../../topics/pi-provider.md)
- [`topics/opencode-backend.md`](../../topics/opencode-backend.md)
- [`topics/grok.md`](../../topics/grok.md)
- [`topics/windows-codex-cli-detection.md`](../../topics/windows-codex-cli-detection.md)

## Reported behavior

On Windows, npm installs expose both extensionless and `.cmd` shims. The
reporter's commands returned two CRLF-delimited paths for each provider, but
YA trimmed the complete output and passed the resulting multi-line string to
`existsSync()`. OpenCode and Pi therefore appeared uninstalled even though
their commands worked in a shell.

Current `main` already repairs OpenCode's npm layout specifically: it resolves
`opencode-ai/bin/opencode.exe`, which Node can execute directly. The Windows
reproduction selected that executable, ran `opencode --version`, and completed
`models --verbose` with 419 nonempty output lines.

Pi still rejects the multi-line lookup result. Splitting alone is not enough:
Node `execFile()` returned `EINVAL` for the reported `pi.cmd`. The published
package declares `pi: dist/cli.js`; launching that entry through
`process.execPath` completed the 0.84.2 version probe and the zero-token RPC
contract (`get_state`, `get_available_models`, and clean stdin-close exit).

## Compatibility boundary

- Parse command-lookup output once with CRLF-safe, whitespace-trimming rules.
  Providers may apply stronger selection rules after parsing; the parser does
  not claim that every existing file is directly executable.
- Preserve explicit configuration precedence. An explicit Pi path never
  silently falls through to a different auto-discovered installation.
- Represent Pi as an executable plus argument prefix. On Windows, npm shims
  resolve to the package's known JavaScript entry and run through the current
  Node executable. YA does not pass provider arguments through `cmd.exe` or a
  generic shell merely to make `.cmd` work.
- Keep OpenCode's native-executable preference. Its `models` path uses
  `execFile()` and must not regress to an npm shim when the packaged `.exe` is
  available.
- Migrate Gemini, Gemini ACP, and Grok lookup parsing without redesigning their
  existing process contracts. Gemini's shell-owned path accepts Windows
  `.cmd` / `.bat` shims but skips extensionless npm shell scripts. Grok's
  shell-free `execFile()` path requires `.exe` / `.com`. This does not certify
  every third-party Windows install layout.
- Keep root `test` and `typecheck` scripts shell-neutral so cmd.exe does not
  preserve quotes around pnpm's negative Android workspace filter.

## Pi 0.84.2 refresh evidence

The official `v0.82.1..v0.84.2` source and 0.84.2 changelog preserve the CLI
bin entry, RPC commands, response correlation, model fields consumed by YA,
`agent_settled`, and the existing v3 coding-agent session files. Pi 0.84.0
changed RPC `message_update` to carry delta events rather than cumulative
messages. YA already accumulates `text_delta` and `thinking_delta` under stable
message ids and takes settled usage from `turn_end`, so no new normalization
branch is required. The real Windows zero-token probe confirmed the startup
and response shapes.

### 1 — centralize command-lookup parsing

Export the existing CRLF-safe candidate parser from `cli-detection.ts`. Add a
coarse direct-versus-shell Windows selector and use the appropriate layer from
Codex, OpenCode, Pi, Gemini, Gemini ACP, and Grok while retaining package-layout
selection and explicit-path precedence.

### 2 — give Pi one launch descriptor

Replace Pi's bare path result with one descriptor used by model discovery,
session startup, and version probing. Resolve Windows npm global and local
`.bin` layouts to `@earendil-works/pi-coding-agent/dist/cli.js`, prefix every
Pi argument list with that entry, and use `process.execPath` as the executable.
Direct executables and POSIX commands retain an empty prefix.

### 3 — lock provider discovery regressions

Cover CRLF, multiple candidates, stale paths, native `.exe` preference, npm
global/local Pi layouts, configured-path authority, and launch-argument
composition with host-independent unit fixtures. Keep OpenCode's existing
Windows regression suite and make the installed Pi contract consume the same
launch descriptor as production.

### 4 — publish the provider contracts

Record the shared discovery rule in provider authoring, the executable Pi
contract and 0.84.2 audit in the Pi topic, and the tested OpenCode/Grok bounds
in their owning topics. Advance `piCli.compatibleThroughVersion` to 0.84.2.

### 5 — keep root validation commands portable

Use pnpm's unquoted `--filter=!...` form in root `test` and `typecheck` scripts
so POSIX shells and Windows cmd.exe select the same non-Android workspaces.

### 6 — validate native Windows launches

Run warning-free focused tests and typechecking locally. On the Windows target,
install the reporter's exact CLI versions in an ownership-marked disposable
npm prefix, run provider detection plus OpenCode model discovery and Pi's
zero-token RPC contract, then remove the prefix without shutting down the VM.

## Acceptance

- The reporter's multi-line `where opencode` output selects the packaged
  `opencode.exe`; version and model discovery remain directly executable.
- The reporter's multi-line `where pi` output produces a Pi launch descriptor,
  not a multi-line path or `.cmd` executable.
- Pi model discovery, session startup, and version probing all use the same
  executable and argument prefix.
- A missing or unresolvable explicit Pi path fails closed without selecting a
  different installation.
- Gemini, Gemini ACP, and Grok ignore blank/stale lookup lines and accept the
  first provider-appropriate executable candidate.
- Pi 0.84.2's zero-token RPC responses and clean exit pass on Windows; no
  authenticated prompt or token spend is required.
- Root `pnpm typecheck` checks the non-Android workspaces on Windows instead of
  succeeding after a `No projects matched` diagnostic.
- No shell interpolation is added to the Pi launch path, and no provider child
  survives test teardown.

## Result

The Windows target reported the exact npm layout from issue 117 for both
providers: extensionless and `.cmd` paths under one isolated prefix. The native
provider contract passed in 37.9 seconds, including OpenCode auth/model discovery
and Pi discovery/model fallback. Pi's zero-token 0.84.2 contract then passed in
23.0 seconds with recognized version output, `get_state`, an empty-but-valid
`get_available_models`, and a clean stdin-close exit.

The root Windows typecheck initially exposed the quoted pnpm filter bug by
building `shared` and then reporting `No projects matched`. With the portable
filter it completed all selected workspace checks successfully. The common
machine-control doctor was fully healthy before and after the test window; the
VM remained running. The ownership-marked checkout, isolated npm prefix, and
transferred archives were removed after validation.

Local focused coverage finished with 81 passing tests and two opt-in contracts
skipped, followed by warning-free `pnpm typecheck`, `pnpm lint`, and
`pnpm format:check`. The full server suite retained 10 failures in two untouched
macOS worktree-watcher files (`projectWorktreeScan.test.ts` and
`projectWorktreeSubscriptionManager.test.ts`) caused by `/var` versus
`/private/var` expectations and dependent timer assertions; 4,199 tests passed
and 44 were skipped. No provider test failed in that run.
