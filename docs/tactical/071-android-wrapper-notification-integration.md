# Android Wrapper And Notification Integration

Status: native foundation and live broker installation lifecycle complete on
2026-08-02. YA server enrollment is now sequenced behind stable server
identity, durable paired-device records, and a Kotlin native connection core.
Notification presentation and foreground activity remain future slices.

Topic: android-fcm-push
Topic: mobile-server-pairing

## Origin

The first useful Android app combined the full YA web client with a small
native notification wrapper. It must not keep a WebView alive merely to receive
notifications. The complete bundled web client is now a permanent trusted
presentation alongside Compose rather than merely transitional scaffolding;
hosted `latest` remains a distinct mutable testing channel.

This plan owns the wrapper and notification path. The approved product
direction in
[`mobile-companion-app.md`](../project/mobile-companion-app.md) makes a Compose
Conversation-view session surface the focused native option and retains the
bundled web client as a permanent full-fidelity alternative. Stable server
identity, pairing, native credentials, direct/relay ownership, and the
independent bundled-web connection are fixed in
[`mobile-server-pairing.md`](../../topics/mobile-server-pairing.md); their wire
contracts still require separate compatibility review.

The browser baseline and the provider-neutral Settings/server seam are verified
and recorded in
[`079-notification-delivery-validation-and-native-readiness.md`](079-notification-delivery-validation-and-native-readiness.md)
before the pairing-first server contract is implemented.

This plan distinguishes three things that are easy to conflate:

- **Foreground UI:** a user choice between focused Compose surfaces and an
  Android-owned full-screen bundled WebView; hosted `latest` is a testing
  channel, not the permanent web trust root.
- **Firebase messaging service:** a short-lived native Android component that
  can receive FCM callbacks while the activity and WebView are absent. It is
  not an Android foreground service.
- **Foreground activity service:** a future, explicitly enabled long-running
  native component with a persistent notification. It is not required for
  ordinary FCM delivery.

## Pairing-First Sequencing Decision — 2026-08-02

Do not design the next YA-server API around push alone. The server must first
recognize one durable paired mobile device independently of its expiring SRP
resume sessions and optional broker subscription. The same pairing owns stable
server identity, native route candidates, revocation, and later push state.

The Android native core, not a hidden WebView, owns native SRP/resume,
Keystore-backed credentials, encrypted direct/relay connections, and any
foreground-service subscription. The bundled web client may keep its existing
TypeScript `SecureConnection` and independent browser resume session. A native
web transport is benchmark-gated future work because bridge copying, stream
traffic, uploads, and binary paths may perform worse.

The previous planned narrow hosted-client enrollment API is therefore not the
next slice. First create and approve the stable-identity/paired-device/native-
connection tactical plan. Server-specific push enrollment then attaches the
broker subscription to that relationship.

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
| Native Android app | Paired-server profiles, native SRP/resume, Keystore credentials, direct/relay connection core, broker installation, notification permission/channels, notification routing, and any foreground service |
| Bundled YA web client | Permanent complete UI with its existing independent TypeScript SRP/transport unless measurements justify a native adapter |
| Hosted `latest` client | Mutable testing UI with browser-owned auth and only explicitly reviewed native-host methods |
| User-operated YA server | Stable public server identity, paired-device and revocation state, server-specific broker subscription/send secret, and notification policy |
| Push broker | FID target mapping, subscription authentication/rate limits, and FCM submission |

The FID is a delivery target, not the user's YA credential. The more powerful
native secret is the broker installation-management capability because it can
replace the FID target and create or revoke server-specific subscriptions.
Both stay out of hosted JavaScript.

Native persistence should use app-private, Android Keystore-backed storage for
the installation capability and subscription routing records. The exact
storage library is an implementation choice. Do not store these values in the
hosted origin's `localStorage`.

## Minimal Web-Client Native Host

The web client feature-detects the Android host in two stages:

1. test for the exact-origin `window.yaNative` message object; and
2. invoke the protocol-1 `host.describe` request through the typed client
   adapter.

A missing message object, rejected request, unknown method, version mismatch,
or request timeout means "native host unavailable." The normal browser UI
keeps working and existing Web Push remains available.

The implemented native host exposes high-level operations, not general native
primitives:

- read native-host protocol version and supported feature names;
- read notification permission/enrollment status without secrets;
- request notification permission from an explicit user action.

The earlier plan proposed adding server-specific subscription preparation,
confirmation, and revocation through this host. That remains possible for the
trusted bundled web UI, but it is no longer the assumed enrollment path. The
native paired-server core may perform enrollment directly; hosted `latest`
requires its own explicit trust decision.

If a future reviewed web operation prepares a subscription, it may return only
the broker endpoint, opaque subscription id, and one-time server send secret.
The authenticated hosted or bundled client passes those values directly to the
YA server and does not persist the secret. The command does not return the FID,
broker installation secret, Keystore data, arbitrary files, an unrestricted
HTTP client, or a generic native command channel.

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

At the first-class-shell handoff, `host.describe` intentionally returned an
empty `features` list. The next slice was required to add each notification
operation and its exact feature name together rather than infer notification
authority merely from `platform: "android"`. Server-specific enrollment calls
remain behind the compatibility review below.

### Native notification foundation contract — 2026-08-02

The first native-only slice adds exactly two protocol-1 feature names and
methods:

- `notifications.status` takes no parameters and returns coarse Firebase
  availability, notification permission, activity-channel state, combined
  delivery enablement, and broker-installation readiness; and
- `notifications.requestPermission` takes no parameters, requires a resumed
  foreground activity plus a recent user interaction, and returns the same
  status shape after Android resolves the request. The web adapter allows two
  minutes for Android's user-controlled prompt, while document teardown still
  cancels it immediately.

Neither operation returns the FID, broker endpoint, installation id,
installation-management secret, encrypted storage, or server subscription
material. Unsupported ordinary browsers retain the quiet absent-host fallback.
The methods remain useful before a YA server supports native subscriptions and
therefore do not call or depend on a YA server route.

Android creates the ordinary activity notification channel at process start.
On Android 13 and later, app notification permission is `not_requested`,
`granted`, or `denied`; older Android reports `not_required`. Channel state is
`enabled`, `disabled`, or `not_supported`. Installation state is `ready`,
`update_pending`, `not_registered`, or `unavailable` when Firebase is absent.
Combined delivery is enabled only when app permission/settings and the activity
channel allow presentation.

The official app's broker endpoint defaults to the documented
`https://push.yepanywhere.com` service. A build-time endpoint override remains
authoritative and must be HTTPS. FCM registration creates one broker
installation when none is stored and replaces its target only when the FID
digest changes. The management capability and last successful target digest
are encrypted with an app-private Android Keystore AES-GCM key and excluded
from backup/device transfer. The plaintext FID is never persisted.

Registration work is callback- and app-start-driven, bounded by network
timeouts, and has no timer, polling loop, durable job, or internal retry loop.
A transient replacement failure marks the local installation `update_pending`;
the next visible process start asks FCM to re-emit current registration. A
broker `404` discards the unusable local capability and makes one bounded fresh
registration attempt. Other failures retain existing credentials and wait for
the next lifecycle trigger.

## Push Enrollment Sequence

1. Firebase invokes `onRegistered()` with the current FID.
2. Native code records that target and creates or updates its broker
   installation without involving the WebView.
3. Native onboarding completes SRP with one authenticated server identity and
   creates or resumes its durable paired-device record.
4. The user explicitly enables native notifications for that paired server and
   grants Android permission.
5. Native code creates or reuses one broker subscription for that pairing.
6. The native connection sends only the server-scoped subscription id/send
   secret to the authenticated YA server.
7. The server stores the capability under the paired device.
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

A real persistent subscriber uses the approved Kotlin native connection-core
direction. It needs to own:

- broker-independent relay/direct connection configuration;
- one independent SRP/resume identity and encrypted transport per YA server;
- relay `/mux` discovery with exact legacy `/ws` fallback;
- a bounded summary/activity subscription rather than full transcripts;
- coordinated reconnect with no overlapping per-server retry storms; and
- deterministic teardown of sockets, heartbeats, timers, and credentials.

That is materially larger than native push, but the selected Compose summary UI
now supplies an independent product reason for it. Plan and prove the core in
foreground native UI before allowing a foreground service to own it.

## Native Session Handoff

The selected native foreground UI is a Compose Conversation-view renderer, not
an invisible WebView or a rewrite of the full web application. Its first slice
consumes saved semantic projection fixtures read-only. It then needs a bounded,
capability-gated projection and a foreground connection core before it can own
live native session routes.

Until that work lands, notification taps may continue into the known WebView
route. Once native session detail is available, routine taps may open native
Conversation view and expose the permanent complete-web presentation for rich
tool inspection or user preference. Approvals remain on the full presentation
until native provides enough command, diff, and provider-specific context for
an informed response. This handoff does not make either presentation temporary.

## Compatibility Boundary

Native-host feature detection is client-local and does not require a YA server
change. Push enrollment does.

Before implementing YA server enrollment routes or fields, perform the required
stable-release compatibility review. The intended optional-feature fallback is:

- a new native or bundled-web control hides native push enrollment unless the
  exact paired-device/push capabilities it needs are present;
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
2. **Native foundation — complete:** native secure storage,
   permission/channel state, and versioned notification operations use the
   first-class shell's exact-origin host channel.
3. **Live broker lifecycle — complete:** a physical Pixel created its durable
   broker installation and replaced the live target after FID rotation without
   replacing the installation capability.
4. **Pairing and connection tactical:** define stable server identity, durable
   paired-device state, Kotlin SRP/transport ownership, and the separate
   compatibility gates before adding enrollment routes.
5. **Compatibility review and enrollment:** audit stable YA releases, approve
   the optional capability/fallback, then attach server-specific subscriptions
   to paired devices.
6. **Notification presentation:** validate background, foreground, denied
   permission, tap routing, unknown mapping, process death, and cold-start
   behavior on physical devices.
7. **Foreground activity:** first prove the Kotlin core under visible Compose
   ownership, then add an explicit persistent subscriber with complete stop.

### Native foundation acceptance — 2026-08-02

The config-free matrix passed every Android JVM variant, warning-fatal lint,
bundled debug/release and hosted-`latest` release builds, instrumentation APK
assembly, and APK contract inspection. The typed web adapter passed eight
focused tests and makes no notification request when the exact host feature is
absent. The Android JVM suite covers broker request shape, HTTPS-only endpoint
selection, redirect rejection, credential parsing, create/replace/`404`/failure
state transitions, target hashing, and cleanup after storage failure.

On the attached Pixel 7a, API 37, ten instrumentation tests passed. They prove
the exact feature advertisement, bounded status response, recent-user-action
permission gate, real Android permission resolution, AES-GCM encrypted
capability round-trip, untrusted-origin/subframe denial, and the existing
WebView lifecycle/navigation contracts. Android reports notification permission
allowed and the `ya_activity` channel enabled.

The configured app created one installation through the public broker without
printing identifiers or capabilities. A bounded live-only instrumentation
probe then unregistered and deleted the current Firebase installation, asked
FCM to register again, and observed the stored target digest change while the
same broker installation id remained active. The probe source was removed
after the check; ordinary connected tests do not rotate live Firebase state.

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
