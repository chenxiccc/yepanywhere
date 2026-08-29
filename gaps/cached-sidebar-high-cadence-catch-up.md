# Rapid activity plus session switching can impair catch-up

The retained-session fast path paints a useful parked snapshot before resuming
the destination session's activity listener, focused watch, and owned-session
stream. The routine `cached-sidebar-switch-routine` ratchet deliberately covers
only low/no activity: after the initial cold destination load, five retained
switches must reach a first readable frame within a 200 ms p95 ceiling.

The larger `cached-sidebar-switch` diagnostic separately waits for one appended
marker to catch up after the retained snapshot paints. It does not cover the
cross-product where updates arrive quickly enough and the user switches quickly
enough that a destination is parked again before its catch-up completes. In
that regime, repeatedly cancelled or superseded hydration could make progress
worse than at the same update rate with a slower switching cadence.

A future scenario should hold total activity constant while varying update and
switch cadence independently. It should compare at least a slower-switch
control against a fast-switch arm, then verify:

- the latest marker eventually converges after switching stops;
- catch-up delay and queued work stay bounded instead of growing per switch;
- exactly one visible session owns active background consumers;
- parked-session cancellation does not lose transcript content; and
- DOM, listener, transcript-store, and process memory remain bounded.

Do not fold this into the routine 200 ms first-paint gate. That gate protects
the common quiet-switch interaction; this gap owns sustained convergence when
both activity and switching are frequent.

Found 2026-08-29 while closing the cached large-session sidebar remount latency
gap with separate first-paint and activity catch-up clocks.
