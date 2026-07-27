# Session Media Handles

> Inline base64 media in transcript messages should become server-owned media
> handles before it enters retained session-detail state. The public handle is
> stable and opaque; row, line, byte offset, and JSON pointer locations are
> internal lookup details.

Topic: session-media-handles

Status: implementation contract. Use this document before changing provider
message normalization, session detail REST payloads, transcript media
renderers, `Read` image result rendering, public share transcript capture, or
the session-detail data-layer ingest boundary.

## Problem

Provider transcripts legitimately store binary media as JSON strings. Codex
uses `data:image/...;base64,...` URLs in session JSONL; Claude-style messages
can carry `{ type: "image", source: { type: "base64", data } }`; structured
`Read` image results can carry `file.base64`. That is a provider interchange
format, not a good retained UI state format.

When inline base64 crosses into YA's session detail API and browser state:

- the REST response pays full image size even if the user never expands the
  image;
- relay users receive that payload over the encrypted request channel as part
  of the JSON body instead of fetching bytes only when needed;
- the client retains UTF-16 base64 strings in transcript caches, which is much
  heavier than retaining a `Blob` URL while visible;
- render behavior differs across providers because Codex durable input images
  are already partially stripped while Claude image blocks and some `Read`
  results still ride through;
- auto-expanded inline image previews can shift old transcript rows unless the
  server supplies enough metadata to reserve layout.

This is a performance feature with security implications. A media URL is not
authorization by itself. Any fetched media must use the same authenticated
session access check as the transcript, work through direct and relay
transports, avoid client-supplied filesystem paths, and serve untrusted bytes
with safe content headers.

## Current Evidence

Measured locally on 2026-07-04:

| Provider / session | JSONL size | Image bytes in JSONL | Live full API response |
| --- | ---: | ---: | ---: |
| Codex `webvam / 019d2bd5-...` | 173.3 MB | 164.9 MB, 95.2% | 14.20 MB |
| Codex `webvam / 019d2fd3-...` | 125.2 MB | 119.8 MB, 95.7% | 5.63 MB |
| Codex `playbox / 019e3998-...` | 86.8 MB | 77.4 MB, 89.1% | 14.67 MB |
| Claude `jstorrent / 06a8e997-...` | 61.6 MB | 0 MB | 61.76 MB |
| Claude `jstorrent / fe23a2d9-...` | 20.6 MB | 17.3 MB, 84.2% | 22.96 MB |
| Claude `webvam / ebcf36f3-...` | 19.6 MB | 7.2 MB, 36.8% | 21.87 MB |

The Codex rows show the local JSONL problem clearly: large files are often
image-dominated, including repeated `payload.content.0.image_url`,
`payload.images.0`, `payload.replacement_history...image_url`, and generated
image `payload.output.0.image_url` strings. YA's current Codex durable
normalization already strips the image URL from the session API for many input
image cases, so the live API payload is much smaller than the JSONL.

The Claude rows show the remaining API problem. The largest sampled Claude
JSONL was not image-driven; it was a huge `toolUseResult.stdout`. But the next
large Claude image sessions still returned inline base64 in the live API body
(`"base64"` keys were present in the response).

## Target Shape

Session detail responses should contain metadata and handles, not bytes:

```ts
type TranscriptMediaRef =
  | {
      state: "stored";
      toolCallId: string;
      id: string;
      mimeType: string;
      byteLength: number;
      width?: number;
      height?: number;
      filename?: string;
    }
  | {
      state: "rejected";
      toolCallId: string;
      reason:
        | "invalid-image-data"
        | "source-unavailable"
        | "storage-unavailable"
        | "too-large"
        | "unsupported-media";
      filename?: string;
      claimedMimeType?: string;
    };

interface InputImageBlock {
  type: "input_image";
  file_path?: string;
  media?: TranscriptMediaRef;
}
```

A stored ref contains presentation metadata and an opaque handle, never a
filesystem path or bytes. A rejected ref is an explicit terminal result: the
renderer can explain why no preview is available without retrying a bad
payload or silently falling back to its claimed extension.

The exact block names may follow existing provider-specific shapes, but the
normalized message also carries a provider-neutral tool-result media list so
the transcript compiler can give every image-bearing tool result the same
presentation. Every ref retains its tool-call ID so a provider message
containing several parallel results cannot project one tool's images onto a
sibling row. The session-detail response must not retain the replaced base64
payload.

The fetch route is:

```text
GET /api/projects/:projectId/sessions/:sessionId/media/:mediaId
```

The client fetches through the active source transport:

- direct mode: credentialed HTTP fetch;
- relay mode: `connection.fetchBlob(path)`, then `URL.createObjectURL(blob)`.

Do not render a bare `/api/...` URL directly in an `<img>`; relay-origin pages
do not have the local server's API.

## Materialized Tool-Result Storage

Tool-result output is materialized under:

```text
<project>/.yep/tool-results/<session-id>/
```

The directory must be obtained through `ensureManagedProjectDir`, preserving
its creation-time `.git/info/exclude` behavior for `.yep/`. A symlinked or
unwritable managed path is unsafe; use a project/session-scoped fallback below
the configured YA data directory. The public ref and serving route stay
identical across both physical locations.

Bytes are content-addressed within the session. A separate catalog record maps
each stable handle to the content hash and safe metadata:

```ts
interface SessionMediaCatalogEntry {
  id: string;
  provider: string;
  projectId: string;
  sessionId: string;
  toolCallId: string;
  mimeType: string;
  byteLength: number;
  width?: number;
  height?: number;
  filename?: string;
  originalPath?: string;
  contentHash: string;
}
```

The handle may be deterministic but clients must not parse it. Blob and catalog
writes are atomic: a partial image must never become a valid handle. Identical
bytes in one project/session share the same content-addressed blob even when
separate tool calls have separate stable handles.

## Media ID And Lookup Model

The public `mediaId` is opaque. A reasonable deterministic seed is:

```text
sha256(provider + projectId + sessionId + toolCallId + mediaIndex + contentHash)
```

Row numbers, line numbers, byte offsets, JSON pointers, `.yep`, and host paths
must not be part of the public handle. The catalog is the only durable
handle-to-blob mapping.

### Active Process Media

`Process` is the live provider-neutral capture boundary. It materializes image
bytes before retaining or emitting a normalized tool result. The durable
session-detail boundary performs the same conversion after authorized history
slicing and before returning messages. Both use the same store and reference
shape, preserving live/persisted render parity.

When immediate durable materialization is impossible, any temporary live-byte
store must be size- and lifetime-bounded and cleaned with the process/session.
The implemented path should prefer immediate materialization so an idle
provider or closed tab retains no unbounded image buffer.

Provider transcript or input media is a separate migration. It may still use a
transcript locator/catalog until it is moved to materialized storage; that
locator must remain server-internal and must not weaken the handle or
authorization contract above.

## Metadata Extraction

The server should extract cheap metadata while replacing the payload:

- MIME type from validated file signatures, retaining a provider claim only as
  diagnostic metadata;
- decoded byte length and content hash from the validated bytes;
- dimensions for PNG, JPEG, GIF, and WebP using header parsing when practical;
- filename from provider path or a stable synthetic name such as
  `pasted-image-1.png`.

The returned bytes are authoritative when a result also names a path. YA must
not reread the mutable path instead. A path-only image event is snapshotted at
event completion only when the existing local-file policy permits it.
Unsupported or script-capable content, including SVG, is rejected based on
bytes rather than accepted from its claimed MIME type or extension.

Dimensions matter because historical transcript rows must not change height
unexpectedly. Known dimensions reserve bounded layout space; unknown dimensions
use a bounded loading placeholder.

## Client Rendering Contract

Every normalized image-bearing tool result uses the shared outline media row:
filename/type metadata, an individual `+ / -` toggle, and a lazy inline
preview. The browser-local `inlineMediaExpandedByDefault` setting chooses the
initial state until that row is toggled. Collapsed rows fetch no bytes; expanded
rows fetch through the active source transport and render an object URL.
Filename and image clicks may still open `LocalMediaModal` and its native-tab
affordance.

Stable transcript media handles would also unlock durable client UI state for
inline preview expansion. The 2026-07-04 inline-media regression showed that
DOM-only expansion state (`data-expanded`, mounted preview children, and object
URLs owned by the rendered-markdown post-processing effect) is vulnerable when
React legitimately remounts rendered transcript HTML. The immediate fix was to
keep identical rendered HTML in a stable island so unrelated quote-button
measurement does not remount inline media. Media handles would address the
next layer: expansion/collapse state and any bounded blob/object-URL cache
could be keyed by stable media identity, so route restores, transcript cache
eviction, changed HTML, or other legitimate remounts can recreate an expanded
preview intentionally without refetch flicker.

The setting remains default-off. Applying it to historical rows must respect
the layout-stability rule from `packages/client/RENDERING_PERFORMANCE.md`;
known dimensions or the bounded placeholder reserve the expanding row.

## Security Contract

Media handle fetches must:

- use the same authenticated/local session authorization as the transcript;
- never accept a client-supplied filesystem path;
- use opaque IDs mapped server-side;
- send accurate `Content-Type`;
- include `X-Content-Type-Options: nosniff`;
- neutralize or refuse script-capable formats such as SVG unless there is an
  explicit safe rendering path;
- work over relay by riding the encrypted request channel.

Public shares need a separate share-scoped media manifest. Do not let a public
share fetch arbitrary session media by raw session ID plus media ID unless the
media was part of the shared transcript snapshot or live-share visibility set.

## Non-Goals

- Do not rewrite provider-owned JSONL as the first implementation.
- Do not expose row numbers, line numbers, byte offsets, or JSON pointers as
  public media addresses.
- Do not move this conversion to the browser as a client-only cleanup. That
  still transfers and retains the base64 payload.
- Do not make image auto-expansion default-on as part of the media handle work.
- Do not solve huge non-media payloads such as giant stdout in this proposal.
  Those need separate output truncation/windowing rules.

## Retention

Tool-result media is viewer state, not provider input: it is never appended to
later user turns or attachment lists. Automatic pruning is deferred until
observed project/data-dir growth justifies a policy. A future cleanup must
remove catalog records and only then unreferenced content-addressed blobs; it
must cover both project-local and fallback locations.
