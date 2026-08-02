# Notifications

> YA servers decide which application events deserve notification; platform
> push transports deliver notification intents; the receiving device decides
> whether and how to present them.

Topic: notifications

Status: Browser notification baseline landed 2026-07-31. Native Android
delivery is only partially implemented.

Related:

- [Web Push troubleshooting](../docs/push-notifications.md)
- [Notification delivery validation and native readiness](../docs/tactical/079-notification-delivery-validation-and-native-readiness.md)
- [Android FCM push](android-fcm-push.md)
- [Android wrapper and notification integration](../docs/tactical/071-android-wrapper-notification-integration.md)
- [Mobile companion app](../docs/project/mobile-companion-app.md)
- [Browser-profile devices](browser-profile-devices.md)
- [Inactivity push notifications](../docs/tactical/032-inactivity-push-notifications.md)

## System Model

```text
YA server event policy
  -> semantic notification intent
  -> platform delivery adapter
  -> subscribed browser or native app
  -> recipient presentation policy
  -> operating-system notification surface
```

The boundaries are:

- The YA server decides which event types are enabled, which subscriptions are
  enrolled or revoked, and what bounded payload is eligible to leave the
  server. It may rate-limit and coalesce delivery.
- Web Push/VAPID, FCM, and a future APNs adapter transport notification intents.
  They do not know whether a particular session is visible on the device.
- The receiving service worker or native app decides whether to display an
  intent based on actual focus, the currently visible session, device-local
  preferences, OS permission/channel state, and privacy mode.
- A foreground activity service, if ever added, is a separate persistent
  connection feature. It is not required for platform push delivery.

Connection presence is not a reliable presentation signal. A connected tab can
be backgrounded, sleeping, stale, or closing. Server-side knowledge that a
browser profile is connected must not replace the recipient's focus-aware
decision.

## Current Systems

| System | Current state | UI must remain open? |
| --- | --- | --- |
| Direct browser `Notification` API | No active UI or event path. A future deduplicated low-latency role remains possible. | N/A |
| Browser Web Push/VAPID | Implemented for any supported desktop or mobile browser profile. The server owns VAPID keys and subscriptions; a push wakes the origin's service worker. | No YA tab is required |
| Browser service worker | Receives Web Push, renders notifications, handles clicks/dismissal, and already contains focused-window/session suppression logic. It is event-driven and must not own a persistent YA secure connection. | No |
| Native Android FCM | The credential-free broker is deployed and a temporary broker-to-FCM delivery was proven on a Pixel. App-owned broker enrollment, YA-server subscription storage, and user-visible native presentation remain unimplemented. | No WebView is required |
| Android foreground service | Planned only. It would maintain an explicitly enabled headless summary/activity connection with a persistent status notification. | No visible UI, but a persistent notification is mandatory |
| Native iOS push | Future adapter through FCM/APNs under the same provider-neutral device-subscription model. | No |

VAPID is not a mobile-only transport. It is application-server identification
for standard Web Push, and YA's ordinary `sendToAll` path does not filter event
delivery by inferred desktop/mobile device type. The current mobile-only filter
belongs to one bulk test control, not the underlying subscription model.

## Browser Presentation Contract

Browser delivery uses recipient-owned presentation:

- deliver eligible Web Push intents to every subscribed browser profile;
- let the service worker inspect actual focused windows and visible sessions;
- suppress by default when YA is focused;
- optionally notify while YA is open when the relevant session is not visible;
  and
- use stable event identity if multiple delivery paths ever coexist, so delayed
  push cannot duplicate a low-latency direct alert.

The server does not exclude a subscription merely because its browser profile
has a live YA connection. It may still omit a delivery for disabled event
types, explicit subscription mute/revocation, rate limits, coalescing, or
another durable send policy. Ephemeral client connection state is not such a
policy.

Test pushes are an explicit diagnostic action and always display, including
while YA is focused. Dismiss intents close the matching session notification
without applying presentation suppression.

## Direct Browser Notifications

Raw in-page `Notification` calls are not the primary cross-platform path. The
old permission/test-only settings surface and its unused implementation have
been removed.

A later direct path may still be useful for low-latency desktop alerts while a
live tab already has the event, or as a fallback where the Notification API is
available but Web Push is not. It must consume the same semantic intent and
deduplicate against Web Push rather than becoming an independent notification
system. Observed mobile Web Push delay under device sleep is a measurement
trigger for this work, not yet a prescribed implementation.

## Native App Boundary

Browser Web Push subscriptions belong to a browser origin, browser profile,
push service, and service-worker registration. A website cannot create one and
transfer its receiving authority to the published Android app; a later push
would wake the browser recipient, not the YA app.

The current Pixel WebView exposes `navigator.serviceWorker` but exposes neither
`PushManager` nor `Notification`. Native FCM is therefore the Android wrapper's
independent delivery path, rather than a replacement for browser Web Push.

The mainstream Android flow is app-only:

1. The installed app registers natively with FCM.
2. The user signs into their own YA server with SRP inside the app.
3. Native code creates a server-specific subscription through the YA push
   broker.
4. The app gives that subscription's send capability to the authenticated YA
   server.
5. The server sends bounded intents through the broker and FCM.
6. Native Android code decides presentation without starting the WebView.

This requires no yepanywhere.com account, external browser enrollment, QR code,
or background WebView. A transitional hosted UI supplies app assets only; SRP
authentication remains between the app and the user's YA server.

## Payload And Presentation Privacy

Event selection and presentation are separate controls:

- Server event policy currently selects approvals, questions, halted/completed
  sessions, project inactivity, and whole-YA inactivity for all browser push
  destinations.
- A user may select generic or descriptive content per device, but the server
  must apply that preference before transport so generic mode never sends the
  omitted content to a broker. The recipient may redact further when focused
  or locked.
- Planned Android generic mode carries fixed intent copy and opaque routing
  metadata. Descriptive mode is explicit opt-in because bounded user-generated
  text passes through the YA push broker and FCM.
- Existing browser Web Push payloads already include descriptive project and
  session details. Aligning browser/native privacy controls remains future
  product work rather than an assumed current guarantee.

## Browser Baseline And Manual Checkpoint

The settings surface now presents Web Push as browser delivery on desktop and
mobile, organized as **This browser**, **Events from this server**, and
**Devices and delivery**. Test-only display and transport priority controls are
collapsed under **Testing and diagnostics**.

The inventory must remain truthful across its browser/server boundary:

- a push-provider hostname identifies browser family but never supplies
  Android or iOS evidence on its own;
- removing **This browser** revokes both its local PushManager subscription and
  its server row, then every mounted browser-subscription control reflects the
  disabled state without a reload; and
- live counts represent browser WebSockets/tabs, not the number of activity
  subscriptions multiplexed over a socket. Page exit releases the activity
  lease immediately, while a cached document may establish one new lease on
  `pageshow`.

Automated contracts cover the complete subscribed server audience and these
recipient decisions: no focused window displays, an unfocused window displays,
a focused window suppresses by default, the focused-window opt-in displays for
another session, and the session already visible stays suppressed.

The live execution matrix and evidence ledger are maintained in
[notification delivery validation and native readiness](../docs/tactical/079-notification-delivery-validation-and-native-readiness.md).
Before release, manually verify a real subscribed desktop browser with no YA
tab, a background tab, a focused unrelated session, and the notified session
already visible. Safari and Firefox are useful follow-up spot checks. Mobile
sleep/delivery delay is a separate longer-running measurement.

Native FCM enrollment and presentation remain the next independent slice.
