# Session scroll memory does not follow the user across devices

The session scroll high-water mark is currently stored only in browser site
storage (`packages/client/src/lib/sessionScrollMemoryStorage.ts`). Tabs in one
browser profile merge each source/project/session independently, but another
device or browser profile starts with no cursor. `live-tail` and
`remember-place` are therefore device-specific cursors rather than
account/server-shared read state.

A server-backed version should preserve the current monotone merge contract:
keep the furthest turn seen by any visible tab, count an active turn before it
completes, and keep the furthest activity/content offset within that turn.
Backward reading must never lower the cursor. The merge must retain whether the
winning observation was following, order concurrent updates deterministically,
and never grant one tab or device an exclusive writer lease.
The client must continue to work against stable servers that lack
the route/field, so implementation requires the supported-release review and a
new capability/protocol gate described in `topics/server-capabilities.md` and
`topics/remote-hosted-compatibility.md`. Without that capability, the current
site-storage cursor remains the fallback and no unsupported request is made.

Keep writes bounded to high-water advances rather than streaming deltas. The
server schema will also need an explicit source/project/session identity and
deterministic ordering when client clocks disagree.

Found 2026-08-25 while implementing visible-follow, cross-tab session scroll
memory in browser site storage.
