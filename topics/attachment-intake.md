# Attachment intake

> Attachment intake brings user-selected files into the existing composer
> pipeline without changing submitted text or granting the browser new native
> editor capabilities.

Topic: attachment-intake

Status: current desktop paste and installed-PWA image share paths are
implemented.

See also:

- [Attachment storage](attachment-storage.md) — durable server-side storage
  after the composer accepts and sends an attachment.
- [Composer rich input](composer-rich-input.md) — why attachments do not
  require the proposed rich editor.
- [Media rendering and routing](media-rendering-and-routing.md) — presentation
  and retrieval after intake.

## Product contract

Desktop clipboard paste reads file items from the existing textarea paste
event and hands them to the normal pending-attachment pipeline. It does not
interpret arbitrary clipboard HTML as an attachment.

An accepted attachment is composer content even when the text field is blank.
A completed attachment can be sent without accompanying text. Completed or
still-uploading attachments make empty-draft affordances inactive; an upload
that is still in progress does not become sendable until it completes.
Direct start, resume, and queue APIs apply the same content rule. A current
client connected to an older server without
`attachment-only-session-messages` retains the draft and asks for a server
update or accompanying text instead of sending a request that server will
reject.

An installed browser progressive web app (PWA) advertises an Android image
share target. Its service worker accepts at most eight `image/*` files and at
most 64 MiB across one share. A rejected or non-image share is not persisted.
Accepted files are held in browser-local IndexedDB for at most one hour; at
most four pending share records are retained, with the oldest record evicted
first.

The share target redirects to the most recently open session, including a
session hidden by the Android share sheet. When no session is open, it opens
New Session in the most recent client's direct or relay context. The redirect
carries only an opaque browser-local share id.

The mounted composer reads the record without consuming it, offers the files
to the same attachment pipeline as ordinary paste, and deletes the record only
after that consumer accepts them. Navigation or unmount before handoff, and a
consumer rejection, retain the record until its normal expiry or capacity
eviction. This deliberately prefers a possible duplicate retry to silent data
loss. The one-shot URL parameter is removed after accepted handoff or after an
error has been surfaced, so a failed render does not loop indefinitely.

Android keyboard image insertion is a separate native-editor contract. Gboard
uses `InputConnection.commitContent`, whose accepted MIME types come from a
native view's `EditorInfo`; browser JavaScript cannot add those MIME types to a
textarea. YA therefore does not claim keyboard image insertion as a supported
web path.

## Design decisions

- Use the PWA share target and existing attachment pipeline rather than a
  server upload endpoint. The service worker needs no YA session authority and
  the composer remains the acceptance boundary.
- Bound both records and retained payload size. A small record-count cap alone
  does not bound IndexedDB consumption when one share contains many or very
  large images.
- Separate read from acknowledgement. IndexedDB transaction completion proves
  only that bytes were read, not that the composer retained them.

## Observable checks

- A valid image share redirects with one opaque `__ya_share` id and becomes
  pending composer files.
- A ninth file, more than 64 MiB total, or a share with no image receives an
  error response and creates no record.
- A pending record remains readable until the consumer resolves acceptance;
  explicit acknowledgement makes a later read empty.
- An open relay session keeps its relay path and existing query parameters;
  otherwise New Session opens in the same relay context.
- Desktop file paste and PWA share intake converge on the same pending-file
  behavior.
- Direct start, resume, and queue requests accept empty text with a completed
  attachment; an older server receives no such unsupported request.
