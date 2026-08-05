# Make New-Session Provider and Model Choices Immediate

> Render the saved provider/model choice from retained state immediately, then
> refresh only the provider facts the user needs without making an unrelated
> provider's CLI discovery part of the New Session critical path.

Status: Partly implemented (2026-08-05). The immediacy fix landed using routes
that every supported release already serves, so it needed no capability gate and
no compatibility review; see *What landed* below. The retained server-side
catalog service, the descriptor/refresh route split, and the deferred
subscription telemetry remain unimplemented, and the transitional capability
they would need is deferred pending tactical 093's measurement. Tactical 089
reproduced the delay; the ownership assignment below still stands for the
remainder.

## What landed (2026-08-05)

The user's constraint was to fix the perceived delay now with existing routes,
and to defer anything that would require a new server capability.

- **Selected provider resolves on its own.** `GET /api/providers/:name` has
  existed since the original multi-provider commit and is present in every
  supported release, so no gate is needed. `useProviderRow()`
  (`packages/client/src/hooks/useProviders.ts`) asks only for the selected
  provider; `routes/providers.ts` already coalesces that request with an
  in-flight aggregate and shares its five-minute entry, so it costs no extra
  probe. Measured on this host, that is Codex at 0.239 s or Claude at 0.747 s
  instead of the aggregate's 6.211 s.
- **Provider cards survive a reload.** `ENABLED_PROVIDERS` is server-only and no
  fast route lists exposed providers, so the *card grid* still needs the
  aggregate. `useProviders()` now keeps a source-scoped `localStorage` snapshot
  of the last successful probe (`ya:providers:<sourceKey>`, seven-day lifetime)
  and hydrates it pre-expired, so it renders immediately but never satisfies a
  request: `loading` stays true, the new `stale` flag is true, and the grid
  carries `aria-busy` until the probe answers. The user accepted showing a
  briefly-wrong card (up to ~10 s) for a provider the server no longer exposes,
  since clicking it reveals the truth.
- **Saved choice paints before the catalog.** `NewSessionForm` splits its
  one-shot initialization into a seed pass that runs as soon as
  `useServerSettings()` resolves and a reconcile pass once the probed catalog
  and version capabilities land. Both go through one `applyInitialDefaults()`,
  and both are gated by the existing `hasUserCustomizedDefaultsRef`, so the
  reconcile cannot stomp a pick the user made in the new window. With no rows at
  all, the seed uses an unprobed placeholder row for the saved provider name.
  Claude Gateway is unchanged: `providerRequiresAdvertisedModel()` still refuses
  a model absent from an authoritative catalog.
- **OpenCode costs one CLI process.** `getAvailableModels()` ran `opencode
  models` and `opencode models --verbose` in series (2.24 s + 2.18 s) for one
  catalog; 094's measurement showed both expose the same 87 headers.
  `parseOpenCodeVerboseModels()` now returns ids and variants from the verbose
  output, with the plain listing kept as a fallback for a CLI whose verbose
  output is unusable. This is the aggregate's slowest member, so it also
  shortens `/api/providers` itself — item 4's OpenCode clause, done without the
  provider-owned cache.

Evidence: `.artifacts/ui-testing/094-revisit-desktop.png` and
`094-revisit-phone.png` capture a second visit with `/api/providers` blocked for
8 s — the saved Claude Gateway card is selected and `MODEL` reads
`Claude Opus 5` at 3.5 s, versus a form with neither control before the change.
Tests: `useProviders.test.ts` covers the snapshot-then-probe order and the
single-provider path (including that a fresh aggregate row suppresses the extra
request); `opencode-model-variants.test.ts` covers verbose ids in listing order.

Deliberately not done, still deferred: the persisted server-side catalog
snapshot, per-provider failure isolation replacing `Promise.all`, suppressing
generic Gateway auto-start, the descriptor/refresh route split, and moving
subscription telemetry off the mount path. Every one of those needs either a new
capability or work whose value 093's measurement should size first.

Needs restart: the OpenCode change is server-side.

Related contracts:

- [`topics/session-defaults.md`](../../topics/session-defaults.md)
- [`topics/provider-abstraction.md`](../../topics/provider-abstraction.md)
- [`topics/server-capabilities.md`](../../topics/server-capabilities.md)
- [`topics/server-performance-observability.md`](../../topics/server-performance-observability.md)
- [`031-client-query-controller.md`](031-client-query-controller.md)
- [`089-main-thread-startup-cpu-investigation.md`](089-main-thread-startup-cpu-investigation.md)
- [`093-provider-session-reconciliation.md`](093-provider-session-reconciliation.md)
- [`095-new-session-recent-project-readiness.md`](095-new-session-recent-project-readiness.md)

## Current fault and live cost

`NewSessionForm` initializes its provider and model only after three independent
queries settle: `useProviders()`, `useServerSettings()`, and `useVersion()`.
Settings already persist the exact provider-scoped default and were effectively
instant in the live probe, but the UI does not project that answer while the
provider catalog is unresolved. The model control is absent until
`selectedProvider` is initialized and that provider's model rows arrive.

The app shell does eagerly call `primeProviderCache()`. That avoids a duplicate
client request, but it does not make the request cheap. On a fresh tab the
primer and New Session join the same `/api/providers` request; after a full
browser reload the client has no retained catalog, and after a server restart
the route has no retained catalog either. Both caches are memory-only with
five-minute lifetimes.

New Session concurrently requests enriched recent sessions to choose a project.
That separate route took 6.496 seconds at the page's 30-row limit and may
contend with catalog discovery, but it is not a provider-catalog prerequisite.
Tactical 095 removes that transcript/index work from project defaulting.

The live localhost measurements on 2026-08-05 were:

| Request or command | Wall time | Relevant result |
|---|---:|---|
| `GET /api/providers` after route-cache expiry | 6.211 s | New Session awaited one aggregate response |
| repeated warm `/api/providers` | 4-33 ms | The symptom disappears temporarily after the five-minute cache fills |
| forced OpenCode provider detail | 4.407 s | Slowest member of the aggregate barrier |
| forced Claude provider detail | 0.747 s | Second material provider in this sample |
| forced Codex provider detail | 0.239 s | The user's saved/default provider was not the barrier owner |
| `opencode models` | 2.24 s, about 437 MB max RSS | First OpenCode child |
| `opencode models --verbose` | 2.18 s, about 436 MB max RSS | Second sequential OpenCode child |
| forced Codex subscription usage | 3.589 s | Optional request starts after selection; it does not block the picker |
| forced Claude subscription usage | 2.656 s | Same optional-work issue |

The OpenCode normal and verbose commands exposed the same 87 model headers in
this installation. `getAvailableModels()` nevertheless launches both
sequentially: the first supplies ids and the second supplies effort variants.
The provider has no catalog cache of its own, so the route's five-minute cache
is its only protection.

The aggregate route calls every exposed provider through `Promise.all` and,
within each row, calls authentication and model discovery concurrently. This
has four undesirable consequences:

- an unselected OpenCode catalog delays a saved Codex choice;
- providers such as Claude may repeat authentication work because their model
  method checks authentication again internally;
- Codex OSS may run `ollama list` independently for auth and models; and
- one uncaught provider failure rejects the complete provider response rather
  than leaving other providers usable from their last successful rows.

The configured Claude Gateway path has an additional side effect.
`getAvailableModels()` calls `gatewayLauncher.ensureReady()`, so server startup
warming and an ordinary all-provider primer may start and retain a gateway
process even when Gateway is not selected. `ModelInfoService.warmProvider()`
does not populate the provider route cache, so startup warm, tab primer, and
the New Session Gateway-specific forced refresh can repeat catalog work under
different owners.

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

## Retained catalog model

Introduce one install-scoped `ProviderCatalogService` (name is provisional)
that owns each provider independently:

- static descriptor and capability projection;
- last successful model rows and observation time;
- last-known availability status without credential material;
- provider configuration/catalog key;
- current in-flight auth/model requests; and
- bounded error and freshness state.

Persist only the compact, non-secret last-successful model snapshot in YA app
data using atomic replacement. Do not persist access tokens, raw auth files,
command output, user email, gateway authorization headers, or arbitrary
environment/config text. Configuration identity must invalidate authority
without destroying the older display snapshot. The client receives explicit
`fresh`, `stale`, `refreshing`, or `error-with-stale-data` state rather than
inferring validity from a nonempty array.

Provider adapters remain responsible for faithful discovery and the key that
makes a catalog generation comparable. The coordinator owns TTL, in-flight
coalescing, persistence, priority, and metrics. A process-specific models route
may still prefer a live runtime's `supportedModels()` result, then fall back to
the shared provider catalog rather than launching a parallel discovery path.

OpenCode should parse ids and variants from one `models --verbose` invocation;
the observed verbose output already contains every ordinary header. Cover the
supported output with a fixture before deleting the normal invocation. Keep
one provider-owned TTL/in-flight entry so route, process-model, recap/helper,
and settings consumers cannot independently launch the same expensive command.

Catalog inspection must not create a persistent provider runtime for an
unselected provider. In particular, the configured Gateway start command runs
only for explicit Gateway selection/refresh or launch, not generic all-provider
enumeration or context-window warming.

## Client presentation and scheduling

Seed `selectedProvider` and `selectedModel` from the source-scoped retained
settings snapshot before dynamic provider rows settle. Use known provider
display metadata and the exact saved model token for the initial badge/control;
do not invent a temporary different default. When a fresh catalog arrives,
reconcile once against the same `newSessionDefaults.providers[provider]`
rules already used by Settings and the floating composer.

Provider/model layout is stable from its first render. Revalidation fills
status, alternatives, and capability-driven controls below/in place; it must
not flash away the saved selection or move the opening composer/project region.
Errors remain provider-local and retain the last successful rows with a retry.

Subscription usage is supplementary account telemetry. Keep its in-place
update, but schedule it after the selected provider/model controls paint and
prefer selection/dropdown demand or browser-idle work over immediate mount.
Retain one source/provider query owner; a one-minute TTL in two independent
layers does not justify starting a multi-second app-server/control probe on
every later New Session visit.

`useVersion()` readiness is a separate shared-query fault. It should not remain
an initialization dependency for facts that settings already establish. The
retained version/capability correction stays in tactical 031.

## Source map

| Concern | Current owner | Change |
|---|---|---|
| Saved initial provider/model | `NewSessionForm`, `newSessionDefaults.ts` | Project the retained settings choice before catalog/version completion; reconcile dynamic validity later |
| Client provider cache | `useProviders.ts`, `App.tsx`, `RemoteApp.tsx` | Consume a source-scoped retained snapshot with provider-local refresh; remove one aggregate all-provider readiness flag |
| Server provider route | `routes/providers.ts` | Separate fast retained descriptors/snapshots from provider-local refresh; preserve legacy response behavior during compatibility support |
| Catalog ownership | new server service plus `ModelInfoService` integration | Persist bounded non-secret model rows, coalesce work, expose freshness/error metrics, and avoid duplicate warm owners |
| Provider adapters | `sdk/providers/*.ts` | Supply faithful catalog keys and side-effect-free discovery; coalesce duplicated auth/model prerequisites |
| OpenCode | `sdk/providers/opencode.ts`, `opencode-models.ts` | Use one authoritative verbose invocation and a provider-owned cache |
| Claude Gateway | `sdk/providers/claude-gateway.ts`, `index.ts` | Do not auto-start a gateway during generic warm/primer work; scope authoritative validation to Gateway demand |
| Process model list | `routes/processes.ts` and runtime `supportedModels()` | Reuse live runtime or shared provider catalog rather than bypassing its owner |
| Usage telemetry | `useProviderSubscriptionUsage.ts`, provider usage routes | Retain one source/provider snapshot and defer optional probes until after interactive readiness |
| Tests | provider route/hook/form/provider tests | Add latency-independence, stale snapshot, scoped failure, side-effect, and coalescing contracts |

## Recommended implementation order

### 1 — freeze immediate saved-choice rendering

Add client tests in which settings resolve first and `/providers` remains
pending for several seconds. The exact saved provider/model must render in its
final region without enabling an invalid authoritative Gateway launch. Cover
fresh browser reload, source switch, no saved choice, stale saved provider,
and explicit URL provider/model preferences.

### 2 — add provider-local retained server snapshots

Build the coordinator, atomic app-data snapshot, per-provider in-flight
coalescing, freshness state, and metrics. Keep auth identity/credentials out of
the persisted file. Seed no fake model rows when a provider has never succeeded.
One provider error must not delete or delay another provider's snapshot.

### 3 — split descriptor, selected-catalog, and refresh requests

Return static/last-known provider descriptors promptly, request the selected
provider's current catalog independently, and make retry/explicit refresh name
one provider. Preserve the old aggregate `/api/providers` route for older
clients until the compatibility plan below is approved and its horizon ends.

### 4 — remove duplicate and side-effecting discovery

Make auth/model prerequisite work share one provider generation. Collapse
OpenCode discovery to one verbose command and prove its 87-header fixture.
Stop generic Gateway warming/priming from starting a process. Route context
window ingestion and process model fallback through the same completed catalog.

### 5 — defer subscription telemetry

Move usage probes out of immediate New Session mount priority, share their
source/provider snapshot, and preserve manual refresh. Measure first picker,
first model control, first input-ready, usage update, and child-process work
with telemetry on and off.

### 6 — measure cold, stale, and failure modes

Compare fresh server/fresh tab, fresh tab/warm server, server restart with a
durable catalog, five-minute expiry, slow OpenCode, unavailable Gateway, and one
failing provider. Record direct server heap/RSS, child max RSS, subprocess
count, first-provider/model paint, and time until Start is valid.

## Compatibility review checkpoint

Provider/model selection is core functionality. Before a new client depends on
a new snapshot route, freshness field, or provider-local refresh semantic,
inspect the latest two stable releases and every stable release in the preceding
60 days as required by `topics/server-capabilities.md`.

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

Each criterion names how it is measured. "Met" marks what the 2026-08-05 change
established; the rest await the deferred work above.

| # | Criterion | Measurement | State |
|---|---|---|---|
| 1 | A saved Codex/Claude/Pi/OpenCode provider and exact model identity occupies its final New Session region without waiting for dynamic catalog discovery | Client test with settings resolved and `/api/providers` pending; browser capture with the aggregate blocked 8 s | Met |
| 2 | A 10-second unselected-provider probe cannot delay or clear the selected provider/model controls | Time from navigation to the model control showing the saved token, with the aggregate artificially delayed 10 s; target under 1.5 s | Met for the control's appearance; not yet for a first-ever visit with no snapshot |
| 3 | Time to witness the *selected* provider's model catalog, cold server | Wall time of `GET /api/providers/:name` after route-cache expiry; baseline 0.239 s (Codex) / 0.747 s (Claude) versus the 6.211 s aggregate | Met |
| 4 | Time to witness *every* provider's model catalog, cold server | Wall time of `GET /api/providers` after route-cache expiry; baseline 6.211 s, of which OpenCode was 4.407 s | Partly — one OpenCode CLI process instead of two; re-measure and record here |
| 5 | Browser and server restart retain a bounded, non-secret last-successful model snapshot | Reload with the aggregate blocked: cards present, `stale` true, no credential material in the stored value | Browser side met (`localStorage`); server side deferred |
| 6 | Current auth and authoritative Gateway validity are never inferred from a stale snapshot | Gateway test: saved model absent from a fresh authoritative catalog is neither displayed nor submitted | Met (unchanged behavior) |
| 7 | Refreshing or selecting one provider launches no model/auth subprocess for another provider | Child-process count around a single-provider refresh | Deferred |
| 8 | Concurrent route/settings/process consumers share one provider catalog generation; failures stay provider-local | One failing provider still leaves other rows usable | Deferred (`Promise.all` still rejects the aggregate) |
| 9 | OpenCode catalog discovery launches at most one CLI process per generation, and generic discovery never starts a persistent Gateway process | Process count during one cold aggregate | OpenCode met; Gateway auto-start deferred |
| 10 | Subscription usage work begins after interactive readiness and cannot block the provider/model controls | Order of first model-control paint versus the usage request | Deferred |
| 11 | Metrics name provider, cache state, duration, child count/max RSS where available, and outcome, retaining no credentials or raw command output | Server log/metric inspection | Deferred |

Criteria 3 and 4 are the two numbers worth carrying forward; tactical 093 is
asked to record 4 as part of its own measurement.

### Partial-completion-usable UI

The rule the landed change follows, and that the deferred work should keep: a
provider row may be shown before it is confirmed, but it must never be shown as
*confirmed* before it is. Concretely — cards from a snapshot render immediately
and stay marked busy; the selected provider's own request overrides them the
moment it answers; a card the server no longer exposes may persist for up to the
probe's duration and reveals itself on click; and nothing in this path relaxes a
launch-time check.
