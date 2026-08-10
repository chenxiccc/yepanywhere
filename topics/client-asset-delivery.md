# Client Asset Delivery

> Client asset delivery makes a built YA entrypoint and every chunk it names
> compact, cache-correct, and available across a deployment generation without
> caching mutable HTML as immutable application code.

Topic: client-asset-delivery

Status: Contract and measured correction target. API response compression is
implemented; production static encoding, validators, immutable recognition,
and generation retention are not.

## Current demonstrated behavior

The production static handler reads the requested file completely with
`fs.promises.readFile`. Hono compression is mounted only for `/api/*` and
`/public-api/*`, so the application JavaScript and CSS bypass it.

The handler recognizes an immutable asset only when its filename suffix is a
hexadecimal hash. Current Vite names include hashes such as `D3zWbkxu` and
`BPXPYV9_`, so real `/assets/` output fails that test. A fresh isolated build
served the 2,668,843-byte application JavaScript response with:

```text
Content-Length: 2668843
Cache-Control: public, max-age=0, must-revalidate
```

It sent no `Content-Encoding`, `ETag`, or `Last-Modified`. The 565,170-byte CSS
response had the same delivery shape. A cache-disabled browser therefore
transferred both files in full. Ten repeated JavaScript requests added about
26.70 MB of server logical reads even though the operating-system page cache
prevented physical storage reads; each request still created whole-file read
work and a transient buffer.

The older assumption in tactical 022 that static assets were cacheable is
false for these generated filenames and headers. Cloudflare may compress or
cache the edge-to-browser response under its own policy, but it does not repair
the direct/LAN path or make origin delivery/versioning correct.

Both browser entrypoints are now route-split at semantic page and shell
boundaries. In the 2026-08-10 warning cleanup, the hosted entry's eager
JavaScript fell from 2,938,667 bytes to 477,061 bytes. The local entry fell from
about 2.84 MB to 472,214 bytes; its largest deferred chunk is 492,331 bytes.
Every emitted JavaScript chunk from both builds remains below Vite's 500 kB
warning boundary, and every future Vite warning fails the owning production
build. Both builds bind `tssrp6a`'s Node `crypto` probe to the browser Web
Crypto API, preserving the existing secure-context requirement without a Node
compatibility shim.

The personal Pages publish path keeps earlier content-addressed assets instead
of deleting them, so its old entrypoints retain the chunks they name. This does
not complete the direct/LAN static-server retention, encoding, or cache-header
work below.

## Response contract

Treat build-owned `/assets/` filenames as immutable only when the build
pipeline proves they are content-addressed. Prefer a manifest/build assertion
or the exact Vite output namespace over a hand-written guess at allowable hash
characters. An immutable response has a long lifetime and `immutable`; bytes
at that URL never change.

HTML, the service worker, manifests, and other mutable entry resources are not
immutable. Give them explicit revalidation/no-cache semantics so a new entry
can name a new asset generation. Do not cache HTML under the asset contract.

Serve compressible generated assets with a negotiated representation:

- prefer build-generated Brotli and gzip sidecars so request handling performs
  no runtime compression of a multi-megabyte file;
- select only an encoding accepted by the request and set
  `Content-Encoding` plus `Vary: Accept-Encoding`;
- fall back to the identity representation when required;
- never compress already-compressed fonts, images, archives, or media merely
  because they live under `/assets/`; and
- ensure range, `HEAD`, content type, and content length describe the selected
  representation correctly.

Stream the selected file or use an equivalently bounded send primitive. A
request for a large cached asset must not require a new full raw-file buffer in
process memory (Node `Buffer` storage is generally external to V8's managed
heap, but still raises resident/transient memory). Runtime gzip middleware is
an acceptable measured first slice for transfer size, but it does not satisfy
this allocation contract by itself.

## Deployment generations

An HTML entrypoint and every dynamic chunk it names form one generation. A
long-lived tab may request a route chunk only after a newer build is deployed.
The deployment must keep at least the preceding complete immutable asset
generation available for the supported tab lifetime, or the client must have a
single state-preserving fresh-entry recovery. The recovery keeps the URL and
unsent composer/draft state and must not loop.

Immutable assets may coexist safely because their URLs are content-addressed.
Cleanup removes only generations that no retained entrypoint can still name
under the declared support window. A deployment that deletes old chunks
immediately is incompatible with route-level dynamic imports even when a fresh
load works.

## Verification contract

Tests and release checks cover:

- real generated filenames, including mixed-case and underscore hash tokens;
- immutable headers only for build-proven immutable assets;
- mutable HTML/service-worker revalidation and no stale entrypoint;
- Brotli, gzip, and identity negotiation with byte-for-byte decompression;
- `Vary: Accept-Encoding`, correct `HEAD`/length/type/range behavior, and no
  double compression of fonts/images/media;
- bounded server heap/resident/transient allocation during repeated large-file
  requests; and
- an old loaded entrypoint requesting an uncached dynamic chunk after the next
  generation deploy.

See [`docs/tactical/022-api-response-compression.md`](../docs/tactical/022-api-response-compression.md)
for the implementation plan and
[`docs/tactical/096-client-route-module-loading.md`](../docs/tactical/096-client-route-module-loading.md)
for the first consumer of the generation-retention contract.
