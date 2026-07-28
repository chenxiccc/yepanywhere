# Unchanged public-share status rerenders the session page

When public sharing is enabled, `packages/client/src/pages/SessionPage.tsx`
polls per-session viewer status every five seconds and calls
`setPublicShareStatus` with each newly parsed response. Even an unchanged
82-byte response therefore rerenders the large session-page owner and drives
another broad style/reconciliation cycle.

A two-minute long-session probe found flat JS heap and DOM counts but 25 of
these polls alongside steadily increasing layout/style work. The cheap fix is
to preserve state identity when the viewer-status fields are unchanged, or to
move this independently changing status below the transcript-owning component
boundary. It was not fixed in place because the requested implementation
following this investigation is the separate Files-pane auto-width change.

Found 2026-07-28 while investigating a reported long-session browser-memory
high-water.
