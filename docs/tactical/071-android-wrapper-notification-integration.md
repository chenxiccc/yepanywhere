# Android Wrapper And Notification Integration

Status: ready to resume after the completed first-class Android-shell migration
in [`080-first-class-android-shell.md`](080-first-class-android-shell.md). The
local-bundled and hosted-`latest` build channels, exact-origin host, and live
broker delivery are proven. Native-host notification operations, broker
enrollment, YA server compatibility work, notification presentation, and
foreground activity remain future slices.

Topic: android-fcm-push

## Origin

The first useful Android app should combine the latest hosted YA client with a
small native notification wrapper. It should not keep a WebView alive merely
to receive notifications, and hosted JavaScript should receive only the native
authority needed for an explicit user action.

This plan owns the transitional wrapper, notification, and enrollment path. It
does not make the foreground WebView the permanent mobile home screen. The
approved product direction in
[`mobile-companion-app.md`](../project/mobile-companion-app.md) makes a Compose
Conversation-view session surface the eventual Android default and retains the
packaged web client as an explicit full-fidelity fallback. Its projection and
native connection work require a separate compatibility-reviewed plan.

The browser baseline and the provider-neutral Settings/server seam are verified
and recorded in
[`079-notification-delivery-validation-and-native-readiness.md`](079-notification-delivery-validation-and-native-readiness.md)
before the hosted enrollment contract is implemented.

This plan distinguishes three things that are easy to conflate:

- **Foreground UI:** an Android-owned full-screen WebView running the bundled
  or hosted YA client until native Compose surfaces replace routine routes.
- **Firebase messaging service:** a short-lived native Android component that
  can receive FCM callbacks while the activity and WebView are absent. It is
  not an Android foreground service.
- **Foreground activity service:** a future, explicitly enabled long-running
  native component with a persistent notification. It is not required for
  ordinary FCM delivery.

## Client Asset Channels

Local Android development runs and debug APKs bundle client assets built from
the current checkout. They do not require a website deployment. Rerunning the
development or debug command incorporates locally edited JavaScript.

A separate hosted release-channel build uses
`https://latest.yepanywhere.com/`. That client is deployed after successful
main-branch pushes and gives Play-installed test builds the shortest iteration
loop without confusing local source iteration with hosted iteration.

The rules are:

- an explicit build-time URL remains authoritative;
- local debug and ordinary production builds do not silently inherit `latest`;
- the hosted channel URL is fixed at build time rather than editable by
  arbitrary hosted content;
- Play internal or closed testing is the normal consumer of hosted `latest`;
- an early public release uses `latest` only through a deliberate release
  decision; and
- loading a remote client does not itself grant that origin native IPC.

The package commands are:

```text
pnpm --filter @yep-anywhere/android dev:android
pnpm --filter @yep-anywhere/android build:android:debug
pnpm --filter @yep-anywhere/android build:android:hosted-latest
```

The first two commands use locally built assets. The ordinary `build:android`
path also retains bundled assets. The third command produces a release build
whose foreground client is hosted `latest`.

Physical channel verification on 2026-07-31 built and installed the old hosted
APK on the Pixel 9 and loaded the current `latest` login UI. Replacement
verification on 2026-08-02 loaded the same channel through the first-class
Android-owned WebView on the `jstorrent-dev` AVD, confirmed that its APK
contains no packaged client JavaScript or CSS, and found none of the Wry
property-redefinition errors emitted by the old shell.

The same device also ran a debug APK built after a local client edit. Its
foreground client loaded from the packaged Tauri app origin, and the launch
produced no failed browser service-worker registration.

## Ownership Boundary

| Owner | State and responsibility |
| --- | --- |
| Firebase SDK/service | Current FID, registration callbacks, and incoming FCM messages |
| Native Android wrapper | Broker installation capability, notification permission/channels, subscription-to-server routing, notification taps, and any future foreground service |
| Hosted YA client | SRP login, current authenticated YA connection, user-facing enable/disable controls, and compatibility fallback |
| User-operated YA server | Server-specific broker subscription and send secret, notification-trigger policy, and revocation state |
| Push broker | FID target mapping, subscription authentication/rate limits, and FCM submission |

The FID is a delivery target, not the user's YA credential. The more powerful
native secret is the broker installation-management capability because it can
replace the FID target and create or revoke server-specific subscriptions.
Both stay out of hosted JavaScript.

Native persistence should use app-private, Android Keystore-backed storage for
the installation capability and subscription routing records. The exact
storage library is an implementation choice. Do not store these values in the
hosted origin's `localStorage`.

## Minimal Hosted-Client Native Host

The hosted client feature-detects the Android host in two stages:

1. test for the exact-origin `window.yaNative` message object; and
2. invoke the protocol-1 `host.describe` request through the typed client
   adapter.

A missing message object, rejected request, unknown method, version mismatch,
or request timeout means "native host unavailable." The normal browser UI
keeps working and existing Web Push remains available.

The native host should expose high-level operations, not general native
primitives:

- read native-host protocol version and supported feature names;
- read notification permission/enrollment status without secrets;
- request notification permission from an explicit user action;
- prepare or reuse a server-specific broker subscription;
- confirm or cancel that subscription after the YA server accepts or rejects
  it; and
- disable/revoke a server-specific subscription.

Preparing a subscription may return only the broker endpoint, opaque
subscription id, and one-time server send secret. The authenticated hosted
client passes those values directly to the YA server and does not persist the
secret. The command does not return the FID, broker installation secret,
Keystore data, arbitrary files, an unrestricted HTTP client, or a generic
native command channel.

The hosted origin is an important security boundary. Before any notification
operation is enabled for it:

- register Android's WebView message listener before navigation with exact
  approved HTTPS origin rules and no wildcard;
- accept messages only from the main frame and recheck the supplied origin on
  every request;
- keep hosted `latest` and stable production origins explicit rather than using
  a wildcard subdomain; and
- enforce argument validation and server/subscription ownership again inside
  each native operation.

Native events are not required for enrollment v1. If later used for
notification taps or live state, they need the same feature detection and
document-bound message channel. A safe native navigation or opaque
launch-context read is preferable to exposing a generic event or evaluation
channel. The exact host envelope, origin, lifecycle, and removal sequence live
in the first-class shell plan.

### First-class shell handoff — 2026-08-02

The Android application now lives at `packages/android` and needs no Tauri,
Rust, Cargo, or generated host project. Bundled and hosted channels both use
the protocol-1 native host, while an ordinary browser sees a quiet absent-host
fallback. Connected tests prove main-frame/origin authority and document
lifecycle behavior on Android API 37.

`host.describe` intentionally returns an empty `features` list. The next slice
must add each notification operation and its exact feature name together; it
must not infer notification authority merely from `platform: "android"`.
App-private broker installation storage, FID replacement, permission/channel
state, and non-secret status reads can be implemented before the YA-server
contract. Enrollment calls from the client remain behind the compatibility
review below.

## Push Enrollment Sequence

1. Firebase invokes `onRegistered()` with the current FID.
2. Native code records that target and creates or updates its broker
   installation without involving the WebView.
3. The user signs into one YA server through the hosted client and explicitly
   enables native notifications.
4. The client confirms the native host and notification permission.
5. Native code creates or reuses one broker subscription for that server.
6. The native host returns only the server-scoped subscription id/send secret.
7. The client sends that capability to the authenticated YA server.
8. After server acceptance, native code marks the subscription mapping active.
9. The YA server can submit bounded notification intents using its send secret.

The native mapping associates the opaque subscription id with a local server
profile and safe app destination. The broker payload does not select an
arbitrary URL.

Registration replacement remains event-driven. The registration callback is an
opportunity to update the broker target; it does not start a polling loop or
recreate server subscriptions. Exact offline retry, invalid-target cleanup, and
reinstall behavior remain gated on live broker observations as required by the
FCM topic.

## Notification Behavior

The normal default is push-only and has no long-running foreground service.

- FCM may start the app process and Firebase messaging service without
  creating `MainActivity` or a WebView.
- The current broker message contains fixed notification copy plus an opaque
  subscription id and intent. It contains no server URL or user-generated
  text in generic mode.
- Android can place background notification messages in the system tray.
  While the UI is foregrounded, the messaging service must post equivalent
  app-owned notification behavior if the product wants a visible alert.
- Tapping resolves the subscription id through native storage, opens the known
  server's inbox or monitor route, and lets the authenticated client fetch
  current state. Unknown or revoked mappings open a neutral app home rather
  than trusting message-supplied navigation.
- Notification receipt itself does not fetch session data, start the WebView,
  or hold a relay socket.
- The packaged Android client skips browser service-worker registration on its
  app-assets origin. Native Firebase delivery remains independent of the
  WebView; hosted HTTPS clients remain eligible for browser PWA registration.
- Permission denial or disabled notification channels leave ordinary app use
  intact and produce a visible disabled status when the user next opens the
  app.

Notification channels should separate ordinary YA activity from the persistent
notification of a future foreground activity service. Coalescing and alert
sound policy should be selected with live traffic rather than encoded in the
bridge.

## Foreground Activity Direction

Foreground activity is optional and default-off. FCM is the first product path
and should be evaluated before building a persistent subscriber.

If added, the user starts it from a visible app action. It displays a persistent
notification with status and a **Stop** action, stops all owned connections when
disabled, and never auto-starts merely because an FCM message arrived. This
respects Android background-start limits and makes the battery/network cost
explicit.

An invisible hosted WebView is not the target implementation for a claimed
low-memory persistent subscriber. The current browser `/-/monitor` route owns
React state, browser storage, several encrypted source runtimes, and teardown
semantics; keeping that entire renderer alive would be a useful diagnostic at
most, not the production background architecture.

A real persistent subscriber needs a headless connection core in native/Rust
or a deliberately embedded shared runtime. It would need to own:

- broker-independent relay/direct connection configuration;
- one independent SRP/resume identity and encrypted transport per YA server;
- relay `/mux` discovery with exact legacy `/ws` fallback;
- a bounded summary/activity subscription rather than full transcripts;
- coordinated reconnect with no overlapping per-server retry storms; and
- deterministic teardown of sockets, heartbeats, timers, and credentials.

That is materially larger than native push. Do not begin it until FCM delivery
measurements show a user problem it would solve or the native summary UI needs
live state strongly enough to justify the cost.

## Native Session Handoff

The selected later foreground UI is a Compose Conversation-view renderer, not
an invisible WebView or a native rewrite of the full web application. Its first
slice consumes saved semantic projection fixtures read-only. It then needs a
bounded, capability-gated projection and a foreground connection core before it
can replace the wrapper's normal session route.

Until that work lands, notification taps may continue into the known WebView
route. Once native session detail is available, routine taps should open native
Conversation view and expose an explicit full-activity action for rich tool
inspection. Approvals remain on the full presentation until native provides
enough command, diff, and provider-specific context for an informed response.
This handoff does not add native-session implementation slices to the current
notification plan.

## Compatibility Boundary

Native-host feature detection is client-local and does not require a YA server
change. Push enrollment does.

Before implementing YA server enrollment routes or fields, perform the required
stable-release compatibility review. The intended optional-feature fallback is:

- a new hosted client hides native push enrollment unless both the native host
  and a new server capability are present;
- older servers receive no unsupported request;
- browser Web Push and ordinary remote use remain unchanged; and
- absence of native enrollment never blocks login, session browsing, or FCM
  registration at the app-installation level.

The exact server capability, route schema, server storage, and revocation order
remain an approval gate rather than being committed by this plan.

## Implementation Slices

1. **Asset channels — complete:** local development, debug APKs, and ordinary
   production builds are bundled; the explicit hosted-`latest` channel remains
   available for Play testing.
2. **Native foundation — next:** add native secure storage,
   permission/channel state, and versioned notification operations to the
   first-class shell's exact-origin host channel.
3. **Live broker lifecycle:** exercise real broker installation creation and
   FID replacement before prescribing retry or cleanup behavior.
4. **Compatibility review and enrollment:** audit stable YA releases, approve
   the optional capability/fallback, then add the narrow server subscription
   contract and hosted-client controls.
5. **Notification presentation:** validate background, foreground, denied
   permission, tap routing, unknown mapping, process death, and cold-start
   behavior on physical devices.
6. **Foreground activity decision:** measure FCM first; build a headless
   persistent subscriber only if a concrete trigger is met.

## Verification

- A debug run and debug APK use current-checkout client assets without a
  website deployment.
- A packaged debug launch does not attempt browser service-worker registration
  on the Android app-assets origin.
- The hosted-`latest` release build loads the fixed hosted origin and packages
  no client JavaScript or CSS.
- An ordinary production build still uses its packaged client assets, and an
  explicit build-time override wins.
- Receiving an FCM message with the UI closed does not create a WebView.
- Browser use and hosted use outside the wrapper behave normally when every
  native-host request is unavailable or denied.
- Remote content cannot invoke undeclared Android host operations.
- The hosted client never observes the FID or installation-management secret.
- One server cannot create, revoke, or route another server's subscription.
- Notification taps never navigate to a URL supplied by an FCM payload.
- Disabling enrollment revokes the intended mapping without affecting other
  paired servers.
- Foreground activity, if later implemented, has an explicit owner and leaves
  no socket, retry, timer, or persistent notification after stop.
