# Project directory storage policy implementation plan

Parent contract: [Project Directory Storage](../../topics/project-directory-storage.md)

Settings contract: [Storage Settings](../../topics/storage-settings.md)

Status: audit complete; implementation intentionally not started. This plan
exists to drive the follow-up discussion and fixes.

## Audit result

Current source has six ways to mutate a project or its Git metadata for
YA-owned state: attachments, tool-result media, the Git author palette,
source-review files, the source-review capture ref/object graph, and automatic
Git excludes. Only project-local attachments have shipped in a stable npm
release; they first shipped in `0.5.0` and remain present through `0.7.0`.

There is no implemented attachment-location or general project-storage
setting. The prose that described an attachment setting was a design that
never landed.

## Recommended order

### 1 — establish the global project-storage gate

Add the server setting `projectDirectoryStorage: "app-data" | "project"`,
defaulting to `"app-data"`, plus one policy resolver that every YA-managed
project writer must call. Store the setting centrally. Do not add per-project
overrides.

Advertise `project-directory-storage-policy` only when the complete audited
writer set obeys the resolver. Add the capability registry route and field
contract together with released-server fixtures. Add the **Storage** Settings
category after **Source Control** with independent capability gating for each
control.

### 2 — return attachments to app-data storage by default

Route final attachment writes to the existing project/session namespace below
the YA data directory in app-data mode. Preserve dual-read support for legacy
`.attachments` files. Project-local mode may write the documented project root
after its exclusion and containment checks pass.

The provider prompt must name the actual readable attachment path rather than
assuming `.attachments`. If a provider sandbox cannot read the central path,
surface that limitation or require the explicit project-local opt-in; do not
change storage mode silently.

### 3 — make media handles lazy and preservation optional

Restore the transcript-locator design: build an in-memory media catalog during
normal transcript scanning, seek and decode provider-owned bytes on demand,
and use a bounded live store only until provider persistence catches up.

Add `toolResultMediaPreservation: "on-demand" | "preserve"`, defaulting to
`"on-demand"`, behind the separate permanent
`tool-result-media-preservation-policy` capability. Preserve mode captures only
new results emitted while YA manages a session, even without an open client.
It never treats provider replay, session-detail loads, pagination, or media
fetches as preservation triggers. Preserved copies have no automatic pruning
or eviction and follow the global storage location.

Do not add a persistent disk-cache mode in this pass. Existing
`.yep/tool-results` remains a read-only legacy source; the implementation does
not clean it up or import historical media.

### 4 — move the author palette out of project-open paths

Stop `GET`/add-project flows from creating `.yep`. Keep author preferences in
memory or in a project-keyed central cache. A cache failure may degrade to the
existing stable client hash; it never earns a project write.

### 5 — relocate source-review private state

Move draft, submission, and response state to a project-keyed central store in
app-data mode. Review how an agent consumes frozen submission input: inject the
bounded structured request, expose a confined central file the provider may
read, or require project-local storage for a file-by-reference workflow.

Replace the app-data-mode `refs/yep/source-review/captures` pin with a central
content-addressed snapshot store. Creating Git objects or refs is permitted
only after project-local storage is enabled.

### 6 — make Git exclusion downstream of consent

Change the managed-directory helper so callers cannot obtain authorization by
calling it. It receives an already-resolved project-storage decision and only
touches `.git/info/exclude` in project-local mode. App-data mode does not call
the helper at all.

### 7 — prove no-write behavior and compatibility

Test the full acceptance matrix from the parent topic against both ordinary
repositories and linked worktrees. Snapshot the project tree, resolved Git
directory, and relevant refs before each app-data-mode operation and prove
they remain unchanged afterward.

Compatibility fixtures cover `0.5.2`, `0.6.0`, `0.6.1`, `0.6.2`, and `0.7.0`,
plus `0.5.0`/`0.5.1` as the attachment-default origin. Without the capability,
the client makes no new settings request and warns that the older server cannot
enforce app-data-only storage.

### 8 — leave legacy storage in place

Do not delete, migrate, or add exclusions during upgrade. After the safe
default and routing changes are proven, stop. A later cleanup, migration,
historical-media import, cache, custom location, or per-project override is
separate product work with its own explicit contract and capability review.
