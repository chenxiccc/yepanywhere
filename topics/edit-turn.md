# Edit-turn inline editing

> Edit-turn is the proposed inline UI contract for editing queued or sent user
> turns without making an empty composer look like a fresh draft.

Topic: edit-turn

## Proposal status

Queued-turn inline editing is proposed, not current behavior. Live regular,
patient, and current-session Project Queue rows currently use
take-to-composer editing: Edit removes the queued item and restores its content
to the main composer. The Projects page has a separate in-place Project Queue
editor. Sent-turn editing remains correction editing through the composer.

## Problem

Editing a previous turn through the normal composer creates an ambiguous empty
state: if the user selects all text and deletes it, the screen can look the same
as a fresh-message composer. The UI needs a discoverable escape hatch and a
visible edit target so a destructive-looking local edit can be cancelled without
guessing which mode is active.

Queued text also accumulates while the surrounding conversation and backlog
continue to change. Users need to correct that scratchpad without cancelling and
re-appending it at the tail: that silently changes the intended delivery order
and can let later queued context pass the edited item. Keeping the queued row as
the editing surface makes both its identity and its position visible.

## Inline edit contract

- Entering edit mode replaces the target queued or sent user turn with an
  inline textarea/editor at that turn's transcript position.
- Focus moves into the inline editor. The normal composer should not be the
  active fresh-message target while inline edit is active.
- The editor autogrows with input up to a bounded height, then scrolls
  internally. As lines are added or removed, the queued-message stack reflows
  around the editor while preserving its existing bottom anchoring; controls
  remain attached to the edited turn.
- The turn shows a visible edit-state control such as `Cancel edit (Esc)`.
- Pressing `Esc` while focus is inside the inline editor cancels edit mode,
  restores the original turn text, and removes the visible cancel control. That
  disappearance is the confirmation that the cancel happened.
- Select-all/delete leaves an empty inline editor in edit mode. Empty text does
  not collapse back into a fresh composer state.
- Higher-priority UI layers, such as menus or dialogs, may consume `Esc` first.
  The visible cancel control must always perform the same edit-cancel action.

## Queued vs sent turns

Queued turn editing is scratchpad editing: the saved result should update the
queued item while preserving the queue contract, including original queue
position and any edit barrier needed to keep later queued items from passing it.
Entering edit mode therefore requires a server-visible hold on that same item,
not a client-only textarea over a dispatchable row. Save patches the held item
in place and releases it; cancel restores the original item and releases it.
The hold prevents the original text from dispatching while the user edits.

Sent turn editing is correction editing under the current YA model. It does not
mutate the historical provider transcript, and the user-facing submit action
should not imply transcript rewind. Prefer labels like `Send correction` or
`Submit correction` over `Resend from here`.

Use a rewind-style label only if YA later implements a separate explicit flow
that discards or supersedes later assistant output and replays from the edited
turn. That is a different product contract from the existing latest-turn
correction path.

## Editing a slash-command turn issues the command

A recalled draft that opens with a slash command is a fresh invocation, never
prose to correct, and this holds for every command rather than a listed few.
Correction framing prepends a line, which pushes the token off offset 0 so the
provider receives the command as ordinary text; a stripping command such as
`/fast` would additionally diff its bare argument against the unstripped
original. Editing `/goal ship the fix` therefore issues the edited `/goal`, and
re-submitting it unedited re-issues it the way shell history does instead of
reporting no changes. A command YA runs itself, such as `/model` or `/compact`,
also ends correction mode, since it never reaches the send path that normally
clears it.

The decision reads the raw composer text before slash resolution consumes the
leading token, and it accepts only what the provider accepts: a leading space,
a mid-text token, or a path like `/local/graehl` stays ordinary prose and is
still corrected.

## Scroll and autofollow

Entering inline edit mode should pause transcript autofollow enough that the
edited turn does not move away while the user is typing. On cancel or submit,
YA may reenter autofollow if there is no unread text yet. If new unread content
arrived while edit mode was active, preserve the paused/read-position state
instead of snapping to the bottom.

## Relation to existing composer controls

The visible `Cancel edit (Esc)` control is the discoverable escape hatch. It is
stronger than relying on cursor focus alone, and the inline cursor is stronger
than a composer banner because the target turn remains the physical editing
surface.

If an incremental implementation keeps composer-restored edits for a while, the
same escape-hatch invariant still applies: edit mode persists until explicit
submit or cancel, and empty text is still edit mode rather than a fresh draft.
Plain `Esc` invokes the same cancel action as the visible control: it ends
correction mode and clears the restored draft. For plain-Up recall, which only
starts from an empty composer, that restores the exact pre-recall state.
Correction cancellation takes precedence over the running-turn stop shortcut;
open composer menus and active speech capture may consume `Esc` first.
