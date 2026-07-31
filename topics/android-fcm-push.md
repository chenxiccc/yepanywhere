# Android FCM Push

> The published YA Android app uses a small hosted push broker to turn
> revocable, per-server device push subscriptions into FCM notifications while
> self-hosted YA servers and relays remain under their operators' control.

Topic: android-fcm-push

Status: Approved architecture direction. No broker, Android FCM integration, or
server subscription protocol is implemented yet. Exact wire formats and FCM
registration-lifecycle mechanics remain implementation work.

Related:

- [Mobile companion app](../docs/project/mobile-companion-app.md)
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

Existing browser Web Push/VAPID remains supported independently. Native FCM is
an additional Android delivery target, not a replacement for self-hosted Web
Push.

## Trust Model

After a successful SRP login, the YA Android app and the user's YA server are
fully trusted with each other's device-specific push material. The operator is
responsible for protecting secrets stored by their server, just as they are for
existing auth state and VAPID keys.

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

The default server-login path is the existing username/password SRP flow over a
direct or relay connection. Push enrollment happens only after that login:

1. The user logs the YA Android app into a YA server with SRP.
2. The user enables native notifications for that server.
3. The Android app creates a device push subscription through the configured
   broker.
4. The Android app gives the resulting subscription credentials to the trusted
   YA server over the authenticated, encrypted connection.
5. The YA server stores those credentials in its data directory and uses them
   for future notification requests.

A future QR or deep-link flow may make the SRP device login easier. It is an
optional login shortcut, not a prerequisite for push and not a separate push
authorization model.

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

One subscription per YA-server/Android-installation relationship permits
independent attribution, rate limiting, muting, and revocation. It is not a
chat room, a relay circuit, or an address that another server can discover by
username.

The broker maps the stable subscription to the Android installation's current
FCM delivery registration. The YA server may also know that registration, but
it should not need to use it as its durable destination.

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

The broker may store a normalized relay origin, relay username, and
user-visible server label with the subscription. Those fields support
attribution, diagnostics, and secondary rate limits; they are not notification
authorization.

Primary abuse controls should be based on the subscription, Android
installation, and source IP. Relay-origin/username limits may supplement them.
Exact quotas, coalescing keys, retry policy, and idempotency rules should be
chosen with the running broker rather than fixed in this concept note.

## Notification Privacy Modes

The architecture supports two user choices:

### Generic

The notification contains no user-generated content. The broker receives a
small intent such as "pending input" or "session finished" plus opaque routing
metadata, and sends fixed notification copy. Opening the notification fetches
details from the user's YA server over its normal authenticated connection.

This is the conservative default direction.

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

Do not prescribe the exact callback API, background job, retry schedule,
offline recovery, stale-registration threshold, or deletion behavior here.
Firebase is evolving from legacy registration-token APIs toward Firebase
Installation ID targeting, and these details should be validated against the
pinned Android SDK and a working broker implementation.

Before this lifecycle is treated as complete, exercise real target refresh,
offline app/broker recovery, reinstall or cleared-app-data behavior, invalid
FCM send responses, and eventual stale-record cleanup. That implementation
work should produce the concrete observable contract.

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

- Exact broker and YA-server HTTP contracts and their compatibility gates.
- Whether the broker initially shares a deployment with the hosted relay.
- Concrete FCM/Firebase SDK version and registration target API.
- Registration refresh, invalidation, offline recovery, and stale cleanup.
- Default quotas, coalescing, acknowledgement, and delivery-result semantics.
- App-attestation requirements for official and source-built distributions.
- Exact generic/descriptive notification settings and disclosure copy.
