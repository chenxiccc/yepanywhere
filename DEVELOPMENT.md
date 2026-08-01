# Development

## Setup

```bash
git clone https://github.com/kzahel/yepanywhere.git
cd yepanywhere
pnpm install
pnpm dev
```

Open http://localhost:3400 in your browser.

If you only want the main app and do not want to install the relay workspace, use:

```bash
pnpm setup:core
pnpm dev
```

## Commands

```bash
pnpm setup:core       # Install root + client + server + shared, skipping relay
pnpm dev              # Start dev server
pnpm lint             # Biome linter
pnpm typecheck        # TypeScript type checking
pnpm test             # Unit tests
pnpm test:e2e         # E2E tests
pnpm references:sync  # Clone/sync upstream source to pinned provider versions
pnpm references:check # Verify local references match pinned provider versions
```

Commits should be warning-free: `pnpm lint` reports zero warnings, and test
runs emit no runtime warnings (e.g. React "cannot update while rendering" or
`act(...)` notices). Fix the cause rather than suppressing the report; a
warning that must stand needs an inline justification.

Environment-dependent subprocess tests must control both the child environment
and relevant process descriptors. In particular, Bash `BASH_ENV` probes use
ignored stdin rather than inheriting a test runner's socket-backed stdin. See
[subprocess environment boundaries](topics/subprocess-environment.md) for the
runtime and hermetic-test contract.

## Reference Source

`pnpm references:sync` shallow-clones upstream source into `references/` for
local reading (currently the Codex Rust source, `codex-rs`, under
`references/codex`). The directory is gitignored and optional. The Codex
checkout is aligned with the official `rust-v<expectedVersion>` tag derived
from root `package.json`; the command refuses to move a checkout with local
changes. Use `pnpm references:check` for a read-only alignment check.
`pnpm clone-references` remains an alias for the sync command. The Claude SDK
is not open source and is not included.

## Client I18n

Client UI copy should be i18n-ready by default. When adding visible sentences,
labels, headings, placeholders, tooltips, or aria text, add an English key to
`packages/client/src/i18n/en.json` and render it through `useI18n().t(...)`.
Non-English locale files are sparse overlays; only add translated locale values
when an actual translation is available.

Do not spend effort localizing brand/provider names, keyboard keys, terminal
commands, code tokens, protocol values, or source-like renderer text unless
they are embedded in real explanatory copy. To catch obvious misses, run:

```bash
pnpm i18n:scan
```

The scan is intentionally permissive and advisory. It warns on likely raw
English prose in client TSX, hides low-priority technical labels by default,
and can be inspected with `pnpm i18n:scan -- --include-info`. Use
`--max-warnings <n>` only when intentionally ratcheting it toward a blocking
check.

To review untranslated sparse-locale backlog without enforcing it on ordinary
code changes, run:

```bash
pnpm i18n:missing
pnpm i18n:missing -- --markdown --limit all > reports/i18n-missing-$(date +%F).md
```

`i18n:missing` reports English keys absent from non-English locale overlays and
always treats missing translations as advisory. Use this for daily or weekly
translation planning rather than as a blocking lint rule.

## Client CSS

Use co-located CSS Modules (`Component.module.css`) for component-owned client
styles. The legacy global stylesheets are frozen at ratcheting line-count
ceilings, enforced by:

```bash
pnpm css:check
pnpm css:modules:check
```

`css:modules:check` is also part of `pnpm lint`. It blocks undeclared,
production-unused, test-only, unimported, computed, and side-effect module
usage, plus `:global(...)` references that are missing or lack a local anchor.
Use `pnpm css:unused` for the broader investigative report; its known legacy
findings are advisory and do not make ordinary lint fail.

When moving rules out of a legacy global file lowers its line count, record the
new lower ceiling in the same change:

```bash
pnpm css:check --record
```

Do not raise a ceiling to land a feature. Generated HTML vocabularies, themes,
tokens, and document-level rules may remain global under the narrow exceptions
in [`topics/css-architecture.md`](topics/css-architecture.md); ordinary React
component layout and states belong in modules.

The dedicated migration campaign is complete. Ongoing paydown is
opportunistic: when a task changes a component that still emits legacy global
classes, inspect its current ownership and move a bounded, locally verifiable
slice with the feature change. Zero global CSS is not a target, and a feature
task should not grow into generated-markup, dynamic-class, or cross-owner
composition work merely to reduce a line count.

Before finishing such a change, run:

```bash
pnpm css:touched
```

The command compares the working tree with `HEAD`; pass `--base <ref>` to
include committed branch work from that ref's merge base. It prints concise
ownership facts for changed React owners, labels bounded slices as
opportunities, and labels coupled, scattered, dynamic, or unresolved evidence
for deferral. The report is advisory and always succeeds for either outcome.

For standalone paydown work, select a bounded owner from the parser-backed
inventory instead of maintaining a speculative migration queue:

```bash
pnpm css:inventory
pnpm css:inventory -- --owner <component-or-path>
```

The inventory is advisory. Inspect its coupled, generated, unresolved, dynamic,
and test-reference findings before defining a slice. The full selection and
verification protocol lives in the CSS architecture topic.

If the touched component is not a safe extraction candidate, record the
specific reason in the change handoff rather than adding it to a migration
queue. CSS health is evaluated on demand across containment, ownership,
module-contract, escape-hatch, dead-code, and shipping-size signals; the global
line ratchet is one guardrail, not a complete progress score.

For a CSS-focused review or occasional architecture audit, run:

```bash
pnpm css:health
```

This composes the existing analyzers into a human-readable summary; `--json`
is available for a one-off comparison. It reports separate facts rather than a
score and does not build the client, persist results, or fail on observational
debt. Continue to use `css:check`, `lint`, and `css:unused` for their own exit
contracts.

## Contribution Ethos: Minimalist Runtime

Running code — everything outside test/build tooling — is hand-built and lean on
dependencies. Before adding a runtime dep:

- **Narrow-scope utilities**: prefer a ~100-line hand-rolled implementation over
  a package. SGR parsers, debounces, small date helpers, tiny encoders — code
  them. A dep's long-term reading/audit cost usually exceeds the one-time write.
- **Exemptions**: don't hand-roll crypto (bcrypt, NaCl), auth protocols
  (SRP-6a), web frameworks (Hono), syntax highlighting (Shiki), or the official
  provider SDKs. Use the audited/canonical implementation.
- **Client bundle**: mobile-first — anything entering the client bundle must
  justify its payload. Prefer server-side rendering.
- **Mobile interaction**: visible controls and list rows must remain practical
  touch targets. Compact desktop density is acceptable only if mobile users can
  still tap the intended item without precision aiming; verify spacing-sensitive
  UI on a narrow viewport before landing.
- **Client rendering**: rich renderers should operate on block/tool-sized input
  and return cheap metadata they already know, such as whether output changed.
  Reuse a first completed scan for both control decisions and display instead
  of rendering once to decide whether a toggle exists and again to show it. See
  [packages/client/RENDERING_PERFORMANCE.md](packages/client/RENDERING_PERFORMANCE.md).
- **Dev-deps**: tooling (vitest, biome, playwright, tsx, types) doesn't ship to
  users; lower bar applies.

Rule of thumb: if a dep is essentially a one-file helper, write the file.

## Architecture

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the entry-point map of how
provider events flow through the server to the client, the transport modes,
and the large-scope refactor proposals. Read it before changing message-flow
or render-path code.

## Client/Server Compatibility Review

Hosted clients can update before installed servers. When a client change
depends on a new server route, response field, event, or semantic, record and
obtain maintainer approval for the compatibility decision before
implementation:

- identify whether the feature is core or optional;
- inspect the latest two stable releases and every stable release from the
  preceding 14 days (optional) or 60 days (core);
- name the capability/protocol gate and the exact behavior when it is absent;
- prove the fallback makes no unsupported request; and
- call out any proposed change to an already-advertised capability or older
  capable behavior.

Existing capability meanings cannot be expanded retroactively: released
servers already advertised the old contract. Passing the minimum support
horizon allows a human review but does not automatically remove the fallback.
See [`topics/server-capabilities.md`](topics/server-capabilities.md) and
[`topics/remote-hosted-compatibility.md`](topics/remote-hosted-compatibility.md).

## Port Configuration

Ports are derived from a single `PORT` variable (default: 3400):

| Port | Purpose |
|------|---------|
| PORT + 0 | Main server |
| PORT + 1 | Maintenance server |
| PORT + 2 | Vite dev server |

```bash
PORT=4000 pnpm dev  # Uses 4000, 4001, 4002
```

## Data Directory

Server state is stored in `~/.yep-anywhere/` by default:

- `logs/` — Server logs
- `indexes/` — Session index cache
- `uploads/` — Uploaded files
- `session-metadata.json` — Custom titles, archive/starred status

### Running Multiple Instances

Use profiles to run dev and production instances simultaneously:

```bash
# Production (default profile, port 3400)
PORT=3400 pnpm start

# Development (dev profile, port 4000)
PORT=4000 YEP_PROFILE=dev pnpm dev
```

Environment variables:
- `YEP_PROFILE` — Profile name suffix (creates `~/.yep-anywhere-{profile}/`)
- `YEP_DATA_DIR` — Full path override for data directory

## Server Logs

Logs are written to `{dataDir}/logs/server.log`. View in real-time:

```bash
tail -f ~/.yep-anywhere/logs/server.log
```

Environment variables:
- `LOG_LEVEL` — Minimum level: fatal, error, warn, info, debug, trace (default: info)
- `LOG_TO_FILE` — Set to "true" to enable file logging (default: off)
- `LOG_PRETTY` — Set to "false" to disable pretty console logs (default: on)

## Maintenance Server

A lightweight HTTP server runs on PORT + 1 for diagnostics when the main server is unresponsive:

```bash
curl http://localhost:3401/status          # Server status
curl -X POST http://localhost:3401/reload  # Restart server
```
