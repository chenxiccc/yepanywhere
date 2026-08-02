# Security-Client Registration And Native Push

Status: approved for implementation and amended after source-level design
review on 2026-08-02. This tracker supersedes the mobile-only paired-device
endpoint sketch with one cross-platform security-client API. Android must prove
a Keystore key; capable web clients use WebCrypto; legacy web records remain
visible through a server projection. A server-global security ledger and
opt-in new-client alert make the inventory an actionable audit surface. Native
push is a child of the registered Android client.

Topic: security-client-audit
Topic: mobile-server-pairing
Topic: android-fcm-push

## Contract Owners

- [Security clients and authentication audit](../../topics/security-client-audit.md)
  owns the API, descriptor, proof, history, revocation, compatibility, legacy
  projection, and future assurance ladder.
- [Mobile server pairing](../../topics/mobile-server-pairing.md) owns Android
  paired-server profile and native connection lifecycle.
- [Android FCM push](../../topics/android-fcm-push.md) owns broker credentials,
  notification intent mapping, Android presentation, and tap behavior.
- [Architecture mandates](../../topics/architecture-mandates.md) require
  check-in, delivery, and revocation work to remain bounded and quiescent.

## Compatibility Baseline

The optional-feature corpus is `v0.7.0` and `v0.6.2`. Both predate every route,
capability, continuity proof, audit response, and native-push version field in
this tracker. The approved permanent gates are:

- `security-client-audit-v1`; and
- `native-push-subscriptions-v1`.

Missing gates produce no unsupported request. Android reports that registration
and native push require an update while retaining SRP, native summaries, and
the full web client. Web retains the existing browser-profile/activity/Web Push
path. Existing capability meanings and compatibility level 10 do not change.
The `securityEvent` field is an additive member of the existing notification
settings response, but capable clients show or update it only when
`security-client-audit-v1` is known present; older clients ignore the extra
response member and newer clients never send it to an older server.

## Work Tracker

| Step | State | Completion evidence |
| --- | --- | --- |
| Record the unified security-client contract | complete | Topic contract fixes routes, gates, proof transcript, descriptor/history, legacy projection, revocation, push child, and future assurance |
| Keep default in-memory resume credentials off disk | complete | Every mutation avoids `remote-sessions.json` while persistence is disabled and owner-only persistence remains available when enabled |
| Register capabilities and version metadata | partial | `security-client-audit-v1` owns the exact mounted routes and passes capability/version tests; native-push advertisement remains in its later slice |
| Persist clients, tombstones, and the security ledger | complete | Owner-only strict state, bounded histories/anchors/failures, restart, malformed-state, and no-secret API tests pass |
| Inject authenticated transport facts | complete | Only established SRP gets private proof context; nonce, method, direct/relay kind, real peer, session, and connection handle survive for the socket lifetime |
| Verify P-256 continuity proofs | partial | Node SPKI/DER verification plus P1363, mutation, replay, wrong-route/key, stale-transport, and key-bound retry tests pass; Kotlin canonical framing shares a language-neutral vector and the Android Keystore test is compiled but still needs the Pixel run |
| Project legacy web clients | complete | Browser profiles, connected tabs, remote sessions, and Web Push merge without invented proof; legacy revocation tombstones the profile and closes tabs |
| Audit failed authentication and session eviction | complete | Failed SRP/proof evidence is coalesced and quota-bounded; associated session eviction names the client |
| Revoke the complete client relationship | partial | Atomic tombstones precede session/socket and legacy Web Push cascades with distinct unknown/revoked check-ins; native push is not implemented yet |
| Deliver generic native push | pending | Exact broker endpoint/credential binding, notification-policy mapping, test delivery, 404 invalidation, bounded transient failure, and secret redaction pass |
| Register and check in from Android | partial | Pre-release v2 storage reset, per-server Keystore key, pairing-time register, resume check-in, fingerprint pin, capability fallback, unknown re-registration, and revoked terminal state pass JVM tests; attached-Pixel server proof remains |
| Register and check in from capable SRP web | pending | Exact capability gate, non-extractable IndexedDB WebCrypto key, quiet legacy/cookie fallback, and no plaintext fingerprint expansion pass |
| Present the security dashboard | pending | Recognizable cards, distinct reported/owner labels, phone-comparable fingerprint, proof labels, global/per-client history, sessions/push, and revoke UI pass desktop/phone review |
| Alert on a genuinely new client | pending | Default-off `securityEvent` setting sends once to pre-existing enrolled destinations across supported adapters; retry and first-destination cases stay quiet |
| Enroll and present Android native push | pending | Explicit permission/enrollment, broker/server compensation, foreground/background display, safe tap routing, unknown mapping, and disable/forget pass |
| Prove the complete physical-device path | pending | Disposable YA profile and attached Pixel demonstrate SRP, register, resume/check-in, dashboard audit, broker test FCM, tap, and revocation |

## Implementation Order

### 1 — keep disabled remote-session persistence memory-only

Guard the `RemoteSessionService` save path when persistence is disabled. Cover
create, resume-use update, eviction, expiry, deletion, and shutdown rather than
relying on startup to delete a file written during the prior process. This is a
security prerequisite because the security-client registry makes resume
session ownership more load-bearing; it does not change the default.

### 2 — establish the server contract and persistence

Add the exact capability registry entries, version field, strict shared request
and response types, proof-set-shaped owner-only security-client storage,
revoked tombstones, the bounded global security ledger, bounded per-client
observations, and broker endpoint configuration. Add `GET /api/security/events`
and the owner-label `PATCH` route to the exact capability ownership. Keep
secret-bearing persistence and public projection types separate.

### 3 — carry authenticated connection evidence

Extend the private Hono environment used by encrypted multiplexed requests with
server-owned session id, transport nonce, auth method, route kind, connection
handle, and real peer facts. Never accept a lookalike header. Register active
client connections after a verified check-in so revocation can close every
related socket after the initiating response is sent.

Today neither server nor Android retains the transport nonce after key
derivation, full versus resume is not stamped post-authentication, relay and
direct collapse into one connection policy, and the peer is discarded after
the loopback admission check. Retain these facts for the connection lifetime.
Gate proof context on established SRP specifically: trusted-local, cookie, and
auth-disabled transports remain legacy observations even though some currently
share the internal authenticated bit.

### 4 — verify registration and check-in keys

Implement the fixed binary transcript and Node `crypto` verifier. Registration
is idempotent by request id only for the same signing key, Android requires
proof, one connection accepts one client check-in, descriptor changes retain
the same client, and a missing/lost private key cannot take over an existing
record. Convert WebCrypto's P1363 signatures to DER and cover short/high-bit
integer padding in cross-runtime vectors consumed by TypeScript, web WebCrypto,
and Kotlin Android tests. Reserve but reject future `rotate-key` and
`upgrade-attestation` transcript operations.

Wrong-key and malformed proofs append rate-bounded evidence without changing
successful state. Unknown ids permit authenticated re-registration; revoked
ids do not. Mark and persist the tombstone plus global event before responding,
then perform the session/socket/push cascade after the response is deliverable.

### 5 — make legacy and capable web clients coexist

Project current browser/session state into the read model first. Then add the
post-authentication capable-web register/check-in path without removing
`srp_hello`, activity subscription, browser-profile, or Web Push fallback.
Plaintext profile-id cleanup remains a separately compatible follow-up.

### 6 — bind Android registration to the native connection

Generate one non-exportable P-256 key per local paired-server profile, collect
the complete current descriptor without new Android permissions, register
after the capability check, and check in once after each authenticated
connection. Bump the strict paired-server codec from schema v1 to v2 for the
key alias, pending request id, server client id, and revoked state. There is no
v1 migration because Android has not shipped; clear and re-pair disposable
Pixel/AVD profiles, and begin migration compatibility with the first
distributed schema. Perform initial registration on the successful full-SRP
pairing connection before `pair()` closes it, then persist the response so the
phone appears immediately and a lost response can recover without another
password entry.

### 7 — add the security dashboard, alerts, and revocation

Show registered and legacy clients together while accurately distinguishing
reported details, server-owner labels, observed facts, and proof level. Show an
abbreviated fingerprint on cards and the full phone-comparable value in detail.
Present both per-client observations and the non-erasable bounded server event
history. Revoke the selected relationship only, confirm destructive action,
and demonstrate tombstone/session/socket/push cascading behavior.

Add a default-off **New security clients** notification setting. A newly
created record may notify only destinations that were already enrolled before
the registration. Idempotent retries do not repeat it, and failure attempts do
not create push floods. Per-destination 15-minute suppression sends the first
eligible event immediately and leaves later events in the ledger without a
timer. Update the broker's generic intent allowlist before a YA server can use
`security_event` through native push; older or self-hosted brokers fail
boundedly without a queue or retry loop.

### 8 — attach native push and validate FCM

Bind broker installations to the exact configured endpoint, create a
server-specific subscription only after explicit enablement, transfer and then
discard the send secret on Android, deliver generic intents, show foreground
notifications, resolve taps through the stored client/profile mapping, and
compensate or tombstone partial failures without a background retry loop.

## Explicit Follow-Ups After The Initial Baseline

These are recorded now but must not expand the first implementation:

- cookie one-time challenge and cookie-bound WebCrypto continuity;
- attestation challenge, old-key-authorized key rotation, Android Key
  Attestation/Play Integrity, and native desktop keystore proof;
- per-origin WebAuthn enrollment and configurable inactivity/sensitive-action
  step-up with recovery;
- browser Web Push ownership migration from body-supplied profile id to the
  authenticated security client;
- plaintext `srp_hello` profile/origin cleanup;
- stale session-less/push-less web-client pruning;
- evidence-led changes to the five-session cap or remote-session persistence
  default; and
- broader failed-login notification policy, which needs anti-flood UX beyond
  the bounded dashboard ledger.

## Human Checkpoint

Stop after the attached Pixel has registered a key-verified Android client on
the full-SRP pairing connection, resumed and checked in with the same key,
matched the server's public-key fingerprint, and demonstrated revoked versus
unknown behavior against a disposable YA profile. Report the server API/file
evidence and legacy-web behavior before capable-web registration, dashboard
polish, security alerts, native push enrollment, foreground-service, or LAN
discovery work.
