# Android Bundled-Web Native Transport

Topic: mobile-server-pairing

Status: Approved architecture; implementation not started.

## Outcome

Opening the complete bundled web interface from an authenticated Android
profile should enter the application without another username/password prompt.
The bundled client will use a custom `SourceTransport` over an exact-origin
Android message channel. Kotlin remains the sole owner of SRP, resume material,
route selection, encryption, connection capabilities, and reconnect.

Compose, foreground work, and the WebView are logical consumers of
profile-scoped process-level connection managers. Each owns a lease, local
request namespace, subscriptions, and cancellation scope. Eligible profiles
may share a physical relay-mux socket without sharing SRP or source state. No
new YA server route, capability, child credential, or server-visible session
type is required.

Related contracts:

- [Mobile server pairing](../../topics/mobile-server-pairing.md)
- [Mobile companion app](../project/mobile-companion-app.md)
- [Client source runtime topology](../../topics/client-source-runtime-topology.md)
- [Source transport](../../topics/source-transport.md)
- [Trusted client packaging](../../topics/trusted-client-packaging.md)
- [Android native connection foundation](081-android-native-connection-foundation.md)
- [Server message routing](../project/server-message-routing.md)
- [Relay client multiplexing](../../topics/relay-client-mux.md)

## Fixed boundaries

- The privileged transport exists only for the bundled app-assets origin, in
  its main frame, and only while its owning document and Activity are alive.
  Hosted-`latest` continues to perform ordinary web SRP.
- `window.yaNative` remains a small control plane. Its current 16 KiB request
  guard does not apply to application transport and must not be raised merely
  to fit uploads or transcript responses.
- The bridge exposes source operations, not raw relay messages. Web code cannot
  set connection-wide capabilities, browser-profile metadata, wire request
  ids, transport sequence numbers, or authentication state.
- Kotlin never returns the password, resume key, transport key, or a delegated
  bearer credential to JavaScript.
- Speech is deferred. A later native speech implementation may own a dedicated
  ephemeral speech connection because current speech state is socket-scoped.
- An independently authenticated bundled WebView remains a possible later
  optimization or advanced mode. It must use an explicit normal SRP login and
  its own browser-scoped resume session unless a separately reviewed delegated
  credential contract is approved.
- Native multi-host demand and relay-mux ownership are an implementation
  prerequisite. Host selection is presentation state, and the bridge must not
  introduce one mutable global native connection.
- Native issues opaque document-scoped source handles. Every data-plane
  operation is scoped to one handle; stale-document and forgotten-profile
  handles fail without being rebound to another profile.
- Android initially carries full-WebView, media, and 64 KiB upload traffic over
  the profile's mux circuit, including when it is the only circuit. Pixel
  contention measurements, not anticipation, decide whether a later dedicated
  socket optimization is warranted; `NativeSourceTransport` does not expose
  the physical choice.

## Message and streaming contract

The existing 16 KiB `NativeHostProtocol` limit protects only small JSON control
requests. Application messages use a distinct protocol with these properties:

- fixed-size binary bridge frames, initially targeting at most 64 KiB of data
  plus a small header;
- a feature handshake that prefers ArrayBuffer frames and permits bounded
  base64 string chunks on older WebViews without binary-message support;
- logical message id, frame sequence, byte offset, end marker, and cancellation;
- byte-credit acknowledgements and bounded per-WebView queued/in-flight bytes;
- one coalesced UI-thread drain rather than one unbounded callback burst;
- explicit limits and failures for malformed metadata, inconsistent offsets,
  queue overflow, and document replacement; and
- metrics for bytes, frames, queue high-water, p50/p95 latency, main-thread
  drain duration, cancellations, and overflow.

Fragmentation bounds the bridge and UI-thread queues. It does not claim that
JSON parsing is incremental: the current encrypted WebSocket protocol seals
each JSON response or event as one message, so Kotlin must receive and decrypt
that logical message before routing it. Large transcript responses require
representative memory and latency testing. A failure caused by WebView
backpressure must release only the WebView lease.

### Uploads

Uploads retain the existing relay upload protocol:

1. JavaScript sends a small `upload_start` operation with filename, MIME type,
   size, and destination.
2. It reads the browser `File` stream in the established 64 KiB chunks.
3. Each chunk crosses the bridge as an ArrayBuffer when supported; Kotlin adds
   the existing UUID/offset binary-upload header, encrypts it, and sends format
   `0x02`. A bounded base64 compatibility frame is allowed only when the
   installed WebView lacks ArrayBuffer messaging.
4. Local byte credits stop the file reader when the bridge queue is full;
   OkHttp queue high/low-water marks stop it when the network socket falls
   behind.
5. Server progress and completion events resolve the existing upload API;
   abort or teardown cancels the upload and releases buffered chunks.

These chunks provide bounded streaming, not cross-connection resume. If the
socket is lost, its server-owned upload state is discarded and the upload
fails; an explicit retry starts from byte zero. Resumable uploads would be a
separate capability-gated server feature.

A 100 MiB upload therefore produces 1,600 64 KiB chunks. Kotlin never needs a
100 MiB byte array. Each encrypted wire chunk adds 66 bytes before WebSocket or
relay-mux framing: 24 bytes of upload id/offset, one inner format byte, a
24-byte nonce, a 16-byte secretbox authenticator, and one envelope-version
byte. Bridge framing adds another small local header and no base64 expansion on
the normal binary path. The older-WebView string fallback does incur base64
expansion and is measured separately rather than treated as the normal
performance path.

Blob/download results use the same bounded fragmentation across the local
bridge. The current server relay path nevertheless reads the full binary
response and base64-encodes it inside one JSON response before Kotlin receives
it. Eliminating that wire-level whole-response and base64 cost requires a
separate capability-gated server contract and is not hidden inside this
client-only adapter. Normal JSON requests, responses, and subscription events
may span multiple bridge frames without inheriting the control channel's
16 KiB limit.

## Implementation plan

### 1 — prove native multi-host and relay-mux ownership

Before adding the WebView data plane, keep several profile managers demanded
concurrently, group eligible relay profiles below them, preserve exact legacy
fallback, and prove isolated connect/retry/reauthentication/revocation. Treat
the selected profile as presentation state. Exercise ordinary and full-session
traffic through the same logical circuit without exposing its physical relay
choice to consumers.

This prerequisite is tracked in
[tactical 084](084-android-native-multi-host-runtime.md).

### 2 — bind the WebView to a native source handle

Pass the selected paired profile into `WebClientActivity`, mint a
document-scoped source handle, acquire a dedicated connection-manager lease,
and release it on document replacement or Activity destruction. Keep profile
selection and navigation Android-owned.

### 3 — establish the exact-origin transport protocol

Add the separate binary-capable listener/reply channel, frame codec, local
request namespace, cancellation, queue accounting, and lifecycle tests. Reject
hosted, subframe, stale-document, oversized-frame, invalid-sequence, and
post-destruction traffic.

### 4 — enter the bundled client through `NativeSourceTransport`

Implement connection status, JSON fetch, activity, session, and session-watch
subscriptions. Register custom source runtimes from Android source handles and
bypass the web login screen without inventing browser-profile metadata or
exposing native authentication state. Switching hosts obtains another native
handle/runtime rather than invoking web-owned SRP.

This is the first WebView physical-device review checkpoint. On the attached
Pixel, prove concurrent Compose and WebView requests/subscriptions on one native
SRP connection, WebView-only teardown, reconnect restoration, and bounded
bridge metrics against a disposable standalone YA profile.

### 5 — carry large responses and binary blobs efficiently

Add bridge fragmentation/reassembly, ArrayBuffer blob delivery, inbound gzip
format `0x03`, explicit memory/queue limits, and parity for response status,
headers, redirects, setup-required errors, timeout, and abort behavior.

### 6 — stream uploads through the existing binary wire format

Implement `upload_start`, format-`0x02` chunk encryption, progress,
backpressure, cancellation, staged uploads, completion, and cleanup. Verify
1 KiB, 16 KiB, 64 KiB, 256 KiB, 1 MiB, 10 MiB, and 100 MiB cases without
whole-file Kotlin allocation.

### 7 — harden lifecycle and contention

Exercise navigation, rotation, WebView renderer death, Android process death,
network loss, relay reconnect, direct-route selection, queue overflow, a slow
WebView beside active Compose work, and multiple paired profiles. The native
core must remain useful whenever only the WebView consumer fails.

## Validation gates

- TypeScript unit tests cover `SourceTransport` semantics, reassembly,
  cancellation, redirects, error mapping, and upload progress.
- Kotlin unit tests cover frame validation, identifier ownership, flow control,
  encryption formats, lease cleanup, and queue overflow isolation.
- Android instrumentation uses a disposable standalone YA server/profile for
  direct SRP and a relay smoke where route behavior matters.
- Physical-device performance covers 1 KiB through 1 MiB logical responses,
  20–50 Hz events, concurrent Compose/WebView activity, and a 100 MiB upload.
- Existing server request-concurrency, upload-ordering, encrypted framing, and
  stable-client compatibility suites remain warning-free.

The native multi-host prerequisite has its own human checkpoint. The first
WebView checkpoint is after step 4. Steps 5–7 should not be treated as proven
merely because the small-message vertical slice works.
