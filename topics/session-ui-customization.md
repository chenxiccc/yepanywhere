# Session UI Customization

> Session UI customization lets users choose which session controls are visible
> or enabled while preserving keyboard-driven access to advanced actions.

Topic: session-ui-customization

See also: [toolbar-settings-ui.md](toolbar-settings-ui.md) — the how-it-works
reference for the Toolbar settings pane (layout, narrowing priority, previews).

## Landed surface

The first customization surface has shipped as its own top-level **Toolbar**
settings category (id `toolbar`, separate from **Appearance**): it renders a
live `SessionToolbarPreview` mockup beside a per-control visibility list, plus
a reset-to-defaults action.
<!-- verified: i18n-settings.ts:103-112 (appearance vs toolbar categories);
     ToolbarSettings.tsx; SessionToolbarPreview.tsx -->

The `sessionStatus` control defaults **off on mobile** (`≤600px`,
`MOBILE_SESSION_TOOLBAR_VISIBILITY_DEFAULTS`) because the inline status row
crowds the cramped toolbar. Its description names the inline liveness/status
chips and the decoupled age float so the scroll-position "at N ago" anchor is
discoverable from the Toolbar pane.
The last-activity freshness and position age are nonetheless surfaced by a
fit-driven float whenever the inline row is unavailable; this float is
*decoupled* from this toggle — see
[composer-bottom-bar-overflow.md](composer-bottom-bar-overflow.md)
§ Freshness / position-age presentation. The toggle still governs the inline row
and the liveness chip.
Presence state is held by `useSessionToolbarPresence` and currently covers
`modeSelector`, `steerNow`, `attachments`, `slashMenu`, `thinkingToggle`,
`renderMode`, `conversationView`, `microphone`, `waveform`, `shortcutsHelp`,
`contextUsage`, `btw`, `nudge`, `sessionStatus`, `projectQueue`, and
`projectQueueNewSessionShortcut`. Changing a control updates the preview
immediately. The two Project Queue controls are independent and default hidden:
`projectQueue` targets the current session, while
`projectQueueNewSessionShortcut` exposes the `+` shortcut that sends an
existing session composer's draft to a future separate session.
Controls use one stored presence value: missing/`default` follows the current
client default, `hidden` is an explicit local hide, and `first`/`mid`/`last`/
`pin` show the control with that narrowing priority. The server also persists
`clientDefaults.sessionToolbarPresence` so the last selected toolbar value
becomes the default for devices with no explicit local override. Resetting
toolbar presence clears local overrides and returns that browser to following
the server client default.
`conversationView` is the narrow client-only exception: both its mode and its
toolbar-presence override remain browser-local and are not sent to older servers
as a new client-default key. The control defaults shown at the `last` narrowing
tier and Conversation view is active for a browser profile without a stored
choice. Changing this control from hidden to shown also activates the mode;
existing explicit mode and presence choices otherwise remain authoritative.
The same Toolbar category exposes the browser-local **Conversation View
history** slider (100 user turns by default). That limit applies when the user
explicitly switches Conversation view on; a view that opens already active
condenses all loaded turns. Revealing earlier turns changes only the mounted
transcript view, not this default. See
[conversation-view.md](conversation-view.md).
Narrowing priority is derived by `useSessionToolbarPresence` and is editable
for controls the runtime overflow menu can actually reveal: the left-side
controls, shortcut help, `sessionStatus`, `contextUsage`, `btw`, `steerNow`,
`projectQueue`, and `projectQueueNewSessionShortcut`. The right-side controls
default to `pin` when shown, so they stay inline unless the user explicitly
chooses a collapse tier. `microphone` and `waveform` remain visibility-only
controls for now.

The former composer model indicator chip is removed from the customizable
toolbar. The top-right provider badge remains the model/effort status surface
and opens the mid-session model, thinking, and effort control panel for owned
sessions.

This is the resolution path for session controls that are useful to some users
but too busy, speculative, or maintainer-contested for the default UI. Examples
include composer delivery choices such as regular queue versus patient queue,
secondary search/edit controls, and other advanced per-session actions.

Patient queue is a distinct per-item delivery intent, not a magic prompt prefix.
The phrase `when done, ` is ordinary user-authored text. YA must not add it
when queueing. The active composer model is:

- **Plain Enter** follows the user's selected default action for the active
  steering state, currently steer by default when the provider supports
  steering.
- **Ctrl+Enter** is the "other" regular action: if Enter steers, `Ctrl+Enter`
  regular-queues; if Enter queues, `Ctrl+Enter` steers. Patient is not the
  shortcut.
- The **straight-arrow queue button** remains available for steering providers
  while a turn is active, including mobile users who cannot rely on keybinds.
  The patient-switch visibility setting must not hide this alternate send
  option.
- The **patient stopwatch toggle** is default-off and affects only future queue
  submissions. Accepted queued items keep their own regular or patient intent.
- Patient queued rows wait for their per-item verified-quiet patience seconds
  (default 30s).
  Regular queued rows may pass patient rows at delivery time, so UI should
  visibly distinguish patient rows while preserving composition order in the
  scroll-following queue tail.
- The `?` shortcut help should mention right-click/long-press as the route to
  change key behavior. The first narrow setting is swapping Enter and
  `Ctrl+Enter`; broader keybind remapping can build from there.

`onQueue` is only supplied while the agent is running, so a "done" agent never
reaches the queue path. The patient queue default is a Message Delivery
setting, not a Toolbar visibility key; the alternate Steer/Later send button
remains visible when dual-action delivery is available. Tooltips must state the
regular queue and patient queue distinction. See
[`message-control-steer-queue-btw-later-interrupt.md`](message-control-steer-queue-btw-later-interrupt.md).

## Remaining work

Relative to the landed surface:

- Hidden/shown list rows are the editing surface, not click-on-the-mockup-
  control interaction in the top preview.
- Visibility is binary show/hide; there is no "visible but disabled" treatment
  (dimmed / crossed-out) that keeps a removed control legible in the real UI.
- No per-session override distinct from the browser-local explicit choice yet.
- Hidden controls do not guarantee a surviving keyboard-accelerator hint on a
  hover/tooltip surface.

## Contract

- Defaults may stay conservative, but optional controls should have a path to
  remain available without rebuilding the UI for each maintainer preference.
- A disabled visible button is a UI preference, not necessarily a disabled
  command. If the keyboard accelerator still works, tooltip and mouseover
  surfaces should continue to show that accelerator.
- Customization state should distinguish global defaults from per-session
  overrides, matching the pattern used by new-session/global defaults where
  possible.
- Controls disabled by upstream preference should be candidates for
  configurable default-off restoration before the implementation is removed.

### Sidebar spacing

Sidebar spacing is a portable browser preference with two modes. Comfortable
is the default and keeps the intentionally enlarged 34px desktop session rows;
Compact restores the earlier 1.5rem minimum, 2px block padding, and 1.2 line
height. Coarse pointers keep at least 40px rows with 6px block padding in both
modes, so desktop density does not reduce phone and tablet tap reliability.

The same preference controls navigation-row padding and the gaps between
sidebar sections. Inline edge spacing follows the active UI font: top-level
sidebar labels use a `0.75ch` inset, while nested session and queue rows use
`1ch`. The inset must not grow from a fixed window-edge margin independently
of the selected UI font.

## Mockup Requirements

The landed surface shows a realistic session composer/toolbar mockup
(`SessionToolbarPreview`). The target end state, not yet fully reached, is that
clicking a control in the mockup itself toggles whether the real session UI
shows or enables that feature, and that disabled controls remain legible in the
mockup using a visual treatment such as dimming or strikethrough/cross-out so
the user understands what can be restored.

The hover surface for grouped or secondary actions should include keyboard
accelerators for actions that remain available by shortcut, even if their
visible buttons are disabled.

## Related Topics

- [composer-bottom-bar-overflow.md](composer-bottom-bar-overflow.md) defines
  the measured-fit float that surfaces the last-activity freshness and
  scroll-position age over the composer independently of the `sessionStatus`
  toggle on narrow screens.
- [kzahel-disabled.md](kzahel-disabled.md) logs upstream-disabled features that
  should be reconsidered as configurable default-off session controls.
- [message-control-steer-queue-btw-later-interrupt.md](message-control-steer-queue-btw-later-interrupt.md)
  defines message delivery behaviors that session customization may expose or
  hide.
