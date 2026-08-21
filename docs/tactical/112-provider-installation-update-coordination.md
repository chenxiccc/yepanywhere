# Coordinate Provider Installation Updates

> Make provider installation mutation a shared, verified lifecycle so an
> updater cannot race discovery, catalogs, launches, live runtimes, or caches.

Topic: provider-installation-updates

Status: proposed after the 2026-08-21 Codex startup false-negative.

Related contracts and plans:

- [`topics/provider-installation-updates.md`](../../topics/provider-installation-updates.md)
- [`topics/provider-refresh.md`](../../topics/provider-refresh.md)
- [`topics/provider-authoring.md`](../../topics/provider-authoring.md)
- [`topics/windows-codex-cli-detection.md`](../../topics/windows-codex-cli-detection.md)
- [`topics/reload-safe-provider-runtimes.md`](../../topics/reload-safe-provider-runtimes.md)
- [`topics/provider-host-api.md`](../../topics/provider-host-api.md)
- [`094-new-session-provider-catalog-readiness.md`](094-new-session-provider-catalog-readiness.md)
- [`111-windows-provider-cli-launches.md`](111-windows-provider-cli-launches.md)

## Incident And Root Cause

On 2026-08-21 the server started with a usable npm-global Codex 0.148.0 and
successfully ran its startup version probe. The stored
`codexUpdatePolicy: "auto"` then started `npm install -g
@openai/codex@latest` asynchronously while the server was accepting clients.
npm retired the old package and `/opt/homebrew/bin/codex` before the replacement
link existed. The provider-catalog request itself was not timestamped, but the
client connected during that window, received a negative row, and a forced
refresh immediately found 0.149.0 after the update completed. Those facts make
the replacement-window probe the high-confidence trigger, rather than a
directly timestamped observation.

The event-loop timeout and incomplete Apple Silicon fallback remain real
hardening gaps, but they do not best explain this incident. The causal defect
is that `CodexUpdateChecker`, CLI discovery, provider-route acquisition,
provider-owned model caches, and session launches have no common installation
generation or mutation boundary.

## Current Fault Map

| Surface | Current behavior | Required correction |
|---|---|---|
| Auto update | Fire-and-forget from `createApp()` | Admit through a stable installation owner before mutation |
| Manual update | Independent POST runs the same installer | Join the same single-flight operation and safe-runtime gate |
| Provider aliases | `codex` and `codex-oss` probe separately | Share one `codex-cli` installation family/generation |
| Detection | PATH/common candidates each execute `--version`; errors collapse to `undefined` | Typed results, one family-level single-flight probe, bounded transient retry |
| Provider route | Five-minute success and negative TTL; cache is route-local | Generation-aware rows, short negatives, externally driven invalidation |
| Codex model cache | Private five-minute cache with no install generation | Key or clear it with verified installation generation |
| Client provider cache | Five-minute memory plus seven-day display snapshot | Explicit post-update refresh/invalidation; snapshots remain display-only |
| Launches/helpers | Resolve and spawn independently of updater | Read/runtime leases or explicit retryable update barrier |
| Provider host | Workers can outlive Hono | Report family runtime leases across Hono replacement |
| Multiple profiles | Can mutate the same global npm install independently | Stable per-user cross-process writer intent and stale-owner verification |
| Installer command | Shell interpolation of inferred package name | Allowlisted argument-vector package-manager launch |
| Verification | npm exit 0 followed by update-checker refresh | Production launch descriptor must verify before success publishes |

## Design Decisions

1. The generic abstraction is an installation coordinator plus optional
   provider update adapters. It is not an `update()` method copied onto every
   `AgentProvider`, because several provider rows can share one executable and
   many providers will remain externally managed.
2. Codex is the first adapter and `codex-cli` is its stable family. Both Codex
   providers, startup mismatch detection, models, helper app servers, session
   launches, and the updater consume that family.
3. Update checking remains non-blocking. Only filesystem mutation and its
   production verification require writer ownership.
4. Automatic updates never terminate live YA provider runtimes. Manual updates
   follow the same safe rule in this slice. They can wait or report blockers;
   there is no hidden force path.
5. Provider status does not turn negative during a known YA mutation. Warm
   ordinary reads may use the last verified display row; forced/cold reads and
   all launches join completion or receive an explicit retryable updating
   result.
6. Success is one transaction: package-manager exit, production probe,
   generation advance, affected-cache invalidation, provider refresh, and
   update-status publication. Any failure has one classified terminal result.
7. `installed: true` still means launchable outside a known mutation. The fix
   does not weaken detection to “a path exists.”
8. Existing update-policy values and the `notify` default do not change. No
   other provider gains an updater in this work.

## Why Narrow Fixes Are Insufficient

- A shorter negative TTL and a forced Settings refresh improve recovery, but
  still let a launch hit a temporarily missing executable.
- Adding `/opt/homebrew/bin/codex` improves discovery before and after an
  update, but that path is absent during the same npm replacement window.
- Treating an existing path as installed would hide probe failures and weaken
  the provider-authoring launchability contract.
- Invalidating caches after npm completes cannot stop a stale in-flight probe
  from publishing late unless results are ordered by installation generation.
- A lock inside `CodexUpdateChecker` prevents duplicate installers but does
  not coordinate aliases, launches, provider-host runtimes, other YA profiles,
  or future providers.
- Delaying the startup updater only moves this race; manual, scheduled, and
  external updates can create the same replacement window later.

## Implementation Order

### 1 — lock the Codex replacement-window regression

Build a deterministic fake installation fixture whose updater moves the public
command, pauses, installs a new launchable target, and restores the command.
During the pause issue aggregate and named requests for both `codex` and
`codex-oss`, plus a new-session launch attempt. The pre-fix test must reproduce
the negative row/path error without invoking the real npm installation.

Add typed CLI probe results for `not-found`, lookup failure, launch failure,
timeout, empty output, and usable version. Preserve the public compatibility
shape while making structured logs and retry policy able to distinguish them.

### 2 — add the installation-family coordinator

Create one small server service keyed by stable installation family. It owns:

- read, runtime, and writer-intent leases;
- checking/waiting/installing/verifying/terminal state;
- one in-flight update promise and operation id;
- a monotonic install generation plus last verified descriptor/fingerprint;
- affected provider names and invalidation listeners; and
- structured lifecycle diagnostics.

Use writer preference only after mutation can actually start. An automatic
update waiting on a long-lived runtime must not block ordinary turns for hours;
once runtime blockers drain, writer intent prevents a new launch from entering
the replacement window.

Add a private, cross-platform per-user lock/lease record keyed by stable
package/install identity, not a versioned realpath or YA profile. Use atomic
creation and PID/start-identity validation for stale cleanup. Prove the
check/create/recheck ordering that prevents a reader/writer race. Keep these
records out of projects and Git metadata.

### 3 — make Codex discovery one installation consumer

Route startup mismatch detection, `detectCodexCli`, Codex and Codex OSS install
checks, version reads, and launch-descriptor resolution through `codex-cli`.
Coalesce the duplicate auth/model/version probes already identified in
tactical 094. Preserve explicit configured-path authority and highest-version
auto selection.

Add `/opt/homebrew/bin/codex` and a safely resolved npm-global bin candidate to
the macOS fallback set. This is recovery coverage, not the coordination fix.
Do not accept an unlaunchable path merely because it exists.

### 4 — protect every Codex launch and retained runtime

Acquire bounded read leases for model-list app servers, version/auth checks,
account probes, and helper sessions. Acquire a runtime lease before spawning a
new/resumed Codex session and release it only after the underlying provider
process, queue, and retained background work end.

Carry the installation family/generation in provider-worker launch facts. Teach
the provider host to retain/report that lease across Hono replacement and to
reject a new worker launch after writer intent. Inventory side sessions and
direct provider calls so no helper bypasses the boundary.

Expose blocker counts by state without leaking prompt or project content.
Automatic mutation waits. Manual mutation returns a clear retry/update-when-
safe result rather than interrupting a turn or deleting an idle worker behind
the user's back.

### 5 — turn Codex update into a verified transaction

Refactor `CodexUpdateChecker` into the Codex update adapter while preserving
the current routes and settings. Resolve an allowlisted npm executable/argument
vector and run `install -g @openai/codex@latest` without interpolating a
discovered package name through a shell.

The adapter enters writer ownership before npm can retire a path, records
bounded phase output, and verifies through the production Codex launch
descriptor before publishing success. A refreshed GitHub status alone is not
verification. Concurrent auto/manual requests join; retries after a terminal
failure create a new operation generation.

Define reload and shutdown ownership before landing: a replaceable Hono must
not orphan an unobserved npm mutation or start a competitor. Replacement
servers observe a live shared owner/lock. Full shutdown applies one bounded
wait and an explicit recovery diagnostic instead of silently killing npm in
the replacement window.

### 6 — converge server and client provider catalogs

Include the verified installation generation/fingerprint in the provider-row
source version for every affected alias. Make provider-owned Codex model and
launch caches generation-aware. On success or terminal failure, invalidate
`codex` and `codex-oss` together and recompute through the existing
`SourceVersionedSingleFlight` route owner so stale pre-update work cannot win.

Give settled unavailable rows a short negative TTL while retaining the
existing success TTL. During a known mutation, serve only a last-verified
display row or join completion; never cache the replacement window as a new
negative fact.

After a manual update, the initiating client calls the existing forced
provider refresh and publishes it through the shared `useProviders` cache.
For automatic completion, evaluate a provider-catalog invalidation activity
event. If an event is needed, complete the optional-feature compatibility
review before editing the wire contract; new clients retain the existing TTL
fallback when connected to older servers and may add focus revalidation
through existing routes. Old clients must safely ignore or avoid the new
event. Do not make a new client call an unsupported route.

### 7 — harden external-update recovery

An unrelated terminal, desktop installer, or provider-native self-updater will
not hold YA's coordinator. Make those failures recover without weakening
launch truth:

- retry typed transient lookup/launch/empty-output failures with a small
  bounded backoff;
- log the candidate, phase, duration, exit/signal/timeout class, and whether a
  usable last-known install exists;
- retain settled negatives briefly rather than for five minutes;
- make Settings Refresh use the server-forced refresh path; and
- keep common locations and package-manager bin resolution portable across
  macOS, Linux, and Windows.

Do not solve event-loop timer uncertainty by declaring a non-running file
installed. If the three-second version probe remains sensitive under measured
startup pressure, isolate or extend/retry that probe with explicit latency
evidence.

### 8 — publish the provider-updater extension rule

Link the durable topic from provider authoring and provider refresh. Document
that any future Gemini, Grok, OpenCode, Pi, Ollama, or other installer declares
its shared installation family and adopts the coordinator before gaining an
auto/manual mutation route. Keep Tauri/YA self-update contracts separate.

## Verification Matrix

All tests use fake executables/package managers and temporary private runtime
directories; no test mutates a developer's real provider installation.

| Scenario | Required evidence |
|---|---|
| First catalog read during symlink replacement | No transient `installed: false`; forced read returns verified new generation |
| Codex and Codex OSS concurrency | One mutation/probe owner; both rows invalidate and converge together |
| New/resumed/helper launch during mutation | No spawn reaches the missing path; explicit wait/retry result preserves the prompt |
| Active/waiting/queued/retained runtime | Auto update waits and does not interrupt; update proceeds after the final lease drains |
| Two manual/auto requests | One package-manager process and one terminal result |
| Two YA profiles | One cross-process writer; other profile waits and later sees the verified fingerprint |
| Hono safe reload during install | Mutation ownership survives/reattaches; no duplicate updater starts |
| Full shutdown during install | Bounded documented recovery path; next start diagnoses live/stale ownership |
| npm nonzero with old install usable | Old provider remains launchable; update failure is visible; caches do not claim new version |
| npm zero with broken new install | Operation fails verification and provider is not advertised healthy |
| External update window | Typed retry/short negative recovery; forced Settings refresh repairs state |
| Event-loop pressure around version probe | No silent empty-output negative retained for the success TTL |
| Windows npm command/path | Argument-vector updater and production launch descriptor work without POSIX assumptions |
| Apple Silicon npm-global path | `/opt/homebrew`/npm-global install is found without relying only on inherited PATH |
| Client manual success | All mounted provider consumers receive the forced refreshed rows |
| Older client/server combinations | Existing routes/TTL fallback remain usable; no unsupported request is made |

Run focused coordinator, CLI-detection, Codex updater/provider, provider-route,
Supervisor/provider-host, client-hook, and update-prompt tests. Then run
warning-free `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, and `pnpm test`.
Any user-visible update/blocker state also receives the repository's desktop
and phone-width browser captures plus `pnpm console:scan`.

## Acceptance

- A YA-owned provider update cannot publish an uninstall/auth failure solely
  because its package manager temporarily replaced files.
- No affected provider subprocess starts against an installation being
  mutated, including provider-host and auxiliary launches.
- Active provider runtimes are not interrupted by automatic or ordinary
  manual updates.
- Shared aliases and every server/client cache converge on one verified
  generation without waiting for a five-minute negative TTL.
- Auto/manual requests and multiple YA profiles cannot run competing updates
  for one installation.
- Success means the production launch descriptor works; failure is classified,
  observable, retryable where safe, and never overwritten by stale work.
- Codex policy/default/configured-path behavior remains unchanged, and no other
  provider becomes auto-updatable implicitly.
- Provider authoring makes this coordination mandatory for every future
  in-app provider updater.

## Compatibility Checkpoint

The server-only coordinator, launch barrier, typed probes, TTL split, and
existing-route manual refresh need no new client/server contract. If automatic
completion needs a new provider-catalog event, update phase, blocker field, or
generic provider-update route, treat it as optional functionality: inspect the
latest two stable releases and every stable release in the preceding 14 days,
name a new capability if the client depends on the addition, preserve the
existing routes/TTL behavior when absent, and obtain maintainer approval before
editing the wire contract. Existing capability meanings do not expand.

## Non-Goals

- Automatically updating providers other than the already configured Codex
  path.
- Changing `codexUpdatePolicy` values, stored choices, or the `notify` default.
- Treating protocol compatibility refresh (`provider-refresh`) as permission
  to mutate a user's CLI.
- Guaranteeing serialization with an unrelated external package manager.
- Force-killing provider sessions to make an update happen.
- Folding the Tauri desktop or Yep server updater into the provider
  installation coordinator.
