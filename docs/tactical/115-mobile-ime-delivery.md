# Mobile IME delivery boundary

Status: implemented and verified (2026-08-24)

## Goal

Deliver the exact composer snapshot once, without allowing a late Android IME
composition update to repopulate the cleared draft. Preserve post-delivery
keyboard focus only behind a browser-local preference that is off by default.

The compact mobile delivery action above an open keyboard remains available;
this work separates that useful reachability behavior from the previously
implicit choice to keep the keyboard and its composition session open after
delivery.

## Reproduction evidence

The reported reproduction uses Android Chrome, Gboard voice input, and the
large green compact `Send`, `Steer`, or `Queue` action shown while the visual
keyboard is open:

1. Focus the active-session composer and dictate a multi-phrase message with
   Gboard.
2. While the keyboard remains open, press the large green delivery action.
3. The complete message is delivered once.
4. The last dictated phrase reappears in the now-cleared composer.

Three captures from one 2026-08-24 report show the same shape at different
points in the conversation. The composer repeats, respectively, “how exactly
does that work”, “I've only started noticing it in like the past month”, and
“do something smarter” after the delivered message already ends with that
phrase. The last capture reproduces immediately after another voice-input
delivery. This is evidence of a late composition commit, not a partial send or
ordinary draft restoration.

The regression window also matches source history. Commit `f8a85b09d` (2026-07-14,
first released in `site-v1.8.0` and `v0.7.0`) added the compact keyboard-open
delivery action. Its pointer-down handler prevents the textarea from losing
focus, and the submit path focuses the textarea again after clearing it. The
reporter first noticed the problem during the following month.

## Cause

Gboard voice input uses Android's IME composition protocol. Chromium can expose
that protocol as a sequence of `composition*`, `beforeinput`, `input`, and
selection updates. A controlled textarea can clear its React value while the
IME still owns a composing region. A later composition update then arrives as
a legitimate input event and writes the final dictated phrase back into both
the controlled draft and draft persistence.

The compact action deliberately calls `preventDefault()` on pointer down so it
does not steal focus before click. That keeps the action stable long enough to
activate, but it also keeps Gboard attached to the old textarea transaction.
The subsequent synchronous refocus means there is no delivery boundary at
which the IME must retire that transaction.

YA cannot directly flush Gboard's private buffer. The reliable browser-visible
boundary is to capture the delivery action, blur the textarea, dispatch the
current draft, and replace that textarea editing host. Late composition events
remain attached to the retired DOM node. Only the replacement host may be
refocused, and only after React commits it when the user opted into post-
delivery keyboard retention.

Relevant external behavior is documented by the
[Input Events Level 2 composition rules](https://www.w3.org/TR/input-events-2/),
a [Chromium editing discussion of Gboard composing regions](https://lists.w3.org/Archives/Public/public-editing-tf/2018Feb/0000.html),
and a [Gboard field report about cleared and immediately refocused HTML inputs](https://support.google.com/android/thread/16534947/gboard-bug-weird-behaviour-when-an-html-input-is-cleared-and-refocused-in-a-click-event-handler?hl=en).

## Product decisions

- The mobile compact delivery action remains the primary reachable control
  while the visual keyboard is open.
- “Keep keyboard open after delivery” is a browser-local Message Delivery
  preference and defaults off.
- With the preference off, pointer delivery ends the active IME transaction,
  leaves the composer unfocused, and lets the mobile keyboard collapse.
- With the preference on, delivery still ends the old IME transaction; refocus
  happens only after the delivery boundary so a new IME transaction begins.
- Desktop keyboard workflows retain focus. This preference governs coarse-
  pointer delivery behavior, not Enter-key delivery on desktop.
- The solution must not suppress input using string matching or a timed ignore
  window: legitimate text entered after delivery must remain accepted.

## Work plan

### 1 — preserve the Android voice-input evidence

Keep the reproduction, regression window, browser/IME event model, and product
boundary in this tactical so implementation and review have a shared testable
claim.

### 2 — add the post-delivery keyboard preference

Add a browser-local, default-off setting in Message Delivery using the existing
settings storage and UI patterns. Make the setting available to active-session
composer delivery without introducing a server contract.

### 3 — retire the old IME transaction before dispatch

Capture the intended action before blur can replace the compact row. Blur the
textarea, dispatch through the action's ordinary draft/attachment/speech path,
and replace the textarea so late composition events cannot target the next
draft. Conditionally focus only the replacement editing host in the next frame.

### 4 — cover late composition and ordinary delivery

Add focused tests for the reported composition sequence, the default-off focus
result, opt-in refocus, fresh post-delivery input, and unaffected desktop
delivery. Keep the existing Send, Steer, Queue, and fork-summary action
semantics covered.

### 5 — publish the observable contract and verify the UI

Update the owning composer and settings topic contracts, run the client checks,
and inspect fresh desktop and phone-width browser captures of the setting before
pushing the series.

## Result

Pointer delivery on a coarse-pointer layout now blurs and replaces the
textarea's DOM editing host while preserving the existing Send, Steer, Queue,
Project Queue, fork, attachment, and pending-speech paths. Desktop delivery
keeps its prior focus behavior. The new browser-local preference appears in
Message Delivery, participates in pane Undo and portable browser-settings
transfer, and defaults off. Opting in focuses only the replacement textarea in
the next animation frame.

The focused composer/settings suite passed 196 tests, including a regression
that delivers the whole draft once, directs a late Gboard-style composition
commit at the retired textarea, keeps the replacement draft empty, and accepts
fresh next-turn input. The full client suite passed 3,862 tests. Root
typechecking, lint, formatting, console-budget, and i18n scans passed without a
task-caused warning or budget delta.

Fresh settings captures were inspected at 1000×600 and 375×812. The default-off
row remains grouped and readable without overflow at both widths; the reviewed
files are `.artifacts/ui-testing/2026-08-24-mobile-ime-delivery/desktop.png` and
`mobile.png`.

The root unit command retained the existing macOS worktree-watcher failures
documented in tactical 111: five tests still expect Linux native watchers on a
poll-only platform. The unrelated lifecycle timer file also timed out under the
initial concurrent load, then passed all 25 tests in isolation. No client test
failed.
