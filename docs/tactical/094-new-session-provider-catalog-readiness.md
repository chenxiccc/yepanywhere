# Make New-Session Provider and Model Choices Immediate

> Render the saved provider/model choice from retained state immediately, then
> refresh only the provider facts the user needs without making an unrelated
> provider's CLI discovery part of the New Session critical path.

Status: Current-route readiness is implemented (2026-08-05); three acceptance
criteria remain partial. Forced refreshes are generation safe, Gateway launch
requires a successful current named probe, browser snapshots are versioned and
allowlisted, and New Session usage telemetry waits behind selected-provider
route work. Clean first-visit provider-card paint, server-persisted
provider/model rows, and aggregate failure isolation remain open. The measured
aggregate crosses the stop condition for a compatibility-reviewed
descriptor/refresh split; that result does not silently change the current
complete-response protocol.

## What landed (2026-08-05)

The implemented slice uses `GET /api/providers` and
`GET /api/providers/:name`, including their existing `refresh=1` behavior. It
adds no route, response field, event, capability, or partial aggregate semantic.

- **Selected provider resolves on its own.** `useProviderRow()` asks only for the
  selected provider. New Session does not wait for the aggregate before it can
  reconcile the selected model, while the aggregate continues to populate the
  full provider-card grid. Aggregate and named cache entries carry one shared
  request-admission sequence and notify every mounted source consumer, so a
  later settings reload replaces an older named row without letting a late
  older aggregate completion or failure displace newer facts.
- **Refresh generations have one bounded owner.** `routes/providers.ts` now uses
  `SourceVersionedSingleFlight` under a 4 MiB retained-value budget. Ordinary
  callers join current work, concurrent forced callers coalesce, forced work
  supersedes older ordinary work, and a late old success or failure follows the
  newer generation instead of publishing or deleting stale facts. Context-window
  metadata is ingested only after that generation is accepted. Aggregate failure
  semantics remain unchanged.
- **Gateway display and launch authority are separate.** Selecting Claude
  Gateway starts a forced named probe after that selection becomes current. A
  stale saved model remains visible while the probe runs or after it fails, but
  neither Start nor Project Queue launch is authorized until a successful
  current named response advertises the required model. The supervisor repeats
  that Gateway-only advertised-model check at actual new-session process
  creation, so a delayed Project Queue or worker-queue launch cannot reuse
  enqueue-time authority. A Project Queue item deferred into the worker queue
  remains durable until that launch settles; validation failure marks the item
  failed with the current catalog error instead of deleting its prompt. At
  worker capacity, direct Gateway callers without that durable failure callback
  receive the existing `queue_full` response instead of an unsafe queued
  acceptance. Retry calls only the named route, reducing one observed retry from
  nine auth/model provider pairs to one (88.9% fewer unrelated probes).
- **Provider cards survive a reload without retaining account data.** The
  source-scoped seven-day `localStorage` snapshot is now versioned and built
  from explicit provider/model display and capability allowlists. It excludes
  identity, expiry, login commands, credentials, authorization material, raw
  provider output, and unknown configuration. Hydration remains pre-expired:
  the snapshot paints an opening guess but never satisfies the current probe.
- **Saved choice paints before the catalog.** `NewSessionForm` seeds from saved
  provider-scoped defaults as soon as settings resolve, then reconciles against
  current provider rows without overwriting a choice made in the new window.
  With no row at all, the seed uses an unprobed placeholder for the saved
  provider name.
- **New Session usage is supplementary.** Only its first subscription-usage
  acquisition waits behind earlier startup route work. Direct-demand consumers
  and every explicit Refresh remain immediate; the source/provider cache still
  coalesces compatible reads.
- **OpenCode costs one CLI process.** `getAvailableModels()` formerly ran plain
  and verbose model listings in series. The verbose parser now supplies ids and
  variants, with the plain listing only as a fallback when verbose output is
  unusable.

The privacy-safe benchmark is reproducible with:

`pnpm --filter @yep-anywhere/server benchmark:provider-model-route`

The benchmark reads persisted provider settings and the provider marker needed
for production visibility without running settings migration or metadata
restart recovery. Missing files mean defaults/no marker; malformed or unreadable
files fail the measurement. It may probe an already-running Gateway but
deliberately omits the configured Gateway start command, so a benchmark cannot
start an operator process or inherit its output. Provider diagnostics are
suppressed, and output contains only provider names, timings, model/probe counts,
and the number suppressed. A post-fix smoke confirmed both persisted files
remained byte-for-byte unchanged. Five samples measured the aggregate at 2.180
s median / 2.485 s p90 for nine
providers, down
from the previous 6.211 s one-off result. OpenCode remained the owner at 2.093 s
median / 2.148 s p90, down from 4.407 s. Named medians for every other provider
were 321 ms or less. The result exceeds the agreed 2 s aggregate-median
condition for reconsidering descriptor/refresh separation.

`packages/client/e2e/provider-readiness.spec.ts` drives the production client
against an isolated real YA server. Its two passing scenarios hold aggregate,
named Gateway, and usage responses independently; prove stale display,
checking, failure, named-only Retry, current success, fresh-empty blocking, and
route-before-usage order; and keep service workers blocked. Final captures:

- `.artifacts/ui-testing/094-provider-readiness/gateway-checking-desktop-1920x1080.png`
- `.artifacts/ui-testing/094-provider-readiness/gateway-checking-mobile-375x812.png`
- `.artifacts/ui-testing/094-provider-readiness/gateway-ready-desktop-1920x1080.png`
- `.artifacts/ui-testing/094-provider-readiness/gateway-ready-mobile-375x812.png`

Existing `.artifacts/ui-testing/094-revisit-desktop.png` and
`094-revisit-phone.png` show the earlier stale-snapshot behavior with the
aggregate held for 8 s. Unit coverage additionally pins forced-refresh and
aggregate/named cache ordering, accepted-generation metadata publication,
Gateway launch-time revalidation, durable deferred-launch failure, snapshot
exclusions, strict read-only benchmark inputs, and supplementary usage
scheduling.

Still open, with separate evidence gates rather than one blanket capability
deferral:

- Measure ten isolated clean-browser/fresh-server provider-card paints. Revisit
  a persisted server snapshot only if median remains over 1.5 s or p90 over
  3 s.
- Prepare the required stable-release compatibility review before splitting
  descriptors from model refresh or returning partial aggregate rows.
- Keep aggregate failure isolation unchanged until each row has an explicit
  stale/error wire contract.
- Make generic Gateway discovery side-effect free only with provider-runtime
  evidence that the replacement preserves installation/auth/model semantics;
  this provider-internal correction does not inherently require a capability.
  The isolated browser spec intercepts provider responses, so it verifies the UI
  state machine but does not exercise those runtime side effects.
- Add production timing metrics only if p90 exceeds 2x median without an
  identified owner, or browser/network time exceeds route time by 500 ms or
  25%. The current route variance has an identified OpenCode owner; browser
  overhead is not yet measured.

Needs restart: the OpenCode, provider-route ownership, and actual-launch
Gateway validation changes are server-side.

Related contracts:

- [`topics/session-defaults.md`](../../topics/session-defaults.md)
- [`topics/provider-abstraction.md`](../../topics/provider-abstraction.md)
- [`topics/server-capabilities.md`](../../topics/server-capabilities.md)
- [`topics/server-performance-observability.md`](../../topics/server-performance-observability.md)
- [`031-client-query-controller.md`](031-client-query-controller.md)
- [`089-main-thread-startup-cpu-investigation.md`](089-main-thread-startup-cpu-investigation.md)
- [`093-provider-session-reconciliation.md`](093-provider-session-reconciliation.md)
- [`095-new-session-recent-project-readiness.md`](095-new-session-recent-project-readiness.md)

## Original fault and remaining live cost

Before this tactical, `NewSessionForm` withheld the saved provider/model choice
until `useProviders()`, `useServerSettings()`, and `useVersion()` had all
settled. The form now projects the retained settings choice first and validates
the selected provider independently. A second visit can also paint provider
cards from the stale browser snapshot. A first-ever visit still has no retained
provider-card rows, and a fresh server still computes the aggregate on demand.

The app shell's `primeProviderCache()` and New Session continue to join one
aggregate request. That avoids duplicate client requests but does not make the
aggregate cheap. The server retains successful provider rows for five minutes;
there is no durable server provider/model snapshot across restart.

New Session concurrently requests recent project choices. That route is not a
provider-catalog prerequisite, and tactical 095 owns its transcript/index work.
Subscription usage is now admitted only as supplementary startup work in New
Session, after earlier route tiers settle.

The reproducible five-sample route measurements on 2026-08-05 were:

| Request | Median | p90 | Relevant result |
|---|---:|---:|---|
| aggregate `GET /api/providers?refresh=1` | 2.180 s | 2.485 s | Nine configured/visible providers; Gateway already running, 236 models in the final sample |
| forced OpenCode detail | 2.093 s | 2.148 s | Slowest member and identified aggregate owner |
| forced Claude detail | 0.321 s | 0.325 s | Second material provider in this sample |
| forced Gateway detail | 0.002 s | 0.003 s | Persisted Gateway configuration included |
| forced Codex detail | 0.148 s | 0.158 s | Saved/default provider need not await OpenCode |
| forced Codex OSS detail | 0.155 s | 0.155 s | Independent named row |
| forced Gemini detail | 0.006 s | 0.007 s | Independent named row |
| forced Gemini ACP detail | 0.006 s | 0.006 s | Independent named row |
| forced Grok detail | 0.002 s | 0.002 s | Independent named row |
| forced Pi detail | 0.006 s | 0.007 s | Independent named row |

Run `pnpm --filter @yep-anywhere/server benchmark:provider-model-route` to
repeat the measurement. The previous one-off
baseline was 6.211 s aggregate and 4.407 s OpenCode. Parsing ids and variants
from one verbose OpenCode invocation removed the sequential plain listing, but
OpenCode still determines aggregate latency. The current aggregate median
therefore crosses the 2 s descriptor/refresh reconsideration threshold.

The aggregate route calls every exposed provider through `Promise.all` and,
within each row, calls authentication and model discovery concurrently. This
still has four undesirable consequences:

- an unselected OpenCode catalog delays first-visit provider cards and the
  aggregate correction, though it no longer delays selected Codex controls;
- providers such as Claude may repeat authentication work because their model
  method checks authentication again internally;
- Codex OSS may run `ollama list` independently for auth and models; and
- one uncaught provider failure rejects the complete provider response rather
  than leaving other providers usable from their last successful rows.

The configured Claude Gateway path still has an additional side effect.
`getAvailableModels()` calls `gatewayLauncher.ensureReady()`, so server startup
warming and an ordinary all-provider primer may start and retain a gateway
process even when Gateway is not selected. Gateway selection and Retry now use
the named route's generation-safe owner, but `ModelInfoService.warmProvider()`
does not populate that route cache. Generic discovery is therefore not yet
side-effect free, and startup warm remains a separate catalog-work owner.

## Required product behavior

New Session has two different facts and should not flatten them into one
loading state:

1. **Standing choice.** Server settings already say which provider and exact
   provider-local model the user chose. Render that identity and reserve the
   final control geometry immediately.
2. **Current validity and alternatives.** Installation, authentication,
   dynamic model alternatives, and account-dependent capabilities may have
   changed. Revalidate those facts in place and provider by provider.

A stale last-successful model catalog is sufficient to render an honest
selection snapshot. It is not proof that authentication still works or that an
authoritative gateway still offers the model. The launch path remains the
definitive availability check. For Claude Gateway, keep Start disabled until a
fresh catalog for the current gateway configuration validates a model; the
saved selection may remain visible as a checking state instead of disappearing.

An unrelated provider must never gate the saved/default provider. Provider
cards can appear from static descriptors plus last-known status. Refresh the
selected provider first; load another provider's models when it is selected or
during explicitly low-priority idle work. The successful-use gate in tactical
093 is for scanning native **session stores** and must not hide a provider from
the New Session chooser. These are separate catalogs with separate privacy and
product purposes.

## Current owner and server-persistence follow-up

The existing provider route now owns each provider row independently through
`SourceVersionedSingleFlight`. Its source version includes the provider's model
catalog key and a monotonic acquisition generation. Accepted rows have a
five-minute TTL and a shared 4 MiB byte budget. This is enough to order current
process work and prevent stale completion; it is not a durable server snapshot
and adds no freshness/error fields to the wire response.

A persisted install-scoped provider/model snapshot remains conditional on the
clean-browser/fresh-server paint threshold. If that threshold is crossed, keep
only compact last-successful display rows in YA app data using atomic
replacement. Do not persist access tokens, raw auth files, command output, user
email, gateway authorization headers, arbitrary environment/config text, or
other unknown fields. Configuration identity must invalidate launch authority
without destroying the older display snapshot.

Provider adapters remain responsible for faithful discovery and the catalog key
that makes generations comparable. Process-specific model lists may still
prefer a live runtime's `supportedModels()` result; sharing those rows with the
provider route is separate follow-up work rather than a reason to add another
unbounded cache.

OpenCode now parses ids and variants from one `models --verbose` invocation,
with the plain listing retained only as a fallback for unusable verbose output.
Generic catalog inspection can still start a configured Gateway runtime; making
that discovery side-effect free remains a provider-runtime correction.

## Client presentation and scheduling

`NewSessionForm` seeds `selectedProvider` and `selectedModel` from source-scoped
retained settings before dynamic provider rows settle. It uses known provider
display metadata and the exact saved model token rather than inventing a
temporary default. Current rows reconcile through the same
`newSessionDefaults.providers[provider]` rules used by Settings and the floating
composer, without overwriting a choice made in the new window.

Provider/model revalidation fills status, alternatives, and capability-driven
controls in place. Provider-local errors retain the last display row and expose
a named Retry. Gateway is stricter: only a successful named probe started after
the current selection makes the displayed model authoritative for launch.

Subscription usage remains supplementary account telemetry. New Session admits
its first usage read in the `supplementary` bootstrap tier; selected-provider
route work is admitted earlier. A direct-demand surface with no tier remains
immediate, and explicit Refresh bypasses the startup gate even while initial
supplementary work is waiting. The source/provider request owner and one-minute
cache still coalesce compatible reads.

`useVersion()` readiness is a separate shared-query fault. It should not remain
an initialization dependency for facts that settings already establish. The
retained version/capability correction stays in tactical 031.

## Source map

| Concern | Current owner | Current state / follow-up |
|---|---|---|
| Saved initial provider/model | `NewSessionForm`, `newSessionDefaults.ts` | Retained settings paint first; current provider rows reconcile validity later |
| Client provider cache | `useProviders.ts`, `App.tsx`, `RemoteApp.tsx` | Versioned, source-scoped, allowlisted stale snapshot plus named provider refresh |
| Server provider route | `routes/providers.ts` | Byte-bounded generation-safe row owner; descriptor/refresh split remains compatibility-gated |
| Durable model rows | no server persistence | Measure clean first-visit paint before proposing an app-data snapshot and freshness fields |
| Provider adapters | `sdk/providers/*.ts` | Catalog keys participate in generation identity; duplicated prerequisites remain provider-specific follow-up |
| OpenCode | `sdk/providers/opencode.ts`, `opencode-models.ts` | One verbose invocation normally supplies ids and variants; plain listing is fallback only |
| Claude Gateway | `NewSessionForm`, `useProviderRow`, `Supervisor`, Gateway provider | Current named probe gates submission; actual new-session process creation rechecks the advertised model; generic discovery may still start the runtime |
| Process model list | `routes/processes.ts` and runtime `supportedModels()` | Live runtime path remains separate from provider-route retained rows |
| Usage telemetry | `useProviderSubscriptionUsage.ts`, provider usage routes | New Session first read is supplementary; direct demand and explicit Refresh are immediate |
| Tests and benchmark | provider route/hook/form/supervisor/Project Queue tests; `provider-readiness.spec.ts`; `benchmark-provider-model-route.ts` | Ordering, authority, privacy, durable deferred failure, scheduling, isolated-browser behavior, and production-settings route latency are reproducible without Gateway autostart |

## Recommended implementation order

### 1 — freeze immediate saved-choice rendering (complete)

Client coverage holds the aggregate pending while the exact saved
provider/model remains visible. Gateway launch stays blocked until its current
named probe succeeds, including after a stale row was hydrated from the
aggregate or browser snapshot.

### 2 — decide whether server snapshots are warranted (measurement pending)

Measure ten isolated clean-browser/fresh-server provider-card paints first. If
the 1.5 s median or 3 s p90 condition is crossed, propose an atomic app-data
snapshot and explicit freshness state. Keep auth identity/credentials out of
that file, seed no fake rows, and preserve independent provider generations.

### 3 — split descriptor, selected-catalog, and refresh requests (partial)

The selected catalog and Retry already use the existing named route. A distinct
fast descriptor/snapshot route remains open because the aggregate median crossed
2 s; preserve `/api/providers` for older clients until the compatibility plan
below is approved and its horizon ends.

### 4 — remove duplicate and side-effecting discovery (partial)

Route auth/model requests now share one provider generation, and OpenCode
normally uses one verbose command. Generic Gateway warming/priming can still
start a process, while context-window ingestion and process model fallback can
still bypass the provider-route owner.

### 5 — schedule subscription telemetry (complete for startup ownership)

New Session's initial usage read is supplementary and explicit Refresh is
immediate. The isolated browser spec holds route work, verifies zero usage
requests before it settles, and confirms the later usage read without delaying
the saved model control.

### 6 — measure cold, stale, and failure modes

Compare fresh server/fresh tab, fresh tab/warm server, server restart with a
durable catalog, five-minute expiry, slow OpenCode, unavailable Gateway, and one
failing provider. Record direct server heap/RSS, child max RSS, subprocess
count, first-provider/model paint, and time until Start is valid.

## Compatibility review checkpoint

The current slice depends only on existing aggregate, named-provider, and
`refresh=1` routes, so it requires no new capability. Provider/model selection
is core functionality: before a later client depends on a new descriptor or
snapshot route, freshness/error field, or partial aggregate semantic, inspect
the latest two stable releases and every stable release in the preceding 60
days as required by `topics/server-capabilities.md`.

A likely plan is a new transitional `incremental-provider-catalog` capability
(final name chosen during implementation) covering the new snapshot/refresh
routes and freshness fields. Without it, a new client keeps the existing
`/api/providers` request and makes no unsupported request. A new server keeps
the legacy complete provider response for older clients. Do not broaden an
existing provider or settings capability. The registry entry records its
introduction release, review date, client fallback, and removal conditions.

Approval prompt to settle at implementation time:

> Compatibility review for incremental provider catalogs: releases `<60-day
> corpus>` lack `<snapshot/refresh routes and freshness fields>`. Add transitional
> capability `<final name>`; without it the client keeps the existing complete
> `/api/providers` behavior and makes no unsupported requests. New servers keep
> that legacy response for old clients. Existing provider/settings capability
> meanings remain unchanged. Approve?

## Acceptance

Each criterion names how it is measured. Eight are met by the current-route
slice; three remain partial and have explicit evidence gates.

| # | Criterion | Measurement | State |
|---|---|---|---|
| 1 | Provider cards and the saved provider/model controls paint from retained state without awaiting dynamic discovery | Revisit capture with aggregate held; ten clean-browser/fresh-server paint samples against 1.5 s median / 3 s p90 | **Partial** — revisit is immediate; first-ever provider-card paint is not measured and has no server snapshot |
| 2 | A 10-second unselected-provider probe cannot delay or clear selected provider/model controls | Hold aggregate while settings and named selected-provider request resolve | **Met** — saved controls remain visible and reconcile independently |
| 3 | Provider/model route work precedes supplementary account usage in New Session | Hold a `route` bootstrap slot and count usage requests before settlement; explicit Refresh must still run | **Met** — initial count is 0; explicit Refresh is immediate |
| 4 | Time to witness every provider's model catalog is reproducible and below the protocol stop condition, or triggers review | Five production-settings real-route samples, with configured Gateway autostart disabled, aggregate and per-provider median/p90 | **Met** — 2.180 s median / 2.485 s p90; exceeds the 2 s review condition, with OpenCode at 2.093 s median |
| 5 | Refreshing/retrying one provider probes no unrelated provider | Auth/model probe counts around Gateway Retry | **Met** — one provider pair instead of nine, 88.9% fewer unrelated pairs |
| 6 | A stale Gateway row never authorizes Start or Project Queue launch | Browser pending/failure/success/empty cases plus server process creation after the catalog changes | **Met** — submission requires current named success; actual creation rechecks after any queue delay; deferred Project Queue failure preserves the item and error |
| 7 | Cached rows and requests remain isolated by client source and provider | Source-switch tests plus distinct source/provider cache keys | **Met** |
| 8 | Browser snapshots retain only versioned display/capability fields | Inspect serialized fixture containing identity, expiry, login command, and unknown authorization | **Met** — all four excluded fields become zero; unknown/unversioned snapshots are removed |
| 9 | Browser and server restart retain a bounded, non-secret last-successful model snapshot | Reload with aggregate held, then restart with a clean browser | **Partial** — browser snapshot is bounded by its allowlist and storage quota; server persistence is absent |
| 10 | Server route retention and refresh work have one byte-bounded generation owner | Inspect owner budget and test ordinary/forced overlap, coalescing, late success, and late failure | **Met** — one `SourceVersionedSingleFlight` owner with a 4 MiB accepted-value budget |
| 11 | One provider failure does not erase another provider's usable row | Fail named and aggregate provider probes independently | **Partial** — named failure retains stale display data; aggregate `Promise.all` still rejects |

Criterion 4's route measurement is also recorded in tactical 093, without
conflating this provider/model catalog with its native-session catalog.

### Partial-completion-usable UI

The rule the landed change follows, and that follow-up work must keep: a
provider row may be shown before it is confirmed, but it must never authorize
behavior that requires confirmation. Cards from a snapshot render immediately
and stay marked busy; the selected provider's own request overrides them when it
answers; a card the server no longer exposes may persist for the probe's
duration and reveal itself on selection. Gateway is explicit: stale display
survives checking or failure, while Start and Project Queue submission stay
blocked until the current named catalog advertises the required model; actual
new-session process creation repeats that check after any queue delay.
