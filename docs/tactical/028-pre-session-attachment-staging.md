# Draft Attachment Staging

Status: Partially implemented. Draft staging, send materialization, Project
Queue staged refs, and navigation-guard narrowing are implemented; manual
remote/mobile verification remains.

Design decisions captured here:

- Use server-side attachment staging for draft attachments.
- Design around an `AttachmentStagingService`.
- Move composer draft persistence to a tolerant JSON envelope.
- Stage new-session draft attachments without binding them to a project.
- Keep final sent attachment storage on the existing attachment-storage policy.
- Make draft-owned staging cleanup required and bounded.

Storage amendment (2026-08-03): the implemented staging lifecycle remains
valid, but its final project-local destination is superseded by
`topics/project-directory-storage.md`. App-data storage is the default; staged
materialization may write into a project only after the global opt-in.

Implementation progress:

- [x] Add draft envelope helpers and update draft persistence.
- [x] Add `AttachmentStagingService`.
- [x] Implement staged upload APIs for direct and relay transports.
- [x] Add staged-ref validation, deletion, and draft-to-session materialization
      APIs.
- [x] Wire staged materialization into existing-session normal sends and
      per-session deferred queue submissions.
- [x] Wire staged materialization into normal new-session starts after session
      creation.
- [x] Persist staged attachment refs in Project Queue items.
- [x] Transfer draft-owned refs to queue ownership on Project Queue creation.
- [x] Materialize queue-owned refs during Project Queue promotion.
- [x] Delete queue-owned refs on queue item deletion or successful promotion.
- [x] Narrow attachment navigation warnings to states that can still lose
      attachment intent.

## Context

Attachment handling has two related gaps:

1. New-session attachments currently require a real YA session before upload,
   because final upload storage is scoped to a session.
2. Composer text drafts survive refresh/navigation through `localStorage`, but
   selected files and in-flight uploads do not.

The old tactical shape solved only "pre-session" attachments. The better model
is broader: a composer draft may contain attachment refs, and those refs point to
server-owned staged files until the draft is actually sent or accepted into a
server-owned queue.

Relevant standing contracts:

- `topics/project-queue.md` - new-session Project Queue cannot support
  attachments until durable staging exists.
- `topics/attachment-storage.md` - released servers currently write
  `.attachments/<session>/`; the target returns to app-data by default and
  keeps project paths as compatibility reads or explicit opt-in destinations.
- `topics/vanilla-defaults.md` - staging files must not create hidden sends,
  hidden queue items, prompt rewriting, or new default-visible queue behavior.
- `topics/architecture-mandates.md` - cleanup must be bounded; closed tabs and
  idle sessions must not create unbounded server work.

## Current Attachment Semantics

YA's uploaded attachment path is structured inside YA, but provider delivery is
prompt-visible file references rather than provider-native attachment blocks.
`UploadedFile` carries metadata and an absolute server path. When the user
message reaches the provider, YA appends a section like:

```text
User uploaded files:
- [screenshot.png](</absolute/path/to/file>) (...)
```

A staged attachment is not provider context. It becomes provider context only
after YA materializes it to the final session attachment destination and sends or
queues a user message containing normal `UploadedFile[]` references.

## Product Decisions

- Use staging for draft attachments across composer surfaces, not only
  new-session starts.
- Keep text drafts browser-local. Do not add server-backed text draft sync,
  cross-client merge, or a drafts list in this slice.
- Store composer drafts as versioned JSON envelopes. Read legacy raw-string
  drafts best-effort, but no long-lived backwards-compatibility promise is
  needed for one-off local drafts.
- Use the YA data directory for temporary staging. This avoids writing unsent
  draft files into the repository and does not change final sent attachment
  storage.
- Keep final attachment storage unchanged. Materialized attachments continue to
  use the current resolved final destination for that project/session.
- Staging an attachment is not sending, queueing, or starting a session. It is
  only preparation after the user explicitly selects or pastes a file.
- Project selection changes should not invalidate draft attachments. Draft-owned
  staging is project-agnostic; project binding happens at send/queue time.
- For the next bundled release, the existing advertised `projectQueue`
  capability can be the compatibility gate for remote clients using Project
  Queue attachment flows. This assumes no separately released server advertises
  `projectQueue` without staging support. If that assumption becomes false, or
  if implementation needs normal staged uploads against mixed-version remote
  servers before that release, add a separate `stagedAttachments` capability.

## Draft Storage Model

Composer draft persistence should use a shared envelope for surfaces managed by
the draft persistence system:

```ts
interface DraftEnvelopeV1 {
  version: 1;
  text: string;
  attachments?: {
    batchId: string;
    refs: StagedAttachmentRef[];
    updatedAt: string;
  };
}
```

Read rules:

- if a value parses as `DraftEnvelopeV1`, use `text` and `attachments`;
- if a value is a raw string, treat it as legacy `{ version: 1, text: raw }`;
- if JSON is malformed or has an unsupported version, ignore it and preferably
  remove it;
- if `text.trim()` is empty and there are no staged refs, remove the storage key
  entirely.

Draft badge/index logic must use the same "has draft" predicate rather than
checking `localStorageValue.trim()`. A draft exists when it has non-empty text or
one or more staged attachment refs.

This applies to composer-style draft persistence. Do not blindly reinterpret
unrelated localStorage settings or specialized non-text draft maps unless that
surface is intentionally migrated.

## Staging Service

Add an `AttachmentStagingService` as the owner of staged attachment state.

Responsibilities:

- allocate draft batches and staged attachment refs;
- stream uploads to disk under the YA data dir;
- store server-only staged records with internal paths;
- return client-safe summaries/refs without staged filesystem paths;
- validate refs before draft rehydration, queue creation, and materialization;
- delete staged files when removed from a draft;
- transfer ownership from browser draft to Project Queue item;
- delete queue-owned staged files when the queue item is deleted or promoted;
- materialize staged refs into final `UploadedFile[]`;
- run required bounded cleanup for draft-owned stale files.

Suggested filesystem shape:

```text
{dataDir}/uploads/staging/drafts/<batchId>/<uuid>_<name>
{dataDir}/uploads/staging/queue/<queueItemId>/<uuid>_<name>
```

The physical shape is less important than the ownership model. Draft-owned files
have a TTL. Queue-owned files do not expire while the owning queue item exists.

Suggested shared/client ref:

```ts
interface StagedAttachmentRef {
  id: string;
  batchId: string;
  originalName: string;
  name: string;
  size: number;
  mimeType: string;
  width?: number;
  height?: number;
  createdAt: string;
  updatedAt: string;
}
```

Suggested server-only record:

```ts
interface StagedAttachmentRecord extends StagedAttachmentRef {
  owner:
    | { type: "draft"; batchId: string }
    | { type: "project-queue"; queueItemId: string };
  path: string;
}
```

`path` is internal and must not be sent to the provider as an
`UploadedFile.path`. Provider-visible paths are created only by materialization.

The service should use UUID-prefixed sanitized filenames, the existing upload
size limit, existing image-dimension metadata, and exact-size verification at
completion. If the completed byte count or filesystem size differs from the
declared size, fail the upload and remove the partial file.

Use a small JSON index if practical. It makes ownership transfer, restart
validation, deletion, and TTL cleanup explicit. If the first implementation can
reliably rebuild enough state by walking the staging tree, document that
decision and keep the service API the same.

## Materialization

Materialization converts staged refs into normal `UploadedFile[]` for a real
session.

Input:

- final `projectId` / project path;
- final `sessionId`;
- staged attachment refs.

Output:

- files copied into the current final attachment destination for that
  project/session while the browser draft still needs failure recovery;
- `UploadedFile[]` whose `path` points to the final provider-readable file;
- staged records deleted or marked consumed after successful message handoff or
  queue promotion.

The function should be idempotent enough for normal retries. If a final file
already exists with the expected name and size, reuse it rather than creating a
duplicate attachment.

Do not silently drop missing staged files. If a staged file cannot be found,
validated, or materialized, block send/queue promotion and surface an error.

For ordinary sends, keep draft state recoverable until materialization and the
message handoff both succeed. For Project Queue promotion, do not overbuild a
transaction system in this slice; fail the queue item clearly if materialization
or message handoff fails.

## Flow Semantics

### Draft Attachment Selection

When the user selects or pastes files in any composer that supports attachments:

1. ensure the draft envelope has a `batchId`;
2. upload each file to staging;
3. store completed `StagedAttachmentRef`s in the draft envelope;
4. render chips from staged refs;
5. delete the staged ref if the user removes the chip.

In-flight uploads do not need to survive refresh. Completed staged refs should
survive refresh as long as the draft envelope survives and the server still
validates the refs.

### Existing-Session Normal Send

On send:

1. materialize staged refs into the existing session's final attachment
   destination;
2. send the user message with normal `UploadedFile[]`;
3. clear the draft envelope after confirmed success.

If materialization or send fails, leave the draft text and staged refs
recoverable where possible.

### Existing-Session Deferred Queue

Once a deferred/per-session queue item is accepted by the server, it is no
longer a browser draft. Because the session already exists, the narrow first
implementation may materialize staged refs at queue acceptance time and store
normal `UploadedFile[]` in the existing queue machinery.

### Normal New-Session Start

Draft attachment staging is project-agnostic, so users may attach files before
or after choosing a project.

On Start:

1. resolve or create the project as the current new-session flow already does;
2. create the real YA session;
3. materialize staged refs into the real session destination;
4. send the first user message with normal `UploadedFile[]`;
5. clear the draft envelope after confirmed success.

If materialization or send fails, leave the draft text and staged refs
recoverable where possible.

### Project Queue Items

When the user chooses Project Queue:

1. require a real project id;
2. transfer staged refs from draft-owned to queue-owned;
3. persist staged refs in the Project Queue item;
4. clear the local draft envelope only after queue creation succeeds.

On promotion:

1. create or resume the target session;
2. materialize staged refs into the real session destination;
3. send the user message with normal `UploadedFile[]`;
4. delete queue-owned staged refs and remove the Project Queue item only after
   successful handoff.

The first required use case is new-session Project Queue attachments, but the
same staged-ref field can serve existing-session Project Queue items too.

### Unsupported Older Servers

When a remote client connects to an older server that does not advertise the
shared compatibility gate, the client should avoid staged attachment APIs:

- keep the old existing-session upload behavior where possible;
- keep the old new-session two-phase upload flow where possible;
- keep Project Queue attachments disabled.

This is primarily a mixed-version remote-client protection. Same-version local
builds can assume staging support once this slice lands.

## Navigation Guard

Durable staged refs reduce the need for warning on completed attachment chips.
The guard should focus on states that can still be lost:

- selected local files not yet staged;
- upload in flight;
- staged refs that have not yet been written into the draft envelope;
- fallback/unsupported-server flows where attachments are not durable.

Use native browser confirmation for page unload. For in-app navigation, use the
existing router/blocking pattern if one exists; otherwise keep the smallest
local confirmation wrapper around navigation actions that can lose attachment
state.

The guard is advisory. It does not preserve browser `File` objects, blob URLs,
or in-flight upload handles across refresh.

## Cleanup

Cleanup is required and bounded:

- Cancel and remove partial staged uploads on upload connection close/error.
- Delete staged attachments when the user removes them from a draft.
- Delete draft-owned staged attachments after successful materialization and
  handoff.
- Delete staged attachments when a queued Project Queue item is deleted.
- Delete queue-owned staged attachments after successful queue promotion.
- On startup, remove obvious partial files and index entries whose files are
  missing.
- Run startup cleanup or a single fixed-cadence global cleanup pass for
  draft-owned staged files older than a conservative TTL, such as seven days.

Do not create per-draft, per-session, or per-attachment recurring loops.

## Non-Goals

- No server-backed text draft sync.
- No cross-client draft merge/conflict UI.
- No global drafts page or server draft list.
- No default change from project-relative final attachments to data-dir final
  attachments.
- No provider-native attachment protocol change.
- No hidden sends, hidden starts, or automatic Project Queue creation.
- No persistence of browser `File` objects, blob URLs, or in-flight upload
  handles.
- No heavy transaction system for Project Queue crash recovery in this slice.

## Likely Touch Points

Server:

- `packages/server/src/uploads/manager.ts`
- `packages/server/src/uploads/AttachmentStagingService.ts`
- `packages/server/src/routes/upload.ts`
- `packages/server/src/routes/ws-relay-handlers.ts`
- `packages/server/src/services/ProjectQueueService.ts`
- `packages/server/src/services/ProjectQueueScheduler.ts`
- `packages/server/src/routes/project-queue.ts`
- `packages/server/src/routes/sessions.ts`

Shared/client:

- `packages/shared/src/upload.ts`
- `packages/shared/src/project-queue.ts`
- `packages/shared/src/relay.ts`
- `packages/client/src/hooks/useDraftPersistence.ts`
- `packages/client/src/hooks/useDrafts.ts`
- `packages/client/src/lib/sessionDraftStorage.ts`
- `packages/client/src/api/upload.ts`
- `packages/client/src/lib/connection/types.ts`
- `packages/client/src/lib/connection/DirectConnection.ts`
- `packages/client/src/lib/connection/RelayProtocol.ts`
- `packages/client/src/components/NewSessionForm.tsx`
- `packages/client/src/pages/SessionPage.tsx`
- `packages/client/src/components/ProjectQueueSection.tsx`
- `packages/client/src/components/AttachmentChip.tsx`

## Implementation Slices

### 1. Draft Envelope

- [x] Add shared/client draft envelope helpers.
- [x] Teach `useDraftPersistence` to read/write draft envelopes while keeping
      the text-oriented hook API usable.
- [x] Update draft badge/index scanning to use the envelope "has draft"
      predicate.
- [x] Add tolerant legacy raw-string and malformed-value tests.

### 2. Staging Core

- [x] Add shared staged attachment ref types.
- [x] Add `AttachmentStagingService`.
- [x] Add staging upload API/transport support for direct and relay clients.
- [x] Add expected-size verification and partial cleanup.
- [x] Add required startup draft TTL cleanup and reusable cleanup method.
- [x] Wire fixed-cadence draft TTL cleanup in the server runtime.

### 3. Composer Draft Attachments

- [x] Add server APIs to validate and delete staged draft refs.
- [x] Existing-session composer: upload selected/pasted files to staging.
- [x] Existing-session composer: persist completed staged refs into the draft
      envelope.
- [x] Existing-session composer: rehydrate chips from staged refs after refresh
      by validating them with the server.
- [x] Existing-session composer: delete staged refs on chip removal.
- [x] New-session composer: upload selected/pasted files to staging.
- [x] Warn only for attachment states that are not yet durable.

### 4. Send And Queue Materialization

- [x] Add idempotent draft-to-session materialization service and HTTP API.
- [x] Materialize staged refs before existing-session sends.
- [x] Materialize staged refs for normal new-session starts after session
      creation and before first-message send.
- [x] Preserve failure recovery behavior for existing/new-session draft text
      and staged refs.
- [x] Materialize before existing per-session deferred queue submissions.

### 5. Project Queue Attachments

- [x] Extend Project Queue message shape to persist staged attachment refs.
- [x] Transfer staged refs from draft-owned to queue-owned on queue creation.
- [x] Materialize staged refs during Project Queue promotion.
- [x] Delete staged refs when queued items are deleted or successfully promoted.
- [x] Keep Project Queue attachment controls behind the existing Project Queue
      capability gate for the bundled release.

### 6. Verification

- [ ] Verify remote/relay staged upload behavior.
- [ ] Verify narrow mobile flows for file selection, refresh recovery, removal,
      normal send, and Project Queue submission.
- [ ] Verify older-server remote fallback does not call staged upload APIs.

## Tests

Server:

- staged upload rejects unsafe path segments and invalid refs;
- staged upload enforces max upload size;
- staged upload fails and deletes the file when completed size differs from the
  declared size;
- disconnect cancels and removes partial staged files;
- completed staged upload survives service re-instantiation if an index is
  introduced;
- draft-owned TTL cleanup deletes stale staged files and records;
- queue-owned staged files do not expire while the queue item exists;
- materialization copies/moves staged files to the final session destination;
- materialization returns `UploadedFile[]` with final paths, not staged paths;
- missing staged file fails materialization;
- deleting a Project Queue item removes queue-owned staged attachments;
- Project Queue promotion with staged attachments sends a message with final
  `UploadedFile[]`.

Client:

- legacy raw-string drafts read as text-only envelopes;
- malformed draft envelopes do not crash the composer;
- empty text plus no attachments removes the draft key;
- draft badges appear for attachment-only drafts;
- file selection starts a staged upload and persists refs in the draft envelope;
- refresh rehydrates completed staged attachment chips after server validation;
- removing an attachment clears the ref and requests staged deletion;
- selected/uploading/not-yet-persisted attachments activate the navigation guard;
- normal send materializes staged attachments before message send;
- Project Queue submission includes staged refs and does not create a placeholder
  session.

Manual:

- select an image in a new-session composer, refresh, and confirm the completed
  staged chip is recoverable;
- select an image in an existing-session composer, refresh, and confirm the chip
  is recoverable before send;
- change the selected new-session project after staging files and confirm send
  materializes into the final chosen project/session;
- queue a new session with an image while the project is busy, restart the
  server, let the project go idle, and confirm the promoted session receives a
  readable final attachment path;
- test the same flows through remote/relay access.
