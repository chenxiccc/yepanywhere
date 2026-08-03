# Mobile Server Pairing And Native Connection Ownership

> A mobile companion pairs with one logical YA server independently of the
> route used to reach it; native UI and background work use a native secure
> connection core, while the bundled full web client normally acquires its own
> logical lease on that core so entering the complete interface does not
> require a second login.

Topic: mobile-server-pairing

Status: Approved architecture direction. This document fixes the product and
ownership boundaries agreed on 2026-08-02. The unified security-client wire,
continuity-key, audit, revocation, capability, and stable-release compatibility
contract is approved in [`security-client-audit.md`](security-client-audit.md).

Related:

- [Mobile companion app](../docs/project/mobile-companion-app.md)
- [Android FCM push](android-fcm-push.md)
- [Security clients and authentication audit](security-client-audit.md)
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
to disappear. Compose remains the primary mobile product surface; the bundled
client is the complete escape hatch for missing native settings, uncommon rich
renderers, and users who explicitly prefer it. Its transport should be usable
and bounded, but it does not set the optimization priorities for the native
application.

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

The current implementations discard that transport nonce after derivation.
Security-client proof requires both server and Android to retain the plaintext
nonce for the authenticated connection lifetime, then clear it at teardown.
Freshness rather than secrecy is its property; retaining the literal wire value
keeps the signed proof transcript independently auditable.

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

- app-generated local profile id and a display label derived from the SRP
  username;
- opaque server-issued security-client id, continuity-key alias, and revoked
  state;
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

The existing paired-server codec is strict schema v1, but no Android build has
been released. Security-client registration bumps development storage to v2
without a v1 migration. Existing Pixel/AVD profiles are disposable and must be
cleared and paired again; migration compatibility begins only once distributed
builds create user-owned state. V2 adds the continuity-key alias, pending
idempotent registration request id, server-issued client id, and local revoked
state. A successful full-SRP `pair()` performs initial registration on that
still-open authenticated connection before closing it and committing the
profile, so the dashboard can show the phone immediately. A lost registration
response reuses the pending request id and same key rather than prompting for
the password again.

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

### Android connection ownership contract

The Android application owns at most one connection manager for each local
paired-server profile. UI and future service consumers acquire explicit
leases. Leases share one authenticated socket, while each request and
subscription remains attributable to its owning lease. Releasing one lease
closes only its subscriptions. Releasing the final lease cancels the socket,
pending requests, subscription work, and any retry delay, and returns the
manager to idle.

Requests use the existing encrypted `request`/`response` protocol and are
never replayed automatically after a disconnect. Live subscriptions use the
existing `subscribe`/`event`/`unsubscribe` protocol, remember their most recent
event id, and are restored after a successful reconnect. Native inbound and
per-subscription queues are bounded; a consumer that falls behind loses that
subscription instead of growing process memory without limit.

While a lease exists, an unexpected disconnect gets three bounded retries
after 250 ms, 1 second, and 3 seconds. The manager has no recurring retry or
heartbeat of its own. A new explicit request after a terminal failure may
start a new bounded cycle; no work restarts after the final lease is gone.

Routes are tried in deterministic order: the last successful/preferred route,
then remaining direct routes, then remaining legacy relay routes. Every
automatic candidate must prove the saved SRP resume credential. A successful
fallback becomes preferred. The initial implementation uses one ordinary
legacy relay `/ws` per profile; relay `/mux` remains a later optimization and
is not probed or assumed by Android.

If every reachable route rejects resume, Android deletes only the encrypted
credential and requires visible SRP login. Network failure does not silently
become password authentication, and a failed request is not rerouted or
replayed. Full SRP onboarding targets exactly the route the user entered and
persists a profile only after the authenticated server proof succeeds.

Compose consumes domain-facing repositories for server state, inbox, sessions,
notifications, and projections. The raw multiplexed protocol remains internal
transport plumbing rather than becoming the UI's permanent data model.

### Initial native Compose contract

The Android launcher now opens a native Compose server surface by default; it
does not allocate a WebView or JavaScript runtime merely because the app is
opened. This remains true when Android delivers a later launcher `ACTION_MAIN`
intent to the existing single-task activity. Only a valid exact
`https://yepanywhere.com/open` `ACTION_VIEW` App Link hands its typed destination
to the dedicated full-web activity. **Open full app** remains available from
every native state and starts the same bundled or hosted client channel without
routing that web client's traffic through Kotlin.

The default native onboarding surface asks only for the remote-access username
and password. It matches the web relay login by using
`wss://relay.yepanywhere.com/ws` when no custom relay is supplied and by using
the normalized lowercase username as both relay target and SRP identity. The
username also becomes the local profile's display label; onboarding does not
ask for a second name.

An advanced disclosure permits an explicit custom relay WebSocket URL or an
exact direct WebSocket URL. Explicitly entered endpoints remain authoritative:
onboarding does not probe or silently replace them. This default affects only
new pairings and does not change any saved profile's route or preferred-route
history. The password is held only in the visible field and full-login attempt,
cleared from Compose state on submission, and never placed in saved instance
state, a ViewModel field, DataStore, or the web bridge. A profile is persisted
only after the authenticated server proof succeeds.

The initial signed-in surface can select or forget local server profiles,
display connection and reauthentication state, and read up to 50 compact
session summaries through the existing encrypted `GET /api/sessions` request.
It is deliberately read-only: opening a full session, tools, settings, and all
unsupported detail remains the full web client's job. Forgetting a profile
requires confirmation and removes its protected resume credential. A rejected
or expired resume keeps the non-secret profile visible and offers explicit full
SRP reauthentication through its preferred route.

The foreground Compose activity acquires one connection lease only while the
activity is started. Backgrounding it, replacing it with the full-web activity,
or destroying it cancels an in-flight summary load and releases that lease; if
it was the final owner, the socket and retry work return to idle. This behavior
does not imply or emulate the separately reviewed foreground activity service.

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

## Multiple Native Hosts And Selection

One paired profile is one logical source with its own username, routes, resume
credential, security-client binding, connection manager, SRP/NaCl state,
readiness, retry, and revocation lifecycle. The process runtime may keep several
such sources active concurrently when Compose, notification aggregation,
foreground work, or the WebView holds demand for them.

The selected profile is presentation state, not connection ownership. Changing
the visible host must not disconnect another profile that still has a lease,
and one host's offline, reauthentication, revocation, or retry state must not
block healthy peers. Adding or forgetting a profile changes the native host
catalog; forgetting also releases its native demand and destroys its protected
credentials and continuity key as already specified.

Relay mux is an optimization below those source boundaries. A native pool is
keyed by normalized relay base, discovers `client-mux-v1`, and may provide one
logical circuit to each independently authenticated profile. Direct profiles,
old relays, failed mux discovery, and overflow retain ordinary independent
sockets. A physical mux failure fans out a reconnect signal, but each profile
still reports and recovers its own logical state.

Android considers even one demanded relay profile eligible for mux when the
relay advertises `client-mux-v1`. A profile initially uses one logical source
connection for summary, full-session, media, WebView, and 64 KiB upload traffic
rather than opening a second dedicated relay socket. Representative Pixel
measurements with competing circuits are the gate for retaining that simple
policy or later promoting measured bulk work to a dedicated socket; the source
and connection-manager APIs must not expose either physical policy.

Native multi-host demand, selection, failure isolation, mux fallback, and
dedicated-full-session policy are proved before the WebView transport adapter.
That sequencing fixes the source lifecycle the adapter consumes without
delaying the adapter's already-approved framing and security boundaries.

## Bundled Web Client Transport

Opening the bundled full web client from an already authenticated Android
profile should not present another login. Its baseline transport is therefore
a `NativeSourceTransport` adapter over a dedicated, exact-origin Android
message channel. The WebView acquires its own lease from the same process-level
Kotlin connection manager used by Compose and foreground work. Requests and
subscriptions receive adapter-local identifiers while Kotlin remains the sole
owner of wire identifiers, SRP credentials, connection capabilities,
encryption, reconnect, and route selection.

The bridge is multi-source even while the first web presentation shows one
host at a time. Native supplies document-scoped opaque source handles for its
paired-profile catalog; every request, subscription, upload, and cancellation
is scoped to one handle. WebView "Switch Host" selects or opens another native
source and changes the client source runtime. It does not enter the browser
login/profile flow. Kotlin acquires the target lease before releasing an old
WebView-only lease, while unrelated native demand remains untouched.

This is a logical-consumer boundary, not a new server session or authentication
layer. Compose, a foreground service, and the WebView may make concurrent
requests and hold independent subscriptions on one SRP mux connection.
Releasing or overflowing the WebView lease must clean up only its work and must
not close a connection still demanded by a native consumer.

The existing small `window.yaNative` host remains the bounded control plane for
explicit Android operations such as notification permission. Its 16 KiB
request limit is a YA guard for small JSON commands, not a WebView, WebSocket,
SRP, or file-size limit. Application transport uses a separate channel with
binary messages, fragmentation, cancellation, and byte-based flow control.

Upload behavior preserves the existing relay contract:

- the WebView reads each `File` as a stream and emits the established 64 KiB
  upload chunks rather than materializing the complete file in Kotlin;
- each chunk crosses the bridge as an ArrayBuffer when the installed WebView
  supports it, receives the existing upload id and offset header, is
  independently encrypted, and is written by the server before completion;
- bridge and OkHttp queue high/low-water marks bound resident data and suspend
  the WebView reader when the native or network consumer falls behind; and
- abort, navigation, process teardown, invalid offset, and queue overflow fail
  the one upload or WebView lease without retaining the remaining file.

Chunked does not mean resumable: loss of the authenticated socket discards the
server's connection-owned upload state, so the current upload fails and a user
retry starts again at byte zero. Cross-connection upload resume would require a
separate server contract and is not invented by the WebView adapter.

A 100 MiB upload is consequently 1,600 ordinary 64 KiB data chunks, not one
100 MiB bridge message. Downloads and blob responses use the same bounded
fragment discipline on the local bridge, but the current relay response
contract still base64-encodes a complete binary response inside one JSON
message. Removing that upstream whole-response/base64 cost would be a separate
capability-gated server protocol change. Ordinary response and event JSON can
be larger than one bridge frame and is reassembled by logical message id. A
single encrypted server WebSocket message must still be decrypted as a whole
under the current wire protocol; bridge fragmentation controls queue growth but
does not make JSON parsing incremental. Representative large transcript and
blob responses therefore remain an explicit memory and latency benchmark
rather than being conflated with streaming uploads.

The transport handshake advertises whether ArrayBuffer messages are available.
An older installed WebView may use bounded base64 string chunks as a functional
compatibility path, accepting the usual size and copy overhead; it does not
fall back to exposing credentials. Recent supported WebViews should use binary
messages and avoid that expansion.

The privileged transport channel is available only to signed, bundled
app-assets code and is removed on document/navigation teardown. Mutable
hosted-`latest` content never receives it and continues to authenticate with
its own web-owned session.

An independently authenticated bundled WebView remains a valid future mode or
performance optimization. In that shape the WebView performs normal SRP itself
and retains a distinct browser-scoped resume session after the user explicitly
authenticates there. The baseline does not mint, delegate, or expose a child
resume credential merely to avoid the second prompt. Any later delegated-token
proposal requires its own security and compatibility review.

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

## Security Client Registration And Continuity

The server-side paired-device idea is implemented as the Android kind of the
cross-platform security-client registry rather than a mobile-only namespace.
After SRP succeeds and the exact capability is present, Android registers a
per-server Android Keystore P-256 public key, signed device/app/environment
descriptor, and user-visible label. It checks in once per authenticated
connection with a proof bound to the fresh SRP transport nonce.

The stable key, not mutable OS/app metadata, anchors continuity. Android
updates, security patches, locale/timezone changes, and app releases update the
signed audit snapshot without password login or re-pairing. A copied resume
credential cannot impersonate the existing Android client without its
Keystore key; a password-only attacker creates a new visible client record.

The same API admits capable browser WebCrypto keys and a future extension-free
desktop WebView or native-shell key. Existing browser-profile and remote-session
state remains visible as a legacy projection. Exact routes, schemas, proof
transcript, history bounds, assurance labels, and compatibility fallback live
in the security-client topic.

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

The optional `security-client-audit-v1` and
`native-push-subscriptions-v1` contracts, reviewed stable releases, and exact
old-server fallbacks are approved in
[`security-client-audit.md`](security-client-audit.md). An older server remains
usable through current SRP/native summaries and the bundled/hosted web client;
Android reports that registration/push requires an update and makes no
unsupported request. Native projection/inbox APIs, passwordless grants,
plaintext browser-profile cleanup, any independently authenticated WebView
optimization, and optional attestation retain their own future compatibility
reviews. The native WebView adapter reuses existing authenticated API, upload,
and subscription messages and adds no server route or capability by itself.

## Recommended Implementation Order

1. **Prove Kotlin SRP and secure transport — complete:** checked-in
   cross-language fixtures and the direct physical-device probe establish the
   connection foundation without adding a server contract.
2. **Store native paired-server profiles — complete:** Keystore/DataStore
   boundaries, forget/reauthentication states, expiry, and backup exclusions
   are implemented and tested.
3. **Own native connection demand — complete:** a lease-controlled
   request/subscription manager supplies bounded reconnect and deterministic
   teardown.
4. **Select direct and relay routes — complete:** attach a candidate automatically only
   after resume proves credential continuity; otherwise require explicit SRP
   reauthentication and profile selection.
5. **Bind the first Compose consumer — complete:** explicit onboarding,
   profile selection, reauthentication, connection state, and compact existing
   session summaries use the native core while the full web client remains an
   escape hatch.
6. **Register security clients and revocation:** attach expiring native
   sessions to a Keystore-key-verified cross-platform security-client record,
   retain legacy web audit visibility, and cascade explicit revocation.
7. **Feed native inbox and Conversation view:** add only the separately
   approved bounded APIs/projections required by useful Compose surfaces.
8. **Attach native push subscriptions:** make broker subscriptions children of
   the paired device and validate notification presentation/taps end to end.
9. **Add bounded LAN discovery:** discover candidates in foreground and accept
   them only after expected-server authentication.
10. **Add optional foreground activity:** let an explicit user action keep the
   native core subscribed, with a persistent notification and complete stop.
11. **Own multiple native hosts and relay mux:** keep source demand concurrent,
    make selection presentation-only, pool one or more eligible relay circuits,
    carry ordinary/full traffic through each logical circuit, preserve exact
    legacy fallback, and prove per-profile failure isolation and fairness.
12. **Bind the bundled WebView to native transport:** implement and benchmark a
    bounded `NativeSourceTransport` lease so opening the complete UI reuses the
    selected authenticated Android profile without exposing its credential;
    source-scoped handles implement host switching without web-owned login.
13. **Revisit independent WebView transport only from evidence:** retain normal
    browser SRP as a possible later mode when measured throughput, lifecycle,
    or isolation benefits outweigh its separate-login and session-slot costs.
