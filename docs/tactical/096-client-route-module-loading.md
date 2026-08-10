# Load Only the Selected Client Route

> Keep the stable YA shell available while loading only the page tree selected
> by the current route, so New Session, login, and public-share entry do not
> evaluate unrelated transcript and Settings code first.

Status: Top-level local and remote route slice implemented 2026-08-10. Per-
Settings-pane loading, direct/LAN asset delivery, and the full performance
matrix remain open. Tactical 089 measured the original local and remote build
graphs and fresh-browser cost.

Related contracts and plans:

- [`topics/ui-architecture.md`](../../topics/ui-architecture.md)
- [`topics/client-asset-delivery.md`](../../topics/client-asset-delivery.md)
- [`topics/remote-hosted-compatibility.md`](../../topics/remote-hosted-compatibility.md)
- [`022-api-response-compression.md`](022-api-response-compression.md)
- [`033-session-initial-load-performance.md`](033-session-initial-load-performance.md)
- [`089-main-thread-startup-cpu-investigation.md`](089-main-thread-startup-cpu-investigation.md)

## Baseline graph and measured cost

`packages/client/src/main.tsx` statically imports 15 page modules, including
Session, New Session, All Sessions, Agents, Projects, Source Control, Settings,
and the remaining authenticated routes. `remote-main.tsx` statically imports
about 20 page/gate modules, so a public-share or login entry also reaches most
of the authenticated application. Inside Settings, `SettingsLayout.tsx`
statically imports all 21 category panes into `CATEGORY_COMPONENTS`.

The baseline local production build emitted one 2,668,843-byte application
JavaScript file and 565,170 bytes of CSS. The remote build emitted one
2,753,737-byte application file and 566,079 bytes of CSS. The only other
JavaScript chunks are locale overlays. Its source map reaches 651 sources and
7.40 MB of source content. Large owners include KaTeX, React DOM, React Router,
`SessionPage`, `MessageList`, `NewSessionForm`, `MessageInput`, its toolbar, and
several Settings panes.

## 2026-08-10 top-level route slice

Both browser entrypoints now dynamically acquire their page modules,
navigation layout, service-worker registration, and elective floating action
button. The hosted remote entry also defers its connection gates and redirects.
A stable Suspense/error boundary owns each route load; the session DOM-linger
callback remains in `NavigationLayout` and points at one module-scoped
`SessionPage` promise. `SessionPage` separately defers its transcript and
composer modules so the selected route remains below the build ceiling.

Against the immediately preceding source, the eagerly loaded remote JavaScript
fell from 2,938,667 bytes to 477,061 bytes. The local entry fell from about
2.84 MB to 472,214 bytes, with its 491,994-byte `SessionPage` chunk now the
largest output. Both builds remain below Vite's 500 kB warning boundary,
resolve `tssrp6a`'s Node `crypto` probe to the browser Web Crypto API, and fail
on any future Vite warning. The Pages publisher retains old hashed assets,
satisfying generation retention for the hosted path.

Still open: Settings loads every category pane when its route module opens; the
direct/LAN server still lacks the asset delivery contract; and the full
route/device measurement matrix has not run.

This is a real but secondary localhost cost. On an isolated production server
with browser cache disabled, warm server data produced:

| Milestone | Fresh browser result |
|---|---:|
| Document content loaded | 191-201 ms |
| New Session form visible | 249-251 ms |
| Provider/model controls visible | 290-347 ms |
| Initial browser long task | 108-116 ms |

On the first cold provider request, the form still appeared at about 276 ms but
provider/model controls waited 6.22 seconds. Tactical 094 owns that catalog
barrier. Route splitting does not explain or correct it, but it should reduce
transfer/evaluation cost on slower clients and stop unrelated route code from
competing during entry.

The Vite development graph is a different workload: three fresh contexts with
cache disabled fetched 250 script modules and about 10.4-10.5 MB of decoded
JavaScript. New Session appeared in 1.36-4.56 seconds while the live dev
document response itself varied from milliseconds to 1.47 seconds under
server activity. Preserve this as a development-waterfall diagnostic, not a
production bundle estimate.

## Route module contract

The selected route may evaluate its page module and shared shell dependencies.
It must not evaluate page trees reachable only from unselected routes. Keep
authentication/source gates, error handling, primary navigation, and layout in
a small stable shell; load page modules beneath it with one shared promise per
module generation.

The loading fallback occupies stable page geometry and remains nonblank. It
must not tear down navigation, lose the current URL, or flash an unauthenticated
surface. A module failure produces one actionable route error rather than an
indefinite spinner.

Apply the contract to both entrypoints:

- local New Session should not load Session transcript or all Settings panes;
- login should not load the authenticated application page graph;
- a public bearer-link route should not load authenticated session management;
- remote authenticated pages retain their existing source/security gates; and
- moving between already loaded routes reuses the resolved module promise.

`SessionPage` needs a deliberate boundary. `NavigationLayout` currently keeps
session DOM around briefly for fast back/reselect behavior. Lazy loading must
preserve that DOM-linger ownership and must not create a second competing
Session module instance or remount an already-lingering view unnecessarily.

## Settings search is an intentional exception

Entering Settings should load the layout and selected category, not all 21
panes. Each category becomes its own lazy module behind stable header/list
geometry.

Settings search currently mounts every pane for real so it can search the same
rendered setting vocabulary and leave results operable in place. Do not pretend
that search can remain complete while silently loading only the selected pane.
Begin loading the remaining panes explicitly and progressively when the user
activates search. Show progress without reordering already found results, and
surface a pane-load failure as an incomplete-search state with retry. A later
static search index is a separate product/design choice, not a prerequisite for
route splitting.

## Asset and deployment boundary

Dynamic imports create hashed assets whose filenames are embedded in the
entrypoint. A long-lived old tab can request one of those chunks after a new
deployment. The server/deploy pipeline must either retain at least the prior
complete asset generation or provide a one-shot draft-safe recovery that
fetches fresh HTML and retries without losing the current URL or composer
state. Repeated blind reloads and a permanent spinner are not acceptable.

Tactical 022 should land before or with this work. Its current static server
does not recognize real Vite hashes as immutable, provides no validators, and
sends the 2.67 MB application file uncompressed. Splitting that delivery into
more requests without fixing its cache/encoding contract would trade one
large inefficient response for several inefficient responses.

Global CSS is a separate cost. `styles/index.css` imports KaTeX and current font
styles globally, so route-level JavaScript imports will not automatically
remove the measured 565 KB CSS response. Co-located CSS modules may follow
their owning dynamic module, but this tactical does not promise a global CSS
reduction or authorize bypassing the CSS architecture ratchet.

## Source map

| Concern | Current owner | Change |
|---|---|---|
| Local route graph | `packages/client/src/main.tsx` | Replace static page imports with semantic lazy modules below the stable local shell |
| Remote route graph | `packages/client/src/remote-main.tsx` | Separate login/public routes from authenticated pages while preserving source/auth gates |
| Session retention | `NavigationLayout`, `SessionPage` | Keep the DOM-linger boundary outside lazy page acquisition and share one module generation |
| Settings categories | `SettingsLayout.tsx`, category panes | Load the selected pane on demand; retain final header/navigation geometry |
| Settings search | `SettingsSearchResults.tsx` | Explicitly progressive-load all searchable panes only after search starts |
| Build graph | Vite client/remote configurations | Let semantic dynamic imports define initial chunks; inspect output before manual vendor chunking |
| Asset serving | `frontend/static.ts`, build/deploy scripts | Satisfy tactical 022 and the prior-generation chunk contract |
| Verification | build analysis and Playwright | Measure local/remote entry surfaces, navigation, CPU-throttled phone, and deployment skew |

## Recommended implementation order

### 1 — freeze selected-route evaluation boundaries

Add graph assertions or small side-effect sentinels proving New Session, login,
and public-share entry do not evaluate Session or Settings pane modules. Record
current shell, authentication, error, and DOM-linger behavior before changing
imports.

### 2 — split local and remote top-level pages

Introduce route-level dynamic imports under a stable fallback and error
boundary. Keep module promises generation-stable. Do not start with manual
`manualChunks` vendor lists; semantic page boundaries are the first useful
split and provide reviewable ownership.

### 3 — split Settings layout and categories

Load only the current category for ordinary navigation. Preserve deep links,
undo registration, navigation focus, and immediate-apply behavior. Make search
the explicit progressive all-pane consumer.

### 4 — make chunk delivery deployment-safe

Land or verify tactical 022's immutable/cache/encoding contract, then test an
old loaded entrypoint across a new asset generation. Retain prior assets or
implement exactly one state-preserving fresh-entry recovery.

### 5 — measure route and device contrasts

For local and remote builds, record initial JavaScript/CSS transfer bytes,
module/chunk count, parse/evaluation time, long tasks, first shell, first page,
and interactive controls. Include desktop localhost, a CPU/network-throttled
375-pixel client, login, public share, New Session, Session, Settings, and
already-loaded route navigation.

### 6 — add only measured intent preloading

After the boundaries settle, test whether pointer/focus intent or browser idle
preloading materially improves a common next navigation. Preloading must be
cancelable/low priority and may not reconstruct eager all-route evaluation.

## Acceptance

- New Session, login, and public-share entries evaluate no page module that is
  reachable only from an unselected route.
- The stable shell and route geometry remain visible while a page module loads;
  errors do not become indefinite spinners.
- Session DOM linger/back/reselect behavior remains bounded and does not remount
  solely because the page module became lazy.
- Ordinary Settings navigation loads one pane; Settings search explicitly and
  progressively loads the complete searchable set.
- A prior-generation tab can still load an uncached route chunk after deploy,
  or recovers once without losing URL/composer state.
- Local and remote build evidence reports transfer/evaluation improvements and
  shows no regression in authenticated, public, phone, or offline/version-skew
  entry behavior.
- The work makes no claim that global CSS or the server provider barrier was
  solved by JavaScript route splitting.
