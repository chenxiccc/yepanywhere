# Turn-rail marker layout (hit targets + de-cluster spread)

> The scrollbar turn-rail (`UserTurnNavigator`) draws a dash + dot per user
> turn. Their hit/hover targets must match the visible marks — no oversized
> zones that activate blank space, and no z-order confusion in dense clusters.
> This is option **B** (targets sized to neighbor gaps) shipped, plus option
> **A** (de-cluster spread) enabled at a cozy min-gap via one internal constant.

Topic: turn-rail-marker-layout

See also: [fork-from-turn](fork-from-turn.md) (the notch context menu these
markers carry), [scrollback-view-stability](scrollback-view-stability.md).

The normal rail intentionally requires two anchors. It is therefore only a
desktop accelerator for Fork: every real user prompt owns an inline
**Fork from this turn** menu, including the single turn in a short session. The
2026-08-01 discoverability repair is recorded in
[`docs/tactical/075-session-fork-clone-unification.md`](../docs/tactical/075-session-fork-clone-unification.md).

## Keyboard turn navigation

The same real-user-turn anchors provide viewport-relative keyboard navigation.
When focus is outside an editable field, Home jumps upward and End jumps
downward. Alt+ArrowUp and Alt+ArrowDown provide the same directions even while
the composer is focused, preserving Home/End's text-editing behavior there.
Held-key repeat is intentional: every delivered keydown advances again.

A jump skips all user prompts already fully visible in the transcript
scrollport and selects the nearest prompt outside full visibility in its
direction. This makes densely spaced prompts one viewport-aware step rather
than forcing a stop at every already-readable marker. The selected prompt is
aligned near the top of the scrollport and uses the same motion cue as rail and
search jumps. PageUp and PageDown remain native viewport-scrolling keys.
Dragging the transcript's native scrollbar makes that scrollport the focus
owner (without adding it to sequential Tab navigation), so native PageUp and
PageDown keep targeting the transcript instead of a previously focused composer
or a browser-dependent document fallback. Editable controls retain their page
keys until the user makes that explicit scrollbar gesture.

## The bug (root cause)

Each marker's hit/hover target was a **fixed 22px box** (`height:22px;
margin-top:-11px`) centered on a ~3px dash. Markers render at their true scroll
positions with no de-clustering, so in a cluster the 22px boxes overlap heavily;
their union reaches ~9px above the topmost dash and ~13px below the bottommost
and blankets the gaps — blank space activates a marker. Overlap + stacking (later
= lower markers on top) means hovering a cluster activates the *lower* overlapping
marker, so the blue activation sits below the pointer. It was never a coordinate
offset — the `%` hitbox, the dash, and the tooltip all share `topPct ×
trackHeight`; the target was simply far larger than the mark and never tiled.

## B — hit targets sized to neighbor gaps (shipped)

Per marker, the hit/hover target height = `clamp(min(gapAbove, gapBelow),
MARKER_HIT_MIN_PX, MARKER_HIT_MAX_PX)`, centered on the dash (set inline; the dash
line and dot center via `top:50%`). So targets tile without overlap, never reach
past the midpoint to a neighbor, and are capped for isolated/edge markers — blank
space no longer activates, and the topmost overlapping marker no longer wins a
cluster. Dashes stay at their **true** positions.

## A — de-cluster spread (enabled, cozy)

`MARKER_SPREAD_PX` is the single tuning constant: **0** = accurate/status quo;
**9** (current) = a cozy gap just above the dot footprint (~6px circle + ~1px
shadow) so dashes/dots stay tight but non-overlapping. When > 0, dense markers
are pushed apart to at least that px gap before targets are sized, so the dashes
spread to match their targets. Sparse markers keep true positions; in extremely
long sessions `N×gap` can exceed the rail and markers pile up at the bottom.

The spread is **L2-optimal and local**: it minimizes total squared displacement
from true positions subject to `pos[i+1] − pos[i] ≥ gap`. Substituting `w_i =
y_i − i·gap` turns the gap constraint into "w non-decreasing", i.e. isotonic
regression, solved by **pool-adjacent-violators** in O(n) (`spreadMinGap`).
Consequence the user asked for: far-apart clusters keep their true positions and
spreading one cluster never shoves it into the next — only genuinely colliding
runs are pooled and spread (to exactly `gap`, centered on their centroid).

Both paths feed a per-marker `renderTopPct` (= `topPct` when spread is off); the
dash, dot, hit target, and preview label all use it, so they stay aligned.

## Config visibility

`MARKER_SPREAD_PX`, `MARKER_HIT_MIN_PX`, `MARKER_HIT_MAX_PX` are internal tuning
constants in `UserTurnNavigator.tsx`, **not** user-facing settings. If a setting
is ever wanted, expose `MARKER_SPREAD_PX` (0 → max) as the one knob.

## Transcript content clearance

The rail's 22 px marker targets may share a small amount of horizontal space
with transcript content on constrained windows, but that overlap must fade
continuously as the viewport widens. Transcript inline-end padding uses
`clamp(12px, calc(1vw + 6px), 22px)`: the measured 22 px total reaches full
marker/content separation at 1600 px and adds no further padding beyond that
width. The compact phone transcript preserves this inline-end reserve even
while its other edges use tighter spacing.

This reserve is viewport-fluid and applies on both sides of the 1100 px sidebar
mode switch. Do not put a larger reserve only inside the desktop media query;
doing so makes the right content edge jump when the left sidebar appears or
disappears. Right-side transcript action floats additionally move inward by the
remaining overlap plus 2 px, so their hit targets never compete with a turn
marker while ordinary text retains the gradual overlap. The composer sits below
the rail and keeps independent, denser window-edge spacing. Its inline padding
grows continuously from 2 px at 600 px and below to 8 px at 1600 px and above;
growing the viewport must not move the composer edge inward at the phone
breakpoint. The desktop header and composer trim one pixel from their previous
block padding; phone retains its top edge and trims only the composer bottom by
one pixel. Do not apply the transcript rail reserve to the composer.

The rail target ends at the transcript scroll container's client edge. On
desktop, that is the inner edge of the always-visible native scrollbar; the
outermost trim-circle pixel sits 2 px before it. Compact phone layout hides the
native scrollbar and its otherwise empty gutter because the custom track is the
scroll-position affordance, placing that circle pixel 2 px inside the physical
viewport edge. This stays within the 3 px rounded-screen tap margin while
preserving the full marker target inside the usable edge.

## Tabled proposal: independent composer width cap

The composer currently inherits `--content-max-width`; there is no separate
narrow-composer preference. A future browser-local Appearance option could
define an optional composer maximum whose effective value is
`min(content max width, composer max width)`. The default must remain “inherit
content width,” preserving the current wide composer and adding no new concept
for users who did not opt in.

Before implementation, decide whether a deliberately narrower composer remains
centered (the less surprising default) or stays aligned to the transcript start
edge and places all extra room after it. The setting must never widen the
composer beyond transcript content, and should be removed rather than retained
if narrow-composer use does not justify another Appearance option.

## Search preview hover stability

Ctrl-S search mode renders match-preview excerpts beside the turn rail, and
hovering a preview may expand it into a richer multi-line facsimile. Expansion
must keep the preview's right edge anchored: the visual card may grow leftward,
but it must not translate its hitbox horizontally away from the pointer. A
horizontal shift makes pointer-leave collapse the preview, which moves it back
under the pointer and creates a hover/collapse loop.

Preview-label hover is presentation-only: it may expand the hovered card, but it
must not recenter or page the preview window, because moving the label stack
under the pointer causes the same hover/collapse loop. The right-side rail
markers may still recenter/page the preview window on hover, since their hit
targets stay fixed while the text labels move. A click on either a marker or a
preview label is a committed jump target; closing search after that jump should
leave the full transcript centered on the clicked row rather than restoring the
pre-search scroll position.

Marker-hover paging is sticky within a horizontal band. Once a hashmark owns the
preview window, entering another marker at the same pointer Y must not page the
window; the user may move horizontally between the rail marks and their preview
text without a flicker. Paging to a different marker happens when the pointer
actually moves up/down to another band, or after the pointer fully leaves and the
preview state clears.

Active search previews at the rail edges anchor inside the rail instead of
remaining vertically centered. A first-turn / top-edge hit uses the rail top as
the preview top, and a bottom-edge hit uses the rail bottom as the preview
bottom, so at least the hit line remains visible instead of slipping under the
session header or footer chrome. Non-active hover expansion keeps the existing
center position so hovering a preview label remains presentation-only.

Pre-hover search previews, including the active hit, are dense one-line hit
summaries rather than mini cards. The collapsed box height must be large enough
for one readable text line, and the layout pitch should leave only about a
one-pixel visual gap between boxes; do not reclaim height by clipping the text
line into a hairline. Their displayed text is re-excerpted around the first
match so every shown label exposes the needle on its single visible line. Hover
expansion may still show the richer multi-line context from the search
projection.

Follow-up wish: restore the older pointer-driven rail browse behavior where
moving the mouse near the right-side turn rail shifts which turn previews are
shown, without requiring a committed scroll/jump first. Combine that with the
dense preview contract above: before mouseover/focus each candidate stays a
single first-match line rather than a whole-turn card; mouseover/focus expands
only that candidate to richer whole-turn or multi-line context. The preview
window may follow vertical pointer bands near the rail, but the marker hit
targets stay fixed and must not reintroduce the hover/collapse loops above.

## Bottom-bar position age

The composer bottom bar may show a contextual turn-position age immediately to
the left of the session last-activity age. The contract is narrow:

- A hovered/focused turn-rail marker owns the contextual age while its preview
  tooltip is active.
- Otherwise, when the transcript is not following the live tail, ordinary
  scrollbar movement owns the contextual age. Use the most recent visible turn
  end; if no turn end is visible because the viewport is inside a long turn,
  fall back to the timestamp nearest the middle of the visible transcript.
- Hover/focus wins over scroll position. The contextual age clears when the
  preview clears, the rail unmounts, or the transcript returns to follow mode.
- Marker-hover age comes from the marker anchor's message timestamp, not from
  rendered DOM text or the preview label. Normal turn notches use the user
  prompt's timestamp; search-mode anchors may use the row they target.
  Scrollbar-position age comes from the visible transcript rows and their
  source message timestamps.
- The bottom bar renders the contextual age as its own neighbor chip. It is not
  gated by the ordinary session last-activity chip's stale threshold; compare
  against the session last-activity compact label even when that label is
  hidden, and suppress the contextual chip only when the two labels match.
- The chip is informational only: noninteractive, muted relative to warning
  liveness/status chips, and formatted as `at X ago` so it reads as a position
  qualifier for the adjacent session activity age.
