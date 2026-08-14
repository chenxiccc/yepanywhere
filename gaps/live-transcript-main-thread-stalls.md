# Live transcript work still starves the browser main thread

A diagnostic-grade capture from one real current-source tab confirms sustained
main-thread work during ordinary live session activity. It does not yet prove
that Conversation View is the owner.

- With Conversation View on, an 81.3-second visible sample contained 56 long
  tasks totaling 3.264 seconds and 16 frame gaps, with a 154.2 ms maximum gap.
- Switching Conversation View off expanded the DOM from roughly 2,577 to 6,744
  elements and coincided with a 508 ms long task and 524.9 ms frame gap.
- In a later stable 35.0-second window with Conversation View and Thinking
  display off, 84 long tasks consumed 7.054 seconds, 38 frame gaps peaked at
  204 ms, and 16 keystrokes had 55.9 ms average / 104.8 ms maximum dispatch
  delay. The DOM grew from 4,745 to 4,866 elements.
- During the user-labeled compaction tail, 22 keystrokes averaged 44.6 ms and
  peaked at 84.6 ms, matching the user's report that latency then existed but
  was hard to perceive. Turning Thinking display back on increased the rendered
  DOM from about 3,856 to 5,070 elements, but changing activity load prevents a
  causal latency comparison.

These numbers came from a contended real-work tab with diagnostic collection
enabled, not the calibrated performance suite, so they are evidence of a
current symptom rather than ratchet-grade mode comparisons. They nevertheless
violate `packages/client/RENDERING_PERFORMANCE.md`'s invariant that transcript
work must not delay local composer input or defeat browser key buffering.

The next investigation should first repair remote evaluation and timing, then
annotate stream cadence, MessageList preprocessing/commit work, and React render
counts. Replay one identical activity sequence with one display variable at a
time before choosing coalescing, scheduling, or transcript-bounding changes.

Found 2026-08-14 while comparing live Conversation View and Thinking display states.
