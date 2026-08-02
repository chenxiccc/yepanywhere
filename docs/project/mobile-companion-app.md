# Mobile Companion App

## Status

Approved product direction with the first-class Android shell complete. The
local-bundled and hosted-`latest` Android asset channels, exact-origin native
host, App Link, and minimal FCM registration/receive probe exist. The
Gradle/Kotlin replacement has landed and Tauri Mobile has been removed; its
validation evidence and CI contract are recorded in
[`080-first-class-android-shell.md`](../tactical/080-first-class-android-shell.md).
Broker enrollment, native notification presentation, and native foreground UI
remain later slices.

The first native foreground surface was selected on 2026-08-02: Android uses a
Compose companion shell and Conversation-view session detail, with SwiftUI as
the corresponding later iOS renderer. The existing full web client remains an
explicit full-fidelity fallback. This decision does not yet approve a projection
wire schema, native connection-core implementation, or client/server protocol
change.

The Android notification path is specified separately in
[`topics/android-fcm-push.md`](../../topics/android-fcm-push.md).
The current packaged app's password-manager association is specified in
[`topics/android-credential-sharing.md`](../../topics/android-credential-sharing.md).
The shared semantic boundary and current web-only compiler checkpoint are in
[`topics/portable-transcript-compiler.md`](../../topics/portable-transcript-compiler.md),
and the selected compact session presentation is specified in
[`topics/conversation-view.md`](../../topics/conversation-view.md).

## Motivation

Yep Anywhere already supports browser push notifications through Web Push/VAPID,
but mobile browser delivery can be delayed when the device is locked, idle, or in
a pocket. For time-sensitive agent events such as pending input or task
completion, the desired user experience is closer to a native messaging app:
install, authenticate to a YA server, grant notification permission, and receive
reliable alerts without thinking about browser power-management behavior.

The companion app should also provide a small mobile surface for checking agent
activity across one or more YA servers without reimplementing the full web UI.

## Default User Journey

The primary path should optimize for users who do not want to understand mobile
push infrastructure.

1. Install the YA desktop/server app.
2. Install the YA mobile app.
3. Add a YA server and log in with its existing SRP username/password flow.
4. Enable native notifications for that authenticated server.
5. Grant notification permission.
6. Receive native mobile notifications and see a minimal activity dashboard.

An optional future QR or deep-link flow may make the same SRP device login
easier, but it is not required for the default path.

Source builds and `adb install` should remain possible for advanced users, but
they are not the product-defining path.

During the transitional packaged-web-UI phase, the Android app declares a
Digital Asset Links association with `yepanywhere.com`. This lets compatible
password managers recognize the app's SRP login as the same credential surface
as the hosted Remote Access login. The initial association covers the
maintainer-signed debug APK for device testing; a public app needs its official
distribution certificate added before release.

## Transitional Hosted Production UI

A short-term production app may load a fixed YA-hosted client in its foreground
WebView instead of packaging the client assets into the APK. This is a
transitional option, not a commitment to make hosted web content the long-term
mobile home screen.

The official build should use a fixed HTTPS URL such as
`https://yepanywhere.com/mobile/`. That path may initially serve the same client
as the hosted Remote Access UI while preserving room for an independent cache
scope, release policy, headers, and later mobile-specific behavior.

Local Android development and debug APKs bundle the current checkout's client
assets. They do not depend on a website deployment, so locally edited
JavaScript can be tested immediately. A separate release-channel build may use
`https://latest.yepanywhere.com/` for Play internal or closed testing, where
each successful main-branch push should reach installed test builds without a
new APK. Selecting that mutable channel for an early public release is a
deliberate release decision, not a consequence of building in debug or release
mode. A later stable hosted release uses `yepanywhere.com`, bundled assets, or
the native UI.

Benefits:

- The login form has a real `yepanywhere.com` web origin, which should give
  password managers the most direct path to matching website credentials.
  This remains a physical-device acceptance test rather than an assumption.
- Client fixes can ship with a website release instead of waiting for a new app
  store review.
- The APK does not duplicate the web client assets.
- Native FCM receipt and notification display remain independent of the
  WebView. The app does not need to create a WebView while its UI is closed.
- The full web UI remains an escape hatch while native summary and inbox
  surfaces are developed incrementally.

The bandwidth cost is bounded but real. When this option was recorded, the
current core JavaScript and CSS entry assets were approximately 0.83 MiB
compressed. Hashed assets should normally be reused from the WebView HTTP cache
until a website release changes them; fonts and locale bundles are loaded as
needed rather than on every launch. Cache eviction and the first launch after a
release can still require a network download.

Constraints:

- Hosted JavaScript is part of the login trust boundary. A compromise of the
  hosted origin could read an SRP password or resume credential before the
  protocol protects it. This has the weaker trust model described in
  [`topics/trusted-client-packaging.md`](../../topics/trusted-client-packaging.md).
- The official app must not accept an arbitrary remote UI URL by default. A
  source or development build may expose an explicit build-time override.
- Hosted content must not inherit general Android native privileges. The
  planned web/native channel is exact-origin, main-frame-only, versioned, and
  limited to explicit high-level operations; ordinary browsers receive no
  native host.
- An HTTPS page cannot connect directly to an insecure `ws://` YA endpoint
  without weakening mixed-content protections. Relay or other `wss://`
  connections work naturally. Do not enable production-wide mixed content to
  recover insecure direct connections; use a native transport bridge or a
  source-built bundled client if that use case becomes necessary.
- A cold launch can fail when the host is unavailable or the cache has been
  evicted. The app should present an honest retry/offline state.
- Hosted client releases must preserve the stable-server capability gates and
  fallbacks documented in
  [`topics/remote-hosted-compatibility.md`](../../topics/remote-hosted-compatibility.md).
- The published app must deliver meaningful companion functionality rather
  than relying on a generic website wrapper. Native notifications, server
  status, inbox/deep-link handling, and the planned native summary surface are
  part of that product value.

A conservative rollout keeps the low-memory native notification path, opens
the fixed hosted client only on demand, and later makes the native summary
surface the default while retaining the hosted full-session view as an escape
hatch. Before adopting this path for production, verify on a physical device
that website credentials are offered, repeat launches reuse cached assets, no
unintended native IPC is exposed, and background FCM delivery does not start a
WebView.

The first-class shell and WebView host are planned in
[`080-first-class-android-shell.md`](../tactical/080-first-class-android-shell.md).
The subsequent notification lifecycle and foreground-activity staging remain
in
[`071-android-wrapper-notification-integration.md`](../tactical/071-android-wrapper-notification-integration.md).

## Product Shape

The app is a lightweight native companion, not a replacement YA client.

Core surfaces:

- Authenticated server profiles and notification status.
- Native notifications for pending input, task completion, halted sessions, and
  similar user-visible events.
- A minimal inbox/activity dashboard.
- Aggregation across multiple paired YA servers.
- Native Conversation-view session detail for routine monitoring, followed by
  basic text response once the read-only projection and transport are proven.
- An explicit packaged-web action for the complete activity transcript, rich
  tool inspection, settings, and other surfaces outside the native companion.
- Optional foreground-service mode on Android for users who explicitly want a
  persistent activity subscriber.

The app should feel like a companion device, not like a second place where the
entire YA interface must be learned.

## Non-Goals

- Do not reimplement the full YA web UI in native mobile screens.
- Do not require a WebView for the main product value.
- Do not route all YA traffic through the phone by default.
- Do not require users to create Firebase, APNs, or other push infrastructure.
- Do not make Android foreground service behavior mandatory or always on.
- Do not make localhost or local-network bridging part of the core data path
  unless a concrete benefit justifies the added auth and proxy surface.

## Native Session Direction

The default session-detail experience should be native rather than a permanent
full-screen WebView. Android renders it with Compose; a later iOS app renders the
same semantic projection with SwiftUI. Platform renderers share projection
schemas, generated data types, stable identities, fixtures, pagination and
fallback meanings. They do not share layout widgets or aim for pixel identity.

Conversation view makes this scope useful without requiring a native port of
every rich tool renderer. Its native baseline retains user prompts,
agent-authored text, status and boundary rows, important failures, media, and
one compact activity summary per assistant turn. Expanding routine activity may
initially use bounded generic tool rows. A deliberate **Open full activity**
action enters the packaged web client when the user needs rich diffs, file
viewers, provider-specific tools, or settings.

The first renderer prototype should be read-only and consume saved projection
fixtures before it owns live transport, approvals, or a composer. Basic text
response follows only after foreground connection and reconciliation behavior
are established. An approval that requires command, diff, or other rich context
must open the full web presentation until the native renderer can show enough
information for an informed decision; the compact native surface must not offer
an under-explained approval action.

The server-compiled projection is the preferred efficient path. Native clients
should not independently reimplement provider normalization in Kotlin and
Swift. The exact bounded envelope, projection schema, capability gate,
older-server fallback, and connection-core ownership remain a separate
compatibility-reviewed implementation decision.

## Hosted Push Model

For the published app, YA should own one mobile app identity and one hosted push
path. The normal model is not "each relay owns an FCM project". It is:

- The published Android app belongs to the YA Firebase project.
- The app maintains an FCM delivery registration with a YA-hosted push broker.
- After SRP login, the app creates a device push subscription and gives its
  credentials to the trusted YA server over the encrypted connection.
- A YA server sends a small push intent to the broker when a subscribed device
  should be notified.
- The broker sends an FCM notification to the Android device. Exact Android
  priority and wake behavior remain live-device validation work.
- The app displays a notification or wakes briefly and fetches details from the
  paired YA server.

The credential-free broker service is implemented as a separate package and
runtime at `https://push.yepanywhere.com`. A physical Android build has
registered through Firebase's current FID API, received a direct Firebase
Console test message, and received a temporary generic notification through
the deployed broker. App-owned broker enrollment and user-visible native
presentation remain unimplemented. The broker may share physical hosting with
the relay, but it does not share the relay's process, event loop, database, or
delivery credentials. The relay is encrypted transport, while the broker is a
token registry and notification dispatcher.

Payloads should be generic by default. A user may explicitly opt into bounded
notification text passing in plaintext through the YA push broker and Google
FCM. End-to-end-encrypted rich notification bodies remain possible future work,
not a first-release requirement.

## Server Login And Push Enrollment

The existing SRP login is the default way to establish a trusted relationship
between one mobile app installation and one YA server identity. Native push
enrollment follows that authenticated login rather than introducing another
required pairing protocol.

Likely relationship data:

- Server identity and display name.
- Relay or direct connection route.
- Mobile device id and display name.
- Broker device push subscription id and send secret.
- Revocation metadata so a server can forget a phone and a phone can forget a
  server.

An optional QR code or deep link may later bootstrap the same authenticated
device login. Manual SRP login remains supported and is the initial default.

## Multi-Server Inbox

The dashboard should be modeled as an aggregated version of the YA inbox.

Each paired server contributes a small activity feed:

- Sessions needing input.
- Recently completed tasks.
- Halted or failed sessions.
- Recent active agents.
- Connection and freshness state.

The app should preserve server boundaries in the UI. Aggregation is for scanning
and triage, not for hiding which machine owns a session. Opening a routine item
enters that server's native Conversation-view detail. Full activity and
unsupported detail remain available through the corresponding packaged web
route.

This aligns with the existing multi-host direction in
`docs/project/multi-host-plan.md`.

## Android-First Capabilities

Android is the first target because it enables the behavior that motivated this
idea:

- FCM high-priority native push for time-sensitive notifications.
- A foreground service for explicitly enabled persistent activity subscription.
- Optional localhost or local-network endpoints for detection, pairing, or
  page-open/event handoff.
- A Compose dashboard and Conversation-view session surface without relying on
  browser service-worker delivery.

Foreground service mode should be default-off and clearly user controlled. It is
useful for "keep activity live" behavior, but it carries battery and notification
surface costs.

Localhost integration should be treated as an auxiliary channel only. Reasonable
uses include detection, pairing, and a page-open/event handoff between the web
app and the native app. Routing all YA traffic through it should wait for a
specific, measured benefit.

## iOS Compatibility

The core companion concept is compatible with a future iOS app:

- Native push notifications.
- Pairing and server status.
- Aggregated inbox/dashboard.
- SwiftUI Conversation-view session detail.
- Explicit full-web fallback for rich or unsupported detail.

The Android foreground-service activity subscriber is not portable to iOS in the
same form. A future iOS implementation would likely rely on APNs-backed push,
background refresh where available, and foreground app activity rather than a
persistent background service.

The initial iOS delivery direction is to use the same hosted push broker through
FCM's Apple-platform integration, which forwards notifications through APNs.
This avoids a second public notification service and preserves the same
YA-server device push subscription model. Direct APNs delivery may later be
added as a broker-internal adapter without changing that public contract.

To keep that path open, shared backend concepts should be platform-neutral:

- Device registration.
- Pairing records.
- Push intents.
- Inbox snapshots.
- Event freshness and acknowledgement metadata.
- Transcript projection nodes, stable identities, coverage, and pagination.
- Generic fallback and action-eligibility meanings.

Platform-specific delivery details can live below that shared model.

## Self-Hosted and Source Builds

The primary product should assume the published YA app and YA-hosted broker.
Advanced paths can be supported later:

- Build from source and install with `adb`.
- Use the standard YA-hosted broker with a source-built compatible app.
- Bring a custom FCM project/service account for a fully independent build.
- Run without broker push and rely only on foreground-service subscription.

These should be documented as advanced modes. They should not be required for
the normal desktop-plus-phone setup.

## Security and Privacy Notes

The broker should not become a transcript service.

Default broker-visible data should be limited to routing and delivery metadata:

- Mobile registration tokens.
- Device/server association ids.
- Push intent type.
- Timing and delivery attempts.

The phone should fetch sensitive details from the authenticated YA server over the
normal authenticated/encrypted path in generic mode. In descriptive mode, the
user explicitly accepts that bounded notification text is processed in
plaintext by the YA push broker and Google FCM.

Revocation must be first-class:

- Server can remove a mobile device.
- Mobile app can forget a server.
- Device push subscriptions can be revoked or replaced.
- Lost phones should be removable from the desktop/server UI.

## Open Questions

- What is the smallest inbox snapshot API that supports useful aggregation
  without pulling in the full web app session model?
- What is the minimum versioned Conversation-view projection that preserves
  failures, media, coverage, generic tool detail, and safe fallback behavior?
- Which cross-platform implementation should own foreground SRP/resume,
  direct/relay transport, reconnect, and secure session state without coupling
  either native UI to a hidden WebView?
- How should the native shell transfer authenticated context into the packaged
  full-web fallback without broadening the web-to-native host or exposing
  native installation secrets?
- Should notification acknowledgement be recorded by the app, the server, the
  broker, or all three?
- Beyond the verified clean-install and cleared-app-data FID callbacks, what
  refresh and invalidation behavior is required against the live broker?
- How much local page-open/event handoff is worth building before there is a
  concrete use case?
- What is the minimum source-build story that is acceptable without making it
  look like the supported mainstream path?
