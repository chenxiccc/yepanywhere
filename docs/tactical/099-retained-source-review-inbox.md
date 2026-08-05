# Retain Source Review Inbox Projections

> Serve unread Source Review outcomes from one durable, incrementally updated
> projection instead of listing every project and loading every review store on
> each Inbox mount or response event.

Status: Implementation handoff, not yet implemented. Tactical 089's follow-on
collection audit located this optional/default-off amplification path. It is
not evidence for the 2026-08-04 incident.

Related contracts and plans:

- [`topics/source-review-to-session.md`](../../topics/source-review-to-session.md)
- [`topics/architecture-mandates.md`](../../topics/architecture-mandates.md)
- [`topics/project-directory-storage.md`](../../topics/project-directory-storage.md)
- [`031-client-query-controller.md`](031-client-query-controller.md)
- [`085-project-directory-storage-policy.md`](085-project-directory-storage-policy.md)
- [`089-main-thread-startup-cpu-investigation.md`](089-main-thread-startup-cpu-investigation.md)

## Current fan-out and retention

When Source Review submissions are enabled, `GET /api/review/inbox` calls
`ProjectScanner.listProjects()`, then `Promise.all`s every project through
`ReviewCommentService.getStoreFile(project.path)`. It scans each store's
submissions, sites, entries, and outcomes before sorting the unread result.
Filtering to one project happens later in `InboxContent`, after the global
response has already done all-project work.

`ReviewCommentService` retains every touched `ProjectStore` in its process-wide
`stores` map until `reset()`. One review-Inbox read therefore not only loads all
project stores concurrently; it keeps their complete sites, entries,
submissions, outcomes, saver closures, and mutation tails resident for the
server lifetime.

The client keeps this feed in `InboxContent`-local state. Mount triggers one
global read, manual refresh repeats it, and every `review-response-changed`
event repeats it. The event proves one accepted submission changed but carries
no exact unread projection, so one project mutation reloads all projects.

Source Review submissions are default-off, so this is not part of the ordinary
089 cold request census and cannot explain the demonstrated sustained CPU. It
has the same scaling fault as the session and Project Queue collections: a
global projection is recomputed by each consumer instead of maintained by the
state owner.

## Target projection

Maintain a compact source-review Inbox row for each submission whose
`responseRevision > acknowledgedRevision`:

- canonical project id and display name;
- submission id, name, and target YA session id;
- response and acknowledged revisions;
- bounded outcome cards with site id, relative path, entry id, disposition,
  text, and observation timestamp; and
- projection epoch/generation.

Response ingestion, acknowledgment, submission deletion/migration, project
rename/removal, and storage-policy relocation update the exact row and publish
a complete versioned delta. `GET /api/review/inbox` reads the retained
projection, optionally filtering by project before serialization. It performs
no project listing, review-store load, Git read, provider work, or response-file
probe.

Persist the compact projection under YA app data with atomic replacement. Do
not add another project-local file or Git ref. Coordinate with tactical 085's
central-storage migration so the review-state manifest/projection has one
owner; do not build a permanent side index over a storage layout scheduled for
replacement.

At boot, serve the last accepted projection immediately. Reconcile only
projects known by the central review-state manifest or touched by a review
mutation/ingestion event. A migration from the legacy layout may perform one
bounded scan, record progress, and publish only a complete accepted generation.
It cannot make each Inbox request rescan every selected project.

## Store lifetime

Give `ReviewCommentService` a byte/age budget and access retouch. A project
store with no pending mutation/save/ingestion may be released after its compact
Inbox row and canonical state are durable, then reloaded on exact project
demand. Never evict a pending coalesced save, active mutation tail, prepared
submission transaction, or the only canonical copy.

Track estimated bytes for sites, entries, outcomes, submissions, and captured
text. Count alone is insufficient because one project may contain much larger
review history than another.

## Client ownership and compatibility

Move the feed to tactical 031's retained query controller, keyed by backend
source. One query entry owns initial acquisition, reconnect/manual refresh, and
`review-response-changed` reduction. A complete delta patches the compact row
without a global refetch; an older event with only an identity invalidates one
source-level retained query, never one request per mounted component.

Removing the legacy refetch depends on an event/snapshot contract absent from
older servers. Before client/server edits, inspect the optional-feature stable
release corpus required by `topics/server-capabilities.md`. Add a new permanent
capability for retained review-Inbox generations/deltas if needed; do not
broaden `git-source-review-submissions`. Without it, keep one source-level
legacy refetch owner and make no unsupported request.

## Recommended implementation order

### 1 — measure nonempty review-Inbox work

Instrument project count, stores loaded/hit, files/bytes read, row/outcome
counts, peak live store bytes, and duration. Exercise one changed project among
many empty projects, repeated events, acknowledgment, and two mounted clients.

### 2 — define the compact unread projection

Add pure row construction and exact mutation rules. Preserve the complete
outcome/card fields the current UI renders, partial-observation semantics, and
revision ordering without retaining whole `ReviewStoreFile` objects.

### 3 — persist one projection with central review state

Land with or after tactical 085's app-data migration. Store an atomic accepted
generation and a manifest of projects that actually have review state. Make
legacy migration resumable and bounded.

### 4 — publish exact review deltas

Update ingestion, acknowledgment, project lifecycle, and review mutations to
repair the affected row and emit its new revision/generation. A partial build
never replaces the last accepted projection.

### 5 — remove route fan-out and bound stores

Make the global route a projection read with optional server-side project
filtering. Add byte/age release for clean inactive project stores and verify
that release cannot race pending saves or mutations.

### 6 — retain one client feed owner

Apply tactical 031, reduce capable exact deltas locally, and preserve one
source-level capability-gated legacy fallback for older servers.

## Acceptance

- Repeated unchanged `GET /api/review/inbox` calls perform zero project-list,
  review-store, response-file, Git, provider, or transcript reads.
- One response change or acknowledgment updates one project/submission row and
  never reloads unrelated project stores.
- A project filter bounds server serialization and does not first build the
  global projection from canonical stores.
- Cold restart serves the last accepted compact generation, then reconciles
  only manifest-known/changed review projects without blocking Inbox.
- Clean inactive stores release under an explicit byte/age budget; pending
  saves, mutations, and prepared submissions remain protected.
- One source has one retained client feed owner regardless of component/tab
  count, with an approved old-server fallback.
- With the feature disabled, no review catalog, migration, watcher, or poll is
  started.
