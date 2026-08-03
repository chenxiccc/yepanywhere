# Attachment Storage

> User-uploaded attachments are explicit agent context, but their storage
> location is governed by the global project-directory policy. App-data
> storage is the default; project-local storage requires prior opt-in.

Topic: attachment-storage

Parent contract: [Project Directory Storage](project-directory-storage.md).

Status: policy correction pending implementation. Current releases write
attachments into projects and expose no storage-location setting; this topic
records both that compatibility fact and the approved target.

## Why Attachments Are Stored

An uploaded file must survive long enough for the provider to read it, for a
queued message to deliver it, and for the transcript to display or download it.
That is intentional attachment persistence initiated by the upload action. It
does not imply consent to place the bytes inside the selected project.

Two locations have existed:

- **YA data directory:**
  `<data-dir>/uploads/<base64url(project)>/<session>/`. This was the original
  implementation. It is centrally confined and project-namespaced.
- **Project directory:** `<project>/.attachments/<session>/`. This became the
  runtime default in commit `46bb9929` and first shipped in npm `0.5.0`.

Project-local storage made an attachment easy for a provider running in the
working tree to discover. That convenience is real, especially under a
provider sandbox, but it does not justify an ambient project write. A Git
exclude only hides the symptom from `git status`; it does not address checkout
growth, synchronization, backups, privacy, or ownership of the project
namespace.

## Current Implementation And Release History

There is no implemented attachment storage setting. The earlier
"Configuration — v1" prose in this topic described a design that never landed.

Stable npm releases `0.5.0`, `0.5.1`, `0.5.2`, `0.6.0`, `0.6.1`, `0.6.2`, and
`0.7.0` route uploads to `<project>/.attachments/<session>/` whenever the upload
route resolves a project path. They retain the older data-directory location
as a read fallback.

Those stable releases predate the shared managed-directory helper and do not
themselves guarantee a `.git/info/exclude` entry. Current source after the
`0.7.0` tag calls `ensureManagedProjectDir`, which may create the top-level
directory and append `.attachments/` to the clone-local exclude file. That
post-release behavior is also automatic and is disallowed by the target
default.

Pre-session staging is already central and temporary. Materializing a staged
file into a real session currently moves it into the same project-local final
location, so staging does not avoid the policy issue.

## Target Location Resolution

The first implementation uses the one global
`projectDirectoryStorage: "app-data" | "project"` setting from the parent
contract. There is no per-project override.

### App data only — default

Final attachments are written below:

```text
<data-dir>/uploads/<project-key>/<session-id>/
```

Uploading and sending an attachment must not create `.attachments`, `.yep`, or
a Git exclusion. The provider prompt names the actual attachment path. If a
provider's filesystem policy cannot read the central path, YA explains that
limitation or requires the user to opt into project-local storage; it does not
change modes silently.

### Store YA assets with projects — explicit opt-in

Attachments may be written below the one documented YA project root. The
preferred new-write shape is:

```text
<project>/.yep/attachments/<session-id>/
```

This avoids creating another top-level hidden namespace. The implementation
may retain `.attachments/` as a compatibility read location, but must not keep
using it as an independent automatic write root merely because older versions
did.

Before the first project-local write, validate containment, reject symlinked or
already tracked managed roots, and apply the parent topic's opt-in Git-exclude
policy. A failure does not fall back by writing somewhere else inside the
project.

## Agent Delivery Contract

The delivered message includes an explicit path and small safe metadata such
as filename, MIME type, size, and image dimensions. The surrounding label must
not hard-code "files in `.attachments`" when the actual location is central or
under `.yep/attachments`.

Attachments remain provider input. They are distinct from tool-result media,
which is viewer output and is never appended automatically to a later turn.
See [Session Media Handles](session-media-handles.md).

## Read And Serve Compatibility

The narrow attachment route remains the browser-facing read boundary:

```text
GET /api/projects/:projectId/sessions/:sessionId/upload/:filename
```

It may check, in policy-defined order:

1. the current central app-data location;
2. the opted-in current project-local location; and
3. legacy `<project>/.attachments/<session>/` and legacy central paths.

Reading a legacy attachment never authorizes creating, refreshing, migrating,
or excluding that directory. The public response does not expose a new broad
filesystem read capability merely because physical storage moved.

## Retention And Cleanup

Attachment retention and cleanup remain incomplete. Central storage makes a
bounded age/size policy and global cleanup practical; project-local opt-in
requires equally explicit per-project reporting and cleanup.

Changing storage mode does not move or delete existing attachments. A future
cleanup/migration action must show exact paths, sizes, and consequences before
mutation. Legacy reads remain until a separately approved compatibility
decision removes them.

## Capability Gate

The location control is part of the proposed permanent
`project-directory-storage-policy` capability. Without it, a new client sends
no storage field and warns that the older server may write uploads into project
directories. See the parent topic for the full release corpus and absent-gate
behavior.

## Related Topics

- [Project Directory Storage](project-directory-storage.md)
- [Session Media Handles](session-media-handles.md)
- [Security](security.md)
- [Pre-session Attachment Staging](../docs/tactical/028-pre-session-attachment-staging.md)
