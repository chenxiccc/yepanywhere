# Android FCM Push

> The published YA Android app uses a small hosted push broker to turn
> revocable, per-server device push subscriptions into FCM notifications while
> self-hosted YA servers and relays remain under their operators' control.

Topic: android-fcm-push

Status: Approved architecture direction. The credential-free broker v1 is
implemented, deployed, and proven through FCM to a physical Pixel. The current
Android shell owns notification permission/channel status and a
Keystore-backed broker installation whose FCM target follows FID replacement.
The unified security-client and native-push server contracts are approved but
not implemented; server-specific subscriptions and native notification
presentation remain the active slice. The obsolete Tauri Mobile source has
been removed.

Related:

- [Notifications system overview](notifications.md)
- [Push broker v1 tactical plan](../docs/tactical/068-push-broker-v1.md)
- [Android FCM live smoke](../docs/tactical/069-android-fcm-live-smoke.md)
- [Android wrapper and notification integration](../docs/tactical/071-android-wrapper-notification-integration.md)
- [First-class Android shell](../docs/tactical/080-first-class-android-shell.md)
- [Mobile companion app](../docs/project/mobile-companion-app.md)
- [Mobile server pairing](mobile-server-pairing.md)
- [Security clients and authentication audit](security-client-audit.md)
- [Relay design](../docs/project/relay-design.md)
- [Relay client mux](relay-client-mux.md)
- [Web Push notifications](../docs/push-notifications.md)
- [Hard development rules](hard-development-rules.md)

## Product Boundary

YA servers and relays remain self-hostable. The normal published Android app
belongs to the YA Firebase project and uses a YA-hosted push broker because the
Firebase service-account credentials for that app cannot be distributed to
arbitrary server installations.

The push broker is not an account system or application-traffic relay. It
should know only what it needs to register Android installations, authorize and
rate-limit notification requests, and dispatch them through FCM.

The published service endpoint is `https://push.yepanywhere.com`. The
public name and protocol should use provider-neutral push terminology even
though FCM is the first delivery implementation.

Existing browser Web Push/VAPID remains supported independently. Native FCM is
an additional Android delivery target, not a replacement for self-hosted Web
Push.

## Service Boundary

The hosted push broker should be a separate runtime service from the relay. The
two services may share physical hosting, but they should not share a process,
event loop, database, or delivery credentials.

The official push broker is Linux-hosted infrastructure. Windows is not a
supported deployment target, so the push-broker package test command exits
before loading broker dependencies on native Windows. Linux CI remains the
authoritative broker verification environment; macOS development runs may
continue exercising the same package tests.

This preserves the relay's latency-sensitive opaque forwarding path, allows
broker persistence and outbound provider calls to proceed independently, and
keeps Firebase credentials outside the relay's otherwise narrow trust boundary.
Broker deployments and restarts should not disconnect live relay circuits, and
the public push endpoint should be movable without changing the relay endpoint.

## Trust Model

After an SRP-authorized device pairing, the YA Android app and the user's YA
server are fully trusted with each other's device-specific push material. The
operator is responsible for protecting secrets stored by their server, just as
they are for existing auth state and VAPID keys. Push is an optional child of
the durable paired-device relationship; it is not device authentication.

The hosted broker has narrower trust:

- it alone holds the official Firebase service-account credentials;
- it may store Android installation identifiers, current FCM delivery
  registrations, subscription associations, optional server/relay labels,
  privacy preferences, and delivery/rate-limit metadata;
- it does not receive SRP passwords or relay session keys; and
- it must not become a transcript or general YA message service.

An FCM registration does not need to be hidden from the Android app or its
authenticated YA server. Keeping the broker's current registration mapping is
primarily a delivery-lifecycle convenience, not a trust boundary between the
phone and server.

## Login And Push Enrollment

The default server-pairing path is the existing username/password SRP flow over
a direct or relay connection. The native Kotlin core owns that native login and
its Keystore-backed resume credential. Push enrollment happens only after the
server records the authenticated paired device:

1. The user logs the native YA Android client into a YA server with SRP and
   establishes the paired-device relationship.
2. The user enables native notifications for that server.
3. The Android app creates a device push subscription through the configured
   broker.
4. The Android app gives the resulting subscription credentials to the trusted
   YA server over the authenticated, encrypted connection.
5. The YA server stores those credentials under the paired device and uses
   them for future notification requests.

A discovery-only QR may make the SRP device login easier by carrying route
hints and the SRP username; it does not replace the password. Any future
passwordless grant requires step-up authorization and its own security and
compatibility review. Neither QR form is a separate push authorization model.

## Device Push Subscription

A device push subscription is conceptually similar to the Web Push
subscription YA already stores. It is a one-way capability allowing one YA
server to request notifications for one Android installation.

Its conceptual fields are:

- broker endpoint;
- opaque subscription id; and
- high-entropy send secret.

These names describe the authority boundary, not a committed wire schema. The
opaque id identifies broker state; the send secret authorizes delivery. The
broker should store a verifier or hash rather than plaintext when its chosen
authentication scheme permits that.

One subscription per paired YA-server/Android-installation relationship permits
independent attribution, rate limiting, muting, and revocation. It is not a
chat room, a relay circuit, or an address that another server can discover by
username.

The broker maps the stable subscription to the Android installation's current
FCM delivery registration. The YA server may also know that registration, but
it should not need to use it as its durable destination.

The credential-free broker milestone separates two capabilities:

- an installation-management secret creates and revokes server-specific
  subscriptions and replaces the installation's current provider target; and
- each subscription has its own send secret, which can request notifications
  for that installation but cannot read or replace its provider target.

Both secrets are generated by the broker, returned once, and stored only as
verifiers by the broker. Unknown, revoked, and incorrectly authenticated
capabilities have the same externally visible failure.

Routes that await request-body parsing authenticate again immediately before
mutating installation state or submitting to the provider. The preliminary
authentication rejects invalid capabilities before that work and, for sends,
supplies stable rate-limit keys; it cannot authorize work after a concurrent
revocation.

## Credential-Free Broker V1 Contract

The standalone TypeScript service under `packages/push-broker/` exposes:

- `POST /v1/installations` to register one opaque FCM delivery target and
  receive an installation id and management secret;
- authenticated replacement and deletion beneath
  `/v1/installations/:installationId`;
- authenticated subscription creation and revocation beneath that
  installation; and
- `POST /v1/subscriptions/:subscriptionId/notifications` to submit one generic
  intent with the subscription send secret.

The send route never accepts a provider target. Installation and send secrets
are random 256-bit values returned once and retained by the broker only as
SHA-256 verifiers. Revocation prevents later requests; a provider submission
already in flight cannot be recalled.

Defined JSON bodies are limited to 8 KiB and reject unknown fields. Mutation
responses use `Cache-Control: no-store`. Invalid bodies return `400`, missing
JSON content type returns `415`, oversized bodies return `413`, unknown or
unauthorized capabilities return `404`, subscription-cap exhaustion returns
`409`, and rate limits return `429` with `Retry-After`.

The credential-free provider contract waits at most ten seconds. Accepted
provider submissions return `202`, retryable failures return `503`, and
rejections return `502`. There is no broker-owned queue or retry loop.

The conservative process-local limits are:

- 120 mutation requests per minute per source IP;
- 10 installation registrations per hour per source IP;
- 30 notification submissions per minute per subscription;
- 120 notification submissions per minute per installation; and
- 20 active subscriptions per installation.

These counters are bounded in memory and reset on restart. Forwarding headers
affect their source-IP key only when the immediate peer is in the explicit
trusted-proxy configuration. Durable or distributed quotas remain deployment
work.

The fake provider is non-production only. FCM mode requires an explicit
Firebase project id and uses Application Default Credentials. The process
binds to loopback by default; explicit host, port, data directory, provider
timeout, log level, and trusted-proxy settings are authoritative.

## Delivery

The intended flow is:

```text
YA server
  -> authenticated notification request for one device push subscription
  -> YA-hosted push broker
  -> FCM
  -> YA Android app / Android notification tray
```

The broker authenticates the subscription, applies payload policy and rate
limits, resolves the current FCM delivery registration, and submits the
message. Notification requests do not choose an arbitrary FCM registration or
relay username.

The credential-free v1 submits directly to its configured provider and returns
only after that submission succeeds or fails. It has no durable delivery queue,
retry loop, acknowledgement protocol, or delivery guarantee. Those mechanisms
must be justified by observed live-provider behavior before being added.

The broker may store a normalized relay origin, relay username, and
user-visible server label with the subscription. Those fields support
attribution, diagnostics, and secondary rate limits; they are not notification
authorization.

Primary abuse controls are based on the subscription, Android installation,
and source IP. Relay-origin/username limits may supplement them. The v1 limits
are recorded above; durable quotas, coalescing keys, retry policy, and
idempotency rules should be chosen with live broker evidence.

## Notification Privacy Modes

The architecture supports two user choices:

### Generic

The notification contains no user-generated content. The broker receives a
small intent such as "pending input" or "session finished" plus opaque routing
metadata, and sends fixed notification copy. Opening the notification fetches
details from the user's YA server over its normal authenticated connection.

This is the conservative default direction.

The credential-free v1 initially accepted four fixed intents: approval
required, input required, session completed, and session failed. The unified
security-client baseline adds `security_event` for an owner-enabled new-client
alert. Deploy that allowlist addition before a YA server submits the new intent;
an older or self-hosted broker rejects it boundedly and the server does not
queue or retry it. All intents produce bounded fixed copy. The provider payload
contains the intent and opaque subscription id so the app can fetch current
details from its authenticated YA server.

### Descriptive

The user explicitly opts into notification title/body text passing in
plaintext through the YA push broker and Google FCM. This may include bounded
project, session, question, or approval text. The UI must explain that
privacy/functionality trade-off before enabling it.

The broker should validate and forward descriptive payloads without becoming a
durable content store. Exact retention, logging redaction, payload size limits,
and user-facing consent copy belong to the implementation contract.

End-to-end-encrypted rich notification bodies are possible future work, not a
requirement for the first useful Android push path.

## FCM Registration Lifecycle

FCM's delivery registration can change over the lifetime of an Android
installation. The broad ownership rule is simple:

- the Android app uses the supported Firebase SDK lifecycle to learn its
  current delivery registration;
- the broker associates that current registration with stable YA device push
  subscriptions; and
- ordinary FCM refresh should not require the user to repeat SRP login or
  recreate otherwise-valid server/device relationships.

The Android probe pins Firebase Messaging `25.1.1` through BoM `34.16.0`, opts
into FID targeting, and receives the current FID through
`FirebaseMessagingService.onRegistered()`. Firebase auto-initialization
registered a clean app installation without activity code, a custom background
job, or a retry loop. Clearing the dev app's data caused a different FID to be
minted and delivered through the same callback.

The native foundation treats every `onRegistered()` callback as an opportunity
to create the broker installation or replace its target without recreating
future server-specific subscriptions. It does not log or persist the plaintext
FID.

The FID and broker installation capability are native installation state. A
web foreground client does not need either value. The preferred enrollment
path uses the native paired-server connection to install a server-specific send
capability. A future bundled app-assets control may initiate the same explicit
user action or carry the send capability over its own authenticated web
connection, but that is not required for native enrollment and must resolve the
same app-local paired-server profile. Mutable hosted-`latest` content remains
a separate trust decision. The FID and installation-management secret stay
native in every case.

The first native lifecycle has no timer, polling loop, durable job, or internal
retry loop. A missing or pending installation asks FCM to re-emit registration
on the next visible app-process start. Registration callbacks create one broker
installation or replace its target after a FID digest change. A broker `404`
causes one bounded fresh-installation attempt; other failures wait for a later
Firebase/app-start lifecycle trigger.

Real target replacement is proven. Offline app/broker recovery, reinstall or
cleared-app-data behavior, and eventual orphan/stale-record cleanup remain
unresolved and must be measured before broadening this bounded policy.

## Android Foundation Contract

The first-class Android project:

- applies Google Services only when
  `packages/android/app/google-services.json` exists;
- ignores that project-specific file and builds without it, explicitly
  reporting that Firebase messaging is disabled;
- registers a non-exported native messaging service and does not require an
  Activity or WebView for receipt;
- creates an ordinary activity notification channel at process start;
- exposes coarse status and explicit permission requests only through the
  exact-origin, main-frame native host;
- keeps the broker installation capability and last target digest in
  app-private Android Keystore-backed storage excluded from backup;
- uses Firebase auto-initialization plus one app-start registration request
  only while installation work is absent or pending; and
- does not display an app-owned notification, fetch YA state, or create a
  server-specific broker subscription.

The plaintext FID is sent directly to the configured HTTPS broker and is never
persisted or returned to JavaScript. Debug builds log only coarse registration
outcomes and received data-key names plus notification presence. FIDs,
notification title/body, broker capabilities, and token values are never
logged. Release builds log none of this diagnostic material.

For notification payloads, foreground receipt invokes the diagnostic service.
With no app process or Activity alive, Firebase/Android owns background tray
presentation and does not invoke `onMessageReceived`; this distinction is
expected and must not be mistaken for a failed delivery.

## First-Class Shell Live Verification

Completed on 2026-08-02 with the configured replacement APK and an attached
Pixel 7a running Android 17 / API 37:

1. A direct Firebase Console test to the current FID produced exactly one
   foreground service callback.
2. The public broker created a temporary installation and subscription,
   accepted `approval_required` with `202`, and produced exactly one foreground
   callback with the expected `intent` and `subscriptionId` data-key names.
3. The same public path accepted a second message after all YA Activities and
   the app process were absent. Android created the generic system notification
   without starting the diagnostic service callback.
4. Notification permission was granted by ADB only for this acceptance test;
   the product still has no permission prompt or enrollment UI.
5. Temporary broker capabilities were deleted, and the FID, Firebase
   configuration, and returned secrets were neither printed nor retained in
   the repository.

## Future Apple Delivery

A future YA iOS app should use the same device push subscription and broker
service rather than introducing another public notification service.

The initial iOS direction is to use Firebase Cloud Messaging's Apple-platform
integration. The iOS app registers through the FCM SDK, Firebase maps that
registration to Apple Push Notification service (APNs), and the broker submits
through the same FCM server interface used for Android. The Firebase project
must be configured with the YA app's APNs authentication material, but YA
servers continue to use the same provider-neutral subscription contract.

This keeps the first iOS delivery path small while leaving direct APNs delivery
as a possible later broker adapter. Adding such an adapter should not require a
new public hostname or a new YA-server subscription model.

iOS silent/background delivery is opportunistic and subject to platform
throttling. The dependable initial product path should use visible
notifications and fetch current details from the authenticated YA server when
the user opens them. Exact Apple notification behavior must be validated during
iOS implementation.

## Self-Hosted And Configured Variants

The mainstream path is:

- published YA Android app;
- official YA Firebase project and push broker;
- any user-operated YA server; and
- either the hosted relay, a self-hosted relay, or a direct connection.

A source-built Android app may expose build-time configuration for alternate
service URLs and may use an operator-owned Firebase project and push broker.
That is an advanced distribution path, not a requirement for ordinary
self-hosting of YA servers and relays.

Explicit broker, relay, and server configuration is authoritative. A client or
server must not silently replace an operator-selected endpoint with the hosted
default.

## Deferred Implementation Decisions

- Hardware Android Key Attestation and Play Integrity remain optional future
  assurance above the required v1 Android Keystore continuity key. Public or
  fingerprinted server installation identity remains deferred as unnecessary
  for the first native lifecycle.
- Live transient-provider-failure validation.
- Registration refresh, invalidation, offline recovery, and stale cleanup.
- Durable quotas, coalescing, acknowledgement, and delivery-result semantics.
- App-attestation requirements for official and source-built distributions.
- Exact generic/descriptive notification settings and disclosure copy.
- Push alerts for failed authentication/proof attempts; v1 keeps rate-bounded
  evidence in the server audit ledger to avoid attacker-controlled alert spam.
- Whether a later iOS release continues through FCM or adds direct APNs as a
  broker delivery adapter.
