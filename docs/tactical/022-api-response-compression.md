# 022 - HTTP response compression and static asset delivery

Status: API compression implemented; static delivery reopened 2026-08-05.

Progress:

- [x] 2026-06-27: Mounted `hono/compress` on `/api/*` in
  `packages/server/src/app.ts`, registered first so it wraps the whole API
  response. Added end-to-end tests in
  `packages/server/test/api/sessions.test.ts` (encodes when the client accepts
  it + round-trips; leaves the body alone when `Accept-Encoding` is absent).
- [ ] 2026-08-05: A production cold-load audit found that generated client
  assets bypass compression, real Vite hashes fail the immutable-name test,
  and responses have neither validators nor streaming delivery. The static
  correction below is an implementation handoff.

Related contracts and plans:

- [`topics/client-asset-delivery.md`](../../topics/client-asset-delivery.md)
- [`089-main-thread-startup-cpu-investigation.md`](089-main-thread-startup-cpu-investigation.md)
- [`096-client-route-module-loading.md`](096-client-route-module-loading.md)

## Problem

A user running the server directly behind a Cloudflare tunnel reported that
large sessions (multi-MB Codex transcripts, >6MB) were slow to load. Nothing in
the direct HTTP path compressed responses — gzip existed only in the relay layer
(`encryptToBinaryEnvelopeWithCompression`, `crypto/nacl-wrapper.ts`), which the
direct/tunnel/LAN path never touches.

## Why a proxy in front doesn't fix it

The full session loads over a buffered HTTP GET
(`GET /api/projects/:projectId/sessions/:sessionId` → `c.json(...)`,
`routes/sessions.ts`), not over the WebSocket — so HTTP-level compression is the
right tool, and browsers send `Accept-Encoding` and decompress transparently
(no client change).

The wrong assumption was that Cloudflare/nginx would handle gzip for us.
Cloudflare's edge compression only covers the **edge → browser** hop. It does
nothing for **origin → edge**: `cloudflared` ships the origin response raw, so
the full payload crosses the dev machine's (often residential, slow-uplink)
first mile uncompressed. That first hop is the bottleneck the user saw.
Tailscale/LAN clients have no compressing proxy at all. Compressing at the
application is what closes both gaps.

Measured gzip ratios on real on-disk sessions: ~2x for image/base64-heavy
transcripts (base64 is near-incompressible), ~4–6x for text/code-dominated
ones. Brotli would add ~10–20% but needs a custom middleware (Hono's compress is
gzip/deflate only); deferred as not worth the complexity for v1.

## Decision

`app.use("/api/*", compress())` — one line, gzip/deflate, default 1KB threshold.

- Covers every JSON API endpoint, not just session detail.
- Verified to work with the pinned `@hono/node-server` and on the Node-20 CI
  floor. The only modern API it relies on is `CompressionStream`, a Node global
  since v18.
- Safe across the routes under `/api/*`: it bails on WebSocket upgrades
  (`RESPONSE_ALREADY_SENT` has no compressible content-type / null body), SSE
  (`text/event-stream` is excluded from the compressible set), already-encoded
  responses, and sub-threshold bodies. Internal `app.fetch()` calls (public
  shares) send no `Accept-Encoding`, so they're never encoded — no
  double-encode risk on `response.json()`.

## Production static delivery fault

`packages/server/src/frontend/static.ts` currently reads each requested file
fully with `fs.promises.readFile`. Compression middleware is mounted only for
`/api/*` and `/public-api/*`, so static responses bypass it.

The immutable detector accepts only `/assets/<name>-[a-f0-9]+.<ext>`. Current
Vite output uses non-hex tokens such as `D3zWbkxu` and `BPXPYV9_`; real hashed
assets therefore receive `public, max-age=0, must-revalidate`. They also have
no `ETag` or `Last-Modified`, so revalidation cannot produce a cheap `304`.

An isolated production server returned the main 2,668,843-byte JavaScript file
and 565,170-byte CSS file uncompressed. The JavaScript response had a full
`Content-Length`, `max-age=0`, and no `Content-Encoding` or validator. Ten
repeated GETs added about 26.70 MB of server logical reads and 1,352 read
syscalls while physical `read_bytes` stayed flat because the operating-system
page cache was warm. That avoids disk latency, but not per-request filesystem
work, copying, or a new whole-file transient buffer.

The previous follow-up called static assets lower priority because they were
cacheable. That premise is false in the current build/handler pairing. It also
becomes load-bearing for tactical 096: route splitting produces more immutable
chunks and old entrypoints must still be able to request the generation they
name.

## Static delivery implementation

### 1 — derive immutable identity from the build

Treat build-owned `/assets/` output as content-addressed through a Vite
manifest/build assertion or an exact build-output contract. Do not repair the
current bug with a broader guessed hash regular expression. Generated immutable
URLs get a long lifetime plus `immutable`; HTML, the service worker, manifests,
and other mutable entry resources retain explicit revalidation/no-cache
behavior.

### 2 — generate and negotiate compressed sidecars

Generate Brotli and gzip representations for compressible JavaScript, CSS, and
text assets at build/package time. Select an accepted representation and send
`Content-Encoding` with `Vary: Accept-Encoding`; retain identity fallback.
Avoid recompressing fonts, images, archives, and media. Runtime gzip is an
acceptable measured first transfer-size slice, but it does not settle the
whole-file allocation issue.

### 3 — stream the selected representation

Serve the chosen file with bounded buffering rather than `readFile` of a
multi-megabyte asset for every request. Preserve correct content type, content
length, `HEAD`, range, and not-found behavior for the selected representation.

### 4 — retain deploy generations used by old entrypoints

Keep at least the preceding complete immutable asset generation for the
supported tab lifetime, or add one one-shot state-preserving fresh-entry
recovery. The latter must retain the current URL and unsent composer/draft state
and may not loop. Do not delete an old dynamic chunk while a retained HTML
entrypoint can still name it.

### 5 — verify delivery and allocation contracts

Use real generated names, including mixed-case and underscore tokens. Cover
Brotli/gzip/identity round trips, `Vary`, immutable versus mutable headers,
validators where applicable, no double compression, repeated large-file
heap/resident behavior, and an old loaded entrypoint requesting an uncached
chunk after the next deployment.

## Remaining follow-ups

- Brotli (better ratio) — would need a small custom middleware using
  `zlib.createBrotliCompress` for dynamic API bodies. This remains separate
  from build-generated static sidecars.
