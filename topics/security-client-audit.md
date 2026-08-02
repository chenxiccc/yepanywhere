# Security Clients And Authentication Audit

> YA records authenticated client installations as first-class security
> clients so an operator can recognize browsers and native applications,
> inspect how they authenticated, and revoke the right relationship. Capable
> clients prove continuity with a per-server signing key; optional platform
> attestation may raise confidence later without becoming the baseline access
> requirement.

Topic: security-client-audit

Status: Unified v1 contract approved on 2026-08-02. Android is the first
required continuity-key consumer. Capable web clients use the same API and a
non-extractable WebCrypto key, while the server projects existing browser
profile and remote-session state into the audit surface for legacy clients.
Native push is an optional child capability. Hardware/platform attestation,
WebAuthn step-up, and native desktop key ownership are recorded future
extensions rather than v1 requirements.

Related:

- [Mobile server pairing](mobile-server-pairing.md)
- [Android FCM push](android-fcm-push.md)
- [Browser profile devices](browser-profile-devices.md)
- [WebSocket auth state](../docs/project/ws-auth-state-model.md)
- [Server capabilities](server-capabilities.md)
- [Remote hosted compatibility](remote-hosted-compatibility.md)
- [Hard development rules](hard-development-rules.md)
- [Security-client and native-push implementation](../docs/tactical/082-security-client-registration-and-native-push.md)

## Product Contract

The security dashboard must answer, from the user's own YA server:

- Which clients have successfully authenticated?
- Is this a recognizable phone, browser, or desktop application?
- When and how did it authenticate, and was the path direct or relayed?
- Is the current client the same key-holding installation that registered
  earlier?
- Which resume sessions and push authority belong to it?
- What will be invalidated if the user revokes it?

Detailed client-reported information is useful even though a deliberately
malicious client can lie. Password reuse and copied resume material are
important realistic attacks; an attacker using the ordinary Android app,
desktop app, or web client will leave a new key, client record, environment
description, route, and authentication history. The UI distinguishes
client-reported details from server-observed facts and proof status instead of
discarding useful evidence because it is not platform-attested.

This is distinct from the external push-broker boundary. A phone may report
detailed device information to its owner's SRP-authenticated YA server. The YA
server still never receives the FCM/FID target or the broker
installation-management secret because those belong to the broker delivery
boundary and are unnecessary for server audit or notification submission.

## Concepts

| Concept | Meaning | Authority |
| --- | --- | --- |
| Security client | One server-side audit and revocation record for a client installation | Server-generated opaque id |
| Client descriptor | Structured, mutable device/app/environment snapshot | Client-reported |
| Client continuity key | Per-YA-server P-256 signing key retained by the client | Private key possession |
| Authentication observation | Bounded historical record of a successful login/check-in | Mixed reported and server-observed facts |
| SRP resume session | Expiring bearer-equivalent authentication credential | Existing SRP session key |
| Native push subscription | One broker send capability belonging to one registered native client | Broker subscription secret |
| Platform attestation | Optional third-party or hardware evidence about a client key/app/device | Attestation verifier |

A security-client id and client-reported installation id are not credentials.
The current SRP or cookie authentication authorizes an audit observation. V1
accepts a continuity-key registration/check-in proof only when the private
server context also contains a fresh SRP transport nonce; a registered key then
proves that the same key-holding client performed later SRP check-ins. A
cookie-only browser remains an authenticated/legacy observation until a future
one-time server challenge gives that transport an equally fresh proof input.

## Current Browser Profile Purpose

The existing browser profile id is a random value stored in browser
`localStorage`. YA currently uses it to group tabs from one storage profile,
associate Web Push subscriptions, suppress Web Push while that profile is
connected, retain origin/user-agent history, and link full-SRP-created resume
sessions to an approximate browser installation. It is client-asserted and is
not authentication.

The web client currently sends that id plus origin and user agent in plaintext
`srp_hello` during full SRP, then sends them again inside the encrypted activity
subscription. A relay already observes the browser's network address, user
agent, and `Origin` header during its WebSocket upgrade, but the profile id adds
a stable correlation value the relay would not otherwise receive.

Do not add more fingerprint fields to plaintext SRP messages. A future
compatibility-reviewed cleanup should omit the optional profile and origin
metadata from `srp_hello` and rely on the encrypted post-authentication
check-in. Until then, capable web clients add the unified check-in while legacy
activity subscription behavior remains the fallback against older servers.

## Unified V1 API

The permanent exact capability is `security-client-audit-v1`, introduced in
YA `0.7.1`. It owns:

```text
POST   /api/security/clients/register
POST   /api/security/clients/:clientId/check-in
GET    /api/security/clients
GET    /api/security/clients/:clientId
GET    /api/security/clients/:clientId/events
DELETE /api/security/clients/:clientId
```

Registration and check-in require a server-injected authenticated transport
context. A client cannot manufacture that context with an HTTP header. The
context identifies the authenticated username and authentication session; for
SRP it also supplies the current session id, fresh transport nonce,
authentication method, and direct/relay route. Proof-bearing registration and
check-in are sent only after SRP succeeds, through the encrypted application
channel. Ordinary cookie-authenticated browser observations may be projected
or recorded without claiming continuity-key assurance.

`POST /register` accepts a strict, bounded body:

```json
{
  "requestId": "client-generated UUID",
  "kind": "android-native",
  "label": "Kyle's Pixel",
  "descriptorVersion": 1,
  "descriptor": {},
  "key": {
    "protocol": "client-key-p256-v1",
    "publicKeySpki": "base64url DER SubjectPublicKeyInfo",
    "signature": "base64url DER ECDSA signature",
    "reportedStorage": "android-keystore"
  }
}
```

`requestId` makes registration idempotent if the encrypted response is lost.
The server generates and returns the opaque `clientId`; it stores the request
id only for idempotency and never treats it as authentication. Android-native
registration requires a valid key proof. A capable web client should provide a
WebCrypto key proof, but failure to use WebCrypto must not block ordinary web
login or the legacy audit projection.

`POST /:clientId/check-in` runs once per newly authenticated connection, not
once per application request. It carries the current descriptor and a fresh
continuity-key signature. The operation:

- verifies that the key registered for the client signed this connection's
  transcript and current descriptor;
- associates the current expiring authentication session with the client;
- updates the current descriptor without changing client identity;
- records a bounded authentication or descriptor-change observation; and
- returns the server-determined assurance and current public client summary.

Android OS/app/security-patch, locale, timezone, network, and other descriptor
changes never require password login or re-pairing. The existing key signs the
new snapshot. Full SRP is required only under the existing resume expiry,
eviction, restart, password-change, or explicit revocation rules. Loss of the
continuity key creates a new client relationship rather than silently taking
over an old record.

The read routes never expose public keys unless a future explicit diagnostic
contract requires them, and never expose SRP keys, push send secrets, broker
installation credentials, FCM/FID targets, signature transcripts, or raw
attestation secrets. They return recognizable summaries, assurance, current
descriptor, associated session summaries, push status, and bounded events.

Deleting a security client responds first, then invalidates every associated
resume session, closes its active sockets, and removes its push authority.
Deleting a legacy projected browser entry must use the existing browser-profile
and remote-session ownership rather than pretending it had a continuity key.

## Continuity-Key Protocol

V1 uses P-256 ECDSA with SHA-256. It needs no new crypto runtime dependency:

- Android generates and signs through `AndroidKeyStore` using
  `KeyPairGenerator`, `KeyGenParameterSpec`, and `SHA256withECDSA`;
- web uses a non-extractable WebCrypto P-256 private key stored in IndexedDB;
- the future desktop baseline may use WebCrypto in its extension-free bundled
  WebView; and
- the server imports SPKI and verifies DER ECDSA signatures with Node
  `crypto`.

Keys are per YA-server relationship. The private key never crosses the client
boundary. The server stores the public key and its SHA-256 fingerprint.

The signature transcript is a versioned, fixed-order, length-prefixed binary
encoding rather than ambient JSON serialization. It binds:

- the domain `yep-security-client-key-v1`;
- operation (`register` or `check-in`) and exact route;
- server-injected authenticated session id;
- the fresh server-generated SRP transport nonce;
- registration request id or server client id; and
- a SHA-256 digest of the complete proof-excluded request body.

Binding the mutable descriptor is essential: a verified signature attributes
the reported snapshot to the same client key. Binding the transport nonce makes
an old signature unusable on another connection. The authenticated transport
context, not client-supplied copies of session id or nonce, is authoritative.

A continuity proof establishes "the same enrolled key signed this current
snapshot." It does not independently certify the truth of manufacturer/model,
the integrity of the application, or the security of the operating system.
Those reported facts are highly useful under the normal threat model and become
stronger when corroborated by optional attestation.

## Client Descriptors And Audit History

Descriptor v1 is a strict union by client kind. Android may report, where the
platform exposes them without new permissions:

- app-scoped installation id and Android-id digest;
- manufacturer, brand, model, product, device class, device name, and Android
  build fingerprint;
- Android release, API level, security patch, locale, and timezone;
- YA package, version name/code, build channel, installer source, signing
  certificate digest, and first-install/last-update times; and
- current app-supported proof/attestation mechanisms.

Web may report:

- its local client-instance id;
- origin, user agent and available User-Agent Client Hints;
- platform, languages, timezone, screen dimensions/pixel ratio, touch points,
  and available browser hardware concurrency/device memory; and
- YA client version/channel.

The server supplies timestamps, authenticated username/session, full-SRP versus
resume versus cookie method, direct versus relay route, active connection
count, and directly observed peer address when that address is actually the
client. A relayed connection must say `relay`; the YA server must not present
its relay peer as the phone/browser address.

Client descriptor bodies are capped at 8 KiB, unknown fields are rejected, and
individual text fields are bounded. Each client retains its current descriptor,
creation/revocation anchors, and the latest 256 observations. Repeated
check-ins whose descriptor and relevant server-observed facts are unchanged may
coalesce while still advancing `lastSeenAt`. There is no heartbeat, timer,
poller, or retry loop solely for audit history.

The UI presents recognizable device/browser cards with device-class imagery,
reported model/app/OS information, last activity, current route, session and
push state, and an explicit proof badge. Detail shows the bounded observation
history and a prominent revoke action. It must label proof honestly:

```text
Authenticated session
Client key verified
Hardware attested
Official app/device verified
```

## Legacy Web Projection And Migration

A new server projects current `BrowserProfileService`, connected-browser,
remote-session, and Web Push state into the unified read surface even before a
browser registers a continuity key. Those entries have authenticated-session
or legacy-observation assurance and retain their existing revocation behavior.
No migration invents a private key or silently claims continuity.

A capable new SRP web client checks `security-client-audit-v1` after
authentication. When present, it generates or opens its per-server
non-extractable IndexedDB key, registers idempotently, and checks in once per
authenticated connection. When absent, it performs no new request and keeps
existing browser-profile, activity-subscription, Web Push, and login behavior.
Cookie-only web continuity needs a future one-time challenge route or equivalent
fresh server value; v1 must not pretend that an unbound client timestamp or
nonce provides the same proof.

Removing browser profile metadata from plaintext `srp_hello`, changing Web
Push ownership to the server client id, and deleting legacy browser-profile
storage are later compatibility-reviewed migrations. The unified server
service and read model must not require those cleanups to land Android.

## Native Push Child Contract

The permanent exact capability `native-push-subscriptions-v1`, introduced in
YA `0.7.1`, owns:

```text
PUT    /api/security/clients/:clientId/native-push-subscription
DELETE /api/security/clients/:clientId/native-push-subscription
POST   /api/security/clients/:clientId/native-push-subscription/test
```

Only a current key-verified native client may install its own subscription.
The strict `PUT` body is:

```json
{
  "subscriptionId": "opaque broker id",
  "sendSecret": "one-time broker send capability",
  "privacyMode": "generic"
}
```

The server stores the capability as an owner-only secret child of the security
client and never returns it. Android gives it to the server after creating the
broker subscription and does not retain the send secret after acknowledged
installation. Disable/test/revoke operate only on that child.

`/api/version` includes `nativePush` only with the exact native-push capability:

```json
{
  "nativePush": {
    "protocolVersion": 1,
    "brokerUrl": "https://push.yepanywhere.com/",
    "privacyModes": ["generic"]
  }
}
```

The server reads `YEP_NATIVE_PUSH_BROKER_URL`, defaulting to the official
endpoint, normalizes and advertises that exact value, and never accepts a
client-chosen broker URL. Android enables enrollment only when protocol v1 and
the advertised endpoint exactly match its build configuration. Broker
credentials remain bound to their exact origin; an endpoint change never sends
an old credential to a new broker or silently reroutes delivery.

There is no durable native-push queue or retry loop. The existing notification
settings map approval, question, completed, and failed edges to
`approval_required`, `input_required`, `session_completed`, and
`session_failed`. A broker `404` disables the invalid subscription; a transient
failure waits for a later real event or explicit test.

## Compatibility Decision

This is optional functionality. The stable release corpus reviewed on
2026-08-02 is `v0.7.0` (2026-07-25) and `v0.6.2` (2026-07-11); there are no
other stable releases in the preceding 14 days. Both lack every unified
security-client/native-push route, capability, response field, continuity-key
semantic, and native-push version block described here.

The approved compatibility behavior is:

- add permanent exact capabilities `security-client-audit-v1` and
  `native-push-subscriptions-v1` in `0.7.1`;
- keep `remoteCompatibilityLevel` at 10 and leave every existing capability
  meaning unchanged;
- make no new request until the exact owning capability is known present;
- let an older server continue normal SRP login, native summaries, full web,
  legacy browser profile/Web Push, and remote operation;
- show Android that registration/native push requires a server update rather
  than silently creating an unproved native device; and
- make capable web registration an additive security enhancement whose absence
  never blocks ordinary web use.

## Future Assurance And Step-Up

The v1 schema should admit optional proof evidence without advertising or
accepting an unimplemented attestation type.

Future Android options:

- Android Key Attestation certificate-chain verification for
  TrustedEnvironment/StrongBox key storage, verified boot, application id,
  package/signature digests, OS/security-patch facts, and revocation status;
- optional Play Integrity for users of the official Play-distributed app who
  want Google-backed app/device verdicts; and
- no default denial for source-built, de-Googled, emulator, or older-device
  clients merely because the optional service is unavailable.

Future desktop ownership:

- baseline WebCrypto inside the extension-free bundled Tauri WebView;
- a narrow shell `signPairingChallenge` operation owning a per-server key in
  macOS Keychain/Secure Enclave, Windows CNG/TPM, or the best available Linux
  keystore; and
- platform attestation only where its operational and recovery cost is worth
  the additional assurance.

Future web step-up:

- WebAuthn/platform authenticator or security-key registration as an optional
  higher-assurance factor;
- configurable, default-off policy to require user presence/verification after
  a session has been inactive for a chosen duration or before a sensitive
  operation;
- explicit recovery and grace behavior so a lost authenticator cannot
  accidentally strand the owner; and
- an honest distinction between device-bound credentials and synced passkeys.

WebAuthn is not the automatic check-in key: its user mediation is useful for
step-up, while non-extractable WebCrypto provides silent continuity. These
future mechanisms extend the same security-client record and audit history;
they do not create parallel device dashboards.
