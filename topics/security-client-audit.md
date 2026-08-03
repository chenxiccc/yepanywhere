# Security Clients And Authentication Audit

> YA records authenticated client installations as first-class security
> clients so an operator can recognize browsers and native applications,
> inspect how they authenticated, and revoke the right relationship. Capable
> clients prove continuity with a per-server signing key; optional platform
> attestation may raise confidence later without becoming the baseline access
> requirement.

Topic: security-client-audit

Status: The unified v1 server registry, continuity verification, legacy-web
projection, bounded security ledger, revocation cascade, and Android
registration/check-in are implemented; the physical Pixel checkpoint passed
on 2026-08-02. Capable-web registration, the security dashboard, new-client
alerts, and native push remain pending. Native push is an optional child
capability. Hardware/platform attestation, WebAuthn step-up, cookie continuity
proof, and native desktop key ownership remain future extensions rather than
v1 requirements.

Related:

- [Mobile server pairing](mobile-server-pairing.md)
- [Android FCM push](android-fcm-push.md)
- [Browser profile devices](browser-profile-devices.md)
- [WebSocket auth state](../docs/project/ws-auth-state-model.md)
- [Server capabilities](server-capabilities.md)
- [Remote hosted compatibility](remote-hosted-compatibility.md)
- [Hard development rules](hard-development-rules.md)
- [Vanilla defaults](vanilla-defaults.md)
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
- Which security-relevant events remain visible after a client is revoked or
  a stale web record is eventually pruned?

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
| Security event ledger | Server-global bounded history that survives client removal | Server-observed event plus bounded reported snapshot |
| SRP resume session | Expiring bearer-equivalent authentication credential | Existing SRP session key |
| Native push subscription | One broker send capability belonging to one registered native client | Broker subscription secret |
| Client proof | One member of a client-owned proof set; v1 implements a continuity key | Proof-specific verifier |
| Platform attestation | Optional future third-party or hardware evidence about a client key/app/device | Attestation verifier |

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
PATCH  /api/security/clients/:clientId
GET    /api/security/clients
GET    /api/security/clients/:clientId
GET    /api/security/clients/:clientId/events
GET    /api/security/events
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
id only for idempotency and never treats it as authentication. A repeated
`requestId` returns the existing result only when the same registered public
key signs the retry. A key mismatch is an explicit conflict and can neither
reuse nor replace the existing record. Android-native registration requires a
valid key proof. A capable web client should provide a WebCrypto key proof, but
failure to use WebCrypto must not block ordinary web login or the legacy audit
projection.

`POST /:clientId/check-in` runs once per newly authenticated connection, not
once per application request. It carries the current descriptor and a fresh
continuity-key signature. The operation:

- verifies that the key registered for the client signed this connection's
  transcript and current descriptor;
- associates the current expiring authentication session with the client;
- updates the current descriptor without changing client identity;
- records a bounded authentication or descriptor-change observation; and
- returns the server-determined assurance and current public client summary.

Only one proof-bearing registration/check-in identity may attach to a
connection. An exact idempotent repeat is tolerated; attempting to register or
attach a different client or mutated proof on the same connection fails and is
audited.

Android OS/app/security-patch, locale, timezone, network, and other descriptor
changes never require password login or re-pairing. The existing key signs the
new snapshot. Full SRP is required only under the existing resume expiry,
eviction, restart, password-change, or explicit revocation rules. Loss of the
continuity key creates a new client relationship rather than silently taking
over an old record. Check-in for an unknown id returns a stable
`security_client_unknown` response so an authenticated client may register
again. Check-in for a tombstoned id returns stable
`security_client_revoked`; Android retains the local revoked status, discards
that relationship's continuity key and resume material, and requires an
explicit password-backed re-pair before creating a new relationship.

The read routes never expose public-key bytes, and never expose SRP keys, push
send secrets, broker installation credentials, FCM/FID targets, signature
transcripts, or raw attestation secrets. They do expose each proof's type,
status, storage claim, and SHA-256 public-key fingerprint. The Android client
shows the same full fingerprint in its server-security details so the owner can
manually compare phone and dashboard. Summaries also return assurance, current
descriptor, associated sessions, push status, and bounded events.

`PATCH /:clientId` accepts only a bounded server-owner label override or its
removal. The UI shows this separately from the signed client-reported label,
and the ledger records changes. The override improves recognition but does not
raise proof assurance.

`GET /api/security/events` returns the retained ledger newest-first. Coalesced
failure entries expose their first/last server timestamps and count. A failed
proof event uses only the target's previously verified descriptor snapshot;
the attempted body is never promoted into recognizable device metadata.

Deleting a security client means revoke, not erase. The server atomically marks
and persists the record as revoked and appends the global event before the
cascade. It then responds to the initiating request before invalidating every
associated resume session, closing active sockets, and removing push authority.
The tombstone retains only the display-safe audit record and proof fingerprint;
an in-flight check-in cannot resurrect it. Deleting a legacy projected browser
entry must use the existing browser-profile and remote-session ownership rather
than pretending it had a continuity key, while its global revocation event
survives that deletion.
The server tombstones that legacy profile id, removes its Web Push
subscription, invalidates its profile-associated resume sessions, and closes
currently tracked tabs so the still-connected profile cannot immediately
reappear in the unified inventory. A legacy owner-label override is stored
separately from the browser-reported/device-name label and does not raise its
assurance.

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
boundary. The server stores proof records as a set rather than a single
top-level key. V1 accepts exactly one active `continuity-key` proof containing
the public key and its SHA-256 fingerprint; the collection shape permits a
later old-key-authorized rotation or attached attestation without changing the
security-client identity.

The signature transcript is a versioned, fixed-order, length-prefixed binary
encoding rather than ambient JSON serialization. It binds:

- the domain `yep-security-client-key-v1`;
- operation (`register` or `check-in`) and exact route;
- server-injected authenticated session id;
- the fresh server-generated SRP transport nonce;
- registration request id or server client id; and
- a SHA-256 digest of the complete proof-excluded request body.

The proof body uses recursively key-sorted JSON with JavaScript
`JSON.stringify` scalar and string semantics before hashing. Cross-runtime
implementations must match that byte encoding exactly; in particular `/`
remains `/` rather than the equivalent JSON escape `\/`. The shared fixture
contains a slash-bearing Android build fingerprint so another platform cannot
silently repeat that signature-breaking mismatch.

Binding the mutable descriptor is essential: a verified signature attributes
the reported snapshot to the same client key. Binding the transport nonce makes
an old signature unusable on another connection. The authenticated transport
context, not client-supplied copies of session id or nonce, is authoritative.

Android's `SHA256withECDSA` returns a DER signature. WebCrypto ECDSA returns
IEEE P1363 `r || s`, so the web implementation converts that value to strict
DER before sending it. Cross-runtime vectors cover zero/short coordinates and
the leading-zero padding required when either integer's high bit is set.

The transcript operation registry reserves `rotate-key` and
`upgrade-attestation`, but v1 routes reject them. A later exact capability may
issue a fresh attestation challenge, generate a new key, bind attestation to
that key, and require the old continuity key to authorize rotation onto the
same client record.

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

In addition, the server retains at most 512 security events independently of
individual client records. There is no route that deletes individual ledger
entries. Registration and revocation anchors have a 30-day minimum retention;
if every slot is protected, a new registration fails visibly with an audit
capacity error rather than silently overwriting an anchor. Other entries evict
oldest-first within their quotas. The ledger includes client registration,
owner-label changes, revocation, later pruning, successful full SRP login,
rate-bounded failed SRP login, failed continuity proof, and associated
resume-session eviction. Events contain server time, route/auth facts, a client
id when known, and only the minimum recognizable descriptor snapshot needed
after a record is gone. They never contain passwords, SRP values, session keys,
signatures, raw public keys, push secrets, or FCM identifiers.

The persisted client and ledger file is fail-closed state. A genuinely missing
file initializes an empty service; malformed JSON, an unsupported version,
invalid records, or an unreadable existing file prevents the security-client
service—and therefore the server—from initializing. YA preserves the file for
operator recovery and never converts load failure into an empty writable
ledger that could forget a revocation or overwrite audit history.

Failure traffic must not erase useful history by filling the ring. Repeated
failures coalesce into counted windows by bounded server-observed keys, and
failure summaries consume at most one quarter of retained ledger entries.
Failed continuity proofs also add a rate-bounded observation to the addressed
client when it exists. A malformed or wrong-key request can never update its
descriptor, last successful check-in, proof set, owner label, session binding,
or push authority.

The UI presents recognizable device/browser cards with device-class imagery,
reported model/app/OS information, last activity, current route, session and
push state, abbreviated key fingerprint, owner override when present, and an
explicit proof badge. Detail shows the full fingerprint, bounded per-client
observations, server-wide security history, and a prominent revoke action. It
must label proof honestly:

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

WebCrypto and IndexedDB are origin-scoped. The same browser installation
reaching one YA server through localhost, a LAN address, a VPN hostname, and a
hosted remote origin may therefore create distinct key-verified web records.
That is honest separation between storage/extension contexts, not a failed
deduplication. The dashboard explains the origin on each web record.

Removing browser profile metadata from plaintext `srp_hello`, changing Web
Push ownership to the server client id, and deleting legacy browser-profile
storage are later compatibility-reviewed migrations. The unified server
service and read model must not require those cleanups to land Android.

Stale, session-less, push-less web records are eventually eligible for the
same 30-day/oldest-first bounded pruning policy as browser profiles. Automatic
pruning is deferred from the initial implementation and must never remove a
key-verified native client or any push-holding client. The server-wide ledger
retains a compact pruning event after the record disappears.

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
`session_failed`. V1 also adds an independently configurable `securityEvent`
category and generic `security_event` transport intent. It is default-off under
the vanilla-defaults contract. When enabled, registering a genuinely new
client notifies already-enrolled destinations, never the destination created by
that same transaction; the generic payload says only that a new client signed
in and the recipient fetches current details from YA. Retries of an idempotent
registration do not alert again. Failed attempts remain dashboard evidence in
v1 rather than push-alert sources, avoiding attacker-controlled alert floods.
New-client alerts are also rate-bounded per destination: the first eligible
event in a 15-minute window sends immediately and later events in that window
remain in the ledger without a deferred timer. A broker `404` disables the
invalid subscription; a transient failure waits for a later real event or
explicit test.

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

`securityEvent` is an additive notification-settings response member whose UI
and writes are gated by `security-client-audit-v1`. Older clients ignore it;
new clients neither show it nor send it to an older server. The existing push
capability and notification-setting meanings otherwise stay unchanged.

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

Android Key Attestation cannot be retrofitted to an already-generated v1 key:
the platform requires a fresh server challenge at key generation. The upgrade
therefore issues a challenge, generates a new attested key, verifies the
attestation, and has the old key authorize rotation onto the same record.

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

WebAuthn credentials are RP-ID/origin scoped. YA can reach the same server via
localhost, LAN IP, VPN name, and the hosted remote client, so step-up must use
per-origin registrations or explicitly choose which access origins it covers.
It cannot silently promise one passkey valid across every YA route.

WebAuthn is not the automatic check-in key: its user mediation is useful for
step-up, while non-extractable WebCrypto provides silent continuity. These
future mechanisms extend the same security-client record and audit history;
they do not create parallel device dashboards.

## Deferred Follow-Ups

The initial implementation deliberately leaves these separately reviewable:

1. Add the cookie one-time challenge so `local_cookie_trusted` browsers can
   prove silent WebCrypto continuity without pretending cookie auth has an SRP
   nonce. This is the highest-priority post-v1 web assurance improvement.
2. Add attestation challenge and old-key-authorized `rotate-key` support, then
   optional Android Key Attestation/Play Integrity and desktop keystore proofs.
3. Add per-origin WebAuthn registration and configurable, default-off
   inactivity/sensitive-operation step-up with recovery and grace behavior.
4. Migrate browser Web Push ownership from body-supplied `browserProfileId` to
   authenticated security-client ownership. Until then any authenticated
   client can replace another profile's subscription under the existing
   mutual-trust model.
5. Remove optional profile/origin metadata from plaintext `srp_hello` after the
   required compatibility review.
6. Implement bounded stale web-record pruning after real dashboard behavior is
   observed.
7. Revisit the five-session-per-user cap and in-memory persistence default
   using Android/native-plus-bundled-web eviction and restart evidence. Session
   evictions must already be audited; any default change remains an explicit
   security/deployment decision.
