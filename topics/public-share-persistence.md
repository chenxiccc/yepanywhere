# Public Share Persistence

> Public-share persistence separates small bearer-link grants from independently
> loadable session content so one share never requires loading or rewriting all
> other frozen shares.

Topic: public-share-persistence

Status: Target contract; not implemented. The executable migration and
verification sequence lives in
[`docs/tactical/090-public-share-persistence-and-management.md`](../docs/tactical/090-public-share-persistence-and-management.md).
Delete that tactical ledger after this contract is implemented and verified.

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

A **link grant** is a compact bearer authorization. It maps the hash of one URL
secret to an opaque share id, one share-state id, source-session identity for
owner management, and a target of either `live` or one immutable frozen
revision. Deleting the grant revokes the URL.

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

## Physical access bounds

YA app data owns one public-share directory with two storage classes:

```text
public-shares/
├─ grants.<implementation-owned>       compact; no transcript bodies
├─ shares/
│  └─ <opaque-share-state-id>/         independently openable
│     ├─ state.json                    small source/header/revision metadata
│     └─ frozen/<revision-id>/
│        ├─ session.json.gz
│        ├─ presentation.json
│        └─ project/                   optional CoW project-tree clone
└─ migration.json
```

This is a logical layout, not a mandate that the grant store use JSON. A small
atomic file, an embedded database, or separately keyed compact records are all
valid. Its size is proportional to valid-link metadata and it contains no
transcript or project-file bytes. It need not be organized by session.

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

All store content is owner-only app data. No share state, index, snapshot,
migration marker, or garbage-collection record belongs in a selected project or
its Git metadata.

## Frozen project files

When a frozen revision is created, YA attempts the platform's project-tree
copy-on-write clone on the actual project/app-data filesystem pair. Inferring
support from an OS name is insufficient. A successful clone supplies as-of file
bytes without an eager full physical copy.

The clone is storage, not authority. Public file views remain limited to paths
already linked or visible in share content and bounded render assets; unlinked
clone content is never exposed. Git metadata is not a public asset.

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
the lookup namespace is required because legacy storage contains only that hash;
the plaintext secret is returned once and never persisted.

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

1. create or reuse the share state and make a frozen revision/CoW clone durable;
2. atomically update its small state metadata;
3. atomically insert the grant; and
4. return the URL only after the grant commits.

Revoke authority before cleanup:

1. atomically delete the grant from the serving store;
2. commit invalidation before deleting content;
3. collect unreferenced revisions and project snapshots; and
4. delete an empty share-state directory.

Recovery never derives grants from leftover content. “Stop live updates” writes
the immutable revision first and then atomically retargets the valid grant from
`live` to that revision. Per-session and global revoke select grants from the
compact store; they do not open transcript bodies.

The Settings **Public Read-Only Share** toggle remains a destructive global kill
switch. Disable persists the false gate first, invalidates all grants, and then
resumes cleanup. Re-enable finishes interrupted disable cleanup and starts with
no resurrected grants.

## Opening and legacy migration

The service reports `opening`, `migrating`, `ready`, `failed`, or `disabled`.
Authenticated status never projects a not-ready store as an empty inventory.
The broadcast popup shows an immediate loading or actionable failure management
region, then resolves a ready session from compact grants without a global
content scan or blind 10-second delay.

Legacy migration is record-at-a-time and streaming. It must not `readFile`,
`JSON.parse`, or `JSON.stringify` the complete aggregate or one huge embedded
body. It preserves legacy secret hashes and URL behavior, groups live grants
for the same source session onto one live state, and writes every frozen body
independently. Legacy frozen links cannot recover an as-of project tree, so
they are marked as live-linked-file mode and carry its warning.

Until the durable migration marker exists, link reads and mutations return a
retryable unavailable state rather than false not-found/empty results. Ordinary
authenticated session use remains available, and the global kill switch can
disable/revoke the legacy source during migration. The original aggregate is
renamed to a non-serving backup before completion and retained for an explicit
later cleanup decision.

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
