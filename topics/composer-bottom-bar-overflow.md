# Composer Bottom-Bar Overflow

> Composer bottom-bar overflow preserves high-priority session controls on
> narrow screens by folding lower-priority controls into a tappable popup menu
> anchored in the composer bottom row.

Topic: composer-bottom-bar-overflow

See also: [toolbar-settings-ui.md](toolbar-settings-ui.md) — the settings pane
that lets users set each control's narrowing priority (which drives the tier
classes this engine collapses).

## Concern

The session composer bottom row can contain delivery controls, Stop, queue and
patient controls, microphone, context percentage, shortcuts help, render/formula
toggles, heartbeat/pulse, `/btw`, attachments, and other optional controls. On
narrow screens those controls can crowd or overlap each other. The fix should
not make controls vanish permanently or force users to discover settings before
they can reach a control.

## Contract

- Collapse/restore obeys the repo-wide fixed-order rule: widening restores
  controls in exactly the reverse order narrowing removed them, with the same
  width always yielding the same set
  ([`ui-architecture.md`](ui-architecture.md) § Narrowing/Widening Stability
  Principle). The tier ladder in `useMeasuredComposerOverflow` satisfies it by
  construction.
- Bottom-row controls should be represented as one ordered responsive control
  list with shared spacing and collapse rules, including shortcut help (`?`) and
  context percentage circle/text. The visual layout may still have left and
  right anchor groups, but splitting controls across unrelated containers with
  different spacing logic makes priority collapse fragile.
- Controls that visibly occupy bottom-row space must also occupy measured layout
  space. Avoid mobile-only absolute positioning or `display: contents` wrappers
  for row participants such as shortcut help (`?`) and context percentage,
  because they can overlap while the responsive model thinks space remains.
- While microphone capture is active, an enabled live waveform should occupy
  the measured free interval between the bottom row's left- and right-aligned
  control groups. The waveform is elastic, opportunistic content rather than
  another anchor: it may use any available center width, but must shrink and
  disappear before displacing, reordering, or overlapping anchored controls.
  It never reserves required or highest-priority width. The stored `pin` value
  for this non-priority-editable control means that the waveform is enabled,
  not that the allocator must protect its rendered width.
  When capture is inactive it occupies no row space. It is configurable with
  the other session-toolbar elements and defaults on by deliberate product
  decision: while active it is ordinary microphone feedback, not a new
  interaction mode.
- Use a stable, tappable overflow (`...`) affordance, likely near the middle of
  the composer bottom row.
- Tapping `...` opens a popup/fold-out row; tapping `...` again dismisses it.
- The opened state is still one bottom-row control strip, not a detached
  explanatory panel: the `...` affordance remains selected at its stable anchor,
  and hidden icon buttons unfold next to it. Use the available side space around
  `...` first; if the left side is out of room while more hidden controls need
  to be shown, place them immediately to the right of `...` rather than letting
  the left side clip. The anchor slot must not move when opening. The strip can
  cover the composer if that is the cleanest narrow layout. Far-left and
  far-right controls may remain visible outside or behind the popup outline.
- Before hiding controls, spend cheap horizontal space first: reduce lateral
  composer/window padding and inter-button gaps down to the mobile-safe minimum
  (about 2px). Do not reduce bottom padding merely to fit the toolbar; vertical
  touch spacing remains a usability constraint.
- Lower-priority controls can vanish into the popup while the left and right
  anchor groups stay visually stable.
- Collapse should be progressive. Introducing `...` does not mean every
  eligible control disappears at once; hide only the controls needed for the
  current width, then move additional controls behind `...` at tighter widths.
- A control must not be hidden for overflow before the `...` affordance is
  visible and able to reveal it.
- The collapse tier should be based on measured rendered control widths, not
  viewport breakpoints. Sum the visible child widths and gaps for the left
  control list, overflow affordance, and right control list, then advance tiers
  only until that total fits the toolbar width.
- Hidden controls must remain reachable by tap/click from the popup menu, not
  disappear.
- The eligible set includes controls from both the left and right toolbar
  containers. Permission mode, attachment, slash, thinking, render/formula,
  Conversation view, heartbeat/pulse, shortcut help, session status, context
  usage, `/btw`, Steer Now, and Project Queue may all collapse when the user
  assigns a non-`pin` priority. Conversation view defaults to the `last` tier
  once enabled. Send, Stop, pending approvals/questions, and microphone remain
  inline/pinned by their own contracts. An active waveform may stay rendered
  underneath or between controls, but its elastic width does not protect space
  from them.
- At squeeze widths, permission mode should use a pure icon/dot presentation
  rather than carrying text such as `Bypass` inline.
- Overflow priority does not require arbitrary reshuffling of the normal
  toolbar order. Prefer stable positions where possible; controls near the
  overflow affordance can collapse into it as space tightens.
- The overflow decision must be recomputed when conditional high-priority
  controls appear or disappear, including activity-dependent queue/patient
  controls while a turn is streaming. Adding or removing one of these controls
  should cause the lower-priority middle controls consumed by `...` to be
  recalculated from the current rendered state, not frozen from an earlier
  toolbar membership snapshot.

## Freshness / position-age presentation

The composer status row can carry three status chips: session liveness, the
last-activity **freshness** ("M ago"), and the transcript **position age**
("at N ago" — the compose age of the message at the current scroll position).
The freshness and position age are session/scroll information the user wants
even on narrow screens, so they follow a fit-driven rule distinct from the
liveness chip:

- **Inline-expanded when there is room** for the expanded status row; the
  liveness chip and expanded last-activity wording ("Last activity 35m") stay
  inline under the `sessionStatus` visibility toggle
  ([session-ui-customization.md](session-ui-customization.md)).
- **Floated over the composer when there is not room** (the same measured
  `requiredWidth > clientWidth` "compact" signal that drives control overflow,
  or a mobile viewport — not a hardcoded breakpoint). The float carries only
  the two ages, never the liveness chip: floated, the liveness time degrades
  to a context-free "now"/"5m" pill over the composer, styled unlike the
  inline row it came from (observed 2026-07-03 as a mystery "now" pill during
  streaming). The view enforces this — the liveness chip is inline-only.
- **The float is decoupled from the `sessionStatus` toggle** so that
  width-constrained clients still get the ages. This matters because
  `sessionStatus` defaults *off* on mobile (the inline row would crowd the
  cramped toolbar); a float consumes no inline space, so that justification
  does not apply to it. Without decoupling, mobile users see neither age.
- **When `sessionStatus` is off the ages float at *every* width, not only on
  narrow viewports.** The governing rule is "float whenever the ages cannot be
  the inline expanded row" — which is true both when the toolbar is compact
  *and* when the toggle is off (no inline row exists at any width). An earlier
  cut floated only in compact mode, so a *wide* desktop client that hid Session
  Status saw the ages vanish entirely and read it as a silently-changed
  setting. `MessageInputToolbar.tsx` expresses this as
  `statusFloats = isCompactStatusMode || !visibility.sessionStatus`, used for
  the float gate, the forced position/last-activity chips, the `.status-floats`
  class, and suppressing the long "Last activity 35m" prefix (float uses the
  compact "M ago" form). A consequence accepted by design: a user who
  explicitly hid Session Status still gets the age float (at any width, and when
  the toolbar is cramped).
- **"at N ago" is follow-mode-safe.** `positionTimestampMs` is null at the
  scroll bottom (`MessageList`), so the position age never shows in follow
  mode (composing at the bottom); only the freshness can. A secondary guard
  drops it when its label would duplicate the freshness label; a current
  position ("now") always counts as duplicating — the freshness chip hides
  itself when current, and that hidden freshness is still "the same time" —
  so "at now" never renders. The edge that
  survives: at the bottom while hovering a turn-rail marker,
  `hoveredMarkerTimestampMs` re-supplies a position age (an explicit inspect
  gesture, not passive follow).
- These are non-interactive status (`pointer-events: none`), so — unlike the
  interactive row participants above — they are exempt from the "controls that
  occupy bottom-row space must occupy measured layout space" rule; the float
  is intentionally absolute and out of flow.

Implementation: the float reuses the existing `.status-floats
.composer-status-ages` positioning; the age content is gated in
`MessageInputToolbar.tsx` by `hasPositionAge` / `hasLastActivityAge` (toggle-
independent) OR'd with the inline sessionStatus-gated flags. To keep the
compact-mode fit measurement stable (the ResizeObserver sums the measured
status element's width), the same element carries the ages in both inline and
float presentations rather than swapping to a separate probe.

The compact signal measures **content demand, never rendered size, and exits
with slack**. Two latch/oscillation traps live here:

- `.message-input-left` is `flex: 1`, so measuring rendered sizes
  (`scrollWidth`) feeds growth back into the decision: once the status
  floats out of the row, the left section absorbs the freed room, keeping
  `requiredWidth > clientWidth` at any window width — compact latched
  forever, and near-equality plus integer rounding could also flip it
  spuriously on wide windows. `sectionDemand` instead sums each section's
  in-flow children (stretchy `flex-grow` fillers such as the speech waveform
  count as their flex basis).
- Exiting compact requires `COMPACT_STATUS_EXIT_SLACK_PX` of headroom beyond
  fitting, because the float omits the liveness chip and restyles the ages:
  demand measured while floating understates the inline row it would return
  to, and an exact threshold would oscillate at the boundary.

## Priority Notes

- Primary message actions, Stop, queue/patient controls, and microphone should
  stay reachable before lower-priority controls are shown inline.
- A mobile multiline textarea cannot require the software keyboard to expose
  separate Return and Send keys; `enterKeyHint` can only request the key's
  presentation, and some Android keyboards still insert a newline for a
  send-looking key. The composer therefore requests an ordinary Return key and
  keeps newline behavior on coarse pointers.
- A contracted visual viewport does not by itself replace the normal bottom
  toolbar. While a focused coarse-pointer composer is empty, the ordinary
  toolbar remains visible so attachments and the rest of the configured
  controls stay directly discoverable. Once the draft has submittable text or
  attachments and the viewport is below 80% of its pre-keyboard height, the
  normal toolbar yields to a 48px-high compact action row.
- While any enabled text entry is focused on a mobile layout and the visual
  viewport contracts below 80% of the layout viewport, the session shell keeps
  its bottom chrome above the obscured portion of the layout viewport. It
  follows visual-viewport resize and pan changes, including a keyboard that
  hides for voice transcription and then returns. A browser that already
  resizes the layout viewport receives no second inset.
- The compact row keeps a stable More affordance so attachments, Stop, and the
  user's other enabled toolbar controls remain discoverable without first
  knowing to dismiss the keyboard. Project Queue is the exception: when the
  user has exposed it, separate potential 48px slots for its current-session
  (`⇥`) and new-session (`⇥+`) actions remain inline beside More. Available
  actions fill those slots so the purple-family buttons are both directly
  reachable and a glanceable signal that project-wide queue semantics
  currently differ from normal send. The new-session button keeps its darker
  violet treatment and prominent `+` badge in this compact row. Opening More
  must preserve textarea focus; choosing a control may dismiss the keyboard
  when the invoked platform UI naturally requires it (for example, the system
  file picker).
- Clearing or submitting the draft immediately restores the ordinary toolbar.
  This avoids the post-send jump from one enabled Send button to two disabled
  Queue/Steer buttons when clearing the draft and starting the provider turn
  happen together.
- With submittable content, the configured primary action remains right
  aligned. Send, Queue, fork, and Steer actions use the large remaining-width
  target after stable queue slots are reserved. Steer shows its short label and
  arrow whenever that target has enough content space; when constrained, only
  the visible label folds away while the full accessible name and a minimum
  48px arrow target remain. Steering-capable sessions reserve another 48px slot
  for the alternate Queue/Steer action, and Project Queue reserves one 48px slot
  for each of its current-session and new-session targets when that toolbar
  feature is enabled and supported. An unavailable action leaves its slot
  visually empty rather than letting the primary action grow into it; when live
  session or project state makes the action available, its square button fills
  the existing slot without moving or shrinking the primary hit target.
  Non-steering sessions do not reserve a redundant alternate slot: their
  primary control can change from Send to Queue in place. Fork-summary's
  explicit two-submit mode may continue sharing the remaining width because
  its membership is entered deliberately rather than appearing from live
  state. These controls follow the same
  Send/Queue/Steer/fork handlers and enabled state as the ordinary toolbar.
  Restoring the viewport or leaving the textarea restores the normal measured
  toolbar; keyboard-open mode is not another overflow tier.
- Formula/render controls and heartbeat/pulse controls are lower priority than
  microphone for narrow inline space. They can move behind overflow earlier.
- Shortcut/help (`?`) is lower priority than context percentage, because context
  percentage is live session state while `?` is reference/help.

## Open Design Notes

- The fold-out can behave like gullwing doors: lower-priority controls near the
  stable middle overflow anchor move into a menu that expands left and right,
  while higher-priority anchors remain in place.
- This topic is about responsive reachability. It does not replace the separate
  session-toolbar visibility customization surface, which controls whether a
  user wants a control available at all.
- Appearance/settings previews on mobile may need a friendlier multi-row or
  horizontally scrollable treatment. A temporary landscape-rotation hint is an
  acceptable fallback, but arbitrary user-controlled toolbar reordering is not a
  preferred direction unless a stronger need appears.

## Landed Surface

- First pass landed on 2026-06-07: at narrow widths, controls collapse behind a
  stable `...` affordance in tiers. Permission mode and attachment hide first;
  slash and thinking hide at a tighter width; render/formula, heartbeat/pulse,
  and shortcut help hide only at the tightest tier. No overflow-eligible toolbar
  control hides before `...` is visible. The active tier is now chosen from
  measured rendered widths rather than hard viewport cutoffs.
  Tapping `...` opens one absolute bottom-row menu attached directly to the
  selected `...` button: mode and attachment use the available left side, while
  slash, thinking, render/formula, heartbeat/pulse, and shortcut help spill to
  the right when left space would be tight.
- 2026-07-01 follow-up: right-side controls gained real overflow menu copies
  where the Toolbar settings priority editor exposes them: session status,
  context percentage, `/btw`, Steer Now, and Project Queue. Their defaults
  remain `pin`; assigning `first`/`mid`/`last` makes them participate in the
  same measured tier engine as the existing left-side controls. Send, Stop,
  pending approval/question, and microphone stay pinned. The active waveform
  stays enabled but remains elastic and contributes no required width.
- Active-microphone waveform landed on 2026-06-19 as a configurable,
  default-on session-toolbar element. It is an elastic child of the
  measured left control list: real YA-controlled capture samples fill whatever
  center width remains, while measurement excludes the elastic width and the
  fully collapsed child consumes no extra control gap. Its client renderer
  derives sample-vertex count from the measured pixel width and uses the full
  toolbar control height. Canvas drawing is browser-paint-paced, capped at
  60 fps, and coalesces intermediate audio updates instead of accumulating
  offscreen frame work.
