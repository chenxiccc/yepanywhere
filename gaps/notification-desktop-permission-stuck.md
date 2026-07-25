# Desktop-notification permission can hang on "Requesting…"

`packages/client/src/hooks/useBrowserNotifications.ts` `requestPermission`
(`:62`) sets `isRequesting: true`, awaits `Notification.requestPermission()`,
and clears `isRequesting` in both the `try` (`:70`) and `catch` (`:80`). So the
button (`BrowserNotificationToggle.tsx:81`, label `browserToggleRequesting`)
only stays on "Requesting…" (Chinese `请求中…`) when that promise **never
settles** — which happens with browser "quiet permissions", a prompt the user
dismisses without choosing, an already-pending request, or a **non-secure
context** (http:// over a LAN/Tailscale IP instead of https/localhost, where the
Notification and service-worker APIs are unavailable and the same condition
breaks web-push subscription).

Two residual gaps make this unrecoverable in the UI:

- The focus re-check (`:46`) refreshes `permission` but never clears
  `isRequesting`, so if the user grants via browser settings while a stale
  request is pending, the button stays stuck.
- There is no timeout/abort on the pending request, so a hung
  `requestPermission()` leaves the toggle disabled forever with no reset.

Reported upstream in kzahel/yepanywhere#84 (Android Edge + desktop): the desktop
screenshot shows the toggle stuck at `请求中…`. The push-notification half of the
same report (opaque `API error: 500` on subscribe/test) is now addressed — push
routes return the real error via `withErrorBoundary` in
`packages/server/src/push/routes.ts` — so the *server-side* cause of a future
report is self-diagnosing; this client-side stuck state is the remaining gap.

Likely fix: clear `isRequesting` on the focus re-check when `permission` is no
longer `default`, and add a bounded timeout that resets the state (and surfaces
a "couldn't request — enable in browser settings / needs https" hint) so a
hung/suppressed prompt is recoverable. A non-secure-context check up front would
also let the UI explain why desktop/push notifications are unavailable rather
than silently hanging.

Out of scope for the issue-#84 push-error-surfacing change that surfaced it;
captured rather than fixed because it needs a UX decision on the timeout and the
secure-context messaging.
