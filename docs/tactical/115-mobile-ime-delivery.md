# Mobile IME delivery boundary

Status: in progress (2026-08-24)

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

YA cannot directly flush Gboard's private buffer. The browser-visible boundary
is to snapshot the delivery, blur the textarea, let composition/input events
settle, clear and dispatch the captured snapshot, and only then refocus if the
user opted into post-delivery keyboard retention.

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

Capture the visible draft and intended action before blur can replace the
compact row. Blur the textarea, allow the browser's pending composition work to
settle, clear and dispatch the captured snapshot, and conditionally establish
a fresh focus transaction for the opt-in behavior.

### 4 — cover late composition and ordinary delivery

Add focused tests for the reported composition sequence, the default-off focus
result, opt-in refocus, fresh post-delivery input, and unaffected desktop
delivery. Keep the existing Send, Steer, Queue, and fork-summary action
semantics covered.

### 5 — publish the observable contract and verify the UI

Update the owning composer and settings topic contracts, run the client checks,
and inspect fresh desktop and phone-width browser captures of the setting and
composer states before pushing the series.
