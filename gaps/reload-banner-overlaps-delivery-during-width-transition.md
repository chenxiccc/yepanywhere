# Reload banner can cover delivery controls during a width transition

While narrowing a session until the sidebar auto-hides, the server-changed
reload banner can briefly cover the composer send controls. It has also been
observed resting in that overlapping position, although the exact triggering
pixel width was not found reliably. This report excludes the intentional very
narrow layout where the blocking banner spans the top and covers the session
name.

`packages/client/src/components/ReloadBanner.tsx` owns the placement invariant:
on session routes, the fixed `ReloadBannerStack` measures itself against
interactive descendants of `.session-input` and lifts above the composer when
they overlap. Its current observers cover window resize, element size, and DOM
mutation. A responsive transition can also move or reflow controls between
those signals; that is a hypothesis, not yet a demonstrated root cause.

This was not fixed during waveform work because the width-transition state was
not reproduced reliably. Build a focused rendered regression that advances
through the sidebar-hide transition and asserts the banner rectangle never
intersects visible composer controls at rest or during the transition. Repair
the shared placement measurement/scheduling invariant rather than adding a
breakpoint exception.

Found 2026-08-11 while visually reviewing the responsive session toolbar.
