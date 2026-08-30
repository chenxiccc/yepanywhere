# Selection Comment UI

> Select a span of agent output and turn it into a `>` blockquote in the
> composer, so a follow-up turn can comment on a specific passage. The quoted
> source keeps a subtle green tint until that quote is removed from the composer
> or the turn is sent, so you can see what you have already pointed at.

See also:

- [`ui-architecture.md`](ui-architecture.md) — render-boundary principle: the
  tint and the per-paragraph controls attach to the block renderer that owns
  the source, not to post-rendered DOM.
- [`composer-rich-input.md`](composer-rich-input.md) — the composer is a
  `<textarea>` + overlaid mirror; that bounds how the quote lands and forces
  the tint↔draft link to be reconciled against a plain string, not real nodes.
- [`session-ui-customization.md`](session-ui-customization.md) — whether the
  per-paragraph quote circle is always-on or a hideable/optional control.
- [`source-review-to-session.md`](source-review-to-session.md) — generalizes this
  quote-comment into a click-a-diff-line source-control review that accumulates
  comments across commits/revisions and submits them all as one new session.

Topic: selection-comment-ui

Status: **Phase 1 shipped 2026-06-23; the two early contract gaps fixed
2026-06-23; the dedicated assistant quote lane fixed 2026-06-25; initial
Phase 2 scope widening shipped 2026-07-01; portaled modal/file scope shipped
2026-07-27; pressed-pointer tooltip suppression landed 2026-08-10; stable
selection actions and independent controls landed 2026-08-12; selected-text
context actions and source-cited new-session transfer landed 2026-08-13;
exact formatted-source selection and activity-overlay placement landed
2026-08-14; mobile long-press selection ownership restored 2026-08-15;
session-file Markdown block clicks and live-drag deferral landed
2026-08-20; viewer toolbar select-all landed 2026-08-22; collapsed-preview
selection and live-tail suspension landed 2026-08-23; session-file inline
Comment mode landed 2026-08-25; selection-event coalescing and file-viewer
reselection landed 2026-08-28; transcript and registered-surface reselection
landed 2026-08-29.**
Assistant text blocks can be quoted via selection typing, a floating selection
`>` action, or per-paragraph `>` circles; the resulting `>` block is inserted
into the composer and the selected source span is tinted until that quote is
removed or sent. A selected range also exposes a full copy/quote/new-session
context menu and independently configurable compact actions. Thinking
summaries, user turns,
Ran/Bash command and output text, Grep preview/content text, recap rows,
expanded Edit/Read file content, general file viewers, and session hovercard
prompt/reply text now use the same selection pipeline. Right-mouse line-select
and per-section quote lanes for non-assistant-prose surfaces remain
design/follow-up work.

## Resolved gaps (Phase 1)

The early Phase 1 gaps were fixed 2026-06-23, verified in the running app.

- **Floating `>` button on small/partial selections — fixed.** The button did
  appear for short selections, but was mispositioned: it is placed (top/left)
  relative to the `.message-list` rect in JS, yet `.message-list` was
  statically positioned, so the absolute `.selection-quote-button` resolved
  against a farther positioned ancestor and landed in the centering margin —
  next to a short selection it sat far left, reading as "no button." The
  originally-predicted cause (the copy path's coverage-equality gate in
  `extractMarkdownSnippetsFromSelection`) was wrong: browser repro confirmed the
  extractor returns snippets for short selections. Fix: `position: relative` on
  `.message-list` so the JS offsets match the button's containing block.
- **Circles per text block, not per paragraph — fixed.** `TextBlock` now
  renders an overlay rail (`.text-block-quote-rail`) with one circle at the end
  of each top-level rendered block (paragraph / list / heading), each quoting
  just that block via `getMarkdownSnippetForSubElement` — which recovers the
  block's source span through the same `getMarkdownForVisibleSelection` map the
  copy/selection path uses. The whole-block circle stays as a fallback when no
  paragraphs are measured (e.g. while streaming). Circles keep the existing
  hover-reveal and Appearance always-show behavior; the rail never intercepts
  pointer events, so text selection is unaffected.
- **Dedicated right-side quote lane — fixed.** The per-paragraph `>` circles now
  live in a reserved right-side rail beside assistant prose, with the ordinary
  copy/render controls to its left. Assistant text no longer renders underneath
  the paragraph reply affordance, and the quote rail stays visually separate
  from the scrollbar-side turn notches.
- **Subtle comment tint — fixed 2026-06-25.** The source anchor paint is a
  transparent green `background-color` rather than a saturated wash. It must
  stay visible but quiet in both dark and light themes, and it must not depend
  on undefined theme tokens such as `--bg-primary`.
- **Selection action placement avoids the range — fixed 2026-08-12.** On
  desktop, the complete enabled action cluster uses range geometry to choose
  after, before, below, or above the selection according to available space;
  the drag endpoint is the fallback when the browser supplies no usable range
  rectangle. Touch uses 44 px tap targets. Transcript selections dock the
  cluster in a dedicated row above the composer, shrinking the transcript
  viewport instead of covering its text; portaled modal selections use the
  collision-aware local placement. A pointer drag does not render or reposition
  the cluster while the button remains pressed; the final range produces one
  stable placement after release. Presses on the cluster itself remain exempt
  so its controls can consume their preserved selection snapshot. Non-pointer
  range-change bursts place the first position immediately, then discard
  intermediate positions and place at most the latest range once per bounded
  interval. Resize and scroll bursts follow the same leading/latest cadence
  instead of queuing one placement for every browser event.
- **Activity-detail placement uses the selected range — fixed 2026-08-14.**
  For a selection inside a tall expanded Bash/Edit/Read-style detail surface,
  the below/above candidates and fallback-space ranking are anchored to the
  selected range. The full registered source bounds remain the collision
  inventory, never a surrogate selection anchor.
- **Formatted source carries exact selection offsets — fixed 2026-08-14.**
  Syntax-highlighted file viewers annotate every aligned Shiki line and token
  with absolute source offsets. Forward, reverse, cross-token, cross-line, and
  soft-wrapped selections therefore recover the exact authored span in reading
  order for visible-text copy, source copy, quote reply, source-line citation,
  and comment tint. While a quote anchor is live, a scoped mutation observer
  re-resolves its CSS highlight if React replaces the highlighted descendants;
  no observer runs without live anchors.
- **Paragraph quote buttons tint the quoted paragraph — fixed 2026-06-25.**
  Paragraph and whole-block quote actions create text-node-backed highlight
  ranges and re-resolve them when a composer update replaces rendered markdown
  text nodes, so clicking a paragraph `>` leaves the same source-anchor
  indication as a manual selection quote.
- **Quote insertion is undoable — fixed 2026-06-25.** Selection and paragraph
  quote actions route the composer append through the textarea range edit path
  when available, so one `Ctrl-Z` removes the inserted quote text and lets anchor
  reconciliation clear the source tint.

## Vocabulary

- **Quote-comment** — the action: a selected span of agent output becomes a
  `>` blockquote appended to the composer, and focus moves to the composer.
- **Comment anchor** — the persistent association between one inserted quote
  block and the source span it came from. Tracked in a per-session list.
- **Comment tint** — the subtle green paint on an anchored source span.
- **Quote circle** — the circled `>` affordance that triggers quote-comment.
  Two placements: floating next to a live selection, and one per paragraph.
- **Selection action cluster** — the non-obscuring row of enabled circles for a
  live selection: neutral copy icon for visible text, blue `</>` source copy,
  purple `Aa` rich copy, green `>` quote reply, and green `+` new session.

The vernacular here is GitHub's "quote reply" (`>` blockquotes), which is the
mental model the feature was requested under.

## What the user sees (contract)

Five quote entry points, one quote action. A live selection also owns one
shared action snapshot consumed by its compact action cluster and full context
menu.

1. **Type over a selection.** With a non-collapsed selection inside agent
   output and focus *not* already in a text field, the first printable
   keystroke: appends the selection as a quote block to the composer, moves
   focus to the composer, and that same keystroke becomes the first character
   of the comment typed below the quote.
2. **Action cluster near a selection.** Enabled circles appear beside a live
   selection without covering it. The green `>` focuses the composer (raising
   the soft keyboard on touch) and runs the same quote-comment. Optional
   copy, `</>`, `Aa`, and `+` actions copy visible text, copy source, copy
   semantic rich text, or open a same-project new-session composer. A control
   press preserves a snapshot of the selected source snippets and DOM ranges,
   so the action remains valid when the native highlight collapses during the
   press. The cluster never replays intermediate positions from a burst of
   selection, resize, or scroll events; it reflects the latest usable range.
   A primary mouse drag beginning in an existing read-only registered selection
   clears that old range before the browser chooses its text-drag path, so the
   press starts a fresh selection. Editable controls retain native selected-text
   dragging for moving text within the composer or another field.
3. **Context menu over selected text.** Right-clicking inside a non-empty,
   registered selection opens direct **Copy text**, **Copy source**, **Quote
   reply**, and **New session** rows, omitting actions whose destination is not
   available. This full menu does not depend on which compact bubble actions
   are enabled. A right-click outside the selected range retains its ordinary
   browser or component-owned behavior; project-path menus remain authoritative
   over their links. Touch and pen long-press remain browser-owned so native
   text selection and its adjustment handles keep working. Purpose-specific
   interactive targets such as project-file links may retain their own
   documented long-press or context menu; the selected-text menu does not claim
   those events. A device reporting a coarse primary pointer keeps every
   selected-text context-menu event browser-owned, including legacy or
   compatibility events with a missing or mouse-like pointer type.
4. **Per-paragraph quote circle.** Each agent paragraph/block carries a circled
   `>` at its end. Default visibility is hover-revealed on desktop, like the
   existing copy and render-toggle buttons in `text-block-actions`
   (`components/blocks/TextBlock.tsx`). An **Appearance** option — "always show
   quote circles" — switches them to always-visible; this is what makes them
   usable on touch (no hover) and is also offered on desktop for users who want
   them shown without moving the mouse near. Clicking quotes that paragraph.
   Its tooltip points the user at the finer path:
   highlight text — or right-drag
   to select lines (see the line-select helper below) — to comment on a specific
   sub-range instead of the whole paragraph.
5. **Rendered session-file reply affordances.** A rendered Markdown file in a
   session viewer uses the same quote-reply button mode as transcript prose:
   block-only shows the whole-document `>` circle, paragraph-hover reveals one
   circle per top-level rendered block, and paragraph-always keeps those
   circles visible. Activating a circle quotes through the same source-aware
   reply pipeline. Long previews keep circles live only for visible blocks,
   then follow the viewer scroll so every block receives the same control when
   reached. Responsive width changes and asynchronous preview enrichment keep
   those controls aligned without dismissing the viewer.
   Ordinary primary clicks only focus or select viewer content; neither the
   paragraph layer nor selection actions may turn that click into a quote or
   composer focus transfer. Links and other interactive controls retain their
   own actions. A primary mouse drag that begins inside an existing viewer
   selection starts a fresh native text selection rather than dragging the old
   selected text.

### Session-file Comment mode

A private, session-owned textual file modal with a live destination exposes a
top-bar **Comment** toggle. It is default-off and is absent from standalone,
public-share, binary, HTML-preview, and diff projections. With Comment off,
the rendered-file reply affordances above remain the complete click contract.

With Comment on:

- whole-document and paragraph `>` circles are suppressed; ordinary source
  line clicks open the Source Control inline editor at `path:line` with up to
  three neighboring lines on either side;
- selecting rendered or source text opens that editor with the exact
  source-aware quote and `path:line` or `path:start-end` when the mapping is
  known. Independently enabled selection-copy, source-copy, rich-copy, and
  new-session bubbles remain available, while **Quote reply** and
  type-over-selection quote insertion are suppressed so one selection cannot
  start two comment workflows;
- **Cancel** removes the active editor, including an untouched empty editor.
  Opening a different anchor also discards the prior active editor when it is
  empty, but retains it as a draft when it has text;
- `Enter` sends the active nonempty comment immediately to the current session;
  `Shift+Enter` inserts a newline. This send does not clear, submit, quote,
  attach, or otherwise consume the main composer state. The editor remains
  editable during the request; success clears only the submitted snapshot, so
  text changed while that request was in flight remains as an unsent draft;
- editor blur saves nonempty drafts in browser-local storage scoped by source,
  session, project, and file. Moving focus outside the viewer, minimizing or
  closing it, or turning Comment off sends all remaining nonempty drafts in
  one turn, in creation order, separated by `---`; and
- each sent item contains only its location, `>`-quoted source, and the
  reviewer comment/question. It deliberately omits Source Control review
  boilerplate and durable review-site metadata. A failed send leaves the draft
  stored and shows the failure inline so it can be retried.

The editor shell and source-splitting layout are the same components used by
Source Control comments. Session-file comments intentionally have a smaller
turn grammar and browser-local lifetime: they are direct session messages, not
entries in the durable Source Review accumulator.

The **Appearance** rows immediately after `> Reply Buttons` separately control
selection quote, visible-text copy, source copy, rich copy, and new session.
Each row shows the actual enabled circle in its final color and style next to
its caption, description, and toggle. Selection quote remains on by default to
preserve the established behavior; the four additional circles are
default-off. Disabling selection quote also disables the type-over-selection
trigger, but does not affect the paragraph reply-button mode. Hiding the source
copy circle never changes the default source-aware `Ctrl/Cmd+C` behavior or the
complete context menu.

**Source means pre-render input, not Markdown specifically.** A registered
renderer supplies the authored representation it transformed. For prose this
is usually Markdown; for rendered math it includes the original delimiters and
TeX expression; for fixed-font and tool content it may be plain source text.
When YA cannot align a transformed sub-range confidently, copy/quote falls back
to selected visible text and never invents source syntax.

**New-session transfer.** Transcript selections prefill the same-project
composer with the selected text as a `>` blockquote. A file-viewer selection
prepends `project/relative/path:line` or `:start-end` when every selected source
span maps unambiguously to one file. Repeated or structurally transformed text
without a reliable source offset still transfers the quote but omits the line
citation. A session-owned modal also keeps **Quote reply**; a standalone file
viewer has copy and new-session actions but no current-session quote target.

The quote block itself:

- Each source line is prefixed `> `. A selection spanning multiple blocks
  yields one `> ` block per source block, blank-line separated (the existing
  copy path already splits per source element and joins with `\n\n`).
- A highlight crossing consecutive or alternating eligible text regions yields
  one quote block per eligible region, in document order. Ineligible UI chrome
  between them — tool names, local status labels such as the generated "Ran"
  row label, buttons, timestamps, separators, collapsed-preview controls — is
  ignored and must not cancel the quote action.
- Eligible text is transcript/content text explicitly registered by the
  renderer. For tool rows, the Bash/Ran command text and rendered command/output
  bodies are eligible; locally generated row labels and controls are not unless
  a renderer deliberately registers them as content.
- A registered selection may live in the transcript or in a portaled modal or
  session hovercard opened from that session. Reusable modals establish a
  quote-selection root, while their file/text renderers register the actual
  source. The floating actions render inside the owning surface and the `>`
  sends the quote to the session composer. A session file viewer leaves that
  composer visible directly below its reading region; other modal surfaces may
  still place it behind the modal. Modal headers, buttons, labels, and other
  unregistered chrome remain ineligible.
- Textual file viewers and expanded activity details expose **Select all** in
  their top toolbar. It and viewer-scoped `Ctrl/Cmd+A` create a native range
  across the content body, which publishes through the same
  `selectionchange` path and therefore shows the ordinary floating selection
  actions. An input, textarea, select, or editable region keeps native
  `Ctrl/Cmd+A`; a viewer that does not own focus does not intercept it. The
  floating controls mount outside the content-owning render subtree, so their
  appearance and pointer hover must not remount that content or collapse the
  native selection before an action is reached. An expanded activity detail
  retains the content instance captured when it opened until it closes; live
  transcript/source rerenders neither refresh that detail nor displace a range
  inside it.
- While a primary pointer is dragging a selection, selection controls remain
  absent and do not chase the changing range. After pointer-down clears any
  prior controls, intermediate `selectionchange` events do no React state work.
  Pointer release publishes the completed range once, including for upward
  drags. Keyboard and programmatic selections still publish from
  `selectionchange`, and pressing an already visible selection control does not
  dismiss it before its action fires. Resize and scroll events only reposition
  a still-usable native range; if the browser drops that range without a
  `selectionchange`, they retain the captured action snapshot. A
  `selectionchange` that reports no usable range, or an explicit dismissal,
  owns removal.
- In a collapsed textual activity preview, a non-collapsed native selection
  wins over click-to-expand. Forward and upward drags both leave the detail
  closed and preserve the selected text for copying. Forming a transcript
  selection also suspends live-tail following before later output or layout
  changes can move the viewport under the gesture; explicit **Follow** resumes
  it.
- Hover tooltips never activate while any pointer button is held. In
  particular, dragging a native text selection across a glossary term keeps
  the glossary text selectable and cannot insert a passive tooltip into the
  gesture; the definition remains available after the button is released.
- If the composer already holds text, two blank-line-separated newlines come
  first — this is exactly the existing `appendComposerTransferDraft` rule, not
  a new one.
- After insertion the caret sits after the quote, on a fresh line below it,
  ready for the comment.

After a quote-comment fires, the live selection is cleared and the source span
gets the comment tint.

**Tint lifecycle — the anchor list.** Each quote block has a matching anchor,
hence a tint:

- A tint clears when its quote block is removed from the composer — concretely,
  when none of that block's `>`-prefixed lines remain in the draft (the user
  deleted the quote). Editing words *inside* a surviving `>` line keeps it.
- All tints clear when the turn is sent.

Additional quote-comments add more anchored ranges to the same tint. Clearing all
matching `>`-prefixed quote lines from the composer, or sending the turn, clears
all corresponding tints.

The draft reconciler is edit-metadata-gated: with no live anchors it does
nothing, and with live anchors it skips ordinary textarea edits that cannot
touch a quote-prefixed line. When reconciliation is needed, the composer draft's
`>` line signatures are computed once and reused across all anchors.

## Reuse map (mostly assembly, not new machinery)

The genuinely hard parts already exist for copy-selection-as-markdown and the
`/btw` composer transfer. This feature wires them to a second consumer.

- **Selection → markdown source.** `getMarkdownForVisibleSelection(source,
  selectedText, { textBefore })` in `lib/markdownSelectionCopy.ts` already maps
  a rendered selection back to its markdown source, and every agent text block
  registers its source via `registerMarkdownCopySource` (TextBlock).
  `copyMarkdownSelectionToClipboard` already walks the
  `[data-markdown-copy-source]` elements a selection crosses and joins per-block
  snippets with `\n\n`. Factor the snippet extraction out of the clipboard
  writer into a shared `extractMarkdownSnippetsFromSelection(root)` returning
  the per-block snippets plus their source elements/ranges; copy and
  quote-comment both call it. (Render-boundary principle: extend the generator,
  do not post-process the DOM.)
- **"Two newlines if the composer is non-empty."** `appendComposerTransferDraft`
  in `pages/SessionPage.tsx` *is* this rule, already used by the `/btw`
  transfer. Quote insertion = `appendComposerTransferDraft(getDraft(),
  quotedBlock)`.
- **Transfer-into-composer precedent.** `transferBtwTurnToMotherComposer` /
  `applyMotherComposerTransfer` push text up through `draftControlsRef` (a
  `DraftControls` from `useDraftPersistence`) into the Mother composer,
  including the "composer not mounted yet → stash pending" case. Quote-comment
  follows the same shape.
- **Caret placement + range reconciliation.** `lib/textareaSelection.ts`
  (capture/restore helpers) and the speech-commit reconciliation in
  `lib/speechDraftTransaction.ts` are the precedent both for "mutate the draft
  string, then place the caret deterministically" and for "track a range
  through later edits" — the exact shape the tint↔draft reconciliation needs.
- **Source↔visible mapping for painting tint over rendered markdown.**
  `buildVisibleSourceMap` (same file) maps source offsets ↔ visible text, which
  is what turns a stored source range back into a paintable DOM range.

Net new code: the keystroke-capture trigger, the quote circles, the anchor
list + tint paint + reconciliation, and the right-mouse line-select helper.

## Where state lives

`MessageInput` owns the complete composer string. `SessionPage` owns only a
stable session-scoped draft signal and passes that unchanged object to
`MessageList`; publishing a character does not set parent React state or change
a transcript prop.

The selection pipeline has three typed owners behind the stable
`useSelectionActions` composition hook:

- `useSelectionQuoteAnchors` owns quote insertion, comment anchors, draft
  reconciliation, mutation observation, and CSS Custom Highlight updates. It
  subscribes to the draft signal only while at least one anchor is live.
  Ordinary edits marked unable to affect quote-prefixed lines return before
  signature parsing. A relevant edit computes signatures once, drops missing
  anchors, and updates the highlight registry without rendering historical
  rows.
- `useSelectionActionCapture` owns selection snapshots, geometry and placement,
  global selection/pointer/resize/scroll listeners, native source-aware copy,
  and coarse-pointer transcript shielding.
- `useSelectionActionPresentation` owns preferences, action dispatch, the full
  selected-text context menu, mobile docking, local-surface portals, and the
  action-cluster React presentation.

The owners exchange immutable typed snapshots and a boolean quote-application
result. They do not share each other's mutable refs or listener lifecycles.

The submit path still clears all anchors next to the existing
`draftControls.clearDraft()` calls — that is the send seam.

Persisting anchors alongside the draft (shared lifecycle, shared localStorage
namespace) would let a reload that restores the draft also restore the tint.
Follow-up, not v1.

## Cruxes / hard parts

## Unfulfilled UI contract gaps

The shipped phase fixed basic quote-comment insertion, but several requested UI
contracts remain open:

- **Right-click/right-drag paragraph selection.** Selecting whole paragraphs (or
  line/block ranges) by right-click-dragging was part of the intended advanced
  selection path. It is not yet implemented. The gesture should feed the same
  quote-comment action as ordinary text selection, producing a range that maps
  back to source markdown rather than a DOM-only scrape.
- **System output quote lane when Phase 2 widens scope.** The assistant
  paragraph lane now exists; when quote buttons are added to system output,
  thinking summaries, or tool sections, they should use the same reserved-lane
  contract rather than overlaying output text or adjacent controls.

These are UI-surface obligations for the same quote-comment primitive; do not
build a parallel quote path for them.

### Tint paint over rendered markdown

The recovered range is a DOM `Range` clipped to the registered markdown source
element. YA registers one CSS Custom Highlight API highlight under
`::highlight(comment-tint)` and adds every live anchor range to it. It paints
without mutating the DOM, so it does not fight React re-renders or the
streaming-markdown container swaps inside `TextBlock`.

Robustness is **best-effort by design**: the tint is a reminder of what you
quoted, not load-bearing. Each transcript anchor records its render id and its
registered copy-source index. While that anchor is live, the transcript render
window retains the owning semantic row as a sparse island; if React replaces
the source element, the descriptor re-resolves it in the remounted row. Exact
source-offset anchors resolve the original occurrence even when the same text
appears elsewhere. The source-mode
`<pre className="text-block-source">` case is trivial — wrap the offset range
directly.

### Keystroke capture

A capture-phase `keydown` on the message-list root, firing only when: a
non-collapsed selection lies within registered copy-source elements; focus is
not already in an input/textarea/contenteditable; and the key is a bare
printable character (`key.length === 1`, no Ctrl/Meta/Alt). On match,
`preventDefault`, run quote-comment, focus the composer, and append the typed
character to the draft ourselves — the original event will not be redelivered
to the newly focused textarea. Ctrl+C is not a bare printable key, so it still
routes to the existing `copy` handler in `MessageList`; no conflict.

### Clearing attribution (which anchor owns which `>` lines)

On each draft change, reconcile anchors against the draft. Recommended
heuristic: an anchor is live while at least one of its quoted lines still
appears as a `>`-prefixed line in the draft, matched on the first quoted line's
content signature so an anchor that was edited or moved is still found. Exact
line-range tracking through arbitrary edits is fragile (the speech range-mapping
work shows why); a content-signature match is good enough for a reminder tint.

## Right-mouse line-select helper (ancillary)

A general selection enhancement in agent output that feeds the same quote
pipeline. In areas with no more specific context menu:

- Hold the **right** mouse button and drag past a small threshold → begin
  line-granularity selection (snap each selection end to a line boundary), and
  suppress the context menu for that gesture.
- Right-click without dragging past the threshold (a "click") → normal context
  menu; do not suppress.
- Double right-click → select the enclosing paragraph.

Implementation outline: a `pointerdown(button === 2)` → `pointermove` →
`pointerup` state machine on the message-list container, plus a `contextmenu`
handler that `preventDefault`s *only* when a line-drag actually started this
gesture. Hit-test pointer → caret with `caretPositionFromPoint` (standard) /
`caretRangeFromPoint` (WebKit fallback), then expand each end to its line.
"Line" can mean a visual line box (`Range.getClientRects`) or a source line;
prefer visual line boxes so the selection matches what the user sees.

Coordinate with the existing container `pointerdown` listener in `MessageList`
(scroll-follow) so neither breaks the other, and never interfere with normal
left-button text selection.

**Platform risk to validate on Linux first:** `contextmenu` timing (press vs
release) and whether suppressing it mid-gesture is reliable across Chromium and
Firefox. This is the fiddliest part of the whole feature and is therefore Phase
3; prototype it behind a flag before committing to it. The keystroke and
quote-circle paths do not depend on it, so it can ship later without holding up
the rest. Where the gesture is known not to mesh with a platform's native
context-menu behavior, disable it outright there (feature-detect / platform
gate) rather than ship a half-working right-drag — the per-paragraph circle
already covers whole-paragraph quoting on those platforms.

## Phasing

- **Phase 1 — core quote-comment over assistant text.** Shipped 2026-06-23:
  keystroke trigger, floating selection quote circle, hover circles
  (hover-default + Appearance "always show"), quote insertion, and selected-span
  comment-anchor tint with draft reconciliation. Scope is assistant text blocks,
  matching the existing copy-source scope. The two early gaps (small-selection
  floating button, per-paragraph vs per-block circles) were fixed 2026-06-23 —
  see *Resolved gaps*.
- **Phase 2 — widen quotable scope.** Extend the same selection→quote pipeline
  to edit diffs, any outline-expanded text (including expanded Read contents),
  user turns, thinking summaries (see below), and other rendered agent output.
  Each surface needs a registered markdown/text copy-source so the shared
  extractor can recover its source; the pipeline itself does not change.
  Initial scope widening shipped 2026-07-01 for thinking summaries, user
  prompts, Bash/Ran command text, fixed-font tool output after ANSI stripping,
  Grep preview/content text, and recap rows. The extractor now returns every
  eligible source snippet a selection intersects, so a drag crossing
  user/assistant/tool/system regions produces separate blank-line-separated
  quote blocks while skipping unregistered UI chrome.

  Portaled scope widening shipped 2026-07-27. Expanded Edit and Read file
  content, full file viewers, and session hovercard prompt/reply text register
  their source with the same extractor. Reusable modal roots let the active
  session's copy, selection-typing, and floating-`>` controller follow that
  registered text across the portal without creating a second quote path.

  Exact syntax-highlighted source alignment shipped 2026-08-14. The file
  viewer carries source offsets through Shiki's block-per-line DOM and uses one
  mapping for extraction, citation, and persistent tint recovery. This is the
  source-code path; it does not claim alignment for structurally rendered
  Markdown.

  **Exact rendered-Markdown alignment remains follow-up work.** File viewers
  and expanded Read/Edit Markdown currently register the original source, so
  the shared extractor best-effort matches a visible selection back to that
  source and preserves simple whole-block markers such as `#` and list
  bullets. Ambiguous repeated text, renderer normalization, and selections
  crossing structurally transformed blocks can still be inexact. A general
  aligned Markdown renderer should carry token/source offset spans into the
  rendered DOM, then make that one mapping serve quote reply, semantic copy,
  comment tints, and line/range targets. Until then, falling back to the
  selected visible text is the v1 contract; never invent Markdown structure.

  **Thinking summaries — quote while streaming *or* finished.** We want to
  select and comment on a thinking-summary item even mid-stream, not only once
  it settles. This is the one Phase-2 surface whose source is *live*: a
  streaming thinking summary keeps growing/rewriting, so the comment anchor
  cannot track a moving source the way it tracks a settled block. Snapshot the
  quoted text at quote time (the `>` block is a frozen copy regardless), and
  either drop the tint when the underlying streaming text mutates out from under
  the range or re-resolve it best-effort against the latest text. The quoted
  composer content is unaffected either way; only the tint is at risk.
- **Phase 3 — right-mouse line-select helper.** Below; intentionally last
  because it is the fiddliest and the rest does not depend on it. May be
  disabled outright on platforms where the gesture does not mesh with native
  context-menu timing.

## Decisions

- 2026-08-15 — **Selection behavior has three lifecycle owners behind one
  composition hook** (vs. one hook owning anchors, global capture, and React
  presentation): each owner can be exercised independently while callers keep
  the existing `useSelectionActions` contract.

- 2026-06-23 — **Tint paint = selected-span CSS highlight.** V1 keeps a list of
  live anchor ranges and paints them with `::highlight(comment-tint)`; the tint
  is a reminder, not load-bearing.
- 2026-06-23 — **Per-paragraph circle = hover-default, Appearance toggle for
  always-show.** The always-show mode covers touch (no hover) and is also a
  desktop option. Lives in the Appearance settings pane.
- 2026-06-23 — **Scope is phased** (assistant text first; see Phasing).
- 2026-06-23 — **Right-mouse line-select is a later phase** and may be disabled
  on known-incompatible platforms.

## Still open

- **Anchor persistence across reload** (follow-up; tint re-attaches to a
  restored draft).

## Prototype proposals

- **Hover replied-to area → show follow-up text.** When a quote block has
  non-`>` comment text following it in the composer, hovering the tinted source
  anchor could show that reply text in a tooltip. This is not a committed
  behavior yet: it needs draft parsing that maps each quote block to the
  following non-quote paragraph as the draft changes, and it must avoid turning
  every subtle source tint into persistent tooltip clutter.

## Default-preserving note

Quote-comment is purely additive — a new trigger, new buttons, a new tint — and
changes no existing default, satisfying the YA "UI changes preserve non-buggy
defaults" rule. The per-paragraph circle stays hover-revealed (desktop) by
default and only becomes always-visible when the user opts in via the Appearance
"always show quote circles" setting; even then, keep it as unobtrusive as the
existing `text-block-actions` buttons.

This is a client-only feature (composer + transcript rendering); no server
change, so no `reyep` restart is needed to exercise it during development.
