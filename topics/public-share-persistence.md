# Public Share Persistence

> Public-share persistence separates small bearer-link grants from independently
> loadable session content so one share never requires loading or rewriting all
> other frozen shares.

Topic: public-share-persistence

The implemented store is owned by `PublicShareStore`; the specialized legacy
aggregate reader is `LegacyPublicShareReader`. `PublicShareService` retains the
product-level authorization and viewer-presence interface while delegating
durable content and grants to that store.

## Why the aggregate must go

The legacy `public-shares.json` combines every valid bearer authorization with
every frozen `AppSession` and viewer-specific snapshot. Startup reads and parses
the complete file; every mutation pretty-stringifies and rewrites it. The
measured 502 MB store retained about 1.55 GiB of V8 heap after parse and reached
about 3.50 GiB process RSS while stringifying an unchanged state.

The load bound is wrong even without those measurements. Opening one link,
showing one session's management controls, or revoking one grant must not read,
parse, or serialize frozen content belonging to another session.

The legacy startup also projects not-ready as empty. Until the aggregate parse
finishes, session status returns zero; if reading, validating, or parsing fails,
the service leaves that false-empty state indefinitely. Read/parse exceptions
only log a warning, while invalid shape also has no actionable readiness
state. The popup therefore can hide all management controls forever rather
than exposing a loading or failed state.

The current frozen payload is structured, sanitized `AppSession` JSON, not a
captured DOM or worktree. It may include server-produced render augments, but
the public client reconstructs the view with the normal `MessageList`. Current
rewritten file links validate a path against strings in that session and then
read today's project file; transitive render assets are also discovered from
today's Markdown/HTML.

## Logical model

A **link grant** is a compact bearer authorization. It maps one URL secret hash
to an opaque share id, one share-state id, source-session identity for owner
management, and a target of either `live` or one immutable frozen revision.
New grants also retain the exact public URL so the authenticated owner can copy
an existing authorization; legacy grants remain hash-only because their secret
cannot be recovered. Deleting the grant revokes the URL.

**Share state** is the independently stored public projection for one source YA
session. At most one live share state exists for a source session. Multiple
URLs are separate grants over that state; they do not duplicate the live
record. Frozen and live grants can coexist and select different revisions.

A **frozen revision** is one immutable sanitized transcript copy plus bounded
presentation metadata. The first implementation uses a response-ready gzip
copy. A later turn-prefix representation is allowed only over immutable,
share-owned chunks whose cursor cannot change meaning; a byte range into a
provider transcript, mutable source file, or ordinary JSON response is not a
valid frozen boundary.

## Complete frozen capture

Live serving keeps its incremental session loader. Every operation that can
publish frozen authority—new frozen grants, whole-session live-to-frozen
conversion, and viewer-token freeze—uses a separate required complete-history
loader. The app adapter requests the real session-detail route with
`publicShare=1&fullHistory=1`, parses its normal metadata-plus-top-level-messages
envelope, and rejects missing messages, pagination, truncation, or inconsistent
message counts as retryable incomplete history. For this internal request only,
the route also returns the number of messages through the latest completed turn.
An idle source exposes its complete history. A busy source trims the latest
user-authored turn and its partial output; replay-only output before the provider
has created durable history contributes no messages. A newly resumed process
may expose the durable history that predates its current turn. This marker does
not add a field to `AppSession` or the public wire protocol.

An active YA or externally observed session must remain eligible for frozen
sharing. Its capture is the completed-turn prefix described above, not a claim
that the current mutable turn is complete. An invalid, disconnected, or
otherwise ineligible viewer-token freeze is rejected as a no-op before this
complete loader or any project scan runs; the serialized store mutation still
rechecks eligibility before retargeting authority.

One source read produces one sanitized, recursively immutable `AppSession`
projection. Presentation authorization is derived from that same projection.
The store serializes the projection through its persistence serializer, and a
SHA-256 source witness covers exactly those normalized session bytes;
sanitization is not repeated between witness generation and persistence. A
separate persisted integrity witness extends those exact session bytes with the
canonical presentation metadata. Project-backed captures keep this stable
content witness even though their revision IDs include per-attempt randomness
to distinguish worktree snapshots.

Frozen publication remains content-before-authority. After the immutable gzip
revision and optional copy-on-write project tree are complete, but immediately
before inserting a grant or retargeting whole-session/viewer authority, the
store invokes a transient validator. The validator performs a second explicit
complete-history read and compares the exact originally captured message prefix.
Turns appended after the boundary do not invalidate publication; removal or
mutation within the prefix does. Missing or partial history and prefix mismatch
are typed, retryable capture failures. No new grant is inserted and existing
live or viewer authority remains unchanged; the durable cleanup journal collects
the unreferenced attempted revision and project snapshot.

## Physical access bounds

YA app data owns one public-share directory with two storage classes:

```text
public-shares/
├─ grants.<implementation-owned>       compact; no transcript bodies
├─ cleanup.<implementation-owned>      pending share-state collection journal
├─ shares/
│  └─ <opaque-share-state-id>/         independently openable
│     ├─ state.json                    small source/header/revision metadata
│     └─ frozen/<revision-id>/
│        ├─ session.json.gz
│        ├─ presentation.json
│        └─ project/                   optional CoW project-tree clone
└─ migration.json
```

The current implementation uses an atomic `grants.json`, per-state
`state.json`, response-ready `session.json.gz`, and `presentation.json`. The
grant file's size is proportional to valid-link metadata and it contains no
transcript or project-file bytes. It is intentionally not organized by
session; management filters that bounded control data without touching state
directories.

The grant store is the sole source of truth for valid URLs and supports direct
secret-hash lookup, authenticated inventory, and per-session filtering. A
share-state directory can never recreate a deleted grant. Startup may open
bounded control state and compact grants; it does not scan or open frozen
revisions or project snapshots.

Loading or mutating a frozen revision touches only its share-state directory.
Creating, freezing, or serving one share never serializes another share's
content. Global inventory and revocation read compact grants only. Empty state
and unreferenced revisions are garbage collected after authorization changes
commit.

## Design decisions

- **Selective management freeze uses one indexed capability and an exact-ID
  batch** (vs. widening `public-share-management` or calling the session-wide
  freeze once per listed link): source builds that already advertised the
  original management contract keep their meaning, while the server can
  resolve reviewed opaque grant IDs to source sessions, capture each source
  once, and avoid exposing project IDs in global inventory. One request carries
  at most 100 reviewed grant IDs in a stream-enforced 32 KiB JSON body.

All store content is owner-only app data. Opening remediates and verifies the
store root before trusting it. Every control file, temporary file, gzip body,
revision directory, project clone, and retained legacy backup is created or
opened through a strict owner-only path check: regular files are `0600` and
directories are `0700` on POSIX with ownership and group/other access verified;
Windows resolves the process principal and SID, assigns object ownership to that
principal, removes inherited access and owner DENY entries before replacing the
DACL owner grant, then queries and verifies both the object-owner SID and the
resulting owner-only DACL. Mismatched ownership, a remaining owner DENY entry,
or any application/verification failure fails readiness. The unrelated
best-effort secret-file permission API keeps its existing warning-only contract. No share state, index, snapshot,
migration marker, cleanup journal, or garbage-collection record belongs in a
selected project or its Git metadata.

## Frozen project files

When a frozen revision is created, YA attempts the platform's project-tree
copy-on-write clone on the actual project/app-data filesystem pair. Inferring
support from an OS name is insufficient. A successful clone supplies as-of file
bytes without an eager full physical copy.

The clone is storage, not authority. Direct paths come from the immutable
transcript projection. Transitive Markdown/HTML render references are derived
only after a successful clone, by reading the completed clone rather than a
pre-clone live-project scan; a reference removed before the clone therefore
cannot authorize an unrelated file that merely remains in the captured tree.
Public file views remain limited to those captured paths and bounded render
assets; unlinked clone content is never exposed. Git metadata is not a public
asset.

Symlinks are omitted from a successful clone. Preserving one could escape the
immutable tree and expose current external bytes while the revision claimed
copy-on-write semantics. An authorized linked symlink is therefore unavailable
from a CoW-backed frozen revision rather than silently becoming live.

Project-backed captures do not reuse an older revision merely because the
sanitized transcript bytes are identical. Each capture attempt has a distinct
revision identity so a worktree changed between two freezes cannot make the
second link alias the first link's project snapshot. Grants created by one
freeze operation may still share that operation's revision.

If the filesystem does not support the CoW operation, YA deliberately keeps the
legacy behavior for linked files: an authorized link reads the current project
file. The owner-facing frozen-share action and the public frozen viewer both
show a persistent warning that the transcript is frozen but linked project
files remain live and may expose later contents. The compact public header
carries this mode so the warning appears before the transcript body loads.

Only a classified unsupported operation selects that fallback. An unexpected
clone, I/O, space, or permission failure aborts frozen creation rather than
silently changing its semantics.

## Captured presentation is optional

`presentation.json` may replay results already known at capture time, such as
exact path-existence autolinks with opaque targets or glossary definitions
actually used in shared content. It does not authorize new discovery:

- no public path-existence query or arbitrary client-side link rewriting;
- no project rescan merely to enrich a share;
- no authenticated or live project-glossary subscription;
- no unused whole-glossary export; and
- no new presentation layer in the standard session/file renderer.

Capture these results only at an existing augment/result boundary with local
plumbing. If that is not easy, omit them. Storage correctness, authorization,
management, and compact headers do not depend on enrichment.

## URL secrets and compact bootstrap

New links use 16 CSPRNG bytes encoded as 22 unpadded base64url characters. This
provides 128 bits of entropy, the minimum [OWASP recommends][OWASP session
identifier guidance] when an application creates its own random session
identifier. Existing links use 64 bytes encoded as 86 characters and remain
valid.

YA accepts exactly those decoded lengths, hashes either form with the existing
SHA-512 function, and compares the supplied secret safely. Keeping SHA-512 as
the lookup namespace is required because legacy storage contains only that
hash. New grants retain the complete public URL in owner-only app data so the
authenticated management UI can copy it later. This intentionally makes the
compact grant file bearer-sensitive: anyone who can read YA's app data could
already control YA, and must now also be treated as able to use its public
links. Migrated and pre-change grants have no recoverable URL and expose a
disabled copy action rather than minting or guessing replacement authority.

The legacy URL fragment carries mode, project name, capture time, title, and up
to 700 characters of initial-prompt preview so the viewer can show something
before the combined response arrives. New grants persist that bounded public
header instead. A secret-authorized metadata route reads only the grant and
small state metadata; the viewer renders title, preview, mode, capture time,
and linked-file warning while the transcript fetch proceeds separately.

New URLs contain no display text. They retain the relay username, optional
non-default relay address, and a compact fragment protocol marker. An old
viewer ignores the marker and fetches the combined response; a new viewer uses
legacy display fragments on old links and does not probe an old server for an
unsupported metadata route.

## Transactions and revocation

Create content before authority:

1. durably enqueue the affected share-state id for idempotent collection;
2. create or reuse the share state and make a frozen revision/CoW clone durable;
3. atomically update its small state metadata;
4. atomically insert the grant;
5. drain the journal entry against the now-authoritative grant set; and
6. return the URL only after the grant commits.

Revoke authority before cleanup:

1. durably enqueue every affected share-state id;
2. atomically delete the grant from the serving store;
3. commit invalidation before deleting content;
4. collect unreferenced revisions and project snapshots;
5. delete an empty share-state directory; and
6. remove each journal entry only after its idempotent collection succeeds.

Freeze, viewer disconnect, and failed create rollback use the same additive
owner-only cleanup journal. Startup and re-enable replay it; `cleanupPending` is
derived from the in-memory mirror of its committed entries. Journal updates are
copy-on-write: pre-rename failure retains the old set, while a failed directory
sync after atomic replacement retains the newly committed set. A grant-file
write that fails after atomic replacement never restores older in-memory
authority.

Recovery never derives grants from leftover content. “Stop live updates” writes
the immutable revision first and then atomically retargets the valid grant from
`live` to that revision. Per-session and global revoke select grants from the
compact store; they do not open transcript bodies.

The immutable revision directory is renamed into place before its state entry
commits. Before either metadata-known deduplication or filesystem-orphan adoption
can create authority, one validator remediates and verifies the revision
directory, gzip body, presentation file and contents, and optional project
directory, rejecting missing paths, symlinks, wrong kinds, or representation/
project-clone mismatches. It stream-gunzips the stored session, verifies the
exact byte count and integrity witness expected from the complete-history
capture, and includes parsed canonical presentation metadata in that witness.
The persisted witness must agree too when state metadata already carries one;
older version-2 state gains the additive witness only after successful reuse
validation. Equal-size corruption and a structurally valid substituted orphan
therefore fail before grant or viewer authority changes. For a body-only
content-addressed capture, a later byte-identical body and presentation can then
adopt the complete orphan only when no project clone is present; an extraneous
`project/` is a representation mismatch, not evidence that the orphan should be
reclassified as CoW-backed. Project-backed captures have distinct revision
identities; an interrupted one remains unreferenced and cannot become authority.
Journal collection enumerates the actual frozen-directory children, removes
`.tmp-*` and every unreferenced revision even when `state.json` never recorded
it, then trims state metadata. A state directory without a remaining grant never
recreates a bearer authorization.

The Settings **Public Session Sharing** toggle remains a destructive global kill
switch. The settings routes reserve one shared serial transaction slot on
request arrival, before parsing, and keep persistence plus each live settings
effect in that order; the secondary remote-executor persistence route uses the
same queue. Initialize, enable, and disable are one request-ordered desired-state
lifecycle; each call records its desired state before waiting. A superseded
enable cannot publish stale readiness, while every disable records an obligation
that survives a rejected call and persists the `disabled` migration marker
before journaling and invalidating all grants. Re-enable first replays any
unfulfilled destructive disable, then finishes durable disable cleanup before
replacing the marker with `complete` and reaching `ready`, so interrupted or
closely followed toggles cannot resurrect grants.

## Opening and legacy migration

The service reports `opening`, `migrating`, `ready`, `failed`, or `disabled`.
Authenticated status never projects a not-ready store as an empty inventory.
The broadcast popup shows an immediate loading or actionable failure management
region, then resolves a ready session from compact grants without a global
content scan or blind 10-second delay.

Left- and right-click on the broadcast icon open the same management pane at
the same dropdown-like anchor. The Session menu's Share action opens that pane
too, using its default placement. In session context, its two-column layout
keeps five filter rows in the left rail: all projects, this project, and this
session are mutually exclusive (this session is the default); frozen and
live are independent and both default on. Settings management is fixed to all
projects and exposes only the frozen and live filters. Each
selector uses the same white line-glyph tile, accent fill, and tinted-row
selected-state grammar as Settings categories; selection does not depend on a
subtle border alone. The right column lists matching grants with active
connection counts, copy and revoke actions, and—on servers advertising
`public-share-management-freeze`—a freeze action on live rows only. It scrolls
only when available viewport height cannot contain the rows. At narrow widths
the pane stays
anchored below the broadcast icon and expands to the available viewport width;
it does not switch to the centered or bottom modal placement. Each type row
keeps its actions available before inventory resolves. Its green `+` is the
sole session-link creation affordance in the manager: it creates that kind of
link, enables its filter, copies it, refreshes inventory, and highlights the
created row. Strong red `×` actions beside all five selectors use an inline
two-step flow. A location `×` selects that location and both types; a type `×`
keeps the selected location and isolates that type. The first click therefore
makes the visible inventory exactly the set that a second click will revoke,
then resolves every metadata page so its `×` can become a `✓`. The bottom red
banner is inert status, not another action: while armed it states the exact
type/location intersection, link count, and active-client count. A second
click on the same category control revokes; the All projects `×` is therefore
the direct all-projects/all-types path. Any other in-pane control cancels the
armed action; outside-click or clicking the broadcast icon dismisses the pane.
Each listed share carries a compact right-side live/frozen glyph before its
copy and smaller action controls. A live row's freeze control uses the same
significant-action confirmation as its revoke control, then retains bearer
access at the newly captured state. The Live type row provides the bulk path:
its first click selects and pages through the exact live-link set in the current
location, its inert banner reports link and active-client counts, and its second
click confirms. Frozen rows and the Frozen type row expose no freeze action.

One mounted manager controller belongs to one backend source. Changing the
current source remounts the controller, clears its inventory and operation
state, and invalidates every callback owned by the previous source before the
new inventory request starts. A non-abortable create or revoke may still settle
on its admitted source, but its late result cannot publish into the replacement
controller. Losing the advertised management capability unmounts and closes the
Settings manager immediately; restoring capability does not reopen it without a
new user action.

While public sharing is ready, an open session polls its compact owner status
every five seconds. A structurally unchanged response preserves the existing
client-state identity and does not rerender the session page; changed share or
viewer counts replace the status immediately.

Legacy migration is record-at-a-time and streaming. It must not `readFile`,
`JSON.parse`, or `JSON.stringify` the complete aggregate or one huge embedded
body. The streaming reader validates the complete JSON grammar even for ignored
legacy fields and preserves UTF-8 code points split across its 64 KiB reads; a
malformed ignored literal cannot advance the source to a backup or commit a
migration marker. Startup cleanup removes only strictly named regular atomic
temps for the owned control files, never an unknown lookalike or directory. It
preserves legacy secret hashes and URL behavior, groups live grants
for the same source session onto one live state, and writes every frozen body
independently. Legacy frozen links cannot recover an as-of project tree, so
they are marked as live-linked-file mode and carry its warning.

Until the durable migration marker exists, link reads and mutations return a
retryable unavailable state rather than false not-found/empty results. Ordinary
authenticated session use remains available, and the global kill switch can
disable/revoke the legacy source during migration. The original aggregate is
renamed to a non-serving backup before completion and retained for an explicit
later cleanup decision.

Migration starts only after the listening server is available. Its durable
completion marker and log record the migrated grant count, source byte offset,
body bytes, elapsed time, and observed peak heap. A malformed source remains in
place; a successful source becomes a non-serving backup. Availability is scoped
to the selected frozen representation: migration marks the inspected primary or
viewer revision only. A broken primary does not disable an intact viewer
snapshot, and a broken viewer snapshot does not disable the live/default view or
other viewers. In particular, a live primary with no frozen-primary availability
field is available regardless of the grant-wide downgrade marker; that marker is
only the fallback for an older frozen primary. Compact metadata remains
available in every case. Existing
version-2 grants that lack representation fields are upgraded once by streaming
each such stored gzip revision through the migration inspector without
materializing a complete session. Scoped fields take precedence in current
selection, while `repairRequired: true` remains on disk whenever any scoped
representation needs repair so older binaries still fail closed; complete
scoped fields prevent repeated inspection on later startups. A frozen legacy
body whose stored message count cannot be satisfied remains explicitly
unavailable instead of being repaired from later live session contents.

## Serving and management bounds

The compact metadata route reads a grant and its already-persisted public
header without opening `session.json.gz`, including when a stored representation
needs repair. Session-body and share-scoped file routes resolve the requested
primary or viewer representation first and reject only when that selected
frozen revision is marked `repair-required`.

For an available immutable revision with complete persisted length and
integrity metadata, the secret-authorized v2 header advertises
`public-share-session-chunks-v1`. New revisions are eligible only when both the
compressed gzip and decompressed session are at most 64 MiB; creation rejects a
larger projection before publishing authority. Structurally valid historical
revisions above either ceiling remain stored but are not chunk-capable. They
omit the capability, so a conforming client sends no chunk request and uses
`wire=raw-json`; relay access succeeds only through the 8 MiB raw-response cap
and otherwise returns 413 with update guidance. Direct HTTP streaming can still
load a larger structurally valid revision. Direct chunk requests reject with
update guidance.
Repeated ordinary `GET /public-api/shares/:secret/session-chunks` requests read
at most 256 KiB of compressed bytes directly from that revision's
owner-validated `session.json.gz`. Each response identifies the immutable
revision, integrity witness, chunk index, current and next offsets, complete
compressed length, final state, and an opaque next cursor. The cursor is
HMAC-bound to the bearer grant/share state, selected primary or viewer identity,
immutable revision, selected capture timestamp, and next offset. Revocation
removes the grant before another request can resolve; retargeting, viewer
changes, revision changes, and cross-grant cursor reuse fail closed. Every
request still requires the bearer secret. The chunk route never gunzips or
materializes the complete stored session.

The browser runtime-validates metadata before publishing the compact header,
constructing a decompressor, allocating the advertised destination, or pulling
a first chunk. It requires safe integer lengths within both 64 MiB ceilings,
the exact 256 KiB chunk bound, no more than 256 chunks, and exact HTTP status and
response shape at every hop. Relay text-frame ceilings count encoded UTF-8
bytes, not JavaScript string code units, so non-ASCII metadata, chunks, and
legacy responses cannot exceed their physical transport bounds. It accepts one
chunk before requesting the next
over the same public viewer WebSocket, feeds the compressed bytes to one
incremental gzip stream, uses fatal UTF-8 decoding, and parses then validates the
complete `AppSession` only after final compressed and decompressed lengths
match. The advertised decompressed length owns one destination allocation;
chunks are copied into it as they arrive rather than retained for a second full
copy. One `AbortSignal` owns the page request, pending relay transaction,
WebSocket, gzip writer/reader, and result-publication fence. A readable-side gzip
failure is observed immediately and closes the connection before another pull
can start. A metadata endpoint that is absent or returns an older
capability-free shape, an otherwise valid response without the capability, or a
browser without `DecompressionStream` keeps the established one-response
`raw-json` path and sends no chunk request. The viewer reuses the metadata
socket when it remains open and creates one fresh socket only when a
capability-absent one-response peer already closed it; a capable transfer never
splices chunks across sockets. Malformed metadata that explicitly advertises
the capability still fails before decompressor work or fallback. Those fallback
responses are runtime-validated too. Unmarked links keep the ordinary combined
response and do not probe metadata, so `#v=2` retains its compact-bootstrap
meaning rather than becoming a transport version.

A pre-auth WebSocket selects one lifetime mode. Its first public-share read
locks it to `public_read_only`; any SRP control attempt locks it to `srp` even
when the proof later fails. Neither mode may cross into the other. The server
also permits exactly one public-share request in flight on a public-read-only
socket. A second request is a protocol violation that aborts the active request
and closes the socket rather than queueing more work. Socket close or error
aborts the internal Hono request and any response-body read. Each response uses
the plaintext or SRP framing captured when its request was admitted, never
mutable auth state at response-send time. Authenticated relay request
multiplexing is unchanged.

The WebSocket relay adapter caps every pre-auth public-share response body at
8 MiB. It retains no more than the accepted 8 MiB body plus one logical
inspection byte. Controlled combined/raw-json serializers emit source chunks of
at most 64 KiB, so cancellation can consume at most one bounded producer chunk
beyond the accepted prefix; they do not manufacture a one-byte source chunk at
the boundary. A producer chunk larger than the adapter's entire 8 MiB + 1
inspection bound is an internal invariant failure only on that controlled
serializer path. Other public resources, including `/files` and `/files/raw`,
use `Content-Length` only for early rejection and enforce the streamed count as
the hard bound; overflow cancels the source and returns 413. Frozen unmarked and
raw-json responses stream the immutable revision rather than materializing it
before this cap, and raw project files are cancellation-aware streams.
Authenticated relay traffic, unrelated relay routes, and direct HTTP
public-share streaming remain uncapped by this transport policy. The chunk
capability is not broadened to file transfer.

Viewer-presence telemetry is ephemeral server-owned state, not durable share
authority or a client-selected workload. It retains at most 4,096 bearer/viewer
pairs across the process for the two-minute active window. Per-share hash maps
provide identity lookup while one access-ordered set tracks recency. Expiration
and capacity maintenance inspect the oldest application record rather than
rescanning other sessions or viewers; the process-wide cap also bounds any
engine-dependent scan inside the ordered set. Capacity eviction affects
approximate presence/count history only and never blocks a valid public read or
changes frozen/disconnected viewer authority.
The bounded access-ordered `Set` is deliberate pending whole-server profiling.
On Node 24/V8 13.6, a constructed tombstone-heavy oldest lookup measured about
1.72 microseconds, while replacing it with intrusive recency links retained
about 19 extra bytes per modeled record (roughly 76 KiB at the cap) and would
spread unlink invariants across every removal path. Reconsider the structure
only if production profiling makes viewer-heartbeat maintenance material; then
compare it with an intrusive doubly linked list under the same workload.

Authenticated inventory and revocation are exposed by the dedicated
`public-share-management` route module. Inventory uses stable keyset pagination
with a maximum page size of 100 and optional project, session, and mode filters.
It returns opaque share ids, retained public URLs, public headers, sizes, modes,
timestamps, and ephemeral viewer counts—never the standalone secret, secret
hash, transcript body, project root, or authorized path set. A URL is absent for
legacy hash-only grants. One-link revocation and explicitly confirmed global
revocation commit grant invalidation before best-effort content collection; a
cleanup failure remains visible as `cleanupPending`.

Selective live-link freezing is independently gated by the permanent indexed
`public-share-management-freeze` capability. Its authenticated batch route
requires an explicit confirmation marker and an exact non-empty opaque
`shareIds` set. It ignores missing or already-frozen grants, groups the remaining
live grants by source session, and publishes one complete current capture per
source group before retargeting only those grants. Processing stays bounded to
one source capture at a time; a later source failure can therefore follow
earlier committed groups, reports the converted count in the error response,
and causes the manager to refresh inventory. A client without the capability
keeps inventory, copy, and revocation unchanged and makes no freeze request.

## Related contracts

- [`relay-origin-and-share-gating.md`](relay-origin-and-share-gating.md)
  defines bearer authorization, owner management, compact-link compatibility,
  and relay visibility.
- [`security.md`](security.md#public-share-file-access) defines the public file
  boundary and warned live-file fallback.
- [`public-share-content-censorship.md`](public-share-content-censorship.md)
  defines the separate proposed transcript-redaction layer.
- [`project-directory-storage.md`](project-directory-storage.md) keeps this
  persistence in app data rather than the selected project.

[OWASP session identifier guidance]: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#session-id-content-or-value
