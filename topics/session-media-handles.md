# Session Media Handles

> Replace inline transcript media with authenticated, lazy server handles
> without making persistent copies by default. Durable tool-result preservation
> is a separate default-off feature whose location follows the global
> project-directory storage policy.

Topic: session-media-handles

Parent storage contract:
[Project Directory Storage](project-directory-storage.md).

Settings surface: [Storage Settings](storage-settings.md).

Status: media handles and unconditional materialization are implemented in
current source after `0.7.0`; no stable npm release contains them. The default
persistence behavior violates the approved target and awaits implementation.

Use this document before changing provider message normalization, session
detail REST payloads, transcript media renderers, image-bearing tool results,
public share transcript capture, or the session-detail ingest boundary.

## Problem

Provider transcripts legitimately store binary media as JSON strings. Codex
uses `data:image/...;base64,...` URLs in session JSONL; Claude-style messages
can carry `{ type: "image", source: { type: "base64", data } }`; structured
image results can carry data URLs or path-only references.

Sending that representation through every YA session-detail response is
expensive:

- the response pays full image size even if the user never expands it;
- relay traffic carries the bytes as part of the encrypted JSON body;
- the browser retains large UTF-16 base64 strings in transcript caches; and
- presentation varies across provider formats.

That performance problem requires lazy media delivery. It does not require YA
to preserve another durable copy of every image, and it does not authorize a
project write.

## Separate Decisions

Three concerns must remain independent:

1. **Lazy delivery:** replace inline bytes in the client-facing transcript with
   metadata plus an opaque authenticated handle.
2. **Durable preservation:** retain bytes that might otherwise disappear, such
   as a path-only result in `/tmp`. This is a user-visible data-retention
   feature and defaults off.
3. **Storage location:** if preservation is enabled, use app-data storage by
   default or the project only after the separate global project-local opt-in.

Calling preservation a cache or implementation detail does not change its
retention semantics.

## Default Lazy Handle Model

During normal transcript scanning, the server detects media and builds an
in-memory catalog keyed by provider, project, session, source file stamp, and
opaque media id. A durable locator may contain internal JSONL line/offset and
JSON-pointer information; none of that enters the public handle.

On media fetch, the server seeks to the provider-owned transcript location,
parses the containing record, validates the content hash and safe raster type,
decodes the bytes, and streams them. If the in-memory catalog is cold or the
source stamp changed, rebuilding it by scanning the transcript is the default
cost. Persistent indexing is an optional optimization only after measurements
justify it, and any such index lives in bounded app-data storage.

Live output can arrive before provider persistence catches up. In default
on-demand mode that boundary uses a size- and lifetime-bounded memory or
temporary app-data store tied to the process/session lifecycle. It must not
survive indefinitely because a provider session is idle or a client tab
closed. With preservation explicitly enabled, a newly emitted result crosses
instead into the durable store at this live managed-session boundary.

A path-only result is available while its permitted source path exists. When
the source disappears and preservation was not enabled, the media ref becomes
unavailable with an explicit reason. YA does not snapshot it silently.

## Public Shape And Fetch Route

Session responses contain presentation metadata and handles, never retained
base64 payloads:

```ts
type TranscriptMediaRef =
  | {
      state: "available";
      toolCallId: string;
      id: string;
      mimeType: string;
      byteLength: number;
      width?: number;
      height?: number;
      filename?: string;
    }
  | {
      state: "unavailable";
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
```

The exact migration from the current `stored`/`rejected` names is an
implementation compatibility detail. The invariant is that a handle does not
promise or imply that YA made a durable copy.

The authenticated route remains:

```text
GET /api/projects/:projectId/sessions/:sessionId/media/:mediaId
```

The client fetches through the active source transport:

- direct mode: credentialed HTTP fetch;
- relay mode: `connection.fetchBlob(path)`, then `URL.createObjectURL(blob)`.

Collapsed media rows fetch no bytes. Expanded rows lazily fetch and render an
object URL. Do not render a bare `/api/...` URL directly in `<img>` because a
relay-origin page does not share the server origin.

## Optional Durable Preservation

Durable tool-result preservation is default-off and requires a dedicated
setting. Enabling project-local storage alone does not enable it.

The setting is
`toolResultMediaPreservation: "on-demand" | "preserve"`, defaulting to
`"on-demand"`. When preservation is enabled, capture the authoritative returned
bytes for new results emitted while YA is managing a session; use a permitted
source path only for a path-only result. Capture happens at the live
tool-result boundary even when no client is connected so temporary sources do
not disappear first. Validate file signatures, reject script-capable formats
such as SVG, record safe metadata, and content-address identical bytes. Blob
and catalog writes remain atomic and hash-verified.

Preservation is not a historical read-through cache:

- enabling it starts no scan, import, migration, or backfill;
- provider replay and persisted history are not new results;
- session-detail loads, pagination, and image fetches never create preserved
  copies;
- disabling it stops later captures without deleting prior copies; and
- a provider that cannot distinguish new output from replay cannot implement
  preservation by treating replay as new output.

Physical location follows the global policy:

- **App data only:**
  `<data-dir>/tool-results/<project-key>/<session-id>/`;
- **Store YA assets with projects:**
  `<project>/.yep/tool-results/<session-id>/` after explicit opt-in and safety
  checks.

Preservation has no automatic age limit, size eviction, garbage collection, or
pruning. It may grow without bound, and the Settings copy states that plainly.
On disk pressure or write failure, YA does not interrupt the provider turn,
delete an older copy, or silently change location; it reports the failed
preservation and uses any still-available provider-backed on-demand source.

There is no persistent server disk-cache mode in v1. If measurements later
justify avoiding cold transcript scans or repeated decoding, a bounded cache
with eviction is separate product work and a separate remotely advertised
capability. It is not implemented by weakening the preservation promise.

Preserved tool output is viewer state, not provider input. It is never listed
as an attachment or supplied automatically to a later turn.

## Current Implementation Audit — 2026-08-03

Commit `800a4598` replaced the earlier lazy-locator proposal with unconditional
materialization below `<project>/.yep/tool-results/<session-id>/`. It captures
both live results and images encountered while reading durable session history.
There is no setting and no automatic retention or garbage collection.

Observed in one project after seven days of current-source use:

- 352 image blobs: 342 PNG and 10 JPEG files;
- 391 small catalog records;
- 258.8 MiB of blobs across five Codex sessions; and
- most path-backed captures copied from `/tmp` or `/private/tmp`.

The originating implementation commit explicitly listed automatic retention
and garbage collection as deferred. This growth satisfies the documented
trigger for revisiting that decision.

No stable npm release contains the implementation: the latest stable release,
`0.7.0`, predates `800a4598`. Existing source checkouts after that tag may
already contain `.yep/tool-results` data.

## Legacy Data And Upgrade Behavior

The policy correction does not delete, migrate, rehash, or add exclusions for
existing `.yep/tool-results` during upgrade. In app-data mode the server may
read legacy project-local records for compatibility, but it does not refresh,
repair, or grow them.

Any later cleanup or historical-import action is separate explicit product
work. The first correction does not add one.

## Metadata And Layout

The server extracts cheap safe metadata while replacing payloads:

- MIME type from validated signatures rather than extension claims;
- decoded byte length and a content hash;
- dimensions for PNG, JPEG, GIF, and WebP where practical; and
- a safe filename from provider metadata or a stable synthetic name.

Known dimensions reserve bounded layout space. Unknown dimensions use a
bounded loading placeholder. The browser-local inline-expansion preference
remains default-off and does not alter storage or preservation policy.

## Security Contract

Media fetches must:

- use the same authenticated session access check as the transcript;
- never accept a client-supplied filesystem path;
- use opaque ids mapped server-side;
- validate source containment and returned bytes;
- send accurate `Content-Type` and `X-Content-Type-Options: nosniff`;
- reject script-capable media without an explicit safe rendering path; and
- work over the encrypted relay request channel.

Public shares require a share-scoped media manifest. A raw session id plus
media id never grants public access.

## Non-Goals

- Do not rewrite provider-owned JSONL as the first correction.
- Do not expose line numbers, byte offsets, JSON pointers, host paths, or
  `.yep` paths as public media identifiers.
- Do not move conversion to the browser; that still transfers the base64.
- Do not make inline expansion default-on.
- Do not treat huge non-media output such as stdout as part of this policy.

## Acceptance

In the default configuration, loading live or historical image-bearing
sessions leaves the project tree and Git metadata unchanged and creates no
durable media copy. A cold image fetch may rescan provider persistence, and an
expired path-only image may report unavailable.

With preservation explicitly enabled, tests cover new results emitted by
managed sessions with and without a connected client, provider replay
rejection, absence of historical-read writes, configured location, content
deduplication, corruption handling, write failure, direct/relay fetches, and
transition from live temporary bytes to provider-backed or preserved media.

## Related Topics

- [Project Directory Storage](project-directory-storage.md)
- [Storage Settings](storage-settings.md)
- [Attachment Storage](attachment-storage.md)
- [Media Rendering And Routing](media-rendering-and-routing.md)
- [Server Capabilities](server-capabilities.md)
