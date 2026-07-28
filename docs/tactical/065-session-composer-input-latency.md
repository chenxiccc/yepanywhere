# Session Composer Input Latency

Status: implemented and validated in automated/browser probes; validation on
the originally affected Chromebook remains pending.

Topic: composer-input-latency
Topic: selection-comment-ui
Topic: transcript-virtualization
Topic: client-global-store

## Origin

A session composer became visibly laggy while typing on a Chromebook even with
streaming disabled. The New Session composer on the same browser was
substantially more responsive. The reported behavior made two architectural
problems visible:

- ordinary composer text invalidates the mounted session transcript; and
- transcript-row preference hooks repeatedly read unchanged values from
  `localStorage` during that invalidation.

This tactical addresses the input path rather than hiding the problem behind a
faster device, a smaller transcript, disabled streaming, or a broader
transcript-window change.

## Product Contract

### Typing is local to the composer

An ordinary composer edit must not render `MessageList`, any historical
`RenderItemComponent`, or a transcript tool/text/thinking row. This invariant
does not depend on:

- transcript row count or DOM size;
- desktop versus phone layout;
- streaming being enabled or disabled;
- whether the first character changes the draft from empty to non-empty; or
- whether the last deletion changes the draft back to empty.

The textarea, its local affordances, draft recovery persistence, and its own
height may update. Transcript work must remain zero unless session/transcript
data itself changes.

### Quote reconciliation is a narrow draft consumer

The quote-comment feature may observe draft changes, but observation must not
make the transcript a consumer of the complete draft string.

- With no live quote anchors, no quote reconciler subscribes to draft edits.
- With live anchors, an ordinary edit whose metadata says it cannot touch a
  quote-prefixed line exits without parsing quote signatures or setting React
  state.
- A potentially relevant edit computes draft quote signatures once and reuses
  them across anchors.
- Removing the last matching quote line updates the quote layer and CSS
  highlights without rendering historical transcript rows.
- Sending or clearing the draft clears quote anchors without creating a
  composer-text dependency on the transcript.

This preserves the observable tint lifecycle in
`topics/selection-comment-ui.md` while changing its ownership boundary.

### Queued-message editability is a leaf concern

Queued-message Edit controls must continue to appear only when the composer is
available to receive the queued text. Draft presence, staged attachments, and
active uploads participate in that decision.

Only mounted queued-action controls may subscribe to this boolean. Changing it
must not render `MessageList` or historical rows. The action handler must
re-check availability when invoked so a stale paint cannot overwrite a newer
draft.

### Draft recovery remains immediate

Do not solve input latency by weakening recovery semantics. The current draft
text continues to be written synchronously for each accepted edit so an HMR
remount, refresh, page freeze, or lifecycle path cannot restore an older
draft.

The session draft index is presence metadata, not draft contents. It should be
updated only when persisted draft presence changes between empty and
non-empty.

### Reactive browser preferences use cached snapshots

Reactive browser-local preferences must have an in-memory snapshot:

- the first client read lazily initializes it from `localStorage`;
- same-tab application setters update storage and the snapshot, then notify;
- cross-tab `storage` events update or invalidate the matching snapshot;
- a bulk migration/import can explicitly invalidate one key or all keys; and
- a direct DevTools/console write is not required to appear synchronously in
  the current tab.

Application code that expects a same-tab reactive update must use the
preference interface. Tests must exercise that interface or explicit
invalidation rather than rely on a later unrelated render to discover a raw
storage mutation.

## Measured Baseline

Measurements used isolated Playwright Chromium contexts against the existing
Vite development server. Storage calls, React commits, and CDP performance
metrics were reset after warm-up for each character. Development React adds
diagnostic overhead, but all comparisons used the same bundle and the scaling
signal is unambiguous.

| Surface | Rows | React commits/key | `getItem`/key | storage writes/key | sampled task/key |
| --- | ---: | ---: | ---: | ---: | ---: |
| New Session | 0 | 1 | 2 | 1 | about 8 ms |
| Short session | 21 | 3 | 90 | 2 | about 16–18 ms |
| Tool-heavy session | 859 | usually 3 | 2,882 | 2 | about 72–74 ms |
| Same 859 rows at 375px | 859 | usually 3 | 2,882 | 2 | about 70–73 ms |

The representative long session mounted approximately 17,600 elements:

- 470 tool-call render rows;
- 316 thinking rows;
- 81 text rows;
- 17 explored groups;
- 10 user prompts; and
- 856 message-age elements.

The preference reads in one steady long-session character were dominated by:

- tooltip mode: 1,824;
- stable tool-preview rendering: 860; and
- inline-media expansion: 162.

The session textarea performed two writes: the draft envelope and the
source-scoped session draft index. These are synchronous local writes, not
network messages, storage events, or console logs.

### Causal isolation

In a disposable browser context, only the `MessageInput` instance's
`onDraftTextChange` prop was disabled at runtime. No source or server state was
changed.

The same 859-row session then produced:

- one React commit per character instead of three;
- a 0.5–0.7 ms composer React commit;
- about 1.5–2.7 ms script time for an ordinary short-draft character; and
- no transcript render.

This reduced the hot path by roughly an order of magnitude and proves that the
draft-to-parent-to-transcript dependency is the primary defect.

Caching storage reads alone did not materially change the fast-host
long-session time because React still invoked thousands of snapshot functions
and reconciled the transcript. It remains required as a correctness and
constant-factor cleanup, but it is not a substitute for the render-boundary
fix.

The global "suppress tooltips while typing" path had 107 subscribers and ran
for both `beforeinput` and `input` (about 214 callback invocations per
character). Disabling it did not materially improve the long-session sample.
It is follow-up cleanup, not the causal fix.

### Why New Session is different

`NewSessionForm` owns its draft locally. A character renders the form and
persists its one draft envelope, but it does not publish the complete text into
a mounted transcript tree.

`MessageInput` also owns text locally, but its effect calls
`onDraftTextChange(text, metadata)`. `SessionPage` stores both values in React
state and passes them to `MessageList` for:

- quote-anchor reconciliation; and
- the queued-message "composer is empty" decision.

Both props change per character and therefore defeat `MessageList`'s memo.
The quote reconciler's cheap "no anchors" and edit-metadata gates run only
after React has entered `MessageList`; they do not protect the memo boundary.

## Architectural Decision

Composer text remains owned by `MessageInput`/`useDraftPersistence`, consistent
with `topics/client-global-store.md`. Do not put the full string in Zustand, a
global context value, or a session-summary collection.

Add a stable, session-scoped draft signal with two kinds of consumers:

1. imperative draft-change listeners for quote reconciliation; and
2. a primitive external-store snapshot for composer availability, consumed
   only by queued-action leaves.

The signal object and subscribe functions keep stable identity. Publishing a
draft change does not set `SessionPage` React state and does not change a
`MessageList` prop.

Conceptual interface:

```ts
interface ComposerDraftChange {
  text: string;
  metadata: DraftTextChangeMetadata;
  hasTextContent: boolean;
}

interface ComposerDraftSignal {
  getDraft(): string;
  subscribeDraftChanges(
    listener: (change: ComposerDraftChange) => void,
  ): () => void;
}

interface ComposerEditAvailabilityStore {
  getSnapshot(): boolean;
  subscribe(listener: () => void): () => void;
  getCurrent(): boolean;
}
```

The exact module split may differ, but the ownership and render behavior may
not:

- publishing draft text is non-React work at the session boundary;
- quote state belongs to a quote-layer child, not the transcript parent;
- availability is a primitive snapshot subscribed to at queued controls; and
- the transcript receives only stable functions/store objects.

## Target Render Topology

```text
SessionPage
├─ stable ComposerDraftSignal
├─ stable ComposerEditAvailabilityStore
├─ MessageList (memo)
│  ├─ transcript rows
│  ├─ MessageListQuoteLayer
│  │  └─ conditional draft-change subscription
│  └─ composer-tail rows
│     └─ QueuedMessageActions
│        └─ availability-store subscription
└─ MessageInput
   ├─ local draft state
   ├─ immediate recovery write
   ├─ textarea autosize
   └─ publish draft change without parent state
```

A state update in `MessageListQuoteLayer` or `QueuedMessageActions` renders
that child. It does not execute the transcript row map.

## Implementation Slices

### Slice 0 — contracts and reproducible probes

Before changing runtime ownership:

- add the ordinary-typing isolation invariant to
  `packages/client/RENDERING_PERFORMANCE.md`;
- update `topics/selection-comment-ui.md` to replace its current
  parent-draft-state ownership with a narrow quote-layer subscription;
- update `topics/client-global-store.md` to describe event-driven same-tab
  draft decorations rather than a polling requirement;
- record that this is client-only and adds no server route, response field,
  event, capability, or compatibility-floor change; and
- add a deterministic render-count probe suitable for focused tests.

The probe should count `MessageList`, `RenderItemComponent`, `MessageAge`, and
representative tool-row renders while editing a mounted composer. Render-count
assertions are the primary non-flaky contract; wall time is supporting
evidence.

### Slice 1 — sever draft text from `SessionPage` React state

Replace:

- `composerDraftForAnchors`;
- `composerDraftChangeForAnchors`; and
- the per-character `setState` calls in
  `handleComposerDraftTextChange`.

Create one stable session-scoped signal. `handleComposerDraftTextChange`
updates a ref/snapshot and publishes to its current listeners without changing
`SessionPage` state.

Remove `composerDraft` and `composerDraftChange` from `MessageList` props.
Retain a stable `getComposerDraft`/signal reference for click-time quote
insertion and explicit reconciliation.

Every path that changes text must publish through the same seam:

- native textarea edits;
- quote insertion;
- queued-message edit transfer;
- recall/correction;
- speech insertion/finalization;
- programmatic `setDraft`;
- clear, restore, and successful-send cleanup; and
- draft-key/session changes.

Prefer the existing text-keyed `MessageInput` effect as the single publication
point if it can preserve edit metadata and cover all mutation paths. Avoid a
collection of call-site notifications that can silently miss programmatic
changes.

StrictMode effect replay and same-value publication must be harmless.

### Slice 2 — isolate the quote layer

Extract the stateful parts of `useMessageListSelectionQuote` into a
`MessageListQuoteLayer` child or an equivalent child-owned controller:

- comment anchors;
- floating/mobile selection button state;
- selection/document listeners;
- draft-change subscription;
- CSS Highlight registration; and
- quote-clear reconciliation.

Create a stable controller action for paragraph/block quote buttons so
transcript rows do not need the quote layer's state as props. The existing
quote-reply display preference may legitimately rerender rows when the user
changes that setting; draft changes may not.

Subscription rules:

1. no anchors means no draft listener;
2. `mayAffectQuoteAnchors === false` returns before draft parsing;
3. a relevant edit computes signatures once;
4. unchanged anchor membership does not call React state setters; and
5. changed membership rerenders only the quote layer and updates highlights.

Selection-copy, paragraph quote, selection-first-keystroke, mobile selection,
undo, and send-clear behavior must remain on the existing shared quote path.

### Slice 3 — move composer availability to queued-action leaves

Remove `canEditQueuedMessages` and the fallback
`composerDraft.trim().length === 0` from `MessageList`.

Create a stable `ComposerEditAvailabilityStore` whose primitive snapshot is:

```text
no non-whitespace draft text
AND no staged attachments
AND no active upload progress
```

`QueuedMessageActions` or a small wrapper immediately above it subscribes with
`useSyncExternalStore`. With no queued rows there are no subscribers.

The store publishes only when the boolean changes. Repeated non-empty edits do
not notify. The Edit handler re-checks `getCurrent()` immediately before
transferring text and preserves the existing unavailable behavior if the
composer changed since paint.

Project-queue item-specific `canEdit` and mutation state remain separate leaf
inputs.

### Slice 4 — cache reactive browser preferences

Turn `createLocalStorageValue` into a real cached external store:

- keep an initialized flag and parsed snapshot in its closure;
- do not permanently mark the store initialized while storage is unavailable
  during SSR;
- have `read()` return the cached primitive after the first successful client
  read;
- have `set()` update the in-memory value even if persistence throws;
- notify only when the effective snapshot changes, unless an existing caller
  has a documented same-value notification requirement;
- consume a matching `StorageEvent.newValue` or invalidate/re-read on
  `event.key === null`; and
- expose explicit invalidation for tests, migrations, and any future bulk
  update that does not reload.

Migrate the high-fan-out read-through preferences first:

- tooltip mode and delay, including the legacy delay fallback;
- stable tool-preview rendering;
- inline-media expansion;
- conversation view; and
- quote-reply button mode.

The primitive stores already built with `createLocalStorageValue` receive the
new behavior centrally. `useTooltipAppearance` needs migration from its custom
read-through implementation.

The browser-settings restore path currently reloads after applying values, so
it does not require live invalidation before reload. Tests that directly call
`localStorage.setItem` must explicitly invalidate or dispatch the matching
cross-tab event when reactive observation is part of the test.

Do not monkey-patch the browser's global `Storage` prototype.

### Slice 5 — stop rewriting and polling unchanged draft presence

Keep the actual draft-envelope write immediate. Change session draft indexing
so:

- the previous stored envelope's presence is compared with the next envelope;
- non-empty-to-non-empty text edits do not read/sort/write the draft index;
- empty-to-non-empty and non-empty-to-empty transitions update it once;
- a membership-preserving index update is a no-op; and
- attachment-only presence transitions follow the same rule.

Publish a same-tab draft-presence event from the owned persistence path.
`clientSummaryStore` consumes that event to update draft decorations. Keep the
initial scan and cross-tab storage-event reconciliation.

Once every same-tab application mutation is covered, remove the one-second
draft-decoration polling interval. Apply the same owned-notification rule to
New Session draft presence instead of polling for raw same-tab console writes.

This change must preserve source scoping and legacy local draft-index
backfilling.

Expected steady session write shape:

- first non-empty character: draft envelope plus one index transition;
- later non-empty characters: draft envelope only;
- final clear: draft removal plus one index transition.

### Slice 6 — measure secondary composer work

After Slices 1–5, remeasure before changing lower-value paths.

Textarea autosize currently performs computed-style reads, an `auto` height
write, `scrollHeight`, and composer/textarea rectangles for each edit. If it is
still material on constrained hardware:

- cache minimum-height and composer-chrome measurements;
- invalidate them on width/font/viewport/collapse changes;
- retain the `scrollHeight` read needed for wrapping/newline growth; and
- verify cursor visibility and the 50%-of-viewport maximum.

Tooltip suppression currently broadcasts twice per character. If it remains
measurable:

- deduplicate `beforeinput`/`input` suppression for one edit; and/or
- avoid notifying closed triggers when there is no visible, scheduled, or warm
  tooltip state to clear.

Do not include either cleanup in the causal fix without a before/after signal.

### Slice 7 — closeout and real-device validation

Run the focused and full warning-free checks required for client changes:

- focused composer, quote-selection, queued-message, storage-store, and draft
  decoration tests;
- `pnpm lint`;
- `pnpm typecheck`;
- relevant client tests with zero React/runtime warnings;
- `pnpm console:scan`;
- `pnpm i18n:scan` if user-facing copy changed (none is expected);
- `git diff --check`; and
- the browser performance matrix below.

Validate on the originally affected Chromebook or an equivalently constrained
real device. The configured ChromeOS device-streaming target is unrelated and
is not a substitute for testing YA in the affected Chromebook's own browser.

## Automated Acceptance

### Render-count contract

Mount a session with at least 1,000 representative render items and type a
sequence that includes:

- empty to first character;
- repeated ordinary characters;
- whitespace and newline;
- deletion while still non-empty; and
- final deletion to empty.

For every ordinary edit:

- `MessageInput` updates;
- `MessageList` render delta is zero;
- `RenderItemComponent` render delta is zero;
- `MessageAge` render delta is zero; and
- tool/text/thinking row render deltas are zero.

Repeat with:

- no queued items;
- queued and project-queued items mounted;
- no quote anchors;
- live quote anchors with a non-quote edit; and
- a quote-line deletion.

The quote-line deletion may render the quote layer and queued controls as
applicable, but it must not render historical rows.

### Preference-store contract

Tests must prove:

- the first client `read()` accesses backing storage once;
- repeated reads and React snapshot checks return the cached value without
  another backing read;
- `set()` updates the cache and same-tab subscribers;
- persistence failure still leaves a coherent in-memory preference;
- a matching cross-tab event updates or invalidates the snapshot;
- unrelated cross-tab events do nothing;
- `event.key === null` invalidates safely;
- SSR defaults do not poison later client initialization; and
- a raw same-tab write is invisible until explicit invalidation, by design.

### Draft persistence contract

Spy on storage and presence publication:

- first non-empty character performs one envelope write and one index write;
- later non-empty edits perform one envelope write and zero index writes;
- attachment changes preserve envelope fields and transition presence
  correctly;
- clear performs the expected removal/index transition;
- same-tab draft badges update without waiting for a poll;
- cross-tab writes still reconcile; and
- no draft-presence polling timer remains after the last consumer unmounts.

### Browser performance matrix

Profile at minimum:

- New Session;
- a short session;
- the representative long/tool-heavy session or a deterministic equivalent;
- 1280px desktop;
- 375px phone width; and
- normal plus 4x CPU throttling as diagnostic evidence.

After warm-up, an ordinary non-empty-to-non-empty character must show:

- one composer-owned React commit;
- zero `MessageList`/row renders;
- zero backing `localStorage` reads for initialized rendering preferences;
- one draft-envelope write;
- zero draft-index writes; and
- cost that does not scale materially with transcript row count.

Wall-time thresholds should be reported, not used as the sole CI gate. On the
existing development profile, target a median ordinary-character script cost
below 5 ms unthrottled and below 20 ms at 4x CPU throttling. Render-count and
storage-call invariants remain authoritative if shared-host timing is noisy.

## Manual Acceptance

On the affected Chromebook, use the same long session that originally lagged:

- hold a hardware key long enough to expose buffering/backlog;
- type and backspace rapidly with streaming disabled;
- repeat with streaming enabled while the session is idle;
- verify the first character and the final deletion are not special stalls;
- quote assistant text, type an ordinary comment, then delete the quote lines
  and confirm tint behavior;
- mount a queued message and confirm Edit availability follows composer,
  attachment, and upload state;
- exercise a multi-line and a large draft to verify autosize/cursor behavior;
  and
- switch away/back or reload to verify the newest draft is recovered.

Success is immediate visual echo with no growing key backlog. The result should
be comparable between the session composer and New Session; transcript size
must no longer determine input latency.

## Rollback And Slice Boundaries

Each slice should remain independently reviewable:

- Slices 1–3 are the causal render-boundary fix and should land together if an
  intermediate state would weaken quote or queued-edit behavior.
- Slice 4 is a self-contained preference-store contract change.
- Slice 5 is a self-contained draft-presence/index change.
- Slice 6 lands only where post-fix measurement justifies it.

If quote behavior regresses, roll back the quote-layer extraction rather than
restoring per-character draft props on `MessageList`. If cached preference
semantics regress, retain the composer isolation while reverting that storage
slice. Do not reintroduce polling or read-through snapshots as an implicit
compatibility mechanism.

## Risks And Mitigations

### A programmatic draft mutation fails to publish

Mitigation: use one text-keyed publication seam covering native and
programmatic state, plus explicit fixtures for speech, quote, queued edit,
recall, restore, and clear.

### Quote state updates still render the parent transcript

Mitigation: keep anchor state in a child quote layer. A hook called directly by
`MessageList` is not isolated merely because its subscription is conditional.

### Queued Edit overwrites a newly occupied composer

Mitigation: leaf subscription for paint plus a synchronous click-time
availability check.

### Cache initializes during SSR and never reads the browser value

Mitigation: storage-unavailable reads return the default without marking the
client snapshot initialized.

### Cross-tab preference or draft changes stop propagating

Mitigation: preserve real browser `storage` event handling and cover it
separately from unsupported same-tab raw writes.

### Immediate draft persistence is accidentally debounced

Mitigation: retain the current per-edit envelope write and lifecycle flush
tests. Optimize only redundant index/presence work.

### The full transcript DOM remains large

Mitigation: treat this as orthogonal. The default-on bounded semantic active
window remains the current safety mechanism. One tool-heavy retained turn can
still mount many rows, and future virtualization retains the scroll/search/
selection trade-offs in `topics/transcript-virtualization.md`. Composer
latency must not wait for that larger project.

## Non-Goals

- Changing streaming throttles, provider transports, session replay, or server
  catch-up behavior.
- Debouncing or weakening recovery-draft persistence.
- Moving composer text into the global client store.
- Making direct same-tab DevTools storage edits reactive.
- Solving transcript virtualization, scroll anchoring, or native-memory growth.
- Changing quote-comment or queued-message user-visible semantics.
- Adding a server capability or compatibility gate; this is entirely within
  existing client behavior.

## Completion Evidence To Record

When implemented, append:

- files and symbols changed per slice;
- focused/full check results and warning counts;
- before/after render, storage, script, layout, and commit measurements;
- desktop/phone matrix results;
- affected-Chromebook validation notes;
- any secondary autosize/tooltip work accepted or rejected by measurement; and
- remaining independent transcript-size risks.

## Implementation Evidence (2026-07-28)

### Landed slices

The work landed as a reviewable commit series:

- `780bfe12` adds the session-scoped composer draft signal and primitive edit
  availability store, removes draft text from `SessionPage` state and
  `MessageList` props, moves quote reconciliation into its narrow layer, and
  moves queue availability subscriptions into queued-action leaves. It also
  updates the rendering, quote-selection, and client-store contracts.
- `3a99f6e6` makes `createLocalStorageValue` a lazy cached external store,
  migrates tooltip mode/delay, and adds explicit invalidation plus the
  preference-store contract tests.
- `983e7a53` makes session and New Session draft presence event driven. Draft
  envelopes remain immediate; the index changes only on presence transitions,
  and the one-second draft-decoration polling loops are gone.
- `ab25e923` keeps preference snapshots hot across consumer remounts, routes
  cross-tab events through one shared listener, caches the legacy native
  hover-card delay, and moves the session performance settings snapshot onto
  the same storage interface.

The deterministic render probe in
`MessageList.rendering.test.tsx` mounts 1,000 historical rows. First-character,
ordinary, whitespace, newline, deletion, and final-clear draft publications
produce zero additional transcript commits.

### Storage shape

After a non-empty draft was primed, every measured session character performed:

- one read of only the session draft envelope;
- one write of only the session draft envelope;
- zero draft-index reads or writes; and
- zero rendering-preference reads.

New Session performed two reads and one write of only its draft envelope per
character. No measured character accessed tooltip, tool-preview, inline-media,
conversation-view, quote-mode, hover-delay, or session-performance preference
keys.

Before the final cache cleanup, delayed sidebar rendering exposed 432 reads of
the legacy hover-card delay in one update. The cached hover-card store reduced
that count to zero. Preference caches now remain cross-tab correct while no
React subscriber is mounted, so temporary consumer churn cannot make the next
render hit backing storage.

### Browser matrix

These are CDP development-build measurements against the already-running
server on port 3400. CPU throttling was applied before navigation. Each surface
was allowed four stable 500 ms DOM/render-row polls before measuring ordinary
non-empty-to-non-empty edits. Times are milliseconds per character.

| Surface | Viewport | CPU | Rows / elements | task median / p95 | script median | layout median | gets / sets |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| New Session | 1280×900 | 1× | 0 / 1,579 | 8.20 / 12.07 | 6.36 | 0.094 | 2 / 1 |
| short session | 1280×900 | 1× | 21 / 2,094 | 3.83 / 14.43 | 2.31 | 0.112 | 1 / 1 |
| long/tool-heavy session | 1280×900 | 1× | 316 / 8,460 | 5.05 / 7.19 | 2.21 | 0.154 | 1 / 1 |
| long/tool-heavy session | 375×812 | 1× | 316 / 7,505 | 4.70 / 5.89 | 2.20 | 0.160 | 1 / 1 |
| long/tool-heavy session | 1280×900 | 4× | 316 / 8,843 | 25.66 / 30.57 | 11.48 | 0.888 | 1 / 1 |
| long/tool-heavy session | 375×812 | 4× | 316 / 7,505 | 15.34 / 20.59 | 8.40 | 0.466 | 1 / 1 |

The desktop 4× row uses a 30-character follow-up run; its maximum task was
52.89 ms. The other rows use ten characters. Compared with the baseline, the
session result no longer scales by performing transcript commits or thousands
of preference reads per character.

### Secondary work decision

Textarea autosize was not changed. Its median layout cost was 0.094–0.160 ms
at normal speed and 0.466–0.888 ms at 4× throttling; it is not the remaining
material cost.

Tooltip suppression was also left unchanged. Causal isolation before
implementation found no material improvement when it was disabled. After the
render-boundary and preference fixes, no storage fan-out remains in that path.

### Checks

- focused composer, quote/queue, preference, draft-persistence, draft-index,
  summary-store, and session-cache tests pass without runtime warnings;
- full client suite: 311 files and 2,544 tests passed;
- `pnpm typecheck` passed;
- `pnpm lint` passed with zero warnings;
- `pnpm console:scan` remained at its existing 110/110 warning budget with no
  increase; and
- `git diff --check` passed.

The full suite still prints pre-existing diagnostic output from unrelated
speech, connection, sidebar, and floating-action-button tests. None originates
from the touched composer, storage, or draft paths, whose focused runs are
quiet.

### Remaining validation and independent risk

The reported lag occurred on a different Chromebook from the configured
ChromeOS device-streaming target. That target is not evidence for the affected
device, so the original Chromebook still needs a real-browser subjective
typing check.

Initial session catch-up can independently occupy the main thread while a large
transcript and sidebar are first settling. A deliberately unsettled 4× probe
observed a one-off task over one second; after settling, the 30-character 4×
run had a 30.57 ms p95. This is not draft-triggered work, but it can collide
with typing immediately after navigation. The retained transcript DOM also
remains large. Both belong to the existing transcript loading/windowing work
and are not reasons to reconnect composer text to the transcript.
