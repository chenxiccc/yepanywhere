# Security-Client Registration And Native Push

Status: approved for implementation. This tracker supersedes the mobile-only
paired-device endpoint sketch with one cross-platform security-client API.
Android must prove a Keystore key; capable web clients use WebCrypto; legacy web
records remain visible through a server projection. Native push is a child of
the registered Android client.

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

## Work Tracker

| Step | State | Completion evidence |
| --- | --- | --- |
| Record the unified security-client contract | complete | Topic contract fixes routes, gates, proof transcript, descriptor/history, legacy projection, revocation, push child, and future assurance |
| Register capabilities and version metadata | pending | Capability audit and version-route tests cover exact routes and conditional native-push metadata |
| Persist security clients and bounded observations | pending | Owner-only versioned state, strict schemas, idempotency, coalescing, restart, malformed-state, and no-secret API tests pass |
| Inject authenticated transport facts | pending | Only server-owned SRP/cookie context can register/check in; current session, nonce, auth method, route, and real peer facts are authoritative |
| Verify P-256 continuity proofs | pending | Node verifies Android/WebCrypto-compatible SPKI and DER signatures; mutation, replay, wrong route/key/client, and stale transport attempts fail |
| Project legacy web clients | pending | Existing browser profiles, connected tabs, remote sessions, and Web Push appear without invented proof or changed legacy behavior |
| Revoke the complete client relationship | pending | Response precedes active-socket close; associated resume sessions and push authority are removed, unrelated clients remain |
| Deliver generic native push | pending | Exact broker endpoint/credential binding, notification-policy mapping, test delivery, 404 invalidation, bounded transient failure, and secret redaction pass |
| Register and check in from Android | pending | Per-server Keystore P-256 key, signed descriptor, idempotent recovery, key-loss/new-client behavior, and process restart pass |
| Register and check in from capable SRP web | pending | Exact capability gate, non-extractable IndexedDB WebCrypto key, quiet legacy/cookie fallback, and no plaintext fingerprint expansion pass |
| Present the security dashboard | pending | Recognizable native/browser cards, proof labels, observations, sessions/push state, and revoke UI pass desktop and phone visual review |
| Enroll and present Android native push | pending | Explicit permission/enrollment, broker/server compensation, foreground/background display, safe tap routing, unknown mapping, and disable/forget pass |
| Prove the complete physical-device path | pending | Disposable YA profile and attached Pixel demonstrate SRP, register, resume/check-in, dashboard audit, broker test FCM, tap, and revocation |

## Implementation Order

### 1 — establish the server contract and persistence

Add the exact capability registry entries, version field, strict shared request
and response types, owner-only security-client storage, bounded audit events,
and broker endpoint configuration. Keep secret-bearing persistence and public
projection types separate.

### 2 — carry authenticated connection evidence

Extend the private Hono environment used by encrypted multiplexed requests with
server-owned session id, transport nonce, auth method, route kind, connection
handle, and real peer facts. Never accept a lookalike header. Register active
client connections after a verified check-in so revocation can close every
related socket after the initiating response is sent.

### 3 — verify registration and check-in keys

Implement the fixed binary transcript and Node `crypto` verifier. Registration
is idempotent by request id, Android requires proof, descriptor changes retain
the same client, and a missing/lost private key cannot take over an existing
record. Use cross-runtime vectors consumed by TypeScript, web WebCrypto, and
Kotlin Android tests.

### 4 — make legacy and capable web clients coexist

Project current browser/session state into the read model first. Then add the
post-authentication capable-web register/check-in path without removing
`srp_hello`, activity subscription, browser-profile, or Web Push fallback.
Plaintext profile-id cleanup remains a separately compatible follow-up.

### 5 — bind Android registration to the native connection

Generate one non-exportable P-256 key per local paired-server profile, collect
the complete current descriptor without new Android permissions, register
after the capability check, and check in once after each authenticated
connection. Persist pending request id and server client id so a lost response
can recover without another password entry.

### 6 — add the security dashboard and revocation

Show registered and legacy clients together while accurately distinguishing
reported details, server-observed facts, and proof level. Revoke the selected
relationship only, confirm destructive action, and demonstrate session/socket
and push cascading behavior.

### 7 — attach native push and validate FCM

Bind broker installations to the exact configured endpoint, create a
server-specific subscription only after explicit enablement, transfer and then
discard the send secret on Android, deliver generic intents, show foreground
notifications, resolve taps through the stored client/profile mapping, and
compensate or tombstone partial failures without a background retry loop.

## Human Checkpoint

Stop after the attached Pixel has registered a key-verified Android client and
the YA security dashboard shows its descriptor and authentication history,
before foreground-service or LAN-discovery work. Report the continuity-key and
legacy-web behavior, live broker/FCM evidence, remaining platform gaps, and any
reason a later attestation experiment should change the v1 extension point.
