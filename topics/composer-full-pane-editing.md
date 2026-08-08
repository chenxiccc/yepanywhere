# Composer Full-Pane Editing

> Composer full-pane editing gives long drafts a viewport-bounded editor that grows with the draft while preserving the page title and the composer's ordinary action controls.

Topic: composer-full-pane-editing

## Contract

- The New Session composer and editable handoff composer expose a visible
  full-pane toggle. The in-session composer exposes the same mode through
  `Ctrl+Shift+F`; a visible in-session affordance remains deferred until it can
  be distinguished from the existing one-line collapse control.
- Full-pane mode is transient UI state. Leaving the page or restoring the
  ordinary composer does not change a saved preference or the draft text.
- The textarea continually resizes as the draft changes. Its target height is
  the rendered draft plus four additional text lines, capped by the space
  available in the pane; once capped, the textarea scrolls internally.
- Entry preserves the ordinary composer width when that width can accommodate
  the target height. The New Session and handoff composer may widen to the
  available pane when wrapping at the ordinary width would exceed the height
  cap.
- `Enter` always inserts a newline in full-pane mode, independent of the normal
  Enter/Ctrl+Enter setting and any queue shortcut. `Ctrl+Enter` performs the
  direct send or start action. The ordinary tappable send/start control remains
  available.
- In a session, the session title bar, transcript, auxiliary pane content, and
  ordinary bottom composer bar remain rendered. The existing split point moves
  upward as the textarea grows, shrinking the content scroll region only by the
  height the composer actually needs. On New Session and handoff surfaces, the
  containing page or modal header remains visible while launch settings yield
  the editing area.

## Deferred UI Design

Keeping the New Session and handoff project, provider, thinking, and related
launch controls visible in full-pane mode requires a deliberately compact
launch-controls layout. Until that layout is designed and evaluated, those
controls yield to the editing area and return unchanged when full-pane mode is
restored; do not improvise a partial compact toolbar as part of the current
interaction.

## Verification Boundary

`resizeComposerTextarea` owns the draft-plus-four-lines calculation and height
cap. `NewSessionForm` owns the visible toggle, width escalation, and handoff
reuse. `MessageInput` owns the keyboard-only in-session entry and the
editing-first Enter contract.

Behavior tests cover live sizing, height capping, both entry paths, newline
semantics, and direct Ctrl+Enter submission. Final browser captures cover the
New Session and in-session layouts at desktop and phone widths.

## Related Topics

- [composer-bottom-bar-overflow](composer-bottom-bar-overflow.md) — responsive
  ownership of the action controls that remain available in full-pane mode.
- [session-context-actions](session-context-actions.md) — handoff creation and
  the editable handoff launch surface.
- [vanilla-defaults](vanilla-defaults.md) — records the explicitly authorized
  default-visible New Session affordance.
