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

## Likely ownership and next check

Treat the 275.9 ms `MessageList` commit as the primary lead. Profile which
render items and layout effects execute for each streamed update, keeping the
composer-local invariant intact. Run the same controlled streaming-and-typing
trace with Fun Phrases enabled and disabled; add an explicit metric for
`ProcessingIndicator` renders so its local commits are distinguishable from
parent transcript commits. If it contributes materially, replace the 25 ms
React typewriter loop with a compositor-friendly or substantially lower-rate
presentation rather than merely hiding its timers.

Acceptance is comparable key-to-frame latency while the session is settled or
actively streaming, without weakening stream freshness or draft recovery. Add
a real-browser active-stream case alongside the settled matrix in
`docs/tactical/065-session-composer-input-latency.md`.

This was filed rather than fixed because the request was to preserve the
observed contrast and inspect Fun Phrases; the causal split still needs the
controlled A/B above.

Found 2026-08-23 while typing in a Codex session during streamed agent
activity.
