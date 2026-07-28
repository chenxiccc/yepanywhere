# Source Control

> Source Control is YA's repository-navigation workbench for moving among
> working-tree changes, commits, tracked files, blame, diffs, and relevant
> agent sessions, with page-wide layout and navigation kept separate from the
> detailed line-review workflow.

Topic: source-control

The original implementation grew out of
[Source Review → New Session](source-review-to-session.md). That topic remains
the contract for line-comment anchors, persistent review drafts, relocation,
submission, and review-session handoff. This topic is the current landing site
for behavior that belongs to Source Control generally: its modes, repository
navigation, master-detail layout, changed-file rows, diff controls, search,
compatibility shell, and links to relevant sessions. The old topic retains its
combined implementation record for historical context; where its page-wide UI
statements conflict with this topic, this topic governs.

## Product boundary

Source Control is primarily an inspection and agent-direction surface, not a
full git client. Check refreshes remote-tracking observation; fast-forward-only
Pull and explicit Push are the narrow established repository mutations.
Staging, committing, amending, discarding, branch surgery, stash mutation,
integration, conflict resolution, and recovery remain agent work unless a
separate proposal justifies one operation's preconditions, feedback, and
recovery.

The navigation surface has four modes:

- **Changes** is the default quick check and presents the current
  HEAD-to-filesystem changed-file list and diff.
- **Commits** is revision-first history. A dirty **Working tree** revision is
  pinned above commits and opens the same working-tree file/diff detail.
- **Files** searches tracked paths and opens highlighted content with blame.
- **Comments** is the integration point for the pending review workflow owned
  by [Source Review → New Session](source-review-to-session.md).

Desktop uses master-detail panes; phone layouts drill from revisions to files
to a full-screen diff and restore the prior list position on Back or
back-swipe. Changes remains the default until a separately approved change;
making its Working tree view available in Commits does not itself authorize a
default flip.

## Workbench geometry

Source Control is a workbench, not prose or a transcript. It must use the
available page width after ordinary page padding and must not inherit the
Appearance **Max Content Width** measure globally or on its detail panes. The
revision, changed-files, diff, and blame tracks may use all available width.

On wide layouts, the browser region fills the page space remaining after the
actual Source Control header, notices, and action feedback. Lists and
diff/blame panes own their internal scrolling. Fixed viewport deductions such
as `100vh - 220px` are not the product contract, and the blank space they
currently create is not reserved for later content. Phone layout may continue
using normal page and full-screen-modal scrolling.

### Pane splitters

Commits exposes revision/files and files/diff boundaries; Changes and Files
expose their files/detail boundary. Matching top and bottom handles resize the
same boundary, remain keyboard-operable, and stay absent from phone layout.

The changed-files pane has no arbitrary fixed maximum such as 500 px. It may
grow until the inter-pane gap and splitter handles would cease to remain fully
visible and operable; do not reserve an unrelated minimum width for the detail
pane. The user naturally stops after exposing as much path text as desired,
and the still-visible splitter is the recovery path from an extreme choice.

A content-derived natural maximum is optional, not required. If added, compute
it from the widest untruncated row in the **complete file corpus**, including
status, count, and menu affordances—not only rows currently mounted in the
vertical-scroll window. Recompute it when the corpus or relevant font, size,
or spacing metrics change.

### Changed-file state and path recovery — proposal

Changed-file rows use the compact git status code as the primary kind:
`M` = Modified, `A` = Added, `D` = Deleted, `R` = Renamed, and `?` =
Untracked. Tooltips and accessible labels expand every code.

Do not repeat the long, visually similar **unstaged** or **untracked** words on
ordinary rows: the status code already carries the useful distinction, with
unstaged as the ordinary dirty state and `?` identifying untracked files. A
compact check may identify a fully staged file. When a file has staged changes
plus additional unstaged changes, use the explicit short label **partial**
rather than the opaque `±`; its tooltip says “Partially staged: staged changes
plus additional unstaged changes.”

Changes, Commits, and Files use one shared file-row/path treatment. A truncated
path exposes its full value from the actual row hover/focus target in both
Native and Themed tooltip modes; a nested `title` that happens to work in only
one mode is not sufficient. Touch layouts preserve more path identity in the
row itself rather than depending on hover.

### Diff gutter

Added/deleted line backgrounds remain subdued while the `+` / `−` strip carries
the stronger semantic color. Narrow the current roughly 20 px gutter to about
16 px and reduce its internal inline inset from roughly 8 px to 6 px, retaining
the breathing room between the color divide and source text. Verify highlighted
and fallback diff renderers in unified and side-by-side modes.

## Navigation and diff controls

One selected row drives the adjacent detail. Identity and state stay visible
in list rows; primary quick actions belong in the selected detail banner; one
shared ellipsis/context menu discloses the full action set. Right-click,
long-press, the visible ellipsis, and Shift+F10/Menu open the same accessible
menu with focus return and keyboard traversal.

Source lists support Up/Down selection, Enter drill-in, Escape return, and `/`
to focus search when focus is outside an editor. Diff navigation supports
previous/next hunk and a visible current-hunk indicator. Browser shortcuts must
not copy native GitHub Desktop accelerators that collide with browser tabs,
Find, or the address bar.

Unified/Split and full-context controls stay in the diff pane. Ignore
whitespace is an independent projection of the active working-tree, commit, or
selected-revision-to-HEAD diff. Selected revision → HEAD uses a fixed selected
tree as base and a pinned HEAD SHA as tip; every file request stays on those
returned endpoints so a later HEAD move cannot mix comparisons.

The wide diff pane keeps filename, path, view controls, hunk navigation, and
file actions in one toolbar row when they fit. A narrow pane or phone modal may
use a compact second row.

## Search and compatibility

Files search owns the complete tracked-path corpus up to the explicit 10,000
file bound; rendering may window results but must not turn that window into a
search-coverage limit. Commit-delta search builds an on-demand client corpus
from lightweight history plus bounded changed-path/line batches. Once a corpus
is present, typing performs no network request and starts no git process.
Browser-lifetime reuse is implemented; IndexedDB reuse across browser restarts
remains optional future work. Focused completions and rendered match-context
tooltips remain pending.

The permanent `git-source-review` capability currently gates the complete
Changes/Commits/Files/Comments browser as well as the review endpoints. An
older server with only `git-status-enhanced` receives the basic status,
working-tree diff, and independently advertised Check/Pull/Push shell; the
client makes no unsupported browse/review requests. Ignore whitespace and
selected-revision-to-HEAD comparison remain gated by
`git-source-review-projections`. See
[server capabilities](server-capabilities.md) and
[`063-source-control-hosted-compatibility.md`](../docs/tactical/063-source-control-hosted-compatibility.md).

## Dirty-file editor sessions — proposal

Kyle suggested a button to **“navigate to session(s) that made edits to this
dirty file”**; graehl agrees (2026-07-28). This reverses the existing bridge
from a session Edit block into the exact dirty file. In Changes, the selected
file banner and shared file context menu expose a compact `Sessions (N)`
action. One candidate may navigate directly; more than one opens a
newest-evidence-first chooser using the standard session identity, hovercard,
and canonical YA-session navigation.

Git records no dirty-file session authorship. The deliberately bounded
contract is **sessions with recorded edits**: successful structured file
mutations YA observed in a canonical session—Edit, Write, `apply_patch`, or a
provider equivalent—whose normalized project-relative target is this path.
Do not infer candidates from active sessions, project membership, or file
mtime.

Shell commands, generators, human edits, external processes, and provider
activity YA did not observe may remain unattributed. An unobserved writer can
also replace or revert an observed session's contribution while leaving the
path dirty, so a stale candidate can remain until the file next becomes clean.
This accepted limitation bounds implementation effort; the UI never claims the
set is exhaustive or that every listed session contributed to the exact
current contents.

Implementation plan:

1. Characterize each supported provider's structured file-mutation events and
   success boundary. For `apply_patch`, parse every Add, Update, Delete, and
   Move header; after a successful multi-file patch, upsert one row for each
   touched normalized path. Ignore failed or merely proposed mutations.
2. Maintain logical rows of
   `(source, project, normalized file, canonical YA session, latest edit time)`.
   A later successful edit by the same session to the same file only replaces
   that row's time. Retain no event history, tool/message ids, content hashes,
   transcript backfill, or before/after lineage.
3. Whenever YA observes that a tracked path has become not dirty, clear every
   row for that file. A successful commit normally causes this transition, but
   a commit that leaves further staged or unstaged changes does not: the
   clearing condition is observed clean file state, not a commit command.
4. Add a capability-gated query for remaining candidate session summaries,
   ordered by latest recorded edit, and reuse the existing session
   hovercard/navigation and file banner/menu.
5. Test one and several sessions, repeated edits deduplicating to latest time,
   failed edits being ignored, clean-state clearing, a commit that leaves the
   file dirty, and accepted missing/stale attribution after unobserved shell or
   human changes.

**Difficulty:** the UI is low difficulty. Provider mutation hooks, clean-state
observation, the small tuple set, and its query are low-to-medium difficulty.
Exact lineage and exhaustive attribution are deliberately out of scope.
