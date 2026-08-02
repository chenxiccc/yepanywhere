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

The navigation surface has these modes:

- **Changes** is the default quick check and owns both the current
  HEAD-to-filesystem state and explicitly opened commit history. **Working
  tree** is its permanent default revision, including when its diff is empty.
- **Files** searches tracked paths and opens file content immediately, then
  enriches its blame column asynchronously when provenance becomes available.
- **Pending Comments** is the unsubmitted accumulator owned by
  [Source Review → New Session](source-review-to-session.md). Its stable URL
  key remains `comments`, preserving existing `?tab=comments` links.
- **Reviews** is the submission and comment-site browser owned by that topic.
  Its URL key is `reviews`; it shows frozen reviewer entries, captured source,
  target sessions, outcomes, and open/addressed/resolved state as those
  contracts become available. The added fourth mode means the wrapping rule
  in *Header hierarchy* below must be re-verified at phone width rather than
  assumed to still fit.

Normal Source Control navigation opens Changes with Working tree selected.
Neither a clean tree nor an empty changed-file list falls through to HEAD or
another commit. A clean tree renders a quiet confirmation with no recent
commit card or history list. The detail-level **‹ Commit history** parent link
is the explicit path into commits and occupies the same position for Working
tree and narrow-screen commit detail; it names the parent destination without
claiming that history was necessarily the user's previous view. Legacy
`?tab=commits` URLs enter that history inside Changes, and a `?rev=<sha>` deep
link selects its commit.

Desktop uses master-detail panes once history is open; phone layouts drill
from revisions to files to a full-screen diff and restore the prior list
position on Back or back-swipe. Once history is open, the pinned Working tree
behaves like any other revision: desktop keeps it selected beside the history
list, while phone opens its detail with **‹ Commit history** returning to that
list. The top-level Changes tab or Clean/Dirty badge restores the standalone
default working-tree landing.

## Header hierarchy

The Source Control header keeps repository identity and repository operations
in separate visual bands. Project selection, branch, upstream, ahead/behind
state, and the Clean/Dirty badge form the identity band. When the available
header width fits the complete mode selector, Changes/Files/Pending
Comments/Reviews occupies the trailing top-right space without displacing that
identity.
Constrained layouts move the same tabs to their own full-width row.
One selector serves every viewport: the placement is browser-computed from the
rendered intrinsic widths of a wrapping header row, not chosen by a
viewport-width threshold. A narrow-screen rule only compacts the tab styling
once the row has wrapped.

Pull, Push, and Check remote form a second, left-anchored action row in that
fixed order at every viewport width. Review remains independently anchored at
the trailing edge. Branch names, upstream names, count badges, action progress,
and action outcomes must not move the Pull/Push/Check group. Their visible
labels stay constant while a leading action glyph changes in place to present
progress and brief success/warning state. Full action feedback remains visible
below the action row. The project selector retains its intrinsic width, up to
its desktop cap, before branch and upstream text yield space; ordinary short
project names must not truncate while unused header space remains.

A successful fast-forward Pull reports the number of commits by which the
local branch advanced, or **Already up to date** when `HEAD` did not move. A
successful Push to an existing upstream reports the pre-push ahead count that
the action advanced; publishing a new branch remains **Branch published**.
Commit counts are optional additive response data under the existing Pull and
Push contracts. Clients receiving an older response without the count retain
the generic **Pull complete** or **Pushed commits** feedback and make no
different request.

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

Changes exposes revision/files and files/diff boundaries while history is
open, and exposes its direct files/detail boundary for the default Working
tree. Files exposes its files/detail boundary. Matching top and bottom handles
resize the same boundary, remain keyboard-operable, and stay absent from phone
layout.

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

### Changed-file state and path recovery

Changed-file rows use the compact git status code as the primary kind:
`M` = Modified, `A` = Added, `D` = Deleted, `R` = Renamed, and `?` =
Untracked. Less common codes retain the same treatment: `C` = Copied, `T` =
Type changed, and `U` = Unmerged. Tooltips and accessible labels expand every
code.

Do not repeat the long, visually similar **unstaged** or **untracked** words on
ordinary rows: the status code already carries the useful distinction, with
unstaged as the ordinary dirty state and `?` identifying untracked files. A
compact check may identify a fully staged file. When a file has staged changes
plus additional unstaged changes, use the explicit short label **partial**
rather than the opaque `±`; its tooltip says “Partially staged: staged changes
plus additional unstaged changes.”

Working-tree changes, commit revisions, and Files use one shared file-row/path
treatment. A truncated
path exposes its full value from the actual row hover/focus target in both
Native and Themed tooltip modes; a nested `title` that happens to work in only
one mode is not sufficient. Touch layouts preserve more path identity in the
row itself rather than depending on hover.

### Diff gutter

Added/deleted line backgrounds remain subdued while the `+` / `−` strip carries
the stronger semantic color. The authored gutter is about 16 px wide with a
roughly 6 px inline inset and separate breathing room between the color divide
and source text.

Source Control and session Edit-tool diffs use the same gutter-alignment class;
neither surface may keep a separately tuned approximation. The same shared
boundary owns the diff-specific Shiki palette. Each shipped theme uses fixed,
uniform added and removed line fills, and every syntax token has at least 3.5:1
contrast against both fills. This deliberately softer threshold keeps syntax
roles distinct from ordinary body text while preventing illegible combinations
such as a dim comment on a tinted line. Contrast is audited from the theme
palette offline, never inferred from the current file's content. Highlighted
and fallback renderers retain the contract in unified and side-by-side modes.
The stronger `+` / `−` gutter tints have separately audited foregrounds at the
same minimum, including the session fixed-font rendered form.

Source text is source text regardless of entry point. Source Control diffs,
session Edit-tool diffs, Files content, and blame use the same fixed-font
family, size, and line-spacing tokens derived from Appearance settings.
Individual source surfaces may add local density offsets, but may not substitute
a separately sized or spaced monospace style.

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

A comparison comment cites the endpoint that contains the clicked projection:
an old-side line anchors to the fixed base SHA and a new-side line anchors to
the pinned tip SHA. An ordinary one-commit diff uses that commit SHA for both
sides; a working-tree diff remains uncommitted. Rendered diff lines are
interactive on their first visible frame—first-click commenting and hunk keys
do not depend on a later passive effect. Pending-comment tint uses revision,
side, and line identity so similarly numbered lines in another projection do
not inherit it.

Full context is a view of the current diff, not a file-path cache entry. If a
live working-tree refresh changes the diff while full context is open, YA
invalidates and reloads that projection. An older request resolving later
cannot overwrite the newer projection.

Source Control presents a text diff only when the exact Git projection is not
classified as binary and both file versions are safe UTF-8 text. Git attributes
that mark a tracked path binary are authoritative; a filename extension alone
is never authoritative in either direction. Binary working-tree, staged,
commit, and selected-revision comparison files show a bounded skipped-preview
state with the path and size when known, and their bytes never enter syntax
highlighting. Untracked files receive the same treatment from their content.
A current client also suppresses binary-looking structured patch text returned
by an older server. Large-content, long-line, and highlighted-HTML limits remain
independent reasons to omit a text preview.

Markdown Preview must remain a rendered projection of those same diff rows,
not replace them with the complete new document. Its source-line identities,
incremental rendering boundary, and cross-representation scroll contract live
in [aligned Markdown diffs](aligned-markdown-diffs.md).

The wide diff pane keeps filename, path, view controls, hunk navigation, and
file actions in one toolbar row when they fit. A narrow pane or phone modal may
use a compact second row. The filename is the primary identity: it uses compact
source type and retains its full text before the directory path spends
remaining width. The smaller directory prefix precedes it and, when clipped,
keeps its rightmost segment next to the filename. Toolbar actions use compact
glyphs with complete hover and accessible names; hunk position uses the
language-neutral `current/total` form.

Ignore whitespace uses the conventional open-box space glyph `␣`. Its compact
button is outlined when off and accent-filled when pressed; the selected state
must not depend on interpreting the glyph or a subtle tint.

Each commit and working-tree changed-file pane exposes one compact file-filter
disclosure. Opening its magnifier expands a path search across the pane's
complete current file corpus, including expanded untracked files and both sides
of a rename. Filtering is case-insensitive and local after the corpus is
present. On wide layouts, the first visible file becomes the detail when the
prior selection no longer matches; no match leaves an explicit empty result.

## Search and compatibility

Files search owns the complete tracked-path corpus up to the explicit 10,000
file bound; rendering may window results but must not turn that window into a
search-coverage limit. Commit-delta search builds an on-demand client corpus
from lightweight history plus bounded changed-path/line batches. Once a corpus
is present, typing performs no network request and starts no git process.
Browser-lifetime reuse is implemented; IndexedDB reuse across browser restarts
remains optional future work. Focused completions and rendered match-context
tooltips remain pending.

Files starts its ordinary project-file request and blame request independently.
Readable content renders as soon as the file request returns; the view never
holds it behind `git blame`. Until blame resolves, the gutter shows inert
placeholders and line commenting waits for a provenance anchor. Blame then
fills commit-hash links in place and may add highlighting without resetting the
file selection or scroll context. Failure to load blame leaves readable content
visible with a provenance warning.

A committed hash opens that exact revision in Commits, including a revision
outside the recent page. Its tooltip shows the full SHA, author/date when
known, and commit summary. Right-click, long-press, and the shared keyboard menu
offer **Open commit** and **Copy commit hash**; copying uses the full SHA.
Uncommitted lines remain visibly non-link provenance. Pending blame-comment
tint matches both the line and its committed/uncommitted revision identity.

The blame grid has three real columns: a five-character displayed commit hash,
a content-sized line number, and selectable code. Clicking the line number or
clicking code without selecting it starts a review comment; completing a text
selection does not turn the release click into a review action. Consecutive
lines with the same populated blame provenance share one horizontal overflow
region. Different commits never share that scrollbar, and code cells do not
grow independent per-line scrollbars.

The path-copy icon sits beside the pathname. The detail banner's trailing
document-copy icon instead copies the exact raw text returned by the file
endpoint and remains disabled until readable text is available. Their icons,
tooltips, and accessible names distinguish path from content.

One-author files retain the ordinary gray hash. With multiple authors, hashes
receive distinct hues chosen by maximum minimum distance over the visible
author set. The server gives each author a durable project-wide hue preference
and refreshes the palette in the background when a project is opened or added;
new HEAD commits only scan the newly reachable range. A palette read, update,
or write error discards persisted detail and permits exactly one full-history
regeneration attempt, then omits server palette detail rather than retrying in
a loop. The client re-spaces the visible file's author set from those
preferences. When palette generation fails or an older server omits the
optional preference, a stable author-name hash supplies the preference without
an unsupported request.

Files caches the selected file's maximum intrinsic rendered code-line width by
project, path, content fingerprint, and the typography metrics that affect
measurement. On a wide layout, selection or a relevant viewport/typography
change targets the content pane at the blame gutter, line-number gutter,
scrollbar/border allowance, and that maximum line width—just enough to show the
file without gratuitous empty space—and leaves the remainder to the file list.

The allocator clamps to available space and existing pane minima. It may shrink
an oversized file list toward its ordinary default when that lets the content
fit, but uses a list the user manually narrowed below that default as its
automatic lower bound. A manual split remains in effect until file selection or
the measured viewport/typography changes. Phone layouts keep their full-screen
drill-in and do not run this two-pane allocation. Tests cover cache reuse and
invalidation, tabs/wide characters and empty files, wide-space allocation, and
constrained minimum-width fallback.

**Persist project-wide author preferences, then re-space the visible file**
(vs storing a final color per author): the durable preference keeps identity
stable while file-local maximum-distance assignment preserves useful
distinction for the usually small visible author set. Regenerating only after
an error keeps corrupt state recoverable without turning palette maintenance
into a background retry loop.

## Foreground diff latency

A working-tree file selection depends on its exact Git projection and renderer,
not on fresh provider-session aggregates. Once the project id has resolved in
the server's project snapshot, every Source Control path-only route may reuse
that known identity even after the aggregate snapshot's five-second freshness
window expires. A cold server may discover projects once; clicking a file after
the Changes list is visible must not synchronously rescan Claude, Codex, or
Gemini histories. Session/project inventory refresh remains owned by the
surfaces that consume that mutable inventory.

The working-tree diff endpoint reports `Server-Timing` phases named `project`,
`preflight`, `versions`, `render`, `projections`, and `total`, and emits the same
numbers in its debug event. This keeps future regressions attributable: a
simple file should spend only ordinary subprocess time in Git preflight/version
reads, while syntax highlighting or Markdown rendering is visible separately
as `render`. The file-diff request does not compute or fetch blame.

Do not add speculative file-diff prewarming as the first remedy for a slow
selection. Eliminate unrelated project/session scans and measure the remaining
phases first. Prewarming the likely next file remains an optional latency
courtesy only if those measurements show a meaningful irreducible renderer
cost; it cannot become a correctness dependency or retain unbounded file
content.

The permanent `git-source-review` capability currently gates the complete
Changes/Files/Comments browser, including commit history inside Changes, as
well as the review endpoints. An
older server with only `git-status-enhanced` receives the basic status,
working-tree diff, and independently advertised Check/Pull/Push shell; the
client makes no unsupported browse/review requests. Ignore whitespace and
selected-revision-to-HEAD comparison remain gated by
`git-source-review-projections`. See
[server capabilities](server-capabilities.md) and
[`063-source-control-hosted-compatibility.md`](../docs/tactical/063-source-control-hosted-compatibility.md).

## Dirty-file last editor — proposal

The selected dirty file should link to the **last YA session observed editing
it**. This reverses the existing bridge from a session Edit block into the exact
dirty file without pretending YA can reconstruct complete authorship. In
Changes, the selected file banner and shared file context menu expose one
compact session action when attribution exists; it navigates through the
canonical YA session id and uses the standard session identity/hovercard.

Git records no dirty-file session authorship. The deliberately bounded
contract is **the last session with a recorded edit**: a successful structured
file mutation YA observed in a canonical session—Edit, Write, `apply_patch`, or a
provider equivalent—whose normalized project-relative target is this path.
Do not infer an editor from active sessions, project membership, or file
mtime.

Shell commands, generators, human edits, external processes, and provider
activity YA did not observe may remain unattributed. Scripted edit/output
commands are a best-effort extension only where their touched paths can be
deduced reliably; gaps are accepted and documented rather than guessed. An
unobserved writer can also replace or revert the observed session's
contribution while leaving the path dirty, so stale attribution can remain
until the file next becomes clean. The UI says "last observed editor", never
claims exhaustive authorship, and does not imply that session contributed to
the exact current bytes.

Implementation plan:

1. Characterize each supported provider's structured file-mutation events and
   success boundary. For `apply_patch`, parse every Add, Update, Delete, and
   Move header; after a successful multi-file patch, upsert one row for each
   touched normalized path. Ignore failed or merely proposed mutations.
2. Persist one logical record per `(source, project, normalized file)`, carrying
   the canonical YA session id and latest observed edit time. Any later
   successful edit replaces the prior session and time. Retain no editor set,
   event history, tool/message ids, content hashes, transcript backfill, or
   before/after lineage. Store these records in private server-owned state and
   reload them after process restart; they have no TTL. The mutation observer
   already has source, project, and canonical session context, so Source Control
   must not run provider-specific discovery or `agent-mapping` work to construct
   the link.
3. Reconcile only from a successful, complete, authoritative Git-status
   refresh. Whenever such a refresh observes that a tracked path has become not
   dirty, clear that file's record. A successful commit normally causes
   this transition, but
   a commit that leaves further staged or unstaged changes does not: the
   clearing condition is observed clean file state, not a commit command.
   Reconciliation may wait until Source Control enters or refreshes that
   project; restart need not eagerly walk every repository.
   Temporary source/project disconnect retains rows and does not pretend that
   files became clean; reconnect reconciles before serving them. Explicit
   project removal clears that project's rows, and explicit source removal
   clears all rows owned by that source.
4. Under a dedicated capability, add the remaining editor session id and
   observation time as an optional field on each dirty-file record returned by
   the existing Git-status response. This prepopulates all visible links in one
   request; selecting a file starts no attribution query. Reuse the existing
   session hovercard/navigation and file banner/menu. An absent record produces
   no request-time provider scan and no empty chooser.
5. Test first attribution, a later session replacing it, repeated edits by the
   same session updating its time, failed edits being ignored, clean-state
   clearing, restart persistence and
   reconciliation, disconnect/reconnect retention, explicit project/source
   removal, a commit that leaves the file dirty, and accepted missing/stale
   attribution after unobserved shell or human changes.

**Difficulty:** the UI is low difficulty. Provider mutation hooks, clean-state
observation, the one-record-per-file store, and its query are low-to-medium
difficulty.
Exact lineage and exhaustive attribution are deliberately out of scope.
