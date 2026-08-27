# UI Architecture

> UI architecture keeps shared rendering, layout, and interaction behavior
> attached to the data or render boundary that produces it, rather than patching
> generated DOM after the fact.

See also: [`injected-message-visibility.md`](injected-message-visibility.md) —
how YA-injected, non-user text (compaction commands, summaries, skill/resume
init text) is hidden or given the system/boundary contract instead of rendering
as a normal turn.

Topic: ui-architecture

## Render Boundary Principle

When two views present the same model data, prefer to share the component,
renderer, or source adapter that creates the UI state. Do not satisfy a view
request by adding a custom click interceptor that inspects already-rendered DOM
and rewrites destinations as a primary design; that creates view-specific
spaghetti and prevents other views of the same data from inheriting the fix.

Preferred order:

1. Amend the data/model/render generator so the current UI state is produced in
   the right shape for all callers that should share the behavior.
2. Add an explicit view-bound adapter near the origin when only one context
   should differ, such as public-share snapshot/live file links.
3. Add a default-preserving parameter when other callers need the old behavior.
4. Use post-render rewriting only as a small containment bridge, with the rule
   named and scoped so it cannot silently become the architecture.

## Narrowing/Widening Stability Principle

Any UI surface that sheds items as space narrows and restores them as space
widens must behave with a fixed order in both directions: widening brings
items back in exactly the reverse order narrowing removed them, and the same
width always yields the same set. Two acceptable constructions:

1. **Provably fixed-order algorithm** (preferred — simpler): the shed/restore
   decision is a deterministic, monotone function of available space over a
   fixed removal order, so reverse-order restore holds by construction and no
   history is needed.
2. **Tracked removal order**: record the actual order items were removed
   (fine to compute in advance, e.g. width cutoffs) and replay it in reverse
   on widen.

What this bans: unordered recomputation — e.g. bin-packing by measured item
widths, or iteration-order-dependent selection — where widening can restore a
different set or sequence than narrowing removed, or where a boundary width
oscillates. Near-equality thresholds also need slack/hysteresis so measured
feedback (an item returning changes the measurement) cannot latch or
flip-flop; see the compact-signal traps in
[`composer-bottom-bar-overflow.md`](composer-bottom-bar-overflow.md).

Worked instance: the composer bottom-bar overflow engine
(`useMeasuredComposerOverflow` in `MessageInputToolbar.tsx`) walks a fixed
tier ladder (`none → early → medium → late`) one step at a time while
measured demand exceeds available width, and on any >1px widening resets to
`none` and re-escalates from scratch. The result at a given (layout, width)
is history-free and identical from either direction, so restore is
reverse-of-removal by construction — form 1 above.

## Transient Feedback Lifetime

In-page toasts remain click-to-dismiss alerts. Success and informational
feedback uses a 4.5-second lifetime, or seven seconds when it includes an
action. Error feedback remains for 12 seconds because it commonly carries the
only explanation for a failed operation. The toast stays fully opaque for the
first 75% of its lifetime and fades only near removal, so nominal lifetime and
readable lifetime do not diverge. One duration resolver owns both the removal
timer and CSS animation value.

## Desktop Sidebar Display Modes

The desktop sidebar has three browser-persisted display modes. Expanded mode
reserves the configured sidebar width; collapsed mode reserves only the icon
rail; minimized mode reserves no width and leaves the standard sidebar toggle
fixed over the page at 2px from the top-left viewport edge. The floating toggle
is an overlay: page headers and content do not add padding or otherwise reflow
around it.

Minimize is available only from the collapsed desktop rail. Its small
bottom-line control removes the entire rail, and the floating standard toggle
restores the collapsed rail rather than expanding it. Mobile overlay behavior
is unchanged. The normal default remains the expanded sidebar, so the new
control appears only after the user has already selected or reached collapsed
desktop mode.

## Public Share Example

Public shares have a valid reason for an independent unauthenticated top-level
page: the route is a read-only bearer-link trust boundary. That does not justify
forking the normal session/file presentation stack. The public route should feed
share-scoped loaders and link transforms into shared viewers, transcript rows,
media affordances, copy UI, spacing, and inspection behavior whenever those
affordances remain read-only.

Dynamic-scope or explicit snapshot/live link adaptation is acceptable for public
shares when the adaptation is attached to the shared rendering context or file
viewer source. It is not a license for arbitrary `onclick` URL surgery after
the UI has already been generated.

## Global Tooltip Boundary

Ordinary text hints already enter the UI through the semantic `title` or
`data-tooltip` attributes across many renderers. `TooltipLayer` is the one
interaction boundary that translates those hints into themed presentation; it
owns dwell, warm adjacency, viewport placement, dismissal, and accessibility
association instead of duplicating that machinery at every producer. It must
not inspect text to infer behavior or rewrite unrelated rendered content.
Tooltip producers use the shared exclusive-attribute helpers so one element
has either a native `title` or a themed `data-tooltip`, never both. Shared
hidden-content badges require their producer's omitted-tail text, keeping the
tail affordance attached to the abstraction that means “more content” rather
than patched into individual renderer types.
While Themed mode is active, the boundary proactively normalizes legacy and
dynamically added `title` attributes into YA-owned tooltip metadata across the
mounted document; it restores them only on a switch to Native. This metadata
normalization is the compatibility boundary for older producers, not a rewrite
of their rendered content.

Structured explanatory tooltips use the same timing coordinator explicitly.
Interactive help panels remain popovers with their own state. The observable
contract and native fallback are in
[tooltip-interactions](tooltip-interactions.md).

## Global Reload Notice Placement

The shared backend/frontend reload notice preserves page identity and
navigation rather than claiming the full top edge. On desktop and tablet it is
an intrinsic-width card at the lower viewport edge, where unused space is more
likely; it must not cover a session title, page-level navigation, or session
composer controls or another fixed lower-corner action. The notice stack
measures live fixed occupants as one allocation problem: it occupies the
lower-right space when that space is clear and lifts the entire stack above
the session composer or floating action button when it would collide. A second
notice must not grow underneath a higher-z-index occupant. On phone it may
remain at the top, but stays inset from both viewport edges instead of becoming
a full-width bar.

Every form has an explicit × dismiss control with at least a 36×36 pixel hit
target. Visible copy stays compact; complete restart-risk and action wording
remains available through accessible names and hover titles. All
`ReloadBanner` callers inherit this placement and interaction contract.
Choosing any action consumes the current notice instead of morphing it into a
status or confirmation panel. The requested reload or safe-restart schedule
continues; after a reload, later source changes may produce a fresh notice.

## Fatal Client Diagnostics

The root client error boundary preserves enough context to diagnose an
otherwise unrecoverable React render failure without reproducing it. Its
fallback exposes a copyable diagnostic containing the error and component
stacks, route, client/server versions, timestamp, user agent, bounded DOM
counts, and the browser-local Conversation View/thinking settings relevant to
session rendering. It never includes transcript or draft text.

The Report Issue action targets the canonical repository and pre-fills the
same diagnostic plus a prompt for the immediately preceding action. Optional
remote client-log collection receives the diagnostic as one formatted error
entry, so object serialization cannot discard React's component stack.

## Selected-Route Module Ownership

The initial client module graph contains the stable source/authentication,
navigation, error, and layout shell plus the selected page. A page that is not
selected must not be evaluated merely because its route exists. Local and
remote entrypoints apply the same rule; login and public bearer-link entry do
not reach the authenticated session-management page graph.

A route-level loading boundary preserves the shell and final page geometry.
It never flashes an unauthenticated surface, loses the URL, or substitutes a
temporary 404. A module generation has one shared acquisition promise, and a
failure becomes an actionable route error rather than an indefinite spinner.

A selected session starts its remote app, connection gate, navigation layout,
page, transcript, and composer acquisitions together from the initial URL. Its
module and connection boundaries render the same full-viewport session shell;
status changes stay in the transcript slot while header and composer geometry
remain reserved. Once the real session header or composer is visible, a lazy
descendant must not hide it or return the route to a generic page fallback.

Session DOM linger belongs outside the module-acquisition boundary. Making
`SessionPage` lazy must not create a second module instance, tear down a view
that `NavigationLayout` is deliberately retaining, or convert an already-warm
back/reselect into a remount.

Settings is layered. Ordinary entry loads the layout and selected category;
inactive panes are not evaluated. Settings search is the explicit consumer
that may need every pane because results are operable instances of the same
controls. It loads those panes progressively only after search starts, reports
incomplete loading/failure honestly, and keeps already found results stable.

Dynamic route assets remain part of one deployed entrypoint generation. Old
loaded entrypoints must be able to acquire chunks they name after a deployment,
or recover once through a state-preserving fresh entry. The delivery contract
is in [`client-asset-delivery.md`](client-asset-delivery.md); the implementation
handoff is
[`docs/tactical/096-client-route-module-loading.md`](../docs/tactical/096-client-route-module-loading.md).

Implementation status: both browser entries apply this boundary to their page,
navigation-layout, service-worker, and elective floating-action modules. The
remote entry also defers its connection gates and redirects, preloads only the
current initial route, and shares cached loader promises with `React.lazy`.
Session transcript/composer suspension is caught inside their owned slots. The
boundary preserves the session DOM-linger owner outside `SessionPage` and
routes load failures through the existing fatal error boundary. The
per-Settings-pane split remains open in tactical 096.

## Settings Pane Conventions

Settings panes apply changes immediately on interaction — the house style
for toggles, sliders, and selects (Notifications, Model, Appearance,
Development). A deferred Save/`hasChanges` flow is acceptable only for
free-text panes where partial input should not hit the server (Agent
Context, Lifecycle Webhooks, Providers, Local Access); continuous controls
like sliders debounce their saves rather than deferring them.

The per-pane undo affordance has a single implementation and a single
location: panes register their open-time snapshot revert via
`useSettingsUndo` / `useSettingsUndoBaseline`
(`pages/settings/SettingsUndoContext.tsx`), and `SettingsLayout` renders
the one Undo button top-right on the header row — never inside scrollable
pane content. A pane that adopts immediate apply should register undo so
accidental changes stay recoverable.

Undo is intentionally one step at pane granularity, rather than a per-action
history or redo chain. The header button and `Ctrl+Z` / `⌘Z` invoke the same
active-pane registration. The button's hover and accessibility label names the
pane and says that it undoes changes made since opening it. When focus is in a
text-editable control, the shortcut remains native text undo.

Undo semantics vary by pane kind, deliberately:
- **Snapshot panes** (immediate-apply or simple Save forms) revert to the
  pane-open snapshot via `useSettingsUndoBaseline` — wired in Message
  Delivery, Speech, Notifications, Development, Model, Emulator,
  Appearance, Agent Context, Lifecycle Webhooks, Remote Executors
  (list reconciliation; re-added hosts may lose position).
- **Apply-flow panes** (Local Access) register `useSettingsUndo` with
  discard-unapplied-edits semantics only: re-applying an old network
  binding automatically could sever the operator's own connection, so
  applying stays behind the explicit button.
- **Not wired**: About/Devices/Remote Access (status and actions, no
  undoable settings); Providers (below).

### Why Providers sub-form undo is deferred (likely never)

The Providers pane is several independent sub-forms (Ollama endpoint/prompt,
per-provider toggles, and any future helper-targets editor with edit-in-place
drafts), each with its own draft, validation, and Save lifecycle. The
header contract is one Undo button in one location, which forces a
single answer to "undo what?" — and across heterogeneous sub-forms
there is no honest single answer: reverting *all* sub-forms punishes a
user who finished one edit and is mid-draft in another; reverting only
the last-touched form makes the button's scope invisible. Supporting
this would mean either multi-registration plumbing (several buttons or
a scoped menu — breaking the one-button contract) or lifting every
sub-form's state into the pane (a refactor whose cost exceeds the
benefit: these are low-churn forms that already have explicit
Save/cancel lifecycles). Per the options-pay-rent principle in
[vanilla-defaults](vanilla-defaults.md), the affordance is not worth
its complexity here unless the pane is restructured for other reasons;
treat this as likely-never rather than pending.
