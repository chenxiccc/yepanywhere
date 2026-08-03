# Mic Button Speech UI
> YA's mic button owns a speech insertion transaction: it captures either
> streaming or batch speech, integrates recognized text at the user's selected
> draft position, and treats spoken commands as control events rather than
> dictated text.

Topic: mic-button-speech-ui

See also:

- [pluggable-speech-recognition.md](pluggable-speech-recognition.md) for
  backend selection, server/direct STT routing, and provider capability rules.
- [streaming-speech-capture.md](streaming-speech-capture.md) for the client
  Web Audio PCM pipeline, warm mic visibility lifecycle, and readiness
  indicators.
- [composer-bottom-bar-overflow.md](composer-bottom-bar-overflow.md) for the
  active-capture waveform's measured center-space and overflow contract.
- [direct-xai-speech.md](direct-xai-speech.md) for direct browser-to-xAI STT.

## Speech Insertion Transaction

Pressing the mic button creates a speech insertion transaction at the current
textarea selection. If no text is selected, final speech inserts at the cursor.
If text is selected, the selected text remains in the textarea and should still
look selected while capture starts; YA deletes it only when a non-command final
transcript chunk is committed. A spoken cancel command before any committed
speech therefore leaves the selected text untouched.

Final speech chunks are speech-owned spans. User edits map those spans through
ordinary textarea changes; YA must not infer replacement by substring matching.
When final speech lands in the middle of draft text, subsequent final chunks in
the same mic transaction insert after the previous final chunk, not at the
draft end and not over the previous chunk.

Interim streaming text is only a preview at the transaction insertion point. It
does not delete pending selected text and does not enter the textarea value.
When a provisional selected replacement target exists, the preview mirror
renders as if the selected text were replaced so following text wraps at the
same positions it will use once a final chunk commits.

If the user makes a non-empty selection after the mic transaction is already
active, YA treats that selection as a provisional replacement target for the
next non-command final speech chunk. The replacement is not committed
immediately: a final chunk that arrives within 300 ms of the selection is held
until that grace window ends. The value is an explicit speech-UI exception
authorized for this race, not a general readiness or latency delay. If the user
types, cuts, copies, pastes, or collapses the selection before the held final
chunk commits, the manual action wins and the provisional speech replacement
is cleared.

Speech providers may sentence-initial-capitalize the first word of a chunk even
when the user is replacing a lowercase word in the middle of a sentence. For
explicit selected-span replacement, YA may lowercase a title-case first word
when the selected text starts lowercase and the replacement context is not
sentence-initial. It must not do this for collapsed-cursor insertion or for
all-caps/acronym-looking words.

Across separate finalized chunks in one mic transaction, YA also smooths a
provider-created capitalization boundary when the new chunk begins with a
conservative allowlist of ordinary continuation words in mid-sentence context.
This behavior is always active and has no setting. It applies only after at
least one chunk has committed, never to provider revisions or explicit
selected-span replacements, and preserves sentence starts, acronyms, single
letters, and unlisted title-case words such as likely names. A provisional
preview for such a later chunk uses the same normalization, so capitalization
does not visibly change merely because the chunk commits.

For browser-native Web Speech, YA feature-detects the
`SpeechRecognition.unspokenPunctuation` property and enables it when present.
Recognizers without that property must continue normally with their raw
transcripts; browser support is detected from the recognition instance rather
than inferred from a user-agent string. The capitalization fallback above
remains active because older Chrome and Android do not provide inferred
punctuation through this interface.

## Streaming Behavior

Streaming providers may emit mutable interim text, finalized chunks
(`is_final`), and utterance-final or end-of-turn events. YA commits finalized
chunks into the speech transaction as they arrive, using provider audio timing
where available to advance the insertion target.

Mutable interim text uses the same typography and text color as committed
draft text, with a thin underline in that same text color as its only
provisional treatment. The textarea's native caret is hidden while this mirror
preview is visible, and the mirror draws a caret immediately after the
provisional phrase so the visible insertion endpoint follows the user's
speech. The mirror is used only while actual provisional text exists. Active
capture does not insert a `Listening…` label into the draft; the animated mic
control is the capture affordance.

Desktop capture start and stop return focus to the textarea. This keeps the
native typing caret visible at the speech insertion point while batch
transcription or a streaming flush finishes. On a coarse-pointer device, mic
start and stop do not focus the textarea: YA-owned dictation must not summon
the on-screen keyboard. A deliberate textarea press remains the keyboard-open
signal. If that keyboard is already open and the composer switches to its
compact delivery row, the mic remains a pinned 48px action alongside the
delivery controls so entering text does not remove the active speech control.

xAI STT has two timing notions. The top-level `start`/`duration` on a partial
can identify the current segment window and remain fixed while several
separate finalized sub-chunks arrive. Word timestamps are the committed audio
span for a chunk. YA therefore uses word timestamps, when present, for the
committed cursor and uses the top-level `start` only as the segment group key.

Within one xAI segment group, a later `speech_final` partial may revise the
text made from earlier non-empty `is_final` sub-chunks. YA must not append a
tail guessed from the segment window in that case. It replaces the currently
owned text for that segment with the `speech_final` text by emitting explicit
replacement metadata to the composer.

If a later `speech_final` starts at an earlier committed segment group and its
text is no longer prefixed by the already-committed group text, YA treats it as
a correction spanning the committed groups from that start point to the current
insertion target. It replaces that owned suffix instead of slicing off only the
word-timestamp tail.

An empty finalized chunk is not committed speech. It must not clear the mutable
preview and must not advance the committed audio cursor; xAI can emit empty
`is_final` chunks before a later non-empty final chunk for the same audio span.

When Smart Turn triggers an automatic send from an endpoint event, the provider
may still deliver additional final text in its done event. YA must commit that
uncommitted tail before applying the send command metadata.

An automatic Smart Turn endpoint send is held — committed to the draft but not
submitted — once the user has manually edited the composer during the active
mic transaction. This protects a turn the user is co-authoring by hand from
being submitted out from under them by an endpoint. The hold is specific: it
applies only to the *automatic* endpoint send (carried as `smartTurnAutoSend`
in the result metadata, distinct from an explicit spoken `send`); an explicit
`send` command and a manual Enter always submit. The triggering edit must add or
delete non-whitespace text — whitespace-only changes and cursor moves do not
count — and speech-inserted finals (which reach the draft programmatically, not
through the textarea's change event) are never treated as manual edits. The hold
is scoped to the current mic transaction and resets when the next one starts.

When Smart Turn actually submits on a coarse-pointer device, YA blurs the
textarea after submission so the on-screen keyboard closes with the completed
turn. Desktop Smart Turn keeps the ready-to-type refocus behavior. A held
automatic send does not blur because no submission occurred and the user still
owns the draft for review.

xAI may also send one or more non-empty final partials after YA has sent
`audio.done`, then send an empty `transcript.done`. YA stages such post-stop
final partials in order and uses them only if the final done event has no text,
preserving protection against bad stop-flush partials when `transcript.done`
does contain text.

Manual stop for streaming STT is a flush/finalize operation, not cancellation.
It stops capturing new audio immediately, but final transcript updates for
audio already sent must still reach the composer and retain their Smart Turn
command metadata. Only one streaming provider request is active at a time in
the current implementation, so a reclick during streaming finalization does not
start a competing stream. Future work may make that reclick start local
prerecording immediately, buffer PCM into a new speech transaction, and open
the next provider stream only after the previous `transcript.done` resolves.
That follow-up must preserve the user's click-time insertion target and flush
the buffered audio without dropping first words.

When server-routed speech audio retention is enabled, YA persists structured
streaming transcript events next to the retained audio. The older
tab-separated text trace is kept for grepping, but the structured trace keeps
`isFinal`, `speechFinal`, `start`, `duration`, and word timestamps for replay
and reducer tests.

Spoken commands are evaluated from finalized speech, not from mutable interim
text. A command word is a trailing lexical token such as `send`, `cancel`, or
`wait`, after punctuation/quote stripping and case normalization. Recognized
command words are control tokens and are removed from the textbox — except
`wait`, which is intentionally left in place (see its bullet below).

Current streaming command semantics:

- `cancel` removes only the most recent committed final speech chunk in the
  current mic transaction and keeps recognition running.
- `wait` stops recognition, keeps committed speech text, and does not submit.
  It **holds the send even when Smart Turn's endpoint would otherwise auto-send**
  the turn. Unlike `send`/`cancel`, `wait` is recognized eagerly: it does not
  require a deliberate pause before it, because a missed `wait` prematurely
  submits the turn (the disruptive failure) while a missed `send`/`cancel`
  merely takes no action. So the pause gate that separates a spoken `send`/
  `cancel` command from dictation does not apply to `wait`. Because dropping the
  pause check means a sentence legitimately ending in the word "wait" also
  holds, `wait` is **left in the draft** (not stripped, unlike `send`): a false
  hold is then a one-click manual send with nothing lost. The `send`/`cancel`
  pause gate is 300 ms.
- `send` submits the whole composer. The initial implementation stops
  recognition after sending.
- A future "continue after command" option may let `send` submit and begin a
  fresh speech transaction without making the user press the mic again.

Open design slot: command recognition should eventually work per `is_final`
chunk after a YA command-settle signal. That settle signal may be a timeout
shorter than the Smart Turn timeout, but the value is not chosen here. Per the
speech UI timing rule, do not implement a fixed delay unless the maintainer
explicitly authorizes the value.

## Batch Behavior

Batch providers produce no streaming drafts and no mid-utterance Smart Turn.
The default batch result is "wait": insert the whole recognized transcript at
the speech transaction point, stop recognition, and do not submit.

Stopping a batch recording ends capture synchronously. The mic button must
clear its red/listening state immediately; slower upload, provider latency,
local model load, or a slow CPU plus large ASR model are post-capture
processing and must not make the mic look active.

While the batch result is pending, the composer stays fully native and usable:
the textarea keeps its real, visible draft and native caret, and the user may
type or edit anywhere. The captured insertion target maps through those
ordinary textarea edits. A single `Transcribing…` status appears beside the
mic in the toolbar, never inside the textarea or its mirror. Overlapping
requests must not duplicate status strings in the draft.

**Known limitation — typing at/after the insertion span.** While a speech
preview is active, the provisional span is absent from the textarea value but
the overlaid mirror reserves visual space for it, so the native selection and
the rendered text diverge at and after that point. A mirror-drawn caret
communicates the visible speech insertion endpoint, but typing to edit text
*at or after* the insertion/replaced span is effectively unavailable until
the provisional preview resolves. This limitation applies only while actual
interim speech is visible; processing and finalizing never activate the
mirror. The clean fix for the remaining provisional-state limitation is a
richer input (see
[composer-rich-input.md](composer-rich-input.md)).

### Cancel contract

Cancel during the post-capture wait is **Escape**. The toolbar status is
informational and there is no inline `✕`. Escape ends the pending speech
transaction and drops its insertion target; active `listening` still finalizes
on Escape instead (keeping interim), and the mic can still start an overlapping
new recording during the wait.

The guarantee is result-suppression, not necessarily work-interruption: a
transcription that finishes after cancel must be fully inert — it inserts
nothing, replaces nothing, and triggers no send. The provider discards the late
result via its `cancel()` method (see
[pluggable-speech-recognition.md](pluggable-speech-recognition.md)). Actually
interrupting the backend request or model work is an optional optimization and
may never be implemented; the only contract is that a completed-after-cancel
result is a no-op.

### Unifying batch and streaming

Batch is a special case of streaming: one `is_final` block per mic activation,
possibly with a high startup latency (model cold-load). The pending-result wait
(`processing`) and the streaming finalize wait (`finalizing`) are the same
conceptual state at different latencies, surfaced by one status beside the mic.
The distinct surface wording is deliberate and stays — `Transcribing…` for
batch and `Finalizing…` for streaming. The composer still receives the pending
*kind* (`listening` | `transcribing` | `finalizing`) from the mic button for
transaction lifecycle, but none of those status strings enter the draft.

Cancel (Escape) abandons only the in-progress, non-final portion of the active
mini-turn; already-accepted `is_final` blocks remain in the draft. For batch
there is no committed block during the wait, so cancel drops the whole pending
result. For streaming, `cancel()` discards the uncommitted preview / in-flight
tail and ignores any racing `final` (a start-token bump makes later socket
messages inert), while the `is_final` blocks already emitted to the draft stay;
this is distinct from `stop()`, which finalizes/flushes the tail.

Implemented: the draft mirror surfaces underlined provisional speech during
capture and nothing else. `Transcribing…` (batch) and `Finalizing…` (streaming
flush) render once beside the mic while the textarea and native caret remain
untouched. During active capture the animated mic remains the stop/finalize
control. Escape cancels the post-capture wait and routes to the unified
`cancel()`.

When the batch result arrives, YA treats it as one delayed finalized streaming
chunk. It uses the speech transaction target captured at mic start, including
the originally selected replacement span, rather than whatever selection or
speech transaction is current at result time. User edits made while the batch
is pending map that target through ordinary textarea edits. A new recording may
start while the earlier batch transcription is still pending; if multiple batch
transcriptions overlap, each result must either carry a distinct speech target
or be blocked until the previous pending result has landed.

Batch supports simple whole-batch spoken commands:

- A trailing `send` word is stripped, the preceding recognized text is inserted
  at the speech transaction point, and the composer is submitted. If the batch
  transcript is only `send`, YA submits the existing composer unchanged.
- A trailing `cancel` word cancels the whole batch result. It inserts nothing
  and, when the mic started over a selection, leaves that selected text
  untouched.
- `wait` is not a batch command. If the recognizer returns a transcript ending
  in `wait`, YA treats it as dictated text because batch already defaults to
  stop-without-send.

## Stop And Escape

Clicking the active mic button or pressing the voice shortcut toggles capture
off using the provider's normal stop behavior. For xAI streaming STT, manual
stop sends `audio.done` immediately and waits for `transcript.done`. The mic
button must clear its red/listening state as soon as capture stops, but the
speech provider remains in a non-recording finalizing state until the final
response lands. YA should not treat the live interim preview as final unless
the final response fails and the preview is being salvaged. Smart
Turn/endpointing finalizes through `is_final` transcript partials, but manual
stop does not require or promise one last `is_final` partial. In the initial
implementation, Esc may duplicate that same toggle behavior when focus is in
the composer.

Proposed stronger Esc behavior: while a mic transaction is active, Esc should
remove all speech inserted since the button press and stop recognition. That
is broader than spoken `cancel`, which only removes the latest finalized
speech chunk and keeps recognition running.

## Feedback

The mic's capture readiness stays event-driven. While the capture path is
initializing, the mic retains its normal inactive appearance and the
wide-screen status says `Starting…`; startup does not add an amber color or
pulse. Once the path produces a real capture event, the wide-screen status says
`Speak now…`; while the recognizer reports speech or delivers transcription
results, it says `Listening…`. Because browsers do not reliably emit a matching
speech-end event, 1.2 seconds without a provisional or final recognition update
returns the status to `Speak now…`; an explicit speech-end event returns it
immediately. This inactivity inference changes only the feedback label, never
transcript boundaries or capitalization.
Browser-native Web Speech sessions that end unexpectedly and are automatically
restarted return to `Starting…`; they do not expose the network-sounding
internal `reconnecting` state. The changing words provide the status feedback;
all non-error status text keeps the normal text color and weight instead of
flashing between state-specific red, green, and amber treatments. Actual error
text remains red. The mic control itself turns red after the active path
produces a real listening/capture event. Its active icon is a microphone
knocked out of a filled circle in the input background color. The unified disc
stays still at `Speak now…` and pulses only while the state says `Listening…`.
Only the filled circle changes size; the larger microphone glyph remains fixed
so the activity cue does not make the symbol itself wobble. Idle, starting, and
active states all render the exact same microphone SVG geometry and size;
capture changes only its foreground/background treatment and adds the disc
behind it. The 18px icon is sized to balance with neighboring toolbar glyphs
without filling the button. Even at rest, the disc fully contains the
microphone and its stand; active pulsing expands outward from that baseline
rather than shrinking behind the glyph. Its resting scale includes the
microphone stroke extending beyond the path's nominal bounds. This is
deliberately activity-driven, not a fabricated volume meter;
browser-native Web Speech exposes sound/speech events but not audio samples.
While capture is active, the configurable live waveform uses whatever measured
center space remains between the bottom row's anchored control groups; it
yields before moving or overlapping those controls. The animated mic and
changing status copy are the only persistent capture indicators: neither the
session composer nor the new-session composer draws a pulsing red strip across
its top edge. Overflow behavior remains as specified in
[composer-bottom-bar-overflow.md](composer-bottom-bar-overflow.md). The
waveform is a default-on element in Appearance → Session toolbar. The
waveform is available for YA-controlled capture paths, where YA receives real
audio samples; browser-native Web Speech does not expose its microphone samples
and therefore does not show a fabricated waveform. When the waveform is shown,
the desktop `Speak now…` / `Listening…` text beside the mic is suppressed as
redundant; starting, finalizing, and error text remain useful state feedback.
Waveform
amplitude uses a bounded decibel scale, saturates at 80% input amplitude, and
may reach the toolbar's exact top and bottom bounds without a rectangular
background or outline. The visible sample count is a client-side presentation
effect derived from the waveform element's measured pixel width; capture and
transport remain layout-independent. It renders one sample vertex per measured
CSS pixel in a continuous mirrored envelope, so there are no visual gaps and
saturation intentionally becomes a visibly clipped band. The envelope is
painted directly to a canvas, not rebuilt through React or SVG state. Audio
callbacks only overwrite the latest pending sample buffer; at most one
`requestAnimationFrame` is queued, accepted draws are capped at 60 fps, and
intermediate samples are coalesced when the browser is busy. Hidden documents
queue no paints. Spoken commands may be shown as
temporary UI feedback near the mic, such as a small command chip, but the chip
is advisory UI only: the command word still must not appear in the textarea
value.

Each stopped batch recording also owns a terminal settlement event keyed by
its captured speech target. A later mic activation does not cancel or replace
that queued request. Completion, cancellation, or failure retires exactly that
target; in particular, an older failure while a newer capture is active must
not leave an orphan `Transcribing…` tag or clear the newer target.
