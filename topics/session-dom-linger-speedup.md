# Session DOM Linger Speedup

> Session DOM linger speedup is a proposed bounded keep-alive path that keeps
> the most recently left session route's mounted DOM and render state hidden for
> a short grace period, so immediate back/reselect returns can skip even
> deterministic rerender work.

Topic: session-dom-linger-speedup

Status: One-session underlay linger implemented 2026-07-01; bounded direct
session A/B reuse implemented 2026-08-29. The current `SessionRouteSnapshot`
implementation remains the fallback safety net. User-observed warm returns can
take over 0.5 seconds when React remounts the transcript and deterministic
renderers rebuild DOM, so the fast path keeps one eligible prior session DOM
alive for a bounded grace window.

## Problem

`client-route-retention` now restores session data and scroll state
synchronously, but React still remounts the transcript and deterministic
renderers still rebuild visible DOM. For short returns, especially
session -> Inbox/Agents/Source Control/Settings -> back, the old DOM was
available milliseconds ago. A fixed grace-period linger could make those
returns feel closer to switching browser tabs.

The committed snapshot path avoids the worst defect, a blocking data fetch and
full-page loader, but it cannot make large transcripts instant by itself. The
expensive work left on a warm return is client-side: route remount, render-item
reconstruction, markdown/tool renderer DOM creation, layout, and scroll
restoration. Keeping the DOM mounted is the direct fix for that remaining
latency.

## Proposal

Keep at most the most recent one or two session route DOM trees hidden for a
short same-tab grace period, initially 60 seconds. A return to the same source,
project, session id, and tail-window params during the grace period reattaches
or reveals the lingered tree immediately. Expiry, source switch, auth switch,
tab close, reload, memory pressure, or route mismatch destroys it.

This is deliberately narrower than generic route keep-alive. It is a speed
layer on top of explicit `SessionRouteSnapshot` retention, not a substitute for
the snapshot/delta path. When DOM linger misses, the normal retained snapshot
path still gives an immediate useful view without a blocking loader.

## Recommended First Slice

Implemented first slice: one-session **underlay linger**. When the user leaves
a session for a non-session route, keep the session route mounted in a hidden/inert
session layer underneath the foreground route. Source Control, Inbox, Agents,
Settings, and similar routes render in the foreground layer while the URL and
browser history behave normally. Returning by browser Back or by selecting the
same session removes the foreground layer and reveals the already-mounted
session layer.

This is likely faster and simpler than physically moving DOM nodes between
containers. The session subtree stays owned by the same React host, its scroll
container stays alive, and renderer state remains intact. The desired user
experience is closer to switching browser tabs than to remounting a route from
cached data.

Initial scope:

- one lingered session entry only
- session -> non-session route -> same session within 60 seconds
- direct session A -> session B navigation may park A when its rendered tree is
  below the direct-linger admission cap; returning to A swaps the active and
  parked trees without remounting either
- same source, auth state, project id, YA session id, route params, and
  tail-window params only
- no cross-tab, reload, or durable persistence
- fallback to `SessionRouteSnapshot` on every miss or expiry

Do not expand this into a generic keep-alive wrapper for all routes. Session
detail is the latency problem and the resource-risk problem; solving it with a
narrow session host keeps the behavior inspectable.

Do not retain two parked sessions. Direct switching is bounded to one active
tree and one parked tree. The parked tree releases its activity listener,
focused session watch, and owned-session stream, and remains inert and hidden.
Trees above 5,000 descendant elements are admitted beside an active session
only when Conversation View can compact a bottom-following transcript to its
bounded tail. A scrolled-away or otherwise non-compactable tree falls back to
`SessionRouteSnapshot` remount behavior so direct reuse cannot silently move
the user's scroll position.

## Resource Contract

- Bounded grace: default candidate 60 seconds.
- Bounded entries: one active session plus at most one parked session.
- Bounded direct-session size: at most 5,000 descendant elements in the parked
  tree while another session is active, unless the parked bottom-following
  Conversation View is compacted to the 120-render-item tail.
- Same-tab only; no durable persistence and no cross-source reuse.
- Hidden DOM must not survive a closed tab or browser reload.
- The hidden route must be inert to the foreground route: no pointer events,
  no focus capture, no accessible duplicate transcript, and no foreground
  keyboard shortcut handling.
- The owner for every lingering stream, watch, retry timer, and poll must be
  explicit. Either suspend it while hidden or count it as an intentionally
  grace-bounded live client resource.
- A hidden session must not indefinitely warm provider context, hold server
  watchers, or schedule recurring catch-up work after the grace period.

## Implementation Shape

`SessionDomLingerHost` sits beside route layout, keyed by source,
project, session id, route params, and query params. When leaving a session
route for a non-session route, park the route subtree in the host instead of
unmounting it. Prefer the underlay shape for the first pass:

```text
NavigationLayout
  SessionDomLingerHost
    parked SessionPage for the most recent matching session
  ActiveRouteOutlet
    SourceControl / Inbox / Agents / Settings / ...
```

While parked, the session layer should be hidden or covered in a way that keeps
component and scroll state alive. It should also be `inert`, `aria-hidden`, and
non-interactive so the foreground route owns focus, pointer events, and keyboard
handling. On a matching return before expiry, reveal the parked layer instead
of remounting `SessionPage`. On expiry or mismatch, unmount normally so existing
cleanup paths close streams, watches, timers, and polling hooks.

The implementation should record a clear linger state machine:

- `active`: session route is the visible route
- `parked`: matching session route is hidden behind a non-session foreground
  route
- `revealed`: browser Back or session reselection reused the parked route
- `expired`: timer/mismatch/source/auth change destroyed the parked route

The router contract matters: URL, browser history, active nav selection, and
foreground route data loading must continue to behave as if normal navigation
happened. DOM linger is an implementation detail of route rendering, not a
second navigation stack.

This speed layer remains an explicit, default-off performance preference. Do
not infer from its bounded direct-session reuse that generic hidden keep-alive
is safe.

## Content-Frame Contract

Built-in content viewers launched from session content must preserve the session
underlay. A normal click on a generated file-path link, `Read`/`Edit` file link,
local-file link, local-media link, or explicit YA project-file viewer URL should
open a modal or content-frame viewer while the current session remains mounted
underneath. Browser Back is an acceptable close gesture for those viewers: for
modals it should close the modal; for a full-frame content route it should leave
the viewer route and reveal the lingered session immediately.

Full-frame built-in viewers belong inside `NavigationLayout` as content-frame
routes, not as sibling routes that unmount the layout. They may cover 100% of
the app frame and suppress sidebar chrome, but the session linger host must stay
mounted. `/projects/:projectId/file` is the current concrete example.

An authenticated standalone content-frame viewer must still expose the normal
sidebar launcher. Activating it opens the shared sidebar as a temporary overlay
at every viewport width; dismissing the overlay returns to the unchanged viewer,
while selecting a destination performs normal app navigation. The content frame
stays full-width and sidebar session feeds remain disabled until that overlay is
actually opened, so a new-tab file view neither waits for sidebar discovery nor
changes the default presentation merely because sidebar access is available.

External offsite links that navigate the browser away from YA are outside this
contract. If YA later adds a built-in offsite/web viewer, that viewer must follow
the same modal/content-frame rule: Back acts as close/return, the foreground
viewer owns focus and pointer events, and the parked session remains inert.

## New-Tab And Cross-Tab Model

New-tab navigation starts a fresh app instance from a URL. A modified or
middle-click on Settings, Source Control, Inbox, Agents, or another ordinary
React Router `Link` must stay browser-native: the source tab must not run the
same-tab route transition, so it must not park the current session merely
because the new tab opens. The new tab mounts its own `NavigationLayout` and
has no access to the source tab's hidden DOM or React state.

Browser tabs have separate DOM trees, JavaScript heaps, React component
instances, and per-tab singleton objects. Same-origin tabs can still share
browser storage and explicit communication channels such as `localStorage`
events, `BroadcastChannel`, a service worker, or a shared worker, but those
channels can only transfer structured data and messages. They cannot transfer a
live DOM tree, React fiber, scroll container, WebSocket object, or in-memory
hook state between tabs.

The current linger cap is therefore per tab, not global. Viewing the same YA
session in two tabs creates two live session-route instances when both tabs are
on the session URL. If either tab leaves to a non-session route, that tab may
park its own copy for the 60-second grace window. For an active process, each
mounted session route can also create its own session subscription and prompt
cache keepalive viewer lease; the server cleans each lease on unsubscribe, but
there is no current cross-tab election that collapses duplicate same-session
viewers into one owner.

If duplicate same-session tabs become a measured resource problem, mitigation
should be coordination rather than DOM transfer:

- A same-origin tab registry can use `BroadcastChannel` plus a short
  `localStorage` lease, or `navigator.locks` where available, to elect one
  active owner for expensive per-session work while non-owners stay passive.
- A duplicate-session link could ask an already-open owner tab to focus itself
  only when browser restrictions allow it; arbitrary focus of unrelated tabs is
  not a dependable Chrome capability.
- A service worker or shared worker can centralize data fetching or message
  fan-out, but cannot share UI state or mounted DOM. That is a larger transport
  architecture change, not an extension of the DOM linger host.

Current stance: do not implement cross-tab coordination until duplicate
same-session tabs show a real resource or correctness cost. The current
one-entry linger cap is intentionally per tab, and duplicate tabs require the
user to open the same session in multiple browser contexts. That is not yet a
demonstrated priority.

Evidence that would justify revisiting this:

- debug traces showing multiple same-browser-profile tabs holding the same
  source/project/session subscription or prompt-cache keepalive lease for long
  enough to matter
- a measured server or browser symptom, such as duplicated high-volume live
  deltas, extra focused watches, excess keepalive refreshes, or visible CPU and
  memory pressure from duplicate mounted transcript trees
- a clear product decision for two visible windows on the same session: whether
  both must receive full live updates independently, or whether a follower tab
  may depend on an owner tab's broadcast stream with fast fallback

Lowest-risk sequence if that evidence appears:

1. Add instrumentation only. Count same-browser-profile duplicate session
   viewers and keepalive leases without changing behavior.
2. Add a same-origin presence registry keyed by source, project, session id,
   route params, and tail params. Use `BroadcastChannel` plus a short
   `localStorage` lease, or `navigator.locks` where available, and publish only
   compact state: tab id, route key, visibility, parked/active status, and last
   heartbeat.
3. Reduce work only for hidden or parked duplicates first. A visible foreground
   duplicate should keep its direct server subscription until the follower path
   has complete replay, ordering, and owner-loss handling.
4. If needed, trial an owner/follower subscription model. The owner holds the
   server session subscription and rebroadcasts structured events; followers
   fall back to their own subscription when the owner heartbeat expires, when
   ordering gaps appear, or when the browser lacks the chosen coordination API.

Do not use cross-tab coordination as a hidden focus-stealing feature. Focusing
an already-open duplicate tab is at best an opportunistic convenience when the
browser allows it, not a correctness primitive. Do not use a service worker or
shared worker as the first step; that changes the transport architecture and
still cannot share the session DOM.

## Verification

- Browser test: session -> non-session route -> back within 60 seconds reuses
  the lingered DOM, preserves scroll, and shows no loading or progressive
  render bar.
- Performance check: session -> Source Control -> Back should reveal the
  existing session within one animation frame on development hardware. If the
  route still takes hundreds of milliseconds, the implementation is falling
  back to remount or doing synchronous foreground work on reveal.
- Direct-session performance check: after both eligible sessions are warm,
  quiet A/B sidebar switches must reuse the retained layer and reach the first
  readable frame within a 200 ms p95 ceiling.
- Back/reselect parity: browser Back and sidebar/session-list reselection of
  the same session should hit the same linger-reveal path.
- Expiry test: after the grace period, the subtree unmounts and the normal
  retained snapshot path handles return.
- Resource test: hidden linger entries do not accumulate streams, session
  watches, poll timers, or reconnect loops beyond the cap and grace period.
- Memory smoke: visit several large sessions on a mobile-width viewport and
  confirm linger eviction plus session snapshot byte caps bound tab memory.

## 2026-07-01 Implementation Notes

`SessionDomLingerHost` owns route identity, keyed layers, expiry, admission,
resource deferral, and pre-navigation visual swaps. `NavigationLayout` composes
sidebar and foreground layout around that host; the React Router child route is
only a marker. Non-session routes continue through the normal `Outlet` as the
foreground layer. Session route identity is parsed from `location.pathname`, not inherited child
`useParams()`, because a parent layout can otherwise retain stale session params
after navigation to `/git-status`.

`SessionPage` accepts the saved session route location so a parked instance does
not start reading Source Control or Settings as its own route. While parked,
the session disables page-title ownership, engagement tracking, URL-sync
navigation effects, and transcript-level global interaction listeners. The
stream and render state stay alive until the 60-second expiry unmounts the
parked layer.

The inverse latency problem is tracked separately in
[`session-exit-navigation-latency.md`](session-exit-navigation-latency.md):
leaving a large session for Settings or another lightweight route should paint
the new foreground route immediately, even when DOM linger is disabled or when
the old session can be parked for fast Back/reselect.

Browser smoke against a 173-message Codex session verified:

- session -> Source Control parks the session layer while Source Control is
  foreground
- Back reveals the same `.message-list` DOM node
- after waiting for the original session render to settle, Back samples showed
  no full loader and no progressive render bar

If the user leaves before the initial progressive render has completed, DOM
linger preserves that existing in-progress overlay. That is expected for this
slice: the feature avoids remount work; it does not hide work that was already
visible before navigation away.

Follow-up verification added generated assistant text paths and explicit
project-file viewer URLs to the contract. Normal clicks on those links open the
same `FileViewerModal`; direct navigation to `/projects/:projectId/file` stays
inside `NavigationLayout` as a sidebarless content-frame route so Back can reveal
the parked session rather than remounting it.

2026-07-01 code inspection verified ordinary sidebar navigation still uses
React Router `Link`, whose click handler only intercepts unmodified left-clicks.
Modified clicks and middle-clicks are left to the browser, so opening Settings
or similar routes in a new tab does not trigger hidden-DOM parking in the source
session tab. The current app has cross-tab storage/channels for preferences,
draft decorations, service-worker messages, and shared speech mic leasing, but
no session-view ownership or DOM-transfer protocol.

## 2026-08-02 Foreground-work isolation

A parked session must not begin optional pending-agent recovery while another
route is foreground. In particular, navigating to Source Control must not make
its first diff compete with a Codex transcript scan initiated by the hidden
session. Recovery remains pending and runs when that same session becomes
foreground again.

Codex session-detail parsing seeds a compact, file-fingerprint-keyed map from
`spawn_agent` tool calls to child session ids. Pending-agent recovery reuses
that map without reparsing or retaining another copy of the transcript. A cold
mapping request streams the rollout and parses only candidate spawn/output
lines, then retains the compact map; a size or modification-time change
invalidates it. The existing parse-phase metrics report compact-cache hits and
cold scans under the `agent-mapping` purpose.

The motivating trace was a Source Control file click delayed while the parked
session issued `/agents`; the Git diff itself does not need agent mappings or
blame. A development corpus with 617 Codex rollouts measured 1,165 ms in cold
global session discovery, while a mapping lookup seeded by the already-loaded
session detail took 0.17 ms. That establishes both ownership fixes: parked
optional work waits for foreground, and the normal foreground session-detail
path prepopulates the compact mapping rather than making recovery rediscover or
reparse the session.

## 2026-08-29 Direct-session reuse

The direct A/B path keeps the outgoing compact session mounted before React can
discard it, then swaps the two keyed layers on return. Admission happens in a
layout effect before paint: one active session may retain one same-source,
same-project prior session only when the outgoing tree has at most 5,000
descendant elements. A route-parameter mismatch, source/project mismatch,
expiry, preference disable, or larger tree destroys the parked entry and uses
the retained snapshot path.

Parked sessions keep component, DOM, scroll, and draft state but release their
activity-bus consumer, focused file watch, and owned-session stream. Revealing
the session recreates the applicable consumer; the focused watch performs its
normal open catch-up and an owned stream resumes from the hook's retained event
cursor. The wrapper is `inert`, `aria-hidden`, invisible, and pointer-disabled
while parked, so only the active layer owns focus and interaction.

The performance trace records route click, snapshot lookup/hit and message
identity, state queue, MessageList preprocessing/grouping/commit, readable
paint, remount versus DOM reuse, active/parked layer counts, active session
consumers, cache bytes, heap, listeners, and browser process memory. Its causal
mode alternates idle and immediate-append arms by repetition so elapsed idle
time is not silently attributed to session activity.

Sidebar rows publish typed project/session/href navigation intent to
`SessionDomLingerHost`. The host performs wrapper visibility, `inert`,
accessibility, and pause-signal swaps synchronously before urgent router
navigation; it does not discover navigation through the Sidebar's CSS classes.
The keyed session subtree is memoized, so that navigation can commit without
traversing the retained transcript. Background-resource state follows after
the first paint, on the next animation frame plus 500 ms, and is cancelled if
another switch supersedes it.

A completed, bottom-following Conversation View compacts to the existing
120-render-item progressive tail while parked. On reveal, that useful tail is
immediately readable; after a 1.5-second grace, the rest returns in 12-item
batches. Every queued batch and final reveal rechecks the synchronous pause
signal, so parking the session again cancels obsolete hydration. A scrolled-away
view does not opt into compaction and therefore remains subject to the 5,000-
element admission cap. The smaller batch applies only to retained rehydration;
ordinary initial progressive restoration keeps its 90-item batch so an
off-tail remembered scroll anchor mounts promptly.
