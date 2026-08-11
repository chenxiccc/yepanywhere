# Push-notification permission can leave the toggle disabled

`packages/client/src/hooks/usePushNotifications.ts` `subscribe()` sets
`isLoading: true`, then awaits `Notification.requestPermission()`. Both the
permission result and a thrown error clear the flag, but a promise that never
settles leaves `PushNotificationToggle.tsx` disabled indefinitely. Browser
quiet-permission behavior, a dismissed or already-pending prompt, and an
unsupported non-secure context are cases to reproduce; they are hypotheses,
not all verified causes on the current tree.

Two residual gaps make this unrecoverable in the UI:

- The current hook has no focus/visibility re-check that could reconcile a
  permission changed through browser settings while its request is pending.
- There is no timeout/abort on the pending request, so a hung
  `requestPermission()` leaves `isLoading` true forever with no reset.

Reported upstream in kzahel/yepanywhere#84 (Android Edge + desktop): the desktop
screenshot shows the toggle stuck at `请求中…`. The push-notification half of the
same report (opaque `API error: 500` on subscribe/test) is now addressed — push
routes return the real error via `withErrorBoundary` in
`packages/server/src/push/routes.ts` — so the *server-side* cause of a future
report is self-diagnosing; this client-side stuck state is the remaining gap.

Likely fix: add a focus/visibility reconciliation for `Notification.permission`
and a bounded timeout that resets `isLoading` (with an actionable browser
settings / secure-context hint) so a suppressed prompt is recoverable. A
non-secure-context check up front would also explain why push notifications are
unavailable rather than leaving the request pending.

Out of scope for the issue-#84 push-error-surfacing change that surfaced it;
captured rather than fixed because it needs a UX decision on the timeout and the
secure-context messaging.

Found 2026-08-11 while refreshing the existing-gaps survey; the original report
was kzahel/yepanywhere#84.
