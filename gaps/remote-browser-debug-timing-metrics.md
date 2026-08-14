# Remote browser timing telemetry emits impossible and stale gaps

Two timing signals from `packages/client/src/lib/browserDebugLease.ts` are not
reliable enough for latency diagnosis:

- `composer.keystroke-latency` subtracts the `performance.now()` value captured
  at key receipt from the later `requestAnimationFrame` callback timestamp
  (`:737`). In the observed Chromium tab this repeatedly produced impossible
  negative next-frame delays, including values below -200 ms.
- The frame-gap loop carries `previousFrame` across visibility changes
  (`:754-758`). Returning after the tab had been hidden reported the entire
  120-second background interval as one frame gap.

Use one compatible clock basis for key receipt and animation-frame delivery,
and reset or suppress the first frame after a visibility transition. Browser
coverage should assert non-negative key-to-frame durations and no synthetic
hidden-time gap.

It was not fixed during the live diagnosis because the user's current tab was
the measurement target and client source edits could reload other live tabs.

Found 2026-08-14 while diagnosing composer latency through remote browser diagnostics.
