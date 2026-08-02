# Mobile Server Pairing And Native Connection Ownership

> A mobile companion pairs with one logical YA server independently of the
> route used to reach it; native UI and background work use a native secure
> connection core, while the bundled full web client may keep its existing
> independent web transport unless measurements justify a native adapter.

Topic: mobile-server-pairing

Status: Approved architecture direction. This document fixes the product and
ownership boundaries agreed on 2026-08-02. It does not approve a wire schema,
endpoint, capability name, SRP protocol change, or stable-release compatibility
plan.

Related:

- [Mobile companion app](../docs/project/mobile-companion-app.md)
- [Android FCM push](android-fcm-push.md)
- [Android wrapper and notification integration](../docs/tactical/071-android-wrapper-notification-integration.md)
- [First-class Android shell](../docs/tactical/080-first-class-android-shell.md)
- [Trusted client packaging](trusted-client-packaging.md)
- [Client source runtime topology](client-source-runtime-topology.md)
- [WebSocket auth state](../docs/project/ws-auth-state-model.md)
- [Connection matrix](../docs/project/connection-matrix.md)

## Accepted Product Shape

The Android app has two permanent foreground presentations:

- a focused native Compose experience for onboarding, server selection, inbox,
  Conversation view, and the routine mobile supervision path; and
- the complete bundled web client for users who prefer the web presentation or
  need the full desktop-strength interface, rich tools, settings, and
  unsupported native surfaces.

The bundled client is not merely temporary migration scaffolding. It is a
first-class, full-fidelity alternative. The native presentation may grow until
it covers most routine mobile use without requiring the bundled presentation
to disappear.

Native background work cannot depend on the WebView. A Kotlin connection core
must eventually support Compose and an explicitly enabled foreground activity
service without allocating a WebView or JavaScript runtime. Native FCM receipt
continues to remain independent of either foreground presentation.

The bundled web client is trusted application code when its assets are inside
the signed APK and served through Android's app-assets HTTPS origin. It does
not inherit ordinary Chrome extensions, and its integrity follows the APK's
signing and update path. The separately built hosted-`latest` channel remains a
weaker, mutable-code testing channel and does not inherit bundled-code trust
merely because the same Android shell displays it.

## Identity And Credential Layers

Do not collapse these concepts into one `deviceId`, browser profile, or push
record:

| Concept | Meaning | Secret? | Lifetime owner |
| --- | --- | --- | --- |
| Local paired-server id | App-generated key for one saved server relationship; it has no server-authentication meaning | No | Native mobile app |
| Paired server profile | Phone-side record for one trusted YA server | Contains secret children | Native mobile app |
| Paired device | Server-side durable record for one mobile installation | Contains credential handles and revocation state | YA server |
| SRP resume credential | `sessionId` plus shared base key proving a previous SRP login | Yes, bearer-equivalent | One client/server auth session |
| Transport key | Per-WebSocket key derived from the resume/base key and fresh server nonce | Yes | One live connection |
| Route candidate | Relay or direct location through which the same server may be reached | No credentials | Paired server profile |
| Broker installation | One mobile app installation's FCM target-management capability | Yes | Native app and push broker |
| Device push subscription | One server's ability to request push to one mobile installation | Send secret is secret | Paired device relationship |
| Browser profile | Browser-local label for tabs, origin history, and Web Push | Identifier is not auth | Browser profile and YA UI |

The existing `browserProfileId` is generated in browser `localStorage` and is
client-asserted metadata. It is not proof of device identity and must not
become the native pairing credential. The current Devices UI and browser
profile deletion also do not provide the cascading auth and push revocation
required for a paired mobile device.

## Pairing Versus General Authentication

General authentication and device pairing are separate but connected:

1. Existing SRP username/password authentication proves that the user may add
   the device to a YA server.
2. Successful enrollment creates a durable paired-device relationship with a
   server-generated opaque device id, user-visible label, platform metadata,
   creation/last-seen timestamps, and revocation state.
3. Expiring connection credentials and optional push subscriptions belong to
   that relationship.
4. Disabling push removes only the push child. Forgetting the device revokes
   all connection credentials and push subscriptions associated with it.

This is not a new multi-user account system. YA remains single-user oriented;
the separation exists so authentication sessions can expire or rotate without
silently deleting notification preferences and so one lost phone can be
revoked without changing the server-wide password.

A paired-device record is not itself authorization merely because it has an id.
Every operation that creates, changes, or uses it still needs proof from the
appropriate authenticated connection or device credential. Exact credential
types and grant rules remain protocol-design work.

## Deferred Installation Identity And Route Continuity

A public or fingerprinted YA installation id is not required for native
pairing and is explicitly deferred. Do not add an Android-specific identity,
expose the relay-ownership `installId`, populate `SavedHost.serverInstanceId`,
or add a server-proof field merely to label an installation.

The Android app assigns its own local id to each paired-server profile. While
an SRP resume credential is valid, successful resume already proves that an
endpoint possesses that profile's shared base key and live server-side session.
The app may therefore attach a direct or relay route candidate to the local
profile only after the candidate completes resume and returns a valid,
challenge-bound server proof. Acceptance through both routes is sufficient
continuity evidence for that credential's lifetime.

If resume is missing, expired, evicted, or lost after a server restart, Android
must not automatically merge a discovered or newly entered endpoint into an
existing profile. The user explicitly selects the profile or creates a new one,
enters the SRP password, and confirms the route. Full SRP authenticates that
endpoint but does not claim that two independent installations using the same
credentials are one installation.

A future durable paired-device credential may extend route continuity beyond
the current resume-session lifetime. That is part of paired-device enrollment
and revocation, not a global public server-identity contract.

The server may later keep a high-entropy installation secret or id entirely for
its own persistence, token binding, or diagnostics. If it ever exposes a hash
or fingerprint of that value, the fingerprint is itself a public identifier
and requires a separately motivated compatibility and migration review. The
existing web `SavedHost.serverInstanceId` seam remains unused for now, and no
route-scoped web caches or saved hosts are automatically merged.

## Current SRP Resume Facts

Current full SRP derives a 32-byte base session key. The client stores that key
with a `sessionId`; the server stores the same base key. Resume proves
possession of the unchanged base key using a one-time server challenge. Both
sides derive a fresh per-connection transport key from the base key and server
nonce.

The fresh transport key prevents ciphertext replay across connection
boundaries. It is not a newly minted short-lived authentication session and it
has no time TTL; it lives until that WebSocket connection ends. The underlying
resume credential currently has:

- a seven-day sliding idle expiry, refreshed by successful resume;
- a thirty-day absolute lifetime from full SRP login;
- a maximum of five active sessions per username, with the oldest evicted when
  full SRP creates another; and
- in-memory-only server storage by default, so a server restart invalidates it
  unless remote-session persistence is explicitly enabled.

These limits make the resume session a credential under the durable pairing,
not the durable pairing itself. If it expires, the paired device remains a
known device but must reauthenticate before reconnecting. Pairing work may
later change credential lifetime, rotation, or device binding, but it must do
so explicitly rather than retroactively redefining the current SRP resume
contract.

## Native Paired-Server Storage

Android should keep one app-private profile per paired YA server. Conceptual
state includes:

- app-generated local profile id and user-visible server label;
- opaque server-issued paired-device id;
- SRP username and current native resume credential;
- explicit relay configuration and direct route candidates;
- last successful route and connection timestamps;
- broker subscription mapping and safe notification destination; and
- local revocation or reauthentication state.

Non-secret metadata can use app-private DataStore. Passwords are used only for
the visible SRP login and are not persisted. Resume base keys and broker
capabilities are encrypted under Android Keystore-backed keys and excluded
from backup/device transfer. A future iOS implementation applies the same
ownership model with Keychain-backed storage.

The native store is independent of browser `localStorage`. Native Compose and
background operation must never require a WebView profile to exist.

### Android storage contract

Android persists versioned, non-secret paired-server metadata in one
Preferences DataStore. Each resume credential is serialized separately and
encrypted with AES-256-GCM under an app-owned Android Keystore key. The local
profile id is authenticated as additional data, so an encrypted credential
cannot be reassigned to a different profile. Neither the SRP password nor a
plaintext resume session id or base key is written to app storage.

The current Android manifest excludes all app domains from cloud backup and
device transfer. Process restart reopens the same DataStore and Keystore key.
Missing keys, malformed ciphertext, profile/credential username mismatch, and
explicit resume rejection all make the profile require visible SRP
reauthentication; they do not delete the paired-server metadata. Forgetting a
profile atomically removes its metadata, encrypted credential, and selection.

Android uses the current seven-day idle and thirty-day absolute server limits
as a conservative local eligibility check before resume. The server remains
authoritative: restart, explicit logout, password change, session eviction, or
future policy may invalidate the credential sooner. A successful resume must
advance the stored last-resumed timestamp.

## Kotlin Connection Core

The Android-native core owns, per paired server:

- full SRP and resume negotiation;
- base-credential access and per-connection key derivation;
- relay and direct secure WebSocket establishment;
- encrypted request/response multiplexing and subscriptions;
- connection state, wake checks, bounded reconnect, and route selection;
- typed repositories used by Compose; and
- deterministic cancellation and teardown.

The intended ownership is:

```text
Compose UI ------------------+
Foreground activity service -+--> Kotlin connection core --> YA server
Notification-open refresh ---+
```

The core is not itself an always-running service. A visible Compose surface or
explicit foreground service owns live demand. When no owner requires a
connection, sockets, subscriptions, heartbeats, retry timers, and discovery
work quiesce. FCM receipt alone does not start the foreground activity service
or a persistent YA connection.

Compose consumes domain-facing repositories for server state, inbox, sessions,
notifications, and projections. The raw multiplexed protocol remains internal
transport plumbing rather than becoming the UI's permanent data model.

### Native secure-transport checkpoint

The initial Kotlin connection foundation proved the existing contract without
adding a server route or involving the relay. A disposable YA server can expose
the existing `/api/ws` route on host loopback, accept full SRP, authenticate its
server-info proof, exchange binary secretbox protocol frames, close, and accept
challenge-bound resume on a second socket. `RelayClientService` does not need
to run, and no relay registration is required. The current server configuration
still stores the SRP identity beside relay-shaped configuration; decoupling that
storage is product follow-up, not a prerequisite for direct negotiation.

The selected Android foundation is:

- Nimbus SRP6a 2.1.0 with the fixed YA 2048-bit/SHA-512 profile;
- LazySodium Android 5.2.0 and the JNA 5.17.0 Android AAR for TweetNaCl-
  compatible XSalsa20-Poly1305 secretbox;
- OkHttp 4.12.0 for WebSocket ownership; and
- Kotlin coroutines 1.9.0 for cancellable suspension.

`YaNativeSecureConnection` is deliberately a bounded protocol probe, not the
finished connection manager. It keeps the password only inside a full-login
attempt, verifies Nimbus `M2` and the encrypted YA server proof before accepting
a resume credential, derives a fresh transport key per socket, sends encrypted
capabilities and ping, validates the sequenced encrypted pong, and returns only
after the normal WebSocket close handshake. Resume credentials defensively copy
their base key rather than exposing a mutable byte array. Attempt-local raw SRP,
base, transport, and copied resume-key buffers are cleared when their use ends
where the underlying libraries expose those bytes.

The checked-in fixture is generated by the production TypeScript SRP,
secretbox, key-derivation, and binary-framing libraries. Android JVM/device
tests must continue to match it byte for byte, and Android CI regenerates it
when Android, shared framing, or server crypto code changes. This checkpoint
does not yet persist credentials, reconnect, select routes, expose repositories,
or run a foreground service.

## Bundled Web Client Independence

The bundled web client is allowed to keep its existing TypeScript
`SecureConnection`, browser `localStorage` resume session, and direct relay/YA
transport. It does not initially need to proxy application traffic through the
Kotlin connection core.

That independence preserves the proven full interface and avoids assuming a
native bridge improves performance. A native-backed web transport adds JSON
serialization, data copying, thread hops, stream buffering, cancellation, and
difficult binary/upload paths. Full transcripts and high-rate tool streaming
are especially poor places to assume bridge performance without measurement.

Consequences accepted during the transition and potentially longer term:

- the native core and bundled web client may hold separate SRP resume sessions
  for the same physical Android installation;
- they may briefly maintain separate connections and subscriptions;
- native and web profiles are not automatically merged merely because the user
  reaches the same machine through both presentations; and
- the current five-session server limit may need explicit reconsideration
  before several mobile, browser, and native clients coexist routinely.

A future `NativeSourceTransport` for the web client is optional. Build it only
after representative measurements show a concrete product, lifecycle, or
performance benefit. It must not block native pairing, Compose, push, direct
discovery, or foreground-service work.

The existing small `window.yaNative` host remains useful for explicit Android
operations such as notification permission. It is not automatically the full
web data plane. Bundled app-assets code may receive broader methods in a future
review because it is trusted application code; mutable hosted-`latest` content
remains a separate trust decision.

## Direct, Relay, And LAN Discovery

A paired server owns a set of routes rather than one route-shaped identity:

- configured relay location and username;
- manually entered direct endpoint;
- VPN/Tailscale endpoint;
- previously authenticated direct endpoint; and
- foreground-discovered LAN candidate.

The connection core may prefer a working direct path and fall back to relay,
but explicit operator configuration stays authoritative. Route selection does
not create a second paired device, source cache, inbox, or notification record.
A new candidate joins an existing profile automatically only after successful
resume with that profile's credential. Otherwise it requires explicit SRP
reauthentication and user selection.

mDNS/Bonjour is discovery, never authentication. A bounded foreground scan may
advertise or discover a service name, port, and protocol/capability hints. It
must not advertise credentials, sessions, installation identity, project
names, or push state. A copied or spoofed advertisement is merely an endpoint
candidate; resume must prove continuity before automatic attachment, while
full SRP plus explicit user selection can establish a new route/profile.

Discovery work is lifecycle-owned and bounded. Opening an onboarding or server
connection surface may scan; closing it releases the scan. The design does not
add an indefinite background mDNS watcher.

## QR And Passwordless Pairing

The safe first QR flow is discovery-only. It can encode a relay locator, direct
route hints, and SRP username so the user does not type URLs. Android still
asks for the SRP password and full SRP authorizes the pairing.

Merely opening an unlocked desktop Settings page must not mint durable remote
access. A future passwordless QR grant requires a separate security and
compatibility review and step-up authorization, such as:

- re-entering the YA remote-access password;
- operating-system biometric/system authentication; or
- approval from an already-paired device.

Any such grant must be single-use, short-lived, visibly name the proposed
device, and require explicit confirmation. Password-first remains the normal
pairing posture unless that stronger flow is deliberately approved.

## Push As A Pairing Capability

The broker installation belongs to the Android app installation. A
server-specific broker subscription belongs to one paired-device relationship.
Push does not create or authenticate that relationship.

After authenticated pairing, enabling notifications creates or reuses the
server-specific subscription and transfers its send capability to the trusted
YA server. The server records it under the paired device, applies notification
policy, and can revoke it independently. Generic FCM payloads carry only an
opaque subscription id and intent; the native app resolves that id through its
own paired-server map.

Revocation is hierarchical:

- disabling notifications revokes only that push subscription;
- forgetting a server on the phone revokes or tombstones the phone-side
  relationship and its broker mapping;
- forgetting a device on the server revokes its connection credentials and
  push subscriptions; and
- changing the server-wide SRP password continues to invalidate current SRP
  sessions without silently serving as the only lost-device control.

Exact offline revocation, tombstone, retry, and cross-side acknowledgement
semantics remain implementation decisions.

## iOS Direction

The conceptual model is platform-neutral: a local paired-server profile,
paired device, expiring connection credentials, route candidates, push
capability, typed inbox/session repositories, and revocation. A future SwiftUI
app uses Keychain-backed credentials and its platform's foreground/background
and LAN discovery facilities. Android- and iOS-specific UI and lifecycle code
need not share widgets or pretend their background execution rules are
identical.

The wire protocols and projection schemas should remain shared even if the
first native connection implementations are written separately in Kotlin and
Swift.

## Compatibility And Approval Gates

This document does not name capabilities or routes. Before implementation,
perform the stable-release review required by
[`server-capabilities.md`](server-capabilities.md) and
[`remote-hosted-compatibility.md`](remote-hosted-compatibility.md) separately
for each new client/server dependency, including:

- durable paired-device enrollment/listing/revocation;
- native projection or inbox APIs;
- server-specific native push enrollment; and
- any future passwordless grant or native-backed web transport.

An older server remains usable through the existing bundled/hosted web login
and current remote transport. A new Android client makes no unsupported pairing
or native-push request when the relevant exact gate is absent. Native Compose
surfaces may honestly report that a server update is required while the full
web interface remains available.

## Recommended Implementation Order

1. **Prove Kotlin SRP and secure transport — complete:** checked-in
   cross-language fixtures and the direct physical-device probe establish the
   connection foundation without adding a server contract.
2. **Store native paired-server profiles:** establish Keystore/DataStore
   boundaries, forget/reauthentication states, and backup exclusions.
3. **Own native connection demand:** turn the bounded probe into a
   lease-controlled request/subscription manager with deterministic teardown.
4. **Select direct and relay routes:** attach a candidate automatically only
   after resume proves credential continuity; otherwise require explicit SRP
   reauthentication and profile selection.
5. **Create paired-device records and revocation:** attach expiring native
   sessions to the durable server-side relationship without reusing browser
   profile ids.
6. **Feed native inbox and Conversation view:** add only the separately
   approved bounded APIs/projections required by useful Compose surfaces.
7. **Attach native push subscriptions:** make broker subscriptions children of
   the paired device and validate notification presentation/taps end to end.
8. **Add bounded LAN discovery:** discover candidates in foreground and accept
   them only after expected-server authentication.
9. **Add optional foreground activity:** let an explicit user action keep the
   native core subscribed, with a persistent notification and complete stop.
10. **Benchmark a native web transport:** consider one only if measurements
    show that sharing Kotlin connections benefits the permanent full web UI.
