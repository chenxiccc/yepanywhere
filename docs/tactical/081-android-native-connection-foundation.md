# Android Native Connection Foundation

Status: native crypto checkpoint approved. The evidence-backed library
selection and native Android full-SRP, server-proof, encrypted-traffic, resume,
and teardown proof are complete against a disposable direct YA server. The
post-checkpoint connection and profile slices may proceed.

Topic: android-native-connection
Topic: mobile-server-pairing

## Origin

Android now owns its Kotlin, Compose, WebView, notification, and Firebase
layers directly. The bundled WebView remains a permanent full-fidelity
presentation, but it must not become the owner of credentials or the runtime
required by native Compose and foreground activity.

The next implementation center is therefore a Kotlin connection core that can
serve Compose and a user-enabled foreground service without allocating a
WebView or JavaScript runtime. Its flagship path is a resumable SRP-authenticated
YA protocol connection through either a direct route or the relay. LAN
discovery may later contribute direct route candidates, but discovery never
authenticates a server.

The first checkpoint deliberately starts with a direct WebSocket. YA already
accepts SRP on `/api/ws`, so this removes relay registration and routing from
the crypto experiment while exercising the same server handshake, secretbox
transport, request/response protocol, and session-resume machinery used behind
the relay.

## Related Contracts And Plans

- [Mobile server pairing](../../topics/mobile-server-pairing.md) owns paired
  server profiles, secret boundaries, native connection ownership, route
  selection, discovery, and push enrollment.
- [Connection matrix](../project/connection-matrix.md) owns the existing direct
  and relayed secure WebSocket modes.
- [WebSocket auth state](../project/ws-auth-state-model.md) separates HTTP
  admission policy from an established SRP transport key.
- [Relay client mux](../../topics/relay-client-mux.md) owns the optional outer
  relay `/mux` transport and exact legacy `/ws` fallback. It is distinct from
  YA's encrypted inner request/subscription multiplexing.
- [Android native shell](080-first-class-android-shell.md) owns Gradle, Compose,
  WebView, native messaging, App Links, Firebase receipt, and Android CI.
- [Android FCM push](../../topics/android-fcm-push.md) owns broker delivery and
  the later server-specific enrollment lifecycle.
- [Architecture mandates](../../topics/architecture-mandates.md) require every
  socket, subscription, heartbeat, retry, and discovery scan to have an
  explicit live owner and deterministic teardown.
- [Hard development rules](../../topics/hard-development-rules.md) keep relay
  and endpoint configuration authoritative and require protocol compatibility
  grace for future wire changes.

## Fixed Boundaries

- Kotlin owns native SRP negotiation, server proof verification, transport-key
  derivation, encrypted framing, protocol messages, and resume credentials.
- Passwords exist only during an explicit native login attempt. A successful
  full login produces a resumable base key and session id; normal persistence
  stores those values under Android Keystore protection rather than storing the
  password.
- The connection core has no Activity, Compose, WebView, Firebase, or
  foreground-service dependency.
- Compose and a foreground service eventually acquire leases on one
  process-level connection manager. Releasing the final lease closes sockets,
  rejects pending requests, removes subscriptions, and cancels heartbeat,
  retry, and discovery work.
- The bundled WebView keeps its existing independent TypeScript connection and
  browser resume session initially. Native credentials are never exposed over
  `window.ya`.
- A route is only a location. Direct, discovered, and relay routes do not
  create separate logical server identities.
- mDNS/DNS-SD results are untrusted hints. They cannot update an authenticated
  server profile until resume with that profile's credential proves continuity.
  Without a valid resume credential, a candidate requires explicit SRP
  reauthentication and user profile selection rather than automatic merging.
- Public, fingerprinted, and Android-specific server installation identities
  are deferred. Do not expose relay `installId` or add a server-proof identity
  field for this work.
- This work adds no client/server route, field, event, capability, protocol
  version, endpoint default, or relay-selection change before a separate
  compatibility review.

## Current Wire Facts To Preserve

The existing TypeScript comments describe the SRP hash as SHA-256, but
`tssrp6a` 3.0.0 defaults to SHA-512. Kotlin interoperability must match runtime
behavior, not those comments:

- 2048-bit `N` from `SRPParameters.PrimeGroup[2048]`, with `g = 2`;
- SHA-512;
- `x = H(minimal(s) | H(UTF8(password)))`, omitting the username;
- `k = H(PAD(N) | PAD(g))`;
- `u = H(PAD(A) | PAD(B))`;
- `M1 = H(minimal(A) | minimal(B) | minimal(S))`;
- `M2 = H(minimal(A) | minimal(M1) | minimal(S))`;
- the raw SRP key is the minimal unsigned big-endian encoding of `S`;
- the 32-byte base key is `SHA-512(raw S)[0..31]`;
- the per-connection key is
  `SHA-512(UTF8("yep-transport-v1") | baseKey | transportNonce)[0..31]`;
- NaCl secretbox is XSalsa20-Poly1305 with a 32-byte key, 24-byte nonce, and
  combined 16-byte authenticator plus ciphertext;
- binary envelope v1 is `[0x01 | nonce | secretbox([format | payload])]`;
- encrypted JSON payloads are `{ "seq": number, "msg": object }`, beginning
  at sequence zero for each established transport; and
- full SRP must verify the encrypted `srp_verify_server_info` proof before
  accepting the session id, transport nonce, or resume protocol version.

## Library Decision Gate

The checkpoint compares candidates by exact wire compatibility first, then
maintenance and packaging cost:

| Concern | Leading candidate | Evidence required before selection |
| --- | --- | --- |
| SRP-6a | `com.nimbusds:srp6a` | Cross-language `A`, `M1`, `M2`, `S`, base-key, and server-proof vectors using YA's exact group and SHA-512 profile |
| Secretbox | `com.goterl:lazysodium-android` | TweetNaCl-compatible ciphertext vectors on JVM/device, supported Android ABIs, release shrinker behavior, and measured APK cost |
| WebSocket | Square OkHttp | Direct `/api/ws` full handshake, binary frames, close/cancellation behavior, and no duplicate client/thread-pool ownership |
| JSON | Android `org.json` for the probe | Exact small handshake and YA message shapes without introducing a reflection or schema framework before the protocol boundary settles |

SRP and NaCl are explicit dependency exemptions under `DEVELOPMENT.md`; YA
must not replace them with hand-written cryptography. If Nimbus cannot expose
the exact session key/encoding behavior, the work stops for review rather than
silently implementing SRP arithmetic. If LazySodium's native/JNA or APK cost is
disproportionate, compare a reviewed pure-Java NaCl implementation using the
same vectors before selecting either one.

## Disposable Direct Test Server

The integration harness uses the real YA Hono `/api/ws` route,
`RemoteAccessService`, `RemoteSessionService`, SRP handlers, encrypted frame
router, and request/subscription protocol with temporary directories and test
credentials. It does not start `RelayClientService` and therefore performs no
relay registration, DNS lookup, or recurring relay retry.

For a physical device, bind the harness to the host and use an explicit
`adb reverse` mapping so the app connects to a loopback URL without opening a
LAN listener. The test password is generated for that harness run, is not
written to the repository or durable app storage, and may be passed only as an
instrumentation argument to the test process. Server and client diagnostics
must not print it, any SRP private value, `S`, base keys, transport keys, resume
proofs, or decrypted response bodies.

This proves direct SRP without changing the current production configuration
model, where SRP identity is still stored with relay configuration. Decoupling
SRP username/password configuration from relay registration remains a later
server-configuration slice rather than a hidden test-driven migration.

## Work Tracker

| Step | State | Completion evidence |
| --- | --- | --- |
| Record the native connection contract | complete | This tracker fixes boundaries, wire facts, review gate, and validation ladder |
| Prove cross-language crypto vectors | complete | Production TypeScript generation, Kotlin JVM SRP, and Pixel LazySodium tests agree on the checked-in fixture |
| Select Android crypto and WebSocket libraries | complete | Nimbus 2.1.0, LazySodium 5.2.0/JNA 5.17.0, OkHttp 4.12.0, and coroutines 1.9.0 pass the release and device evidence below |
| Negotiate a direct native SRP session | complete | Pixel verifies Nimbus `M2` and the authenticated server-info proof against the real disposable YA `/api/ws` route |
| Exchange encrypted YA protocol traffic | complete | Pixel sends binary encrypted capabilities and ping, then validates the sequenced encrypted pong |
| Prove native session resume | complete | A second Pixel socket authenticates the challenge-bound server proof and exchanges traffic under a fresh transport key |
| Prove physical-device teardown | complete | The client returns after close; the server records disconnect before resume opens and after resume closes, with no retry owner |
| Review the native crypto checkpoint | complete | Maintainer approved the selected foundation and direct-session result on 2026-08-02 |
| Persist paired-server resume state | ready | Keystore/DataStore boundaries, backup exclusion, expiry, forget, and password re-entry behavior are tested |
| Turn the probe into a connection manager | ready | Leased request/subscription ownership, cancellation, reconnect bounds, and final-owner teardown are tested |
| Add the native relay route | ready after manager | Same core negotiates through deployed legacy relay `/ws`; outer relay `/mux` remains independently capability-gated |
| Add explicit direct route selection | ready after manager | Resume-authenticated candidates and explicit SRP reauthentication preserve one local profile with deterministic cancellation |
| Bind Compose onboarding and summaries | ready after profiles | Native login/profile UI and a small real session-summary consumer use the connection manager |
| Add user-enabled foreground ownership | requires later product review | Correct Android foreground-service type/policy, visible start/stop, lease ownership, process recreation, and timeout behavior are validated |
| Add bounded LAN discovery | ready after route selection | Foreground NSD scan supplies untrusted candidates, attaches automatically only after resume, and stops completely when its owner releases it |

`ready after` in this table describes sequencing rather than a human approval
gate.

## Detailed Steps

### 1 — prove cross-language crypto vectors

Check in non-secret deterministic fixtures covering:

- SRP parameters and padding width;
- fixed salt, password, client private value, and server private value;
- verifier, `A`, `B`, `k`, `u`, `x`, `S`, `M1`, and `M2`;
- raw minimal `S`, base key, transport nonce, and transport key;
- server-info proof secretbox envelope;
- a fixed binary JSON envelope carrying sequence zero; and
- failure cases for a changed password, proof, nonce, ciphertext, sequence, and
  format/version byte.

Fixture generation must use production TypeScript crypto routines or the same
canonical libraries with explicitly fixed randomness. Kotlin tests consume the
checked-in result; they do not copy expected values into Kotlin source.

### 2 — select the Android crypto and socket dependencies

Pin exact dependency versions. Record licenses, transitive runtime
dependencies, supported ABIs, release APK delta, and R8 result. Update the APK
contract checker with an exact native-library allowlist only after the native
files are understood; a wildcard allowance is not acceptable.

Run Gradle dependency verification, JVM tests, Android lint, release builds,
APK inspection, and device crypto tests without warnings. A candidate that
passes a unit vector but fails a release/shrinker or supported-ABI check is not
selected.

### 3 — negotiate the direct native secure session

Implement the smallest UI-independent production-shaped client:

1. open one OkHttp WebSocket;
2. send `srp_hello`;
3. validate the challenge and compute `A`, `M1`, and `S` with Nimbus;
4. send `srp_proof` and verify `M2`;
5. derive the base key;
6. decrypt and validate `srp_verify_server_info`;
7. derive the connection transport key;
8. send encrypted client capabilities and a ping or bounded request;
9. validate a monotonically sequenced encrypted response; and
10. close the socket and all owned callbacks deterministically.

The probe exposes no generic WebView bridge operation and persists no secret.

### 4 — prove native session resume

Keep the checkpoint credential only in instrumentation-test memory. Close the
first socket, open a second socket, perform the two-phase challenge-bound resume
flow, verify `srp_resume_server_proof`, derive a fresh transport key, reset
sequence state, and exchange one encrypted response. Replay or mutation of the
old proof, transport nonce, ciphertext, or sequence must fail closed.

Durable Keystore storage follows after the library and protocol checkpoint so
storage code cannot mask a crypto mismatch.

### 5 — review the connection foundation

Present:

- selected versions and why alternatives lost;
- fixture coverage and any intentional Nimbus adapters;
- baseline and selected APK sizes plus exact new native files;
- JVM, lint, release, emulator/device, direct full-SRP, encrypted-traffic,
  resume, and teardown evidence;
- any discovered mismatch in existing TypeScript comments or contracts; and
- the proposed first post-checkpoint slice.

This checkpoint was approved on 2026-08-02. Relay integration, durable
credential persistence, the connection manager, and bounded Compose work may
continue as later slices. Foreground-service declarations retain their own
product/policy review.

## Validation Matrix

| Layer | Required evidence |
| --- | --- |
| TypeScript | Fixture generation/verification, existing secure WebSocket E2E suite, malformed proof/envelope coverage |
| Kotlin JVM | SRP parameters, exact vectors, encoding, hashes, protocol parsing, state transitions, cancellation without Android framework state |
| Android instrumentation | Loaded crypto backend, secretbox vectors, direct full SRP, server proof, encrypted request/response, resume, and teardown |
| Release build | Warning-free R8/lint, both client channels, exact APK native-library inspection, measured size delta |
| Physical device | Explicit serial/model/API/user, `adb reverse`, no WebView allocation, full SRP, encrypted response, resume, socket close, and no secret-bearing logs |
| CI | Config-free JVM/lint/channel builds and deterministic crypto/device vectors; no Firebase or live relay credential required |

The existing attached physical device is preferred. If it is unavailable, use
an existing JSTorrent AVD for functional feedback and defer only the
physical-device acceptance row.

## Checkpoint Evidence — 2026-08-02

### Library result

| Library | Result |
| --- | --- |
| Nimbus SRP6a 2.1.0 | Selected. Apache-2.0, no production transitive dependencies, exact `A`, `M1`, `M2`, raw `S`, base-key, and transport-key match without replacing its arithmetic. The YA wrapper only fixes the group/hash, translates hex, extracts minimal unsigned `S`, and discards the password-holding session after verification. |
| LazySodium Android 5.2.0 | Selected. MPL-2.0 wrapper around bundled libsodium; its ARM64 implementation matched production TweetNaCl proof, binary-envelope, resume, and tamper vectors on the Pixel. |
| JNA 5.17.0 Android AAR | Selected as LazySodium's native dispatcher, dual Apache-2.0/LGPL-2.1-or-later. LazySodium's POM otherwise resolves the non-Android JNA JAR, so the build excludes that edge and requests the AAR explicitly. |
| OkHttp 4.12.0 | Selected. Apache-2.0 and already-shaped WebSocket cancellation/close ownership. OkHttp 5.4 was rejected for this checkpoint because its Kotlin 2.2 metadata cannot be consumed by the app's deliberate Kotlin 1.9/Compose toolchain. |
| Kotlin coroutines 1.9.0 | Selected for cancellable suspension and timeout ownership; Apache-2.0. |

No pure-Java secretbox fallback was necessary: the reviewed native candidate
worked on device, passed R8, supplies all four established Android ABIs, and has
a measured rather than unknown packaging cost.

### Packaging result

The universal hosted release APK grew from the pre-dependency baseline of
1,772,548 bytes to 3,749,469 bytes: +1,976,921 bytes. Of that, the new native
payload is 1,886,068 bytes across all four ABIs. An ARM64 installation needs
443,256 bytes of the two new native libraries before package-level overhead;
the universal APK carries every ABI by design.

Every release APK contains only the exact established native allowlist:
`libandroidx.graphics.path.so`, `libdatastore_shared_counter.so`,
`libjnidispatch.so`, and `libsodium.so` for `arm64-v8a`, `armeabi-v7a`, `x86`,
and `x86_64`. ABI filtering removes the obsolete `armeabi`, `mips`, and
`mips64` dispatch libraries present in JNA's AAR. R8 succeeds for both bundled
and hosted release channels. The JNA dispatcher is deliberately kept unstripped
because the Android NDK stripper does not recognize its prebuilt form.

### Protocol and device result

- Fixture verification reproduces production `tssrp6a` 3.0.0, TweetNaCl
  1.0.3, YA key derivation, and shared binary framing byte for byte.
- Kotlin JVM tests match the exact 2048-bit/SHA-512 SRP transcript and reject a
  changed server proof plus attempted session reuse.
- LazySodium device tests match full-login proof, binary protocol, and resume
  fixtures and reject changed ciphertext.
- The direct integration probe uses real `RemoteAccessService`,
  `RemoteSessionService`, `/api/ws`, SRP handlers, encryption, and message
  router. It binds host loopback and reaches the phone through `adb reverse`;
  it never starts `RelayClientService`.
- Physical device `33031JEHN17672`, Pixel 7a, Android 17 / API 37, user 0,
  completed full SRP, authenticated server-info proof, encrypted capabilities,
  encrypted ping/pong, normal close, challenge-bound resume on a new socket,
  a fresh transport key, a second encrypted ping/pong, and a second normal
  close. No Activity or WebView was allocated by the instrumentation test.
- Server ordering showed first disconnect before the resume connection and a
  final disconnect afterward. The probe has no heartbeat, retry, or recurring
  owner, and its temporary server directory is removed on shutdown.

### Warning-free validation

- `pnpm android:interop:check`
- server secure-WebSocket E2E: 23 passed, 1 intentionally skipped
- `pnpm typecheck`
- `pnpm lint`
- `pnpm console:scan`: 110/110 existing warning budget, delta zero
- Gradle tests, lint, bundled debug/release, and hosted release with
  `--warning-mode all --no-daemon`
- Android APK contract inspection
- Pixel instrumentation: two LazySodium tests and one direct full-login/resume
  test, all passed

The final direct proof invokes the already-built test APK with `adb shell am
instrument`, avoiding Gradle's configuration-cache warning for arbitrary
command-line instrumentation arguments. The cleartext allowance exists only in
that explicitly opted-in debug build for host-loopback `adb reverse`; release
manifests remain HTTPS-only.
