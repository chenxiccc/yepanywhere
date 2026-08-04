# Tooltip Noninterference and Hint Usefulness

> Preserve hoverable, persistent themed tooltips while making passive hints
> transparent to primary activation, and show hints only when they add
> information the visible interface does not already provide.

Topic: tooltip-interactions

Status: Planned. The complaint reproduces on current `main`; no behavior change
has been enacted. The governing contract remains
[`topics/tooltip-interactions.md`](../../topics/tooltip-interactions.md).

## Report and classification

The reported defect reproduces in default Themed mode. A tooltip appears 14
pixels down and right from the rested pointer, receives pointer events at the
frontmost application layer, and treats the trigger plus tooltip as one hover
region. If that surface appears over a card or button while the pointer is
approaching it, a primary click lands on the tooltip and never activates the
underlying control.

The Inbox examples expose a second defect family:

- `SessionListItem` places the session title on the whole card link's `title`.
  The redundancy check compares the hint with the card's complete text, which
  also includes project and age, so it misses the fully visible title inside
  the card.
- `InboxContent` gives the visibly labelled **Refresh** button the advisory
  title **Refresh inbox**. The extra noun does not add an instruction,
  consequence, shortcut, disabled reason, or state.

The title producers predate the themed default. Browser-native title bubbles
do not participate in page hit-testing, so the global conversion of legacy
titles into page-DOM tooltips made both old producers materially more
intrusive. The pointer-opaque tooltip behavior was added to keep tooltip text
selectable and stable while the pointer enters it; making Themed mode the
default exposed the collision to browsers without an explicit saved mode.

## Accessibility constraints

Do not solve the click defect by closing a tooltip as soon as the pointer leaves
its trigger. WCAG 2.2 success criterion 1.4.13 requires author-rendered hover
content to remain hoverable, persistent, and dismissible. A passive tooltip can
be pointer-transparent while its measured rectangle remains part of the hover
region; `event.target` is not the only possible source of that geometry. The
existing trigger-to-tooltip persistence and Escape dismissal remain part of
the contract.

Pointer opacity currently pays for text selection, contained scrolling of long
content, and secondary-click copy/enlarge. Full-text copy covers the selection
and close-reading need, so passive tooltips do not need selectable text. Keep
secondary-click copy/enlarge through geometric event handling. Capture wheel
input inside a long passive tooltip's measured bounds and scroll that tooltip
rather than the page beneath it, without changing primary hit-testing.
Click/keyboard-activated glossary definitions already express explicit reading
intent and may retain their interactive state. No new preference is justified.

A visible text label supplies a native button or link's accessible name. An
identical tooltip is not needed for that name. Icon-only controls still need an
independent programmatic name through visible text, `aria-label`, or
`aria-labelledby`; a pointer tooltip may remain for sighted discovery but must
not be the only accessible name. When its text equals the accessible name, the
tooltip layer should avoid announcing the same string again as an accessible
description.

## Target behavior

1. A passive tooltip opened by pointer hover is transparent only over its own
   active trigger. Primary, middle, and modified activation there retain native
   trigger semantics; the layer never synthesizes or forwards a click.
2. Moving the pointer into the visible tooltip rectangle continues to keep it
   open even though pointer events target the page beneath it. Underlying hover
   targets cannot replace the active tooltip while the pointer remains inside
   that rectangle.
3. If the tooltip covers an unrelated control, pointer activation is blocked
   and dismisses the tooltip. A visual overlay must never make an obscured,
   unrelated button or link activatable by surprise.
4. A control with a fully visible text label has no tooltip that merely repeats
   or lightly restates the label. Useful supplemental hints remain: hidden or
   clipped content, keyboard shortcuts, disabled reasons, consequences,
   dynamic state, paths/ranges, and explanations not already visible.
5. An icon-only control has a programmatic accessible name independently of
   any tooltip. A same-text visual tooltip is not also attached as a duplicate
   accessible description.
6. Secondary-click inside a passive tooltip's bounds retains the current
   full-text copy/enlarge behavior without making primary clicks opaque. Wheel
   input inside a vertically overflowing passive tooltip scrolls that tooltip
   and does not scroll the page beneath it. Glossary definitions activated by
   click, Enter, or Space may remain explicitly interactive. Native mode remains
   browser-owned.

## Ordered implementation

### 1 — freeze the reported card and button failures

Add one browser-facing regression fixture with a titled composite card and a
visibly labelled button. In default Themed mode, reproduce the 50-millisecond
rest, move toward the trigger, and click at the position the tooltip formerly
covered. Assert the intended card navigation/button action occurs exactly once.

Add focused `TooltipLayer` tests for the two independent causes:

- a hint matching a fully visible descendant is redundant even when the
  actionable ancestor also contains metadata;
- a genuinely longer title or clipped exact-text owner still reveals its full
  hint;
- primary, middle, and modified clicks at coordinates where a passive tooltip
  covers its own card/button/link reach that trigger with native semantics;
- the same events are blocked when the tooltip instead covers an unrelated
  button/link;
- moving from trigger into the tooltip rectangle and pressing Escape retain
  the current hoverable/persistent/dismissible behavior; and
- secondary-click over that rectangle copies/enlarges the full text without
  changing primary hit-testing;
- wheel input over an overflowing passive tooltip changes its internal
  `scrollTop` while leaving the underlying page fixed, including at the
  tooltip's scroll boundary.

Keep Native-mode assertions attribute- and activation-based; its browser
surface is not portable page DOM.

### 2 — make passive tooltips geometrically hoverable and click-through

Give the ordinary revealed tooltip a passive state with `pointer-events: none`.
Use its measured viewport rectangle before interpreting capture-phase
`pointerover`, `pointermove`, `pointerout`, `pointerdown`, `click`, `auxclick`,
`contextmenu`, or `wheel` events: coordinates inside that rectangle remain in
the active tooltip's hover region and cannot warm or switch to a titled element
geometrically underneath it. Leaving both trigger and tooltip rectangle keeps
the existing jitter and close-grace behavior.

The browser now hit-tests the actual page element. Permit primary, middle, and
modified event sequences only when the hit target belongs to the active tooltip
trigger; this preserves native link gestures, nested target behavior, and React
handlers without forwarding or synthesizing events. When the hit target is
outside the active trigger, prevent the covered pointer-down/click/auxclick
sequence before the unrelated element can focus or activate, then dismiss the
tooltip. Test press/focus state as well as final click callbacks so capture does
not leak a partial interaction. Retain a short pointer-id/button guard after
that dismissal until the matching click or auxclick completes; otherwise the
tooltip would disappear on blocked pointer-down and expose the unrelated target
to the rest of the same activation sequence. Keyboard-origin clicks with no
matching pointer sequence remain untouched.

Handle a secondary click inside the passive rectangle as explicit tooltip
intent even though `event.target` names the underlying page element. Preserve
the current exclusions for an existing selection and an already-handled app
context menu where appropriate, then copy and enlarge the full tooltip text.
The ordinary tooltip remains passive.

Handle wheel input inside an overflowing passive rectangle at document capture.
Normalize pixel/line/page delta modes, update the tooltip's own scroll position,
and prevent the hidden page from scrolling or chaining at either tooltip edge,
matching the existing `overscroll-behavior: contain` contract. A non-overflowing
tooltip does not consume wheel input. Explicitly activated glossary definitions
may keep normal element-owned scrolling.

Keep cursor-relative viewport placement for this correction. Non-obscuring
target-aware placement remains optional presentation polish after the scoped
pass-through regression is green; it is not the correctness mechanism and must
not replace the unrelated-control guard.

### 3 — attach session hints to the title owner

Move the session full-title hint from the whole `SessionListItem` link to the
element that renders and truncates the session title. A custom title that is
fully visible produces no hint; an original first turn that adds information,
or a title clipped by its own/ancestor/viewport bounds, retains the full hint.
Card metadata remains outside that comparison and outside the hint's hover
target.

Generalize exact-text suppression only enough to recognize a measurable exact
descendant owner inside a composite target. If no exact owner exists, do not
infer redundancy from partial string similarity. Unmeasurable or clipped
owners keep the hint. This is the compatibility boundary for legacy producers,
not a replacement for attaching new hints to the element that owns the text.

### 4 — remove duplicate labelled-control hints

Remove `InboxContent`'s **Refresh inbox** title while keeping the visible
**Refresh** label as the accessible name. Then inventory production JSX
buttons and button-like shared components; a preliminary syntax scan found 219
intrinsic `<button title=...>` producers and fixtures, so this must be a
classified audit rather than a blanket deletion.

For each producer, record one disposition:

- remove: the title repeats or lightly restates a persistent visible label;
- keep as supplemental description: shortcut, consequence, disabled reason,
  dynamic state, or other additional information;
- keep as visual icon hint: the control has no persistent text, after proving
  an independent accessible name exists; or
- retarget: the hint belongs to a clipped/path/value descendant rather than the
  whole actionable container.

Cover shared button primitives first so consumers inherit one decision. Avoid
changing tooltip copy merely to make a duplicate look different; if the extra
words carry no user decision, delete the hint.

### 5 — separate visual hints from duplicate descriptions

When `TooltipLayer` associates the visible tooltip through
`aria-describedby`, first compare its normalized text with an explicit
`aria-label` and the trigger's fully visible text owner. Skip only the duplicate
description association; keep the visual icon hint and the trigger's accessible
name. Supplemental tooltip text continues to be associated as a description.

Test keyboard-visible focus with an accessibility-tree assertion for each
case: visible-label button, icon-only same-text hint, and genuinely explanatory
hint. Do not use `title` as the sole accessible name in any migrated producer.

### 6 — verify interaction, accessibility, and presentation

Run the focused tooltip, `SessionListItem`, Inbox, and shared-button suites,
then `pnpm lint`, `pnpm typecheck`, `pnpm i18n:scan`, `pnpm console:scan`,
`pnpm css:check`, and `pnpm css:touched` as applicable. All checks and test
runs must finish without warnings.

Against a fresh isolated dev server, inspect 1920x1080 and 375x812 captures.
Desktop coverage includes the Inbox card, Refresh button, a clipped title, an
icon-only control, each viewport-edge placement, keyboard focus, and pointer
movement into passive tooltip text. Include an overflowing tooltip whose wheel
scroll changes only the tooltip. Phone coverage confirms taps never leave an
ordinary tooltip over the post-activation view. Record hit-target and scroll
assertions in the browser test rather than treating screenshots alone as proof.

## Suggested commit slices

1. passive click-through geometry plus the activation/hoverability regressions;
2. session-title ownership and exact-descendant compatibility;
3. Inbox Refresh plus the first coherent labelled-button audit;
4. remaining shared-button producer dispositions and accessibility-tree
   coverage.

Use `Topic: tooltip-interactions` throughout the series. Keep broad producer
cleanup split by coherent product surface so each commit remains reviewable.

## Done condition

With Themed mode active, the supplied Inbox interaction no longer produces a
tooltip for the fully visible session title or Refresh label. A useful tooltip
for a clipped title or icon-only control is passive: its own trigger retains
native primary/middle/modified activation, unrelated controls beneath the
tooltip remain protected, and moving into its visible bounds does not dismiss
or replace it. Secondary-click still copies/enlarges the full text; a wheel over
long content scrolls the tooltip without scrolling the page. Native mode is
unchanged, and keyboard/screen-reader users receive one accessible name plus
only genuinely additional descriptions.
