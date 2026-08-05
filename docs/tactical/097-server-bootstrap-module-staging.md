# Stage Server Modules Behind Useful Readiness

> Bind the secured YA server after evaluating only the modules needed for its
> first useful routes, then acquire optional provider, route, watcher, and
> diagnostics code on bounded demand or in measured background phases.

Status: Implementation handoff, not yet implemented. Tactical 089 measured the
pre-bind module graph and its adjacent watcher/CLI work. This plan defines the
readiness and failure boundaries for reducing it; it does not implement them.

Related contracts and plans:

- [`topics/server-performance-observability.md`](../../topics/server-performance-observability.md)
- [`topics/architecture-mandates.md`](../../topics/architecture-mandates.md)
- [`topics/provider-abstraction.md`](../../topics/provider-abstraction.md)
- [`topics/reload-safe-provider-runtimes.md`](../../topics/reload-safe-provider-runtimes.md)
- [`089-main-thread-startup-cpu-investigation.md`](089-main-thread-startup-cpu-investigation.md)
- [`093-provider-session-reconciliation.md`](093-provider-session-reconciliation.md)
- [`094-new-session-provider-catalog-readiness.md`](094-new-session-provider-catalog-readiness.md)

## Current pre-bind graph and cost

The built server took 1,859 ms from external process spawn to its first
successful static response, although its existing internal timer reported only
36-42 ms and listener `onReady` 40-47 ms. A warm probe placed about 566 ms in
the server module graph and top-level setup before the first Codex discovery
subprocess. Synchronous provider-root watching added about 0.46 seconds and
Codex CLI detection about 155 ms in isolated warm probes.

This graph is broad before any route is chosen:

- `packages/server/src/index.ts` has 55 direct static imports;
- `packages/server/src/app.ts` has 133;
- the provider barrel has 14 and imports every provider implementation;
- an esbuild reachability probe from the built entry found 305 internal server
  modules, including 69 route modules and 3.84 MB of input source; and
- an internal-only bundle of that graph was about 2.96 MB before external
  packages.

Large internal owners include the sessions routes, Codex provider,
`Supervisor`, `Process`, Claude provider, Codex reader, and
`SessionIndexService`. Static external reachability includes the Claude Agent
SDK, Agent Client Protocol SDK, Shiki, KaTeX/Markdown support, bcrypt, and Web
Push before the first request needs most of them.

`@yep-anywhere/shared` exposes only its root package entry. That entry re-exports
almost the whole shared package, and server source has 188 root-import
occurrences across 169 files. `packages/server/src/services/index.ts` and the
provider index repeat the same barrel pattern. In the production Node
ECMAScript Module (ESM) runtime, following a static barrel import evaluates
the modules it reaches; there is no browser-bundler tree-shaking pass that
removes unused re-exports at runtime.

Isolated imports show that third-party owners are individually material but
not additive measurements because each fresh process includes the same Node
baseline: Claude SDK was about 0.15 seconds/88 MB resident, the Agent Client
Protocol SDK 0.11 seconds/78 MB, the shared barrel 0.13 seconds/86 MB, Shiki
0.06 seconds/59 MB, and the Markdown/KaTeX/sanitizer imports 0.04-0.06 seconds
and roughly 53-58 MB. The graph measurement, not their sum, is the performance
baseline.

## Useful-readiness contract

Measure startup from the first statement in the process entry module. Report
at least these distinct milestones:

1. secured listener bound;
2. static entry and `/api/version` useful;
3. projects plus New Session settings/providers useful; and
4. one selected session detail route useful.

The secured listener milestone is not permission to expose a temporarily weak
server. Host/bind policy, CORS, authentication, rate/size limits, and required
error handling must be installed before accepting untrusted traffic. A route
whose implementation has not loaded returns neither a misleading temporary
404 nor a partially authorized response: its stable shim awaits one shared
module promise and applies the same middleware/trust boundary as the loaded
handler.

Essential module acquisition failure fails startup or the owning route clearly
with an actionable error. Optional route/provider failure is scoped to that
surface and remains retryable. Do not hide a broken core dependency behind
warn-and-continue or leave a rejected module promise permanently cached when
the documented operation is retryable.

Binding alone is not the performance target. Background acquisition must be
bounded/yielding so it does not simply move one pre-bind main-thread spike
immediately after the listener begins accepting useful requests.

## Module ownership boundaries

Add narrow `@yep-anywhere/shared/<surface>` exports for server hot paths while
preserving the root export as the existing compatibility API. Update in-repo
server imports and `scripts/build-bundle.ts`, whose current rewriting assumes
the root entry. A subpath should expose a cohesive type/runtime surface rather
than one file per symbol.

Replace service/index barrels at process entry with direct or narrow-domain
imports. Avoid exchanging one broad barrel for a `bootstrap.ts` that imports
the same graph.

Provider metadata must be available without provider implementation or SDK
evaluation. Keep side-effect-free static descriptors/registration separate
from demand-loaded implementations. Selecting or explicitly refreshing one
provider imports and caches that provider generation; enumerating generic
provider names cannot start Gateway or another persistent runtime. Tactical 094
owns catalog freshness and presentation, while this tactical owns whether the
implementation modules are evaluated before demand.

Routes should be grouped by useful product boundary rather than made
individually dynamic without evidence. Core configuration/projects/session
entry can remain eager when measurements justify it. Provider-specific,
sharing/review, rendering/export, speech, push, and advanced diagnostic groups
are candidates because their dependencies and failure scopes differ.

## Source map

| Concern | Current owner | Change |
|---|---|---|
| Process clock | `packages/server/src/index.ts` and launch wrapper | Start before static graph work; publish secured/useful route milestones |
| App assembly | `packages/server/src/app.ts` | Keep security/core middleware eager; mount stable demand-route shims by product group |
| Shared package | `packages/shared/package.json`, `src/index.ts`, server imports | Add cohesive subpath exports, preserve root API, and update bundling assumptions |
| Service barrels | `packages/server/src/services/index.ts` and entry callers | Import only bootstrap owners directly or through narrow domain entries |
| Provider registry | `packages/server/src/sdk/providers/index.ts` | Separate side-effect-free descriptors from cached demand imports |
| Provider/watch startup | provider watcher and tactical 093 owners | Reconcile install-eligible stores after useful readiness in bounded units |
| Advisory work | Codex version warning and source watcher | Run after bind/useful readiness without blocking selected routes |
| Route groups | sessions/providers/rendering/share/review/speech/push routes | Choose measured product boundaries and stable failure behavior |
| Packaging | server build, desktop/bundle launchers | Verify ESM subpaths and dynamic chunks in every supported packaged runtime |

## Recommended implementation order

### 1 — move the startup clock to process entry

Instrument module-graph start, secured bind, and each useful-route milestone
before changing imports. Include event-loop delay, heap/resident deltas, module
count, and route probes so later work cannot improve one clock by moving cost
past it.

### 2 — narrow shared and service entry imports

Add cohesive shared subpath exports and replace bootstrap-path root/barrel
imports. Keep the root export contract intact. Verify source builds, bundled
server output, package exports, desktop packaging, tests, and external type
consumers before attributing an improvement.

### 3 — split provider descriptors from implementations

Make registration, display identity, and capability declarations
side-effect-free. Import one provider implementation through a shared cached
promise only on selected-provider catalog/runtime demand. Prove generic listing
does not evaluate every SDK or start a provider service.

### 4 — stage route groups behind stable shims

Keep security and the smallest useful core eager. Stage measured optional route
groups, preserving middleware order, route identity, error schemas, and one
in-flight module acquisition per generation. Do not transiently return 404.

### 5 — move advisory and discovery work after readiness

Move Codex version warnings, development source watching, and install-eligible
provider reconciliation to named bounded phases. Yield between large parse or
directory units, and ensure closed clients/unused providers do not retain
ongoing startup work.

### 6 — compare source and bundled execution

Bundling can reduce filesystem/module-loader overhead but does not by itself
defer top-level evaluation. Compare direct ESM, bundled ESM, narrowed imports,
and demand route/provider groups independently. Keep the simplest shape that
meets useful-readiness and packaging contracts.

### 7 — verify failure and reload generations

Exercise missing optional dependencies, one rejected import, retryable provider
load, development backend reload, retained provider hosts, and packaged
desktop/server restarts. Each new server generation owns its own module promise;
old handlers and provider protocols follow the reload-safe lifecycle contract.

## Acceptance

- Startup metrics begin before static module evaluation and distinguish secured
  bind from projects/New Session/selected-session usefulness.
- The first useful routes do not evaluate optional provider SDKs, rendering,
  share/review, speech, push, or diagnostics groups unless measurements justify
  a named eager dependency.
- Authentication and all trust-boundary middleware are active before any
  demand-loaded route handles traffic; no loading route returns temporary 404.
- Generic provider listing imports no unselected implementation and starts no
  persistent provider runtime.
- Shared subpath exports are additive; existing root-package consumers retain
  their observable API.
- Post-bind watcher/discovery work is bounded and does not recreate the removed
  startup event-loop spike.
- A/B evidence reports spawn-to-bind and useful-route latency, event-loop delay,
  heap/resident cost, evaluated-module count, and selected-route latency for
  direct, bundled, cold, and warm runs.
- Development reload, production source/bundle, desktop packaging, and optional
  dependency failures preserve explicit behavior rather than silently serving
  a partial application.
