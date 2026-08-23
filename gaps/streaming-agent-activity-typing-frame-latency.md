# Streaming agent activity raises typing frame latency above 200 ms

Typing in a settled session is normally about 10 ms key-to-frame, but while an
agent turn or activity is streaming the observed frame latency is typically
over 200 ms. This is independent of the composer-triggered transcript rerender
fixed by `docs/tactical/065-session-composer-input-latency.md`: ordinary typing
remains local, but unrelated active-turn work is still occupying the main
thread long enough to delay the next frame.

## Browser evidence

The observation came from the real connected YA tab under the 30-minute remote
browser diagnostic lease on 2026-08-23. During the active-turn period:

- lease-total key-to-frame latency reached 214.4 ms, with 30 delayed
  keystrokes;
- a recent 8.9-second window contained nine long tasks totaling 1,088 ms, with
  a 252 ms maximum; and
- six `message-list.commit` measurements totaled 898.5 ms and reached 275.9
  ms, while `message-list.preprocess` reached only 20.5 ms.

These measurements support stream/render contention but do not yet prove which
part of a large React commit owns the time. Preserve the user's stronger
repeated observation—typically over 200 ms while activity streams—rather than
recasting the single 214.4 ms sampled maximum as its entire basis.

## Fun Phrases check

`packages/client/src/components/ProcessingIndicator.tsx` is an active-turn-only
source of React work:

- a 2-second interval resets the phrase; and
- a 25 ms timeout advances the typewriter by one character through local React
  state.

The affected tab had no stored Fun Phrases override, so the default-enabled
path was active. A temporary read-only `MutationObserver` on
`.processing-text` saw 30 text mutations in 2.5 seconds, with a 29.2 ms median
interval during the typewriter burst.

`ProcessingIndicator` is memoized and the typewriter state is local, so these
updates should not directly rerender its `MessageList` parent. They still add
frequent React commits and DOM-width mutations precisely while the agent is
active. Existing `ProcessingIndicator.test.tsx` setup explicitly disables Fun
Phrases, so it does not cover the enabled scheduler or its interaction with
streaming and typing.

## Implementation status and remaining check

The primary ownership is now isolated to historical transcript rendering, not
the Fun Phrases typewriter or render-item preprocessing. One live-tail update
in a 40-turn full transcript re-entered all 40 historical assistant galleries.
The same identity leak existed after Conversation View projection.

The 2026-08-23 implementation stabilizes Conversation View render items, turn
groups, display rows, and the derived thinking-preview slot set, then memoizes
the user and assistant turn boundaries. Deterministic full-transcript and
tool-heavy Conversation View tests now show exactly one gallery and one render
item entering for a live-tail replacement: the changed current turn. Focused
client coverage passes without warnings; lint, typecheck, format checks, and
the client console budget are clean.

Acceptance is comparable key-to-frame latency while the session is settled or
actively streaming, without weakening stream freshness or draft recovery. Add
a real-browser active-stream case alongside the settled matrix in
`docs/tactical/065-session-composer-input-latency.md`.

The original tab's diagnostic lease disappeared before an after-sample could
be collected. Keep this gap until a comparable real-work trace confirms that
active-stream key-to-frame latency is now close to the settled case without
weakening stream freshness or draft recovery. The deterministic render-count
contract remains required even after that measurement passes.

Found 2026-08-23 while typing in a Codex session during streamed agent
activity.
