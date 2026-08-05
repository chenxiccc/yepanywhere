# Configurable Speech Prefix and Delivery Cues

Topic: mic-button-speech-ui
Topic: vanilla-defaults

Status: Implemented 2026-08-05.

## Goal

Make the speech-to-text prefix an explicit browser preference and make every
delivery cue predict the actual provider-bound message. With the preference
off, YA sends text verbatim and shows no prefix cue. With it on, speech-
triggered and eligible rapid post-dictation deliveries use the selected prefix
consistently across Send, Steer, Queue, Project Queue, and New Session.

Use **browser-native Web Speech** for the built-in browser method. YA accepts
the standard `SpeechRecognition` interface or the legacy
`webkitSpeechRecognition` name; Chrome is one implementation, not the product
name.

Related contracts:

- [`topics/mic-button-speech-ui.md`](../../topics/mic-button-speech-ui.md) —
  composer insertion, delivery timing, speech commands, and current `[ASR]`
  behavior;
- [`topics/vanilla-defaults.md`](../../topics/vanilla-defaults.md) — novel
  provider-bound text transforms are explicit and default-off; and
- [`topics/pluggable-speech-recognition.md`](../../topics/pluggable-speech-recognition.md)
  — browser-native and configured STT backend boundaries.

## Defects addressed

The current cue and payload make separate decisions:

- `MessageInput` shows `ASR` whenever speech is pending, even when the
  Quick-send window is Off and a manual delivery will remain unmarked.
- `handleSubmit` and `handleQueue` apply `[ASR]` only for a speech-triggered
  send or an active Quick-send window.
- Active-session Project Queue uses a separate submission path that does not
  apply the prefix, and its toolbar/mobile controls omit the cue.
- New Session Project Queue implements its own recent-speech prefix and cue,
  so it behaves differently from active-session Project Queue.
- The fork-without-summary alternate can show the broad cue even though its
  payload path does not apply the prefix.

Adding a badge to the missing buttons is insufficient. Prefix eligibility,
payload decoration, and cue rendering need one shared decision.

## Agreed behavior

### Configurable prefix, default Off

Add one browser-local **Speech message prefix** selector:

| Choice | Provider-bound prefix |
| --- | --- |
| **Off** (default) | none |
| **`[ASR]`** | `[ASR]` |
| **`[STT]`** | `[STT]` |
| **`[Dictation]`** | `[Dictation]` |
| **Custom…** | the user-authored value |

The dropdown is both enablement and format selection; do not add another
toggle. None of the presets mention Yep Anywhere. **Off** guarantees verbatim
provider-bound text for manual delivery, Smart Turn, and explicit spoken
`send`.

Custom accepts one trimmed, non-empty line with a small length bound. It does
not add brackets automatically. Show the exact resulting prefix in a live
example, and insert one separating space before non-empty message text.

The setting is backend-independent. It describes how YA labels likely
speech-recognition errors, not which STT backend produced the transcript.
Browser-native Web Speech and Grok therefore use the same preference.

### Keep the Quick-send timer

Keep the current browser-local 0–5000 ms timer and default of `0`/Off. Rename
**Quick-send `[ASR]` window** only as needed to reflect the selected prefix,
for example **Quick-send speech-prefix window**. Hide or disable it while
**Speech message prefix** is Off.

The existing documentation specifies the timer's mechanics but does not state
why a short time boundary was chosen. Preserve it as requested. The working
hypothesis—not established history—is that it approximates review opportunity:

- a manual Send, Steer, Queue, or Project Queue inside the window is likely to
  contain unreviewed recognition errors, so it receives the selected prefix;
- after the window expires, the user has probably had time to review the
  transcript, so a manual delivery remains unmarked; and
- speech-triggered submission has no manual review boundary, so Smart Turn or
  an explicit spoken `send` receives the selected prefix whenever prefixing is
  enabled.

Do not present that hypothesis in UI copy as a proven fact. The user-facing
description should state the observable rule: a manual delivery within the
configured interval after finalized speech receives the selected prefix; a
later manual delivery does not. The broader purpose of an enabled prefix is to
warn the agent that the text may contain speech-recognition errors.

A non-empty finalized speech commit arms the timer. The timer starts from
successful backend settlement, not from capture stop, so transcription latency
does not consume it. One successful eligible delivery consumes it. With the
timer at `0`, browser-native Web Speech followed by a manual click gets neither
a prefix nor a prefix cue.

No migration is required. The new prefix selection defaults to Off. The
existing timer stays as configured but has no effect while prefixing is Off.

### Spoken and manual send are ordinary deliveries

An explicit spoken `send` is not a provider message type. YA strips the
control word and invokes the same effective primary delivery used by manual
Send/Enter; New Session invokes its ordinary start flow. Speech choosing the
send boundary is only why it is eligible for the configured prefix.

Do not create separate Grok and browser-native prefix settings. Adding spoken
commands to browser-native Web Speech or extending hands-free follow-up
listening remains outside this plan.

### Every cue predicts the payload

For the current composer and delivery action, one shared decision returns the
exact configured prefix or `null`. Both message decoration and cue rendering
consume that value. Components must not infer a prefix merely from
`speechPending`.

All simultaneously available provider-delivery controls show the selected cue
when their activation will prepend it, or none show it when their activation
will not. Cover:

- Send, Steer, and Queue;
- current-session Project Queue and Project Queue New Session;
- New Session Start and its Project Queue action;
- toolbar, overflow-menu, and mobile-keyboard renderings; and
- summary/fork alternates that actually submit provider-bound composer text.

Local-only actions such as `!!` execution are excluded. Speech activity may
still have its own status or waveform, but it must not reuse the prefix cue.

Preset cues display `ASR`, `STT`, or `Dictation`. A Custom cue may be visually
bounded, but its tooltip and accessible description expose the full exact
prefix. The cue must not remain `aria-hidden` without equivalent accessible
text on the owning button.

## Source map

| Concern | Previous owner | Implemented seam |
| --- | --- | --- |
| Prefix decoration | `packages/client/src/lib/speechDraftTransaction.ts` | Replace the fixed ASR marker with one configured-prefix resolver/decorator |
| Review timer | `packages/client/src/hooks/useRecentSpeechAttribution.ts` | Preserve current arm/settle/consume behavior with prefix-neutral names |
| Browser setting | `useSpeechCaptureSettings.ts`, `storageKeys.ts`, `browserSettingsBackup.ts` | Store prefix choice/custom text and include them in backup and Settings Undo |
| Settings UI | `SpeechTimingControls.tsx`, `SpeechControlMenu.tsx`, `pages/settings/SpeechSettings.tsx` | Add the dropdown/custom preview and make the timer subordinate to it |
| Active delivery | `MessageInput.tsx` | Share prefix decisions across ordinary and Project Queue paths |
| Toolbar cues | `MessageInputToolbar.tsx`, `AsrActionCue.tsx` | Use a prefix-neutral cue on every delivery rendering |
| New Session | `NewSessionForm.tsx` | Share the same Start and Project Queue prefix decision |
| Regression coverage | composer, toolbar, settings, and backup tests | Cover exact text, timer states, every action, and accessibility |

## Ordered implementation

### 1 — add the speech-prefix preference

Add the Off/preset/Custom setting, validation, storage, backup, cross-tab
subscription, and Speech settings Undo support. Add user-facing copy only to
`packages/client/src/i18n/en.json`; sparse locales fall back to English.

Expose the same choice in the full Speech settings page and the mic's compact
speech-options panel. Show the exact custom-prefix preview and subordinate the
existing timer while prefixing is Off.

### 2 — centralize the prefix decision

Create one pure resolver that accepts the configured prefix, whether speech
triggered submission, and whether the Quick-send window is active. It returns
the exact prefix or `null`. Create one decorator that applies the result once
with one separating space.

Off always returns `null`. Failed/cancelled speech and empty no-op submissions
must not emit a standalone prefix. Successful delivery consumes the review
window according to its existing timing contract.

### 3 — unify ordinary and Project Queue delivery

Route Send, Steer, Queue, Project Queue, Project Queue New Session, New Session
Start, and eligible summary/fork alternates through the shared decision.
Project Queue must use the same deferred-speech settlement boundary as the
other delivery actions instead of synchronously pulling provisional text
through a separate helper.

Preserve delivery intent, metadata, draft restoration, attachments, focus,
and queue targets. This work changes prefix attribution only; Project Queue
must not become ordinary Queue.

### 4 — make every delivery cue consume the decision

Replace `asrAttributed: boolean` with the resolved prefix/cue value. Thread it
through inline toolbar controls, overflow controls, Project Queue renderers,
New Session, and mobile-keyboard actions. Rename `AsrActionCue` to a prefix-
neutral component.

The same value used to decorate a click supplies its visible cue, tooltip, and
accessible description. In particular, speech pending with prefixing Off or
the manual window inactive produces no prefix cue.

### 5 — verify settings and delivery consistency

Add focused coverage for:

- Off, every preset, valid/invalid Custom, and exact decoration;
- browser-native manual delivery with the timer Off, active, expired, and
  consumed;
- speech-triggered submission with prefixing Off and on;
- Send, Steer, Queue, both Project Queue targets, New Session, eligible
  alternates, overflow controls, and mobile-keyboard controls;
- pending speech followed by successful, failed, or cancelled settlement;
- typed-only, attachment-only, empty, and mixed typed/dictated drafts;
- setting backup, restore, Undo, and cross-tab updates; and
- preset and bounded Custom cue accessibility.

For the eventual client change, run warning-free `pnpm lint`, `pnpm
typecheck`, focused client tests, `pnpm i18n:scan`, `pnpm console:scan`,
`pnpm css:check`, and `pnpm css:touched`. Finish with fresh 1920×1080 and
375×812 captures of full/compact settings and ordinary/Project Queue cues.

### 6 — add the concise speech-input UX overview

After implementation settles the behavior, add a concise **Speech Input UX
Overview** near the top of
[`topics/mic-button-speech-ui.md`](../../topics/mic-button-speech-ui.md). Cover:

1. browser-native Web Speech and configured STT backends;
2. mic start, insertion, interim preview, and final commit;
3. manual delivery during capture and backend settlement;
4. Smart Turn, spoken commands, and follow-up listening;
5. the prefix selector, review-window behavior, and exact cue invariant;
6. batch/streaming differences; and
7. stop, cancellation, failure, and visible feedback.

Update the detailed prefix section so it no longer promises unconditional
`[ASR]`. Reconcile `topics/vanilla-defaults.md`: the prefix is now an explicit
default-off preference rather than a default-on exception. Keep backend
plumbing in `pluggable-speech-recognition.md` instead of duplicating it.

## Acceptance

With **Speech message prefix** Off, browser-native Web Speech may be active or
settling without putting a prefix cue on any delivery button; every successful
manual and speech-triggered delivery remains verbatim.

Select each preset and a Custom prefix, enable the review window, finalize
speech, and exercise every visible delivery action. Inside the window, all
available provider-delivery buttons show the selected cue and every successful
path prepends the exact value once. After the window expires or is consumed,
all manual-delivery cues disappear and manual text is unmarked. A
speech-triggered Smart Turn still follows the selected prefix without creating
a backend-specific setting. Project Queue and New Session match ordinary
delivery for the same decision.
