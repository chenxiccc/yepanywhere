# Tooltip Interactions

> Tooltips use one browser-level appearance and timing preference while keeping
> ordinary hints compact, keyboard-accessible, and fast to scan once one has
> deliberately opened.

Topic: tooltip-interactions

## Modes and settings

Appearance presents `Themed` and `Native` as an explicit two-way style
selector. The delay slider and number field remain visible beside that selector
in the same row:

- `Native` is the default when the browser has no explicit saved mode. It leaves
  ordinary `title=` tooltips to the browser, including the browser's timing and
  colors. YA must not describe that timing as a numeric preset because it is
  controlled by the browser/OS.
- `Themed` renders YA's tooltip layer with the active theme. Its initial delay
  is 50 ms.
- Explicitly saved `Native` and `Themed` choices remain authoritative across
  default changes.
- Moving the slider or entering a valid number selects `Themed`. Temporarily
  deleting the number while editing neither changes mode nor commits a delay.
- The mode and delay are portable browser preferences. The retired session
  hover-card delay seeds the shared delay at one third of its stored value when
  the new delay is absent, preserving that card's prior timing. Committing or
  resetting the shared delay removes that retired value and invalidates its
  same-tab cache immediately; returning to Native mode cannot resurrect the
  retired card delay until reload.

## Scope of the mode

`Native` and `Themed` select the renderer for ordinary text hints. This includes
static control labels as well as YA-computed text such as clipped commands,
hidden output tails, elapsed times, and concise file paths:

- In `Native`, the target owns a `title` and the browser/OS owns presentation,
  timing, placement, dismissal, and input behavior.
- In `Themed`, the target owns `data-tooltip` and YA renders the text in the
  document. This permits a configurable delay, immediate scanning between warm
  targets, stable placement during app scroll, selectable text, and
  secondary-click copy/enlarge behavior.

Themed tooltips therefore aim to preserve the basic semantics of native hints—
supplemental, nonessential information opened by pointer hover or
keyboard-visible focus—but they are not merely recolored native bubbles with a
delay setting. The extra interaction behavior is intentional and must remain
optional.

Some YA-rendered hover surfaces cannot meaningfully become native tooltips and
remain custom in either mode:

- The risk explanation attached to externally controlled-session and
  pending-tool warnings contains structured explanatory content. Hover or
  keyboard-visible focus may show that content as a rich tooltip on
  hover-capable devices; activation opens the same explanation in a modal,
  which is the touch path. Touch pointer activity and pointer-generated focus
  do not schedule the rich tooltip. In Themed mode it participates in shared
  timing and visibility ownership. Native mode preserves its immediate custom
  hover reveal.
- A session hover card previews session content and status. It remains a custom
  card in both modes; Themed mode derives its first-open delay from the shared
  setting, while Native mode retains its independent legacy/default delay.
  Touch pointer entry and touch-generated compatibility mouse events do not
  open or warm the card. Session-switch links in the Recent Sessions dropdown
  likewise attach their full-title hint only after non-touch pointer entry, so
  a tap cannot become a browser-native or themed hover hint.

Menus, dialogs, interactive help panels, and other popovers are not tooltips
and are outside the appearance setting. The mode name must not be interpreted
as a global ban on app-rendered overlays.

## Themed timing

The configured delay measures **pointer rest**, not merely time since entry.
Pointer movement before the first reveal restarts the timer. Once revealed, the
tooltip remains open while the pointer moves within either its trigger or the
tooltip itself. Leaving both starts a close grace of twice the configured delay;
entering another tooltip trigger during that grace switches immediately.

Keyboard-visible focus uses the same configured delay. Pointer-generated focus,
including touch focus, does not open a tooltip after activation. Escape,
primary click, blur, and a deliberate pointer departure dismiss the tooltip.
Other keystrokes, including modifier combinations used to capture a screenshot,
leave a visible tooltip alone unless they edit a composer. Every composer edit
dismisses visible YA-rendered text, rich, and session-preview tooltips, cancels
their pending reveals, clears tooltip warmth, and suppresses new pointer/focus
activation for 100 ms after the latest edit. Suppression never schedules an
automatic reopen; fresh pointer or focus intent after the window is required.
Browser-native `title` presentation remains browser-owned. Scroll—including
transcript follow-scroll—otherwise does not dismiss a tooltip the user may be
reading. Browser re-hit-testing can emit pointer boundary events when scrolling
moves content under a stationary pointer; unchanged pointer coordinates are not
treated as departure. A visible tooltip keeps its fixed reading position during
scroll and is re-clamped to the viewport after resize.

Only a tooltip that actually became visible warms the tooltip system. After it
closes, entering another target within six times the configured delay opens the
adjacent tooltip immediately. “Adjacent” is temporal: no geometry test is
needed. Casually crossing targets that never opened does not warm anything.
Visibility ownership is global across the delegated text layer, rich
explanations, and session hovercards: granting it to a new tooltip synchronously
dismisses the prior owner. A genuine move between warm text targets hands the
single surface directly to the new target, while small or absent pointer
movement cannot switch it during scroll or layout re-hit-testing. Neither path
can flash two tooltips or an intermediate blank tooltip. Every tooltip is the
frontmost app hit-test surface and belongs to its active hover region. Pointer
enter, move, down, and context-menu events over its visible bounds target the
tooltip, never any mouseover-driven component geometrically underneath it.
Boundary motion accumulates from the last point inside the active hover region;
up to four CSS pixels is treated as hand/sensor jitter rather than an intent to
switch targets or dismiss.

The session preview hover card is intentionally slower and does not require
pointer rest: its first reveal waits three times the configured delay (150 ms
by default), so a casual pass across a session list remains quiet. After one
card opens, scanning neighboring session rows switches cards immediately. In
`Native` mode this YA-rendered card retains its existing 150 ms default or a
legacy stored card delay.

## Themed presentation

Plain text tooltips retain familiar tooltip geometry: a compact monochrome
surface with maximum black/white contrast and polarity opposite the active
light or dark color scheme, a visible border and modest shadow, UI font, tight
unzoomed line spacing, and no decorative animation. The ordinary themed
tooltip is one pixel larger than the compact `--font-size-xs` UI token; the
secondary-click enlargement still advances to `--font-size-sm`. Multiline
content preserves line breaks.

The shared layer consumes both legacy static `title=` hints and explicit
`data-tooltip` hints. New and pointer-computed producers assign exactly one
owner: themed mode uses `data-tooltip`; Native mode uses `title`, never both.
Shared helpers enforce that rule for React attributes, pointer-computed hints,
hidden-content badges, and generated fixed-font file links.
Themed mode proactively detaches every legacy browser `title`, including titles
added or updated after mount, and retains its text as YA tooltip metadata for
the entire time Themed mode is active. A detached React-owned title remains as
an empty `title=""` sentinel: it cannot produce a browser bubble, but it lets a
later React update or removal remain observable. Removing the source title also
removes the layer-injected `data-tooltip`; switching to Native restores only
titles whose producers still own them. No pointer departure, dismissal, or
viewport change may reintroduce a browser-owned bubble while Themed mode owns
tooltip presentation.

A hint that exactly repeats its target's visible text is omitted only when the
target is measurably visible in its own scrollport, every clipping ancestor,
and the viewport. If any of those clips the content—or the target cannot be
measured—the hint remains. When an outer target fits but an exact-text
descendant is ellipsized, that descendant's visibility governs too; measuring
only the row or button would incorrectly suppress the hint. Explanatory hints
and extra metadata are not inferred to be redundant. Ran commands use their
producer's hidden-content count first, then the same actual scroll-visibility
check on hover. Thus a command without a `+N` badge still reveals its full text
when partly scrolled out of view, while any fully scroll-visible command has
neither a themed nor native command tooltip. Expansion alone does not suppress
the hint when the command remains clipped by its own scrollport, an ancestor,
or the viewport. The Ran-label hint separately owns elapsed time.

Faded output/diff previews reveal a plain-text tail through shared preview
machinery: an ellipsis plus the final configured number of lines. The same
tail is available from the faded content and its `+N` hidden-content badge
where present. Bash/Ran, Web, Edit, and Write use this contract; the badge
requires its producer to supply the actual omitted-tail text so a new badge
cannot silently omit the affordance. When the line-count/character budget says
all content fits but wrapping, a clipping ancestor, or the viewport still hides
part of the rendered surface, hovering exposes the full content. Only content
that both fits and is fully scroll-visible remains without either tooltip
attribute.

File links use only the concise path and optional line/range as their hint.
Filename and adjacent `N lines` range links may therefore show the same hint.
Instructions such as “Click to view” are omitted because link activation and
browser link gestures are already conventional.

Secondary-click on a visible plain text tooltip copies its full text and
immediately increases the tooltip by one text-size step, without animation.
This must not intercept a right-click already handled by the app, a nonempty
text selection, or browser-operable link, form, editable, image, video, or
audio targets. The enlarged tooltip follows the same hover-region and close
grace as its ordinary form. The themed surface permits ordinary text selection:
primary drag within it does not dismiss it, and a secondary-click on selected
text retains the browser's normal selection menu instead of invoking tooltip
copy/enlarge.

Rich explanatory tooltips may retain structured content while using the same
dwell/warmth coordinator and the same keyboard-visible versus pointer-generated
focus distinction. Touch activity does not render or warm a rich tooltip when
activation provides its corresponding dialog path. Interactive help panels and
menus are popovers, not tooltips; they keep their own explicit open/close
interaction instead of pretending to be hover hints.

## Future: rendered hidden tails

The shared hidden-tail tooltip is currently plain text in the tooltip UI font.
A future rendered tail may use its normal output renderer or text/output font,
but it remains a tooltip-like affordance: the same monochrome high-contrast
shell, normal tooltip geometry, dwell/adjacency behavior, and slightly tighter
unzoomed metrics. “Rendered” changes the body typography and content treatment,
not the surface into a card.

## Verification contract

- Static and pointer-computed hints obey rest delay, persistent trigger/tooltip
  hover, delayed pointer departure, keyboard-visible focus, and exclusive
  native/themed ownership. Themed mode contains no nonempty native titles;
  removing a detached source title clears its themed metadata, and Native mode
  restores only titles still owned by their producers.
- Keyboard-visible focus opens themed tooltips; pointer-generated focus,
  including touch focus, does not reopen a dismissed tooltip.
- Rich explanatory tooltips likewise ignore touch pointer activity and
  pointer-generated focus while retaining their activation-to-dialog path.
- Once visible, a tooltip survives same-target pointer motion, transcript
  follow-scroll, scroll-generated pointer boundary events, and non-Escape
  keystrokes that do not edit a composer. Composer edits dismiss every
  YA-rendered tooltip owner and suppress pending/new reveals for 100 ms after
  the latest edit; nothing reopens without a later pointer/focus event.
- Exact visible-content hints are absent only when the target and any
  exact-text descendant are fully scroll-visible, and remain when clipped by
  self, descendant, ancestor, or viewport; no-`+N` Ran commands follow the
  same measured rule.
- Every faded hidden-content preview exposes its actual tail from the fade and
  `+N` badge where present; an unfaded preview exposes its full content when
  any of its rendered surface is not scroll-visible.
- Read/file links expose only a concise path/range and never carry native and
  themed attributes simultaneously.
- Only visible tooltips enable immediate temporally adjacent reveals.
- At most one delegated, rich, or session-preview tooltip is visible, and warm
  handoff changes ownership without a blank or dual-tooltip frame.
- Boundary jitter within four CSS pixels neither switches tooltip content nor
  starts departure dismissal.
- Every visible tooltip is pointer-opaque and frontmost: hover and pointer
  interactions cannot reach an obscured component underneath it.
- Native mode leaves ordinary browser titles intact.
- Valid slider/number edits select themed mode; an empty number draft does not.
- Session hover cards use the 3× first-open delay and immediate warm switching.
- Touch activation of a session row or Recent Sessions link navigates without
  opening, warming, or leaving behind a session preview or text tooltip.
- Secondary-click copy/enlarge respects context-menu and selection exclusions.
- Themed tooltip text is pointer-selectable without weakening departure
  dismissal.
- The local and remote entry points install the same tooltip layer and
  pre-render appearance initialization.

## Automation and screenshot verification

Native and Themed mode require different assertions because a native tooltip is
browser/OS UI rather than page DOM:

| Scenario | Semantic assertion | Screenshot expectation |
| --- | --- | --- |
| Native ordinary hint | Target has `title`, has no `data-tooltip`, and exposes the title as an accessibility description where the browser supports that mapping | A Playwright page screenshot generally does **not** capture the native bubble, even after a real hover; absence from the image does not prove failure |
| Themed ordinary hint | Target has `data-tooltip`, has no nonempty `title` (a detached legacy source may retain `title=""`), and a delayed hover or keyboard-visible focus creates one page-DOM `role=tooltip` surface | The tooltip is part of the page and should appear in a screenshot after it becomes visible |
| Touch activation | A real touch tap may focus and activate the target, but waiting past the configured delay must not create an ordinary themed or rich explanatory tooltip | No custom tooltip remains over the post-activation UI |
| Rich explanation or session preview | Assert the custom surface's own content, timing, ownership, and activation contract independently of ordinary `title` ownership | These surfaces are page DOM and are screenshot-visible in either mode |

Use keyboard `Tab` to verify keyboard-visible focus and a real mouse click or
emulated touchscreen tap to verify pointer-generated focus. Programmatic
`focus()` is not a substitute for a pointer test: browsers commonly treat it as
`:focus-visible`, so it can produce the keyboard branch. For Native mode,
prefer attribute and accessibility-tree assertions over screenshot matching.
A whole-device or OS-level capture may include native browser chrome, but that
is platform-dependent and is not a portable browser-test oracle.

The touch regression sequence is specifically pointer activation followed by
pointer-generated focus: dismissal on pointer-down is insufficient if the
subsequent focus event schedules the hint again. Exercise that complete
sequence, wait beyond the configured delay, and let the browser's
`:focus-visible` result distinguish keyboard-visible from pointer-generated
focus.
