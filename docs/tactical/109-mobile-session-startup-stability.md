# Make Mobile Session Startup Visually Monotonic

> Keep the useful selected-route split while making a hosted remote session
> reload move through one stable shell, acquire its critical modules in
> parallel, and reuse immutable prior-generation assets.

Status: complete (2026-08-15).

Topic: mobile-session-startup-stability

Related contracts and plans:

- [`topics/ui-architecture.md`](../../topics/ui-architecture.md)
- [`topics/ui-testing.md`](../../topics/ui-testing.md)
- [`topics/client-asset-delivery.md`](../../topics/client-asset-delivery.md)
- [`096-client-route-module-loading.md`](096-client-route-module-loading.md)

## Reported behavior and reproduced baseline

A 375x812 cache-disabled reload of a selected hosted remote session on current
main exposed nine observable DOM states before the final transcript. The broad
visual changes were:

1. a very-dark empty document;
2. an auto-dark body over the very-dark document background;
3. a short generic `Loading` block over the otherwise empty viewport;
4. repeated generic fallbacks while the remote app, connection gate, layout,
   and selected session route were discovered in series;
5. the final-height session frame with a session-data placeholder;
6. a regression from that revealed frame back to the generic route fallback
   while `MessageList` and `MessageInput` were acquired; and
7. the progressive transcript placeholder followed by the final transcript.

Cache-disabled mobile throttling lengthens these states but does not create
them. First visits, evicted mobile caches, and a new asset generation exercise
the same cold path. The latest hosted deployment also revalidates hashed assets
instead of serving them under a long immutable lifetime.

## Startup contract

The selected session startup sequence is monotonic:

```text
themed full-viewport session shell
  -> connection and session readiness inside stable slots
  -> transcript replaces only the message placeholder
```

- The critical HTML bootstrap and the React theme initializer resolve the same
  default theme. `html`, `body`, and `#root` cover the viewport with the same
  background before the application stylesheet or entry module finishes.
- A selected session route owns stable header, transcript, and composer
  geometry from its first loading fallback. Status copy may change inside the
  transcript slot; an already-visible shell region never disappears because a
  descendant module suspends.
- A fallback replaces only the geometry owned by its boundary. Authentication,
  connection, navigation, and selected-session module acquisition must not
  replace a revealed session frame with a generic page spinner.
- The initial URL starts all modules on the selected route's critical path from
  one route-owned preload description. Login and public-share entry retain
  their smaller graphs; unselected heavyweight pages remain deferred.
- `SessionPage`, its ordinary transcript, and its ordinary composer are one
  acquisition unit or begin acquisition together. The build warning threshold
  follows measured route behavior rather than forcing an additional visible
  boundary.
- Content-addressed generated assets receive a long immutable cache lifetime.
  Mutable HTML and service-worker entry resources revalidate. The latest hosted
  deployment carries the preceding generation's runtime assets so an older tab
  can still request a deferred chunk.

## Implementation slices

### 1 — stabilize the critical theme and session loading shell

Use the same default-theme resolution in the inline bootstrap and React hook,
cover the complete viewport at every bootstrap layer, and introduce one
component-owned startup shell. Use that shell for route-module and initial
connection loading. Give a selected session route fixed header, message, and
composer slots; use a simpler full-page frame for other routes.

Move the existing connection-loading styles out of the legacy global sheet
while touching their React owners. Keep progress copy translatable and expose a
stable startup-phase attribute for deterministic tests.

### 2 — acquire the selected remote route without nested discovery

Represent remote module acquisition with cached loader functions shared by
`React.lazy` and initial-route preloading. Normalize the configured router base,
match the current local, canonical-relay, login, monitor, or public-share path,
and start its shell, gate, layout, and selected page imports concurrently.

Keep later navigation lazy. A selected session must not wait for `RemoteApp`
before discovering the relay gate, for the gate before discovering layout, or
for layout before discovering `SessionPage`.

### 3 — keep the session frame revealed when transcript data arrives

Acquire the ordinary `MessageList` and `MessageInput` with `SessionPage` instead
of discovering them only after the page module evaluates. Remove the suspension
that currently occurs when session data changes the body from the data-loading
placeholder to a still-unavailable transcript component. Accept and document a
larger selected-session chunk when the measured cold route is better.

Progressive long-transcript rendering remains inside the message slot. It may
change its local status and rows, but it does not own the header, composer, or
page background.

### 4 — make hosted route chunks cache-correct and generation-safe

Publish Cloudflare Pages header rules that make `/assets/*` immutable while the
HTML and service worker retain revalidation semantics. Correct the production
static server's Vite-hash recognition for mixed-case and underscore tokens.

Before a latest-client deployment, read the prior deployment's explicit asset
generation manifest and copy its runtime assets into the new output. Publish a
manifest for the new generation only, so each deploy retains exactly the
preceding runtime generation rather than accumulating every historical build.

### 5 — enforce monotonic cold and warm startup

Add focused unit/build tests for theme agreement, route selection/preload
ownership, session-core acquisition, immutable-name recognition, hosted header
rules, and previous-generation retention. Add a production-build Playwright
reload contract at 375x812 that records phase/geometry changes and fails if:

- the document background changes between critical bootstrap and app startup;
- the root does not cover the viewport;
- a session header or composer disappears after becoming visible;
- the generic route fallback returns after the session frame is visible; or
- selected-session module requests begin in avoidable nested discovery waves.

Run the same final route at 1920x1080 and 375x812 from a fresh server, inspect
the rendered captures, and keep cache-disabled evidence separate from a warm
reload so caching cannot conceal a structural regression.

## Acceptance

- A cache-disabled 375x812 remote session reload presents one themed stable
  composition followed by the final transcript, with status changes confined to
  the message slot.
- The selected session's shell, gate, layout, page, transcript, and composer
  acquisitions start without parent-to-child network discovery serialization.
- Login and public-share entry still avoid the authenticated session graph.
- Session data readiness cannot make an already-visible header or composer
  disappear behind the route fallback.
- Current generated JS/CSS asset names receive immutable caching from both the
  production static server and latest hosted deployment.
- A newly deployed hosted entry retains every runtime asset named by the
  immediately preceding generation manifest.
- Focused tests, typechecking, lint, formatting, CSS checks, console scan, and
  final desktop/phone captures complete without warnings.

## Completion evidence

- The production remote entry is 488.78 KiB and remains below the existing
  500 KiB build-warning threshold. Login and public-share routes retain their
  smaller graphs.
- The phone-width production-build reload contract passed with browser caching
  disabled and every JavaScript response delayed by 180 ms. The remote app,
  relay gate, session page, transcript, and composer requests began within one
  delay window; neither the session frame nor its header and composer regressed
  after appearing. The same structural assertions passed on a warm reload. A
  dedicated production preview owns this generated-chunk contract; the shared
  remote E2E server remains source-enabled for browser fixture provisioning.
- A hosted-generation dry run recorded 217 current runtime assets, excluded
  source maps, published the explicit current-generation manifest, and handled
  the expected missing-manifest state for the first deployment.
- The final 375x812 and 1920x1080 production-build captures were inspected with
  no stale-runtime banner, viewport gap, broad loading replacement, or layout
  overflow.
- Focused client and server tests, the production reload test, typechecking,
  lint, formatting, CSS checks, and the console budget scan passed. The full
  workspace run passed 3,542 of 3,543 client tests; its unrelated
  `SessionShareModal` revocation timing assertion passed all 30 tests when the
  file was rerun in isolation.
