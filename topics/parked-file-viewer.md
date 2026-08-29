# Parked file viewer

> A parked file viewer lets a user uncover and operate the live session while
> preserving the viewed document's exact reading state, with a persistent
> path-and-line controller that does not depend on finding the original link.

Topic: parked-file-viewer

See also:

- [`media-rendering-and-routing.md`](media-rendering-and-routing.md) — file
  authorization, transport, and viewer routing.
- [`selection-comment-ui.md`](selection-comment-ui.md) — quote-reply and the
  source selection that motivates moving between document and session.
- [`responsive-layout-gaps.md`](responsive-layout-gaps.md) — measured fit and
  the composer toolbar's existing overflow allocator.

## User workflow and invariant

The motivating workflow is document review during a live session:

1. Open a document from a session and read or select a passage.
2. Click a rendered Markdown block or quote a range into the composer that
   remains visible directly below the document, then submit without closing it.
3. Park the viewer when the transcript itself is needed and watch the live
   assistant response without losing the document's place.
4. Restore the viewer and continue from the same scroll position, selection,
   source/preview mode, search state, and loaded content.

The original transcript link is not a restoration affordance. Quote insertion
and the ensuing response may scroll that link far out of view. Viewer lifetime
therefore belongs to a persistent session-level controller, independent of the
message or tool row that opened it.

`open`, `parked`, and `closed` are distinct states:

- **Open** — the viewer owns the session's transcript row. The live session
  remains mounted behind it, while the composer remains visible and operable
  directly below it.
- **Parked** — the viewer remains mounted but is not interactive or visible;
  the live session and composer are visible and operable.
- **Closed** — the viewer is destroyed and its controller disappears.

Open ↔ parked transitions must reuse the same mounted viewer instance. They
must not refetch or reconstruct the document merely to change presentation.
Close may discard it. At most one managed viewer is controlled in a session at
a time. This includes file viewers, tool activity details, and provider-child
details. Opening another managed viewer closes the previous viewer and dismisses
its still-mounted source deterministically.

File navigation inside an open viewer is a dismissal stack. The file header's
**Back** control closes only the viewer that control belongs to, so an in-file
link returns to its still-mounted parent and the outermost Back returns to the
session. Browser Back/back-swipe and an unmodified, non-repeating Backspace use
the same topmost-only rule. Backspace never dismisses a viewer while its event
target is an input, textarea, select, editable region, or textbox. Each child
file or resource modal owns its own browser-history entry so browser Back does
not skip from a nested file past its parent. Escape likewise dismisses only the
topmost visible modal. Every visible modal shares one reference-counted document
scroll lock: dismissing a child keeps scrolling locked for its parent, and the
last dismissal restores the body overflow value that preceded the stack.

The capability is authenticated-session UI. Live and frozen public shares do
not expose parking controls, consistent with their lack of an authenticated
session composer and their narrower file authority.

## First trial: persistent composer controller

The first presentation to evaluate is one controller in the bottom composer
toolbar. It is present while the viewer is open as well as while it is parked,
so its position and meaning do not depend on remembering where the source link
was.

- The controller occupies the toolbar's available center gap rather than a
  fixed-width pill. Its pathname portion flexes; the toggle and close controls
  never shrink below operable sizes.
- Its text is `pathname:line` (or `pathname:start-end`; no suffix when the
  viewer has no line target). Long paths use a leading ellipsis so the basename
  and line remain visible; phone width may reduce this to `…/basename:line`.
  The full location remains available to assistive text and the native title.
- The main action is a stateful toggle: **Minimize file viewer** while open and
  **Restore file viewer** while parked. The adjacent **Close** action destroys
  the viewer in either state, without forcing an intermediate restore.
- The conventional minimize control remains in the viewer header. Activating
  it reveals and briefly pulses the bottom controller, giving a spatial cue for
  where the viewer went. The bottom toggle is also directly usable while the
  viewer is open. Right-clicking the bottom toggle copies the underlying file
  path (without its displayed line suffix) and does not change viewer state.
- While the viewer is open, activating another enabled composer-toolbar action
  parks the viewer and performs that action with the same trusted click. The
  parking transition must not consume or replay the activation: a Mic click,
  for example, still starts voice input under browser user-activation rules.
  Existing parking through the viewer-header minimize control or the bottom
  file toggle remains unchanged.
- V1 inserts the reserved slot between the left and right control groups and
  lets it grow through the measured center gap. Its DOM position after the left
  group is not a fixed visual edge anchor. With ample space, a central or
  right-biased presentation is preferred so long as it does not displace a
  control merely to move there. The live speech waveform normally extends to
  the right of Mic, but is elastic and inessential: it may shorten or pass
  beneath controls as an alpha-blended background signal rather than reserve
  width from the controller. A later presentation may instead attach to the
  left edge of the right group; this must not change the controller's state
  contract.
- Desktop and mobile both participate in the first trial. The controller uses
  the full gap available after required composer actions; as that gap narrows,
  path text yields before either toggle or close becomes unusable. The toolbar
  overflow allocator, not a viewport-width guess, decides which ordinary
  controls make room.
- The file-viewer modal uses the available session width up to its 1200px
  reading cap rather than reserving a percentage gutter. Its top begins below
  the session header and its bottom meets the top of the composer; it never
  covers the composer in ordinary open mode. At 800px and below it becomes
  edge-to-edge within that reading region. Explicit fullscreen may still claim
  the viewport. Its compact header reserves the first
  row's right column for actions while the path and metadata wrap on the left;
  the path uses at most two lines and the metrics remain on one. At 480px and
  below the actions use a two-row grid. The three-column window block keeps
  minimize, fullscreen, and close on top and the atomic `− N +` zoom control
  across the same columns below. Those equal-width window cells are short
  rectangles whose combined width aligns with the zoom group, with close at
  top-right; remaining actions fill the cells to their left. The scrollable
  document ends above the separate composer row, so its final line can always
  scroll completely clear of those controls without overlay-compensation
  padding.
- Changing the viewport width keeps an open viewer open. Responsive relayout
  must not implicitly minimize or close it.
- Its reduced form reuses the existing measured narrowing and overflow system;
  it does not introduce another user-configurable priority tier. Send and Mic
  remain non-displaceable, while the controller may move any other optional
  inline toolbar control into the existing overflow menu as needed, including a
  control that would otherwise be pinned.

The open-state controller and enabled composer-toolbar actions sit outside the
file-viewer overlay in the dedicated composer row. The toolbar parks during
click capture and leaves the original event to reach the selected action;
synthetic click replay would lose browser user activation.

## Controller ownership

**Keep the portaled controller and its positioning lifecycle in one component**
(vs. embedding them in the composer toolbar):
`SessionViewerToolbarController` owns the icons, accessible labels, copy-path
gesture, portal, viewport and resize observers, and component-local styles.
`MessageInputToolbar` owns only toolbar allocation, the open-viewer stacking
state, and click-capture parking before another toolbar action. It places one
typed controller and does not reach into its rendered subtree.

## Alternative: replace the session-list drawer

A second viable presentation temporarily gives the existing left
session-list drawer to the parked file viewer. It reuses a surface users
already know how to open, collapse, resize, and dismiss, and the same model can
serve desktop and mobile.

- Parking replaces the drawer body; it does not navigate away from the session
  or create another file-viewer instance. Closing the parked viewer restores
  the drawer's previous session-list purpose and state.
- The drawer header carries `pathname:line`, restore/open, and close. Close must
  remain reachable from the drawer's collapsed form; a user must not re-expand
  the document merely to close it and recover the session list.
- Desktop width is allocation-driven. Start from the user's current resizable
  sidebar width, then permit the file presentation to request more width only
  while the viewport can still preserve the main session's documented minimum.
  Respect the existing sidebar min/max bounds and resize behavior rather than
  adding a second fixed width.
- Mobile uses the existing drawer overlay, focus, dismissal, and safe-area
  behavior. Collapsing/dismissing the drawer reveals the session while the
  mounted file remains parked.

This alternative is not a fallback implementation hidden behind a breakpoint.
It may replace the composer controller if that trial packs poorly, or the two
may coexist as redundant access points over one viewer state: drawer for
document presence and the composer controller for fast toggle/close. Supporting
both must not duplicate document state or let the two controls disagree.

## Managed detail viewers

Expanded Bash/Ran, Edit, Write, Grep, Web, and WriteStdin details, the
provider-child transcript selector, and path-backed full image viewers
participate in the same `open`, `parked`, and `closed` state model and use the
same composer controller. An image uses its semantic path as file identity and
retains its decoded bytes and fit/zoom position across parking; pathless media
does not manufacture a file controller. A detail controller label describes the
detail rather than a file, and the file-only right-click copy-path action is not
present. Provider-child detail additionally retains its selected child and
loaded transcript across parking, and its header count can restore the same
viewer. In the full image viewer, a two-touch gesture applies both changes in
finger separation and movement of their shared center: separation scales the
image while center movement pans it horizontally and vertically. Lifting one
finger continues as the existing one-finger pan.

The session owns one managed-panel host beside the message list, inside the same
session metadata and agent-content providers as the transcript. A tool row or
session-level detail control publishes its title and content to that host
instead of owning the rendered modal subtree. Consequently:

- parking only hides the host presentation; it does not unmount the detail or
  reset its scroll, selection, render mode, or other local state;
- transcript virtualization or replacement may remove the publishing row
  without removing the currently viewed detail;
- opening another managed viewer dismisses the earlier row's local open state
  when that row is still mounted; and
- leaving the session destroys its host and controller, while the short
  session-DOM linger may keep the detail mounted but hidden for the same
  session.

Tool renderers used outside this explicit session-viewer provider retain the
ordinary close-only modal. Session metadata by itself does not opt a surface
into a host that may not exist.

## Stable ownership through rich-text replacement

Every authenticated session file link publishes its viewer descriptor and
content to the stable session-level host. The link is only an activation
surface; it does not own the mounted viewer. Session rich-text replacement,
transcript virtualization, or removal of the originating tool row therefore
must not close or reconstruct a viewer while it is open or parked.

The host owns the managed viewer and its browser-history lifetime until one of
these explicit transitions occurs:

- opening another authenticated session file replaces the current managed
  viewer and its controller;
- Back, browser history navigation, Escape, or the close control dismisses the
  current viewer according to the modal-stack rules above; or
- leaving the session destroys the host.

The same mounted viewer remains available through source-link replacement in
both open and parked states, including its loaded content, scroll and selection
state, presentation mode, and controller. File links outside an explicit
session-viewer provider and links in public shares retain their local,
close-only modal ownership; session metadata alone never publishes into a host
that is not present.

## Evaluation

The first trial is successful only if captures and interaction checks show all
of the following at desktop and phone widths:

- The open-state bottom controller is in the same reserved toolbar location as
  the parked-state controller.
- The ordinary open viewer ends at the composer's top edge at desktop and phone
  widths, and the composer remains fully visible and operable.
- Parking immediately reveals the live session and leaves the composer usable.
- A response can grow and scroll independently while the hidden document keeps
  its exact reading position.
- Restoring does not reload the file or reset scroll, selection, or presentation
  mode.
- Long absolute paths retain a visible basename and line suffix without
  overlapping the toggle, close, or required composer actions.
- Header minimization gives a visible destination cue, and close works directly
  from the parked state.

If mobile cannot preserve both operable controls and a useful composer toolbar,
the drawer replacement becomes the preferred phone presentation. If desktop
cannot provide a useful center gap at a given width or font setting, the
measured allocator may choose the drawer-only presentation for that geometry.
