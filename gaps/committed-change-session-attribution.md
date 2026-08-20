# Git-notes commit-session blame is not implemented

Source Control can identify the last YA session observed successfully editing a
still-dirty path, through `packages/server/src/services/DirtyFileEditorService.ts`
and `GitFileChange.lastEditor`. That row is cleared once status reconciliation
observes the path clean. YA records no corresponding relation from a commit or
committed file to the session or sessions that produced it, so commit rows and
commit-file context menus cannot navigate back to working sessions.

## Authorized direction

Use YA-owned Git notes. A default-off setting explicitly authorizes writing
session attribution into the selected repositories' Git metadata. Enabling
that setting is narrow consent for these notes only: it must not enable `.yep`,
attachments, Git excludes, capture refs, or any other project-local storage.
Implementation must update `topics/project-directory-storage.md` to record this
specific opt-in before the writer ships.

Do not put session ids in commit messages. They are bulky and conspicuous to
ordinary commit-message readers, while having no useful meaning to those
readers. `Contributing-model:` may continue to identify contributing model
families, but session-id attribution belongs only in notes. Notes use a
dedicated YA ref, do not change commit ids or message text, and are published
only through an explicit notes-ref push policy rather than ordinary branch
pushes.

## Attribution granularity

The note schema must support one or more of these projections without forcing
the same granularity everywhere:

- **Per commit:** attach the union of attributed canonical YA session ids to
  the commit object.
- **Per commit-changing-file:** attach a path-keyed session map to the commit's
  note. Git has no native `(commit, path)` object, so this relation lives inside
  the commit-note payload.
- **Per file object:** attach attribution to the changed blob object when
  content-object identity is useful. A blob note follows identical content and
  does not by itself retain the repository path.
- **Both:** a commit summary and its path-level detail may coexist; blob notes
  may additionally provide content-object attribution.

Use a versioned machine-readable payload containing canonical YA session ids
and observation evidence. Resolve current session titles from the canonical
session catalog rather than freezing titles into every note. Multi-session and
mixed human/session commits remain explicit: unknown portions stay unknown
rather than being assigned to the most recent active session.

## Setting and statistics

The default-off setting belongs on the Source Control/Storage trust boundary
and controls note writes. When enabled, its row asynchronously reports the
total number of YA Git-note entries and the total megabytes used across the
repositories YA knows about. Loading or recomputing those statistics must not
block opening Settings or saving the option.

Define **MB used** as the summed payload bytes of note blobs reachable from the
YA attribution refs, not the size of `.git` or unstable packfile allocation.
Count note entries across every enabled attribution ref; path records packed
inside one commit note do not pretend to be separate Git notes. Surface scan
errors or partial repository coverage instead of reporting a misleading zero.

## Remaining implementation decisions

Define how YA recognizes a newly created commit, carries observed dirty-path
evidence into the chosen note granularity, handles amend/rebase SHA changes,
and avoids attributing external or mixed commits without evidence. Reads,
writes, statistics, and explicit notes publication need one capability-gated
server contract. Commit and commit-file context menus can then navigate to the
recorded sessions, with titles resolved through the canonical summary path.

Found 2026-08-20 while verifying the requested Source Control session links.
