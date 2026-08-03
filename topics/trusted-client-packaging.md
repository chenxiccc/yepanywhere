# Trusted Client Packaging
> Trusted client packaging pins YA client code delivery through signed or local
> app installs so Remote Access credentials and cached session keys do not
> depend on live hosted JavaScript.

Topic: trusted-client-packaging

## Problem

Normal Remote Access can be zero-trust with respect to the relay only when the
entry client code is trusted. A hosted client such as `ya.graehl.org` is a
convenient bookmark/PWA entry point, but a compromise of that hosted JavaScript
can steal a password or cached resume secret before the SRP and encrypted relay
transport protections matter.

Trusted client packaging is the candidate answer for the stronger threat model:
the relay may be compromised, and the live hosted web origin may later be
compromised, but the user has already installed or pinned a trusted client.

## Candidate Shapes

- A packaged Android app serves bundled YA client assets from the app itself
  and only needs WebSocket connectivity to the configured relay.
- A Chrome-friendly local-client setup serves pinned client files from a stable
  local or extension origin rather than from a mutable hosted origin.
- A signed-update flow downloads replacement client assets only after verifying
  a manifest and artifact hashes under pinned graehl/kzahel signing keys.
- A first-run native flow uses full SRP with the Remote Access password; later
  native reconnects use the Keystore-protected resume credential without
  asking a hosted page for the password again. The bundled web client may keep
  its own independent browser session.

The mobile ownership decision is recorded separately in
[`mobile-server-pairing.md`](mobile-server-pairing.md): native Compose and
background operation use a native secure connection core, while the bundled
full web client may retain an independent web-owned SRP session and transport.

## Current Mobile Packaging Checkpoint

The first-class Android application has two explicit asset channels. Local
debug and ordinary production builds bundle the current checkout's client
assets through Android's HTTPS app-assets origin; a separate hosted-`latest`
release channel loads a fixed YA HTTPS origin for Play internal or closed
testing. Neither channel accepts an arbitrary runtime UI URL. Its native host
is exact-origin and main-frame bound and exposes only declared high-level
methods. The current methods are `host.describe`, `notifications.status`, and
the explicitly user-triggered `notifications.requestPermission`; no method
exports native credentials.

The signed Android package also owns one platform-native launcher identity:
YA's white Y over the established green gradient. Android 8 and later receive
separate full-bleed background, foreground Y, and monochrome Y layers so each
launcher can apply its own circle, squircle, themed tint, and motion effects.
The artwork does not bake in a rounded tile, bevel, border, or shadow. Because
the app's minimum SDK is 24, only Android 7 and 7.1 use density-specific legacy
PNGs; those fallbacks precompose the same Y over a green circle. Google Play's
512-pixel listing icon remains a separate full-bleed artifact rather than a
launcher resource.

The longer-term foreground choice has two permanent presentations. Android
Compose, and later iOS SwiftUI, own the focused native companion and
Conversation-view surfaces. The complete bundled web client remains a
full-fidelity alternative for users who prefer it and for rich tools, settings,
and unsupported native surfaces. Hosted `latest` remains valuable for
transitional testing, but it does not answer the stronger production trust
requirement below.

Bundled app-assets JavaScript is trusted application code: it is shipped under
the APK signature, is isolated in the app WebView, and does not load ordinary
browser extensions. It may legitimately read and modify YA application data.
The native host still remains exact-origin and method-scoped as inexpensive
defense in depth.

The bundled client does not initially need a native data-plane adapter. It may
keep the existing TypeScript `SecureConnection` and browser-local resume
credential independently of the Kotlin core. This avoids assuming that bridge
serialization, stream copying, uploads, and binary paths outperform the proven
web transport. A native-backed web transport is benchmark-gated future work,
not a prerequisite for native pairing or Compose.

Still unresolved are the stable public asset update/signing policy and the
exact native secure storage/rotation model. No authenticated-context handoff is
required for the first native core: native and bundled web may hold separate
server sessions. Native installation and push-management secrets remain
app-private and are not web credentials.

## Deferred Verification Setup

A useful host-local regression gate would run a separate YA checkout or built
artifact, not the in-tree hot-reload instance, with its own data directory,
ports, and fixed relay reservation name. A script could refresh that isolated
server, load credentials from an operator-private file, register it with the
relay, serve the candidate remote client, and then run the same browser path a
GitHub Pages publish would expose. That would test the actual hosted-client +
relay + YA-server shape before pushing Pages changes, while keeping private
relay credentials out of the public repo.

## Security Requirements

- A pinned value must be a verification key, key commitment, or server-auth
  proof input. It must not be a bearer token that an impostor server can simply
  accept.
- The client must authenticate the YA server, not merely the relay username.
  Full SRP already gives the client a server proof; session resume must also
  require an encrypted server proof bound to fresh client/server nonces before
  the client enters authenticated state.
- Cached resume material is secret bearer-equivalent material, not public-key
  material. Store it in the narrowest available app/origin scope and make it
  revocable from the YA server.
- The relay remains transport-only for authenticated Remote Access. It may see
  pairing metadata, timing, sizes, and public-share plaintext, but it must not
  receive Remote Access passwords or application plaintext.
- Public read-only shares remain a separate plaintext-to-relay design until YA
  grows share-specific end-to-end encryption.

## Current Remote Access Boundary

Protocol 3 resume uses a client nonce in `srp_resume_init`, the server's
one-time resume challenge as the transport nonce, and a `serverProof` encrypted
under the stored base session key. A relay-controlled impostor server can still
ask the client for a resume proof, but it cannot produce the server proof unless
it also has the stored resume key. The proof also carries the server's resume
protocol version; the client pins the highest authenticated protocol version it
has seen in local storage and rejects later resumes that prove a lower version.

That closes the compromised-relay false-server path after first trusted login.
It does not protect the password or cached resume key from malicious JavaScript
served by the trusted web origin itself. Avoiding that stronger hosted-client
threat requires signed or locally served client packaging.

## Open Questions

- How are permanent bundled web assets updated and verified without making
  live hosted JavaScript the credential trust root or waiting indefinitely for
  fixes behind app-store review?
- Do representative full-web workloads ever justify a native-backed web
  transport despite bridge serialization, streaming, upload, and lifecycle
  costs?
- Should graehl and kzahel use independent signing keys, a threshold policy, or
  a primary/backup-key policy with explicit rotation?
- What is the minimum browser storage model that keeps local-file or
  extension-served YA ergonomic while preserving WebSocket, clipboard, and
  service-worker behavior?
- Should first full SRP also pin a server-auth public-key commitment, so future
  first-login-like flows can detect an impostor before revealing any password
  proof material?
