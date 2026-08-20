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

Every Git subprocess launched through Source Control disables Git's optional
locks. Passive status, diff, history, and file observation must not
opportunistically refresh the index or briefly create `.git/index.lock` while
an agent or the user is doing concurrent Git work. Explicit Pull, Push, and
review-object mutations still take every lock Git requires for correctness.

The navigation surface has these modes:

- **Changes** is the default quick check and owns both the current
  HEAD-to-filesystem state and commit history. **Working tree status** is its
  normal landing at every repository state. A browser-local preference may
  instead select the newest commit when the repository is clean; Working tree
  remains available as a pinned revision.
- **Working Tree** keeps the stable `?tab=files` URL while browsing current
  filesystem contents. Its complete surface can find every project file except
  `.git` administrative state. Current content is primary; blame is an optional
  tracked-file projection.
- **Pending Comments** is the unsubmitted accumulator owned by
  [Source Review → New Session](source-review-to-session.md). Its stable URL
  key remains `comments`, preserving existing `?tab=comments` links.
- **Reviews** is the submission and comment-site browser owned by that topic.
  Its URL key is `reviews`; it shows frozen reviewer entries, captured source,
  target sessions, outcomes, and open/addressed/resolved state as those
  contracts become available. The added fourth mode means the wrapping rule
  in *Header hierarchy* below must be re-verified at phone width rather than
  assumed to still fit.

Normal Source Control navigation opens Changes with Working tree selected. A
clean repository renders its quiet clean-state confirmation at desktop and
phone widths; a dirty repository renders its changed files. The browser-local
**When the working tree is clean** preference may choose **Latest commit**
instead of the default **Working tree status** landing. If the repository has
no commits, the clean Working tree confirmation remains the fallback.

A user-selected mode pushes a browser-history entry. Back from Pending Comments
or Reviews therefore restores the preceding Source Control mode; a direct entry
at `?tab=comments` still backs out of Source Control rather than inventing an
internal predecessor. Phone commit-detail history remains a separate nested
interaction.

The preference applies only when navigation did not already identify an
explicit source target. A bare `?rev=<sha>` is a focused commit: files and diff
without the revision sidebar. `?history=1&rev=<sha>` opens history with that
commit selected; `?history=1` opens history with Working tree selected. The
detail-level **‹ Commit history** parent link and legacy `?tab=commits` URL open
history inside Changes. A working-tree file link adds
`?worktreeFile=<path>`; a committed-file link combines `?rev=<sha>` with
`?commitFile=<path>`. Both select the named file's diff as soon as its corpus is
available, including the phone drill-in flow.

The pinned Working tree row remains available in history and reflects its
actual state: clean uses calm success/neutral treatment and explicit clean
copy, while dirty uses warning treatment with its changed-file count. Selected
commit detail identifies only the commit; repository cleanliness remains in
the Source Control identity header and is not repeated as commit metadata.

Desktop uses master-detail panes once history is open; phone layouts drill
from revisions to files to a full-screen diff and restore the prior list
position on Back or back-swipe. The pinned Working tree behaves like any other
revision: desktop keeps it selected beside the history list, while phone opens
its detail with **‹ Commit history** returning to that list. The top-level
Changes tab reapplies the status-sensitive landing; the Dirty badge restores
the standalone Working tree landing.

## Header hierarchy

Project selection, branch, upstream, ahead/behind state, and the Clean/Dirty
badge form the Source Control identity cluster. Changes/Files/Pending
Comments/Reviews is the trailing mode selector. Pull, Push, Check remote, and
Pause form one repository-action group in that fixed order. Pending Comments
is only that mode tab; there is no second Comments action that opens the same
pane.

On a wide layout, repository actions occupy the title row between identity and
the trailing modes only when the rendered intrinsic widths of all three groups
fit. A `ResizeObserver`-backed measurement responds to identity, capability,
count, and viewport changes; a viewport breakpoint does not infer that fit.
When they do not fit, identity and modes retain the upper row and repository
actions take a full-width fallback row below it. Constrained layouts give the
mode selector and repository actions full-width rows. The same control
instances move between placements rather than being duplicated.

The branch name in the identity cluster is navigation to the commit that branch
points at — `recentCommits[0]`, the current `HEAD` tip. It is a real anchor with
a standalone `?rev=<sha>` URL, so middle-click, modifier-click, and “open in new
tab” work, while plain left-click stays in the current tab. A detached `HEAD`
keeps its detached label and still opens and copies that tip SHA. The copy
control stays beside the name: the name click navigates, the icon copies. A
server without the Source Control browser leaves the name inert rather than
linking to a view it cannot render.

When the server advertises `git-incoming-commits`, the upstream name opens the
commits reachable from the configured tracking ref but not local `HEAD`. The
server resolves both range endpoints before reading the log, and opening the
preview never fetches: it shows only what the last **Check remote** observed.
Without the capability, upstream remains inert text and the client sends no
incoming-commit request.

The Pending Comments tab opens that accumulator, including when drafts exist;
submission remains on that pane. In the full-width fallback, repository
actions stay left-anchored. Branch names,
upstream names, count badges, action progress, and action outcomes must not move
the Pull/Push/Check group. Their visible labels stay constant while a leading
action glyph changes in place to present progress and brief success/warning
state. Full action feedback remains visible below the header. The project
selector retains its intrinsic width, up to its desktop cap, before branch and
upstream text yield space; ordinary short project names must not truncate while
unused header space remains.

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
tree. Working Tree exposes its files/detail boundary. Matching top and bottom
handles resize the same boundary, remain keyboard-operable, and stay absent
from phone layout. Clicking either revision splitter handle alternates between
zero width and the exact last nonzero revision width; the hidden selector leaves
no minimum-width strip.

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

With `git-working-tree-files`, compact untracked directories are backed by the
server's persistent non-ignored path cache. A group with more than ten
descendants starts collapsed and loads its children only on expansion; a
smaller group may load and expand immediately. Expanded child labels omit the
shared parent while row tooltips and action identity retain the canonical full
path. A debounced query searches cached paths that the client has not realized,
shows matching paths without overwriting disclosure state, and removes
search-only rows when cleared. Loading, truncation, and cache failures remain
visible.

Without that capability, the client keeps the released bounded
`/git/untracked-folder` enrichment. It does not call the cache routes, and search
covers only children that legacy enumeration has returned.

Working-tree changes, commit revisions, and Files use one shared file-row/path
treatment and one path-compression outline. Filtering and semantic sectioning
happen first; grouping is independent inside each resulting section. The
outline factors slash-delimited directory prefixes into headings, including a
directory with only one surviving file. Expanded rows omit the heading prefix
while their tooltip, copy target, menu actions, accessibility name, and
`data-source-path` retain the complete canonical path. This deterministic
elision does not depend on measuring row width and does not attempt generalized
non-path prefix factoring. A collapsed group renders every distinct Git status
represented by its children rather than choosing one status for a mixed group.

Initial disclosure uses the list's available row budget: groups expand in order
while their immediate children fit. A later explicit expand or collapse choice
wins through corpus refreshes and resizes. Search renders the filtered complete
paths directly, so grouping never hides a match.

A case-insensitive search match is highlighted and held visible: the leading
prefix yields from its start and the suffix consumes the remaining live row
width. A truncated path exposes its full value from the actual row hover/focus
target in both Native and Themed tooltip modes; a nested `title` that happens to
work in only one mode is not sufficient. Desktop row menus overlay the trailing
edge instead of reserving permanent path width. Touch layouts keep the menu
target in flow and preserve more path identity in the row itself rather than
depending on hover.

### Current-content inventory and untracked cache

Working Tree exposes a route-local row of **Tracked**, **Untracked**, and
**Ignored** visibility toggles. Revisiting the route restores its defaults:
Tracked and Untracked on, Ignored off. Ordinary entry therefore performs no
ignored-file enumeration merely to hide its result. Tracked means every present
tracked path. Changes retains its diff-oriented changed-tracked and non-ignored
untracked list; composing it from the same section-control surface remains an
optional unification, not a requirement.

Ignored is the final divider-separated section and includes every path Git
classifies through repository ignore rules, `.git/info/exclude`, or global
excludes. `.git` itself and every descendant are categorically absent: YA does
not list, traverse for content, or attach a filesystem watch within that
administrative subtree. No config-file exception is implied.

The Working Tree browser uses the live project subscription described below
when `git-working-tree-sections` is present. A server with only
`git-working-tree-files` retains the released explicit-entry or refresh request
to `GET /api/projects/:projectId/git/working-tree-files`; neither path runs on a
five-second poll. The complete corpus combines present indexed paths with
non-ignored untracked paths and subtracts tracked deletions. Tracked changes
come first, **Untracked** separates live-only files, and **Tracked, unchanged**
separates the remaining tracked paths. The Working tree revision in Changes
uses the first two sections only: tracked rows open HEAD-to-filesystem diffs,
while untracked rows open live contents through `FileViewer`. Every section
uses the shared outline described above. Search spans the enabled section
corpus without changing group disclosure state, and any server safety bound is
an explicit truncation state rather than a claim of completeness.

Selecting a path renders its live contents through the shared `FileViewer`,
including clean and untracked files. Tracked files may switch to Blame; an
untracked file stays in Contents and never receives invented provenance. A
server without `git-working-tree-files` retains the tracked-only Files corpus,
content-plus-blame behavior, and stable `?tab=files` URL while making no
working-tree inventory request.

When no Git repository exists, a server with `git-working-tree-sections` still
shows Working Tree current contents. Ordinary filesystem files are untracked
rows, `HEAD` and base endpoints are absent, and `.git` remains categorically
excluded. The repository action and history surfaces stay absent. YA neither
initializes Git nor offers an initialization control. A server without the live
capability retains the released **Not a git repository** fallback and receives
no worktree subscription.

A current client begins such a project with only the filesystem root open. The
snapshot contains direct root files and one pending row for each direct
subdirectory; a pending row claims no file count. Opening a row leases that
canonical project-relative prefix and its ancestors, enumerates all of its
direct files and subdirectories, and watches that directory non-recursively.
Unopened descendants are neither traversed nor watched.

The server retains every enumerated direct file as opened-directory truth. An
ordinary subscriber receives at most 5,000 files from each open directory, with
an exact total for every successfully enumerated directory. A truncated browser
ends with an ellipsis row and **Show all N**, where `N` is the total file count
across its open-directory corpus. That action acquires an explicit complete
filesystem lease; it removes only the subscriber projection bound, so a wide
flat directory deliberately publishes every row. Other subscribers remain
bounded. If an open directory cannot return rows, it remains explicitly
incomplete. A separate count-only enumeration may still publish its exact total
with an empty row response; if that also fails, the total is omitted rather than
reported as a lower bound.

Directory disclosure is subscription state, not a selectable pseudo-file.
Collapsing a directory releases it and every descendant prefix from that client
lease. Search covers already enumerated files and hides pending directory rows;
it never implies that unopened descendants were searched. Subscriber prefixes
are unioned by the project owner, but each subscriber receives only files below
its own open prefixes and sees a directory opened only by another subscriber as
pending. The filesystem root and the union of currently open prefixes are the
only content directories watched; narrowing the union closes obsolete watches.
A missing directory disappears, while an unreadable open directory remains
explicitly incomplete.

`expandedPrefixes` is optional at the protocol boundary because capability 41
was expanded before its first stable release. Omission retains the earlier
bounded breadth-first filesystem inventory for a cached source client. A current
filesystem client sends an empty array for root-only mode and accepts a snapshot
without directory rows from an older source server; that safely displays the
server's bounded file corpus without offering unsupported lazy disclosure.
When omitted-prefix and expanded-prefix subscribers coexist, the shared file
scan retains the compatibility corpus while a separate scan of the expanded
prefix union preserves current clients' directory rows, files, totals, and
watchers. Compatibility subscribers receive no directory fields;
expanded-prefix subscribers receive their own narrow file and directory
projection.

Permanent capability 42, `git-working-tree-complete-scan`, owns the optional
`coverage.filesystemScan: "complete"` request, snapshot and delta totals, and
the visible **Show all N** action. Without it, the client keeps the bounded
inventory and truncation notice, sends no complete request, and never exposes a
button whose server cannot honor. Capability 41 keeps its existing lazy
opened-directory meaning.

The same capability owns
`GET /api/projects/:projectId/git/untracked-files` and cache-backed status via
`GET /api/projects/:projectId/git?untracked=cache`. Cache-backed polling asks Git
for tracked/staged state with untracked enumeration disabled, then merges the
retained untracked snapshot. One root request is shared in flight, so a polling
tick cannot overlap it. Background replacement retains the current file corpus,
selected row, mounted detail, scroll/view state, and explicit folder/outline
disclosures until replacement data is ready. A changed compact-folder corpus
adds or removes available groups without resetting choices for groups that
remain.

The route-mounted status owner refreshes early when a managed process in the
selected project reaches idle or waiting-for-input, coalescing completion events
for 750 ms. Git actions also refresh explicitly. External editors, human Git
commands, and other unobserved writers produce no YA activity event, so a
30-second safety refresh remains while the Source Control document is both
`visible` and focused. Leaving the route tears down that timer, its activity
subscriptions, and any queued event refresh. A hidden tab, commonly including a
minimized window, and an unfocused browser window do no periodic Git work; the
next focus/visibility restoration refreshes immediately.

Browser attention signals are deliberately coarser than pixels. The Page
Visibility API does not report whether a visible window is covered or whether
Source Control is scrolled outside the viewport, while focus may pause a visible
side-by-side window that the user is passively reading. The immediate refresh on
focus accepts that stale passive view in exchange for stopping repository work
from an open but unattended window. Multiple tabs own independent route
lifecycles; hidden or unfocused tabs do not multiply the safety cadence.

The project-keyed cache lives below the configured YA data directory under
`indexes/git-untracked/`; browsing does not create `.yep`, edit Git excludes, or
otherwise write selected-project state. Git remains authoritative for
`.gitignore`, `.git/info/exclude`, and the user's global excludes. Cached HEAD
and index sets remove newly committed or staged paths immediately and force
reconciliation when those sets change. Full filesystem reconciliation defaults
to hourly; a stale selected path is checked at most hourly, and a root query
does not stat every nested child. Persisted paths must remain canonical
repository-relative paths, bounds and truncation are explicit, and concurrent
refresh callers share one refresh.

### Live project worktree ownership

With `git-working-tree-sections`, one project-keyed server owner replaces the
static file corpus as the current Source Control truth while any capable view
holds a lease. Identical subscribers across direct and relay transports share
one snapshot, watcher set, and reconciliation computation. Subscriber coverage
is unioned: Tracked and Untracked are present by default, while Ignored paths
are neither enumerated nor retained until at least one subscriber requests
them. For filesystem-only projects, explicitly opened directory prefixes are
unioned as well, then projected back to each subscriber's own lease. Releasing
a prefix narrows the retained file corpus and watcher set; releasing the final
lease closes every watcher and timer. Inactive snapshots may then remain only
as bounded least-recently-used state.

The first subscriber receives one complete snapshot with project-root
`{ epoch, sequence }` generation, resolved `HEAD` / `HEAD^1` endpoints, present
tracked and untracked rows, tracked deletions marked `present: false`, and the
exact dirty and cumulative projection facts each row needs. A lazy filesystem
snapshot also carries the visible directory rows and their pending or bounded
state. That payload ends Loading immediately. Fresh query metadata without a
retained payload never stands in for it, and no query identity serializes the
file corpus. File-level diff links first reuse a non-polling status query with
untracked enumeration omitted to establish that the project is a Git
repository. They retain live coverage only for a repository and then read
projection availability from the resident row rather than requesting a
projection manifest. Multiple links share both the status query and live
subscription.

Filesystem changes publish create, modify, and delete deltas. If subscriber
coverage widens while a narrower scan is active, the owner scans again before
the new subscriber becomes ready; its initial snapshot therefore covers the
complete requested union. The generation sequence advances globally even when
a subscriber's coverage filters the delta to an empty change list. The client
applies only contiguous deltas, preserves untouched row object identity,
ignores stale events, and requests one full snapshot after a generation gap or
reconnect. Selection, detail mode, scroll, and explicit outline disclosure
remain component state and therefore survive ordinary corpus replacement.

On Linux, YA watches content directories non-recursively. Git repositories and
the omitted-prefix compatibility walk cover each enumerated content directory;
lazy filesystem inventory covers only the root and the union of open prefixes.
Directory creation and removal update only the affected watch set. For the full
walk, the initial root watcher is installed before background watcher expansion,
so expansion cannot delay the first snapshot or starve a notification-triggered
Git scan. Lazy filesystem watches synchronize to the scanned open-prefix set
before a widened subscriber becomes ready. `.git` and every descendant are
absent from content traversal and watching.

A Git repository adds a separate metadata watch set. YA resolves both the
per-worktree administrative directory and the common Git directory rather than
assuming `.git` is a directory or that linked worktrees share one metadata
root. It watches each root non-recursively and watches existing refs, reftable,
and rebase/am state directories recursively. The containing directories are the
watch targets because Git atomically replaces `HEAD`, the index, and refs;
lockfiles and watchman cookies are ignored. A relevant event starts the same
coalesced worktree reconciliation used for content events. Reconciliations are
serialized, and an event during a scan queues one follow-up rather than
launching an overlapping Git scan.

Once Linux content and metadata watches are complete, the 30-second safety tick
fingerprints a bounded set of Git sentinels, including `HEAD`, the index, packed
refs, the current symbolic ref, operation markers, config, and excludes. An
unchanged tick runs no Git subprocess. Changed metadata triggers a full scan,
and fingerprints before and after that scan force a follow-up if Git moved
during observation. A missing or failed watch restores full 30-second
reconciliation, and so does a failed scan: the published snapshot is then
behind the worktree with no pending event of its own, so the clock reconciles
until a scan succeeds. macOS, Windows, and other platforms retain that full
fallback because recursive watch truth is not assumed there. Explicit YA Git
actions and watch events may refresh more frequently.

A filesystem-only walk survives its directories changing under it. A directory
removed mid-walk is skipped and leaves the inventory complete; one that cannot
be read is skipped and reported as an incomplete inventory. The compatibility
breadth-first walk alone ends early at its file limit. Opened-directory scans
enumerate each direct file before applying subscriber-specific delivery bounds.

A 150 ms quiet timer coalesces an ordinary burst. A separate five-second
maximum deadline is pinned to the first unprocessed filesystem event; later
events never move it forward. Five seconds is not a polling cadence or an
initial-load delay. The Source Control Pause control freezes visible client
application while retaining the lease and continuing server maintenance; Play
applies the queued current snapshot. Pause and Play use the same reserved
leading glyph slot as Pull, Push, and Check: a pair of vertical bars or a
right-pointing triangle, drawn as a 16×16 SVG and optically centered in that
slot. They are not text or numeral glyphs. Pointer motion over the Working
Tree list may wait for 200 ms of quiet before applying row movement, but a
pending client delta has its own five-second hard deadline.

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

When the selected commit has a body, its message card begins with the complete,
wrapping subject even though the detail banner retains its compact ellipsized
copy. The subject is preserved verbatim; only likely manual prose wrapping in
the commit body is folded to the pane width. Its text is selectable; mouse
activation opens the verbatim message only when the release did not complete a
selection, while Enter and Space remain keyboard activation. Phone detail keeps
the full subject above its compact full-message action. **‹ Commit history** is
styled as an actionable parent link rather than a full-width section label.

Source lists support Up/Down selection, Enter drill-in, Escape return, and `/`
to focus search when focus is outside an editor. Diff navigation supports
previous/next hunk and a visible current-hunk indicator. Browser shortcuts must
not copy native GitHub Desktop accelerators that collide with browser tabs,
Find, or the address bar.

Unified/Split and full-context controls stay in the diff pane. Ignore
whitespace is an independent projection of the active working-tree, commit, or
revision-range diff. **To HEAD** is inclusive: an ordinary selected commit uses
its first parent as the fixed base, a selected root uses Git's empty tree, and
the server pins current HEAD as the tip. The returned list therefore contains
the net squash-style change from the selected commit through HEAD, including
paths first added by the selected commit. Every per-file request stays on those
returned endpoints so a later HEAD move cannot mix comparisons. Switching the
range on or off retains the selected file whenever that path, or its rename
counterpart, exists in the new corpus; loading the replacement corpus never
clears the selection merely because its rows have not arrived yet.

Direct selected-tree-to-HEAD remains a different, clearly labelled per-file
context-menu action. It retains the established direct-comparison route and
capability semantics rather than overloading **To HEAD**.

A comparison comment cites the endpoint that contains the clicked projection:
an old-side line anchors to the fixed base SHA (or has no old lines for the
empty tree) and a new-side line anchors to the pinned tip SHA. An ordinary
one-commit diff uses that commit SHA for both sides; a working-tree diff remains
uncommitted. Rendered diff lines are
interactive on their first visible frame—first-click commenting and hunk keys
do not depend on a later passive effect. Pending-comment tint uses revision,
side, and line identity so similarly numbered lines in another projection do
not inherit it.

Full context is a view of the current diff, not a file-path cache entry. If a
live working-tree refresh changes the diff while full context is open, YA
invalidates and reloads that projection. An older request resolving later
cannot overwrite the newer projection.

A diff-only/full-context switch preserves the first changed row's current
viewport offset rather than centering that row. Source Control and session Edit
details share both this scroll-anchor primitive and the unified diff renderer,
so the hunk remains visually stationary while surrounding source and the
scrollbar appear.

A live working-tree refresh preserves the user's selected Diff/Markdown
Preview mode and maintains the viewed position on a best-effort basis. A
projection change may remount the rendered detail while its replacement loads;
the remount starts from the latest explicit per-file view choice, not the
retention snapshot from before the click. Until the aligned source-marker
projection exists, preserving the relative scrollbar position is sufficient.
If one refreshed response cannot supply Markdown preview content, YA
temporarily shows the source diff without clearing the user's preview choice;
preview resumes when a later response can render it.

Source Control presents a text diff only when the exact Git projection is not
classified as binary and both file versions are safe UTF-8 text. Git attributes
that mark a tracked path binary are authoritative; a filename extension alone
is never authoritative in either direction. Binary working-tree, staged,
commit, and selected-revision comparison files show a bounded skipped-preview
state with the path and size when known, and their bytes never enter syntax
highlighting. Untracked files receive the same treatment from their content.
A current client also suppresses binary-looking structured patch text returned
by an older server.

Large text diffs have a bounded plain projection rather than inheriting the
syntax-highlighted projection's expansion limit. Up to 16,777,216 hunk
characters, 20,000 hunk lines, and 20,000 characters on any one line, the server
ships the complete structured patch. Above 640 KiB of hunk text—or whenever
highlighted HTML expands past 20,000,000 characters—it omits highlighting and
the client renders one low-node-count unified text block. The plain view says
that syntax color, split view, and line comments are unavailable; copy, full
context, and hunk navigation remain. Source versions stop at 32 MiB combined
before diff computation. Binary and malformed-text guards remain independent.
Markdown Preview has a separate 256 KiB whole-document rendering budget; it is
not unlimited and does not decide whether the source diff uses rich or plain
mode.

## Design decisions

- **Watch Git's administrative directories and retain a bounded sentinel
  fingerprint** (vs. watching replaceable file inodes or running Git on every
  safety tick): directory events survive Git's atomic replacements, while the
  cheap fingerprint catches a missed event without an unchanged Git subprocess.
- **Show filesystem-only current contents without repository mutations** (vs.
  adding a Git initialization action): projects remain inspectable outside Git
  while Source Control keeps its established inspection-first product boundary.
- **Use a complete bounded plain projection beyond the generous rich-diff
  budget** (vs. omitting the preview or leaving rich rendering unbounded): this
  keeps useful source available while still bounding server expansion and
  browser nodes. The rich budget is twenty times its original 32 KiB / one-
  million-HTML-character thresholds. On a
  quiet 16-core host, three cold-cache repetitions of a real 568,301-character,
  19,803-line evidence file took 166–188 ms to produce 3.6 million highlighted
  HTML characters; its plain browser layout took 53–61 ms at 1000×600. A
  representative one-million-character plain block took 62–64 ms, while two
  million characters took 111–136 ms. One million characters split into about
  350,000 tiny lines took 597–653 ms, which is why both the character and line
  bounds are required. These are diagnostic same-host measurements, not a
  cross-host performance ratchet.
- **Keep one plain-projection budget for every connection** (vs. a smaller
  budget when the viewer arrives through the relay): the server would have to
  learn the viewer's transport at the diff route to vary it, and a remote viewer
  asking for a large diff usually wants the same content a local one gets. The
  accepted cost is that the largest allowed diffs are near the relay's delivery
  ceiling. A relay response travels as 256 KiB transport chunks, but the relay
  closes a circuit whose queued bytes pass 2 MiB, or whose socket passes 8 MiB,
  rather than slowing the sender — so a multi-megabyte diff sent to a viewer
  that cannot drain it that fast drops the remote connection instead of the
  request. A direct (Tailscale/LAN) connection has no such ceiling. Lower
  `GIT_DIFF_PREVIEW_MAX_DIFF_CHARS` if remote viewers start losing connections
  on large diffs; raise the relay's per-circuit queue only with its own
  memory-per-connection evidence.

Markdown Preview follows the explicit diff/full-context scope. Diff-only uses
the same approximate diff-aware rich-text projection as session Edit details,
including added/removed/context lanes. Full context renders the complete
post-change document and may sacrifice changed-block emphasis for a faithful
whole-file render. Copy content follows that same scope. Exact source-line
identities, aligned blocks, and the cross-representation scroll contract live in
[aligned Markdown diffs](aligned-markdown-diffs.md).

The wide diff pane keeps filename, path, view controls, hunk navigation, and
file actions in one toolbar row when they fit. In a narrow pane, controls take
the first row and may wrap to additional control rows; file identity follows on
its own full-width row. The filename wraps without a line cap. The filename is
the primary identity: it uses compact source type and retains its full text
before the directory path spends remaining width. The smaller directory prefix
precedes it and, when clipped, keeps its rightmost segment next to the filename.
Toolbar actions use compact glyphs with complete hover and accessible names;
hunk position uses the language-neutral `current/total` form.

Ignore whitespace uses the compact `_+` glyph. Its tooltip reads **Ignore
whitespace changes** when off and **Ignoring whitespace — click to include it**
when pressed; the selected state must not depend on a subtle tint.

Each commit and working-tree changed-file pane exposes one compact file-filter
disclosure. Opening its magnifier expands a case-insensitive path search across
the pane's current corpus, including both sides of a rename. On a capable
server, the Working tree query also searches cached untracked children not yet
loaded into an expanded group; legacy servers retain returned-child-only
coverage. New arrivals pass through the active query. On wide layouts, the first
visible file becomes the detail when the prior selection no longer matches; no
match leaves an explicit empty result.

### File-viewer projections

Every project file viewer may expose two exact Git projections in its header.
**vs HEAD** compares the current `HEAD` tree to the live filesystem. **vs
HEAD^1** is cumulative: it compares the first parent of `HEAD` to the live
filesystem, so it includes both the current commit and any staged, unstaged,
or untracked work. It is not the commit-only `HEAD^1`-to-`HEAD` diff. A
worktree edit that exactly cancels the current commit's change therefore
removes that path from the cumulative corpus.

A selector exists only when the current Git projection contains the path. With
the live worktree capability, availability comes from the resident project row;
older capable servers use the static project manifest. A clean path has no **vs
HEAD** selector; a root commit has no **vs HEAD^1** selector; a path with neither
net diff has no selector at all. Selecting one projection sends only its current
path and, for a rename, its original path; the server performs an exact
literal-path comparison rather than rebuilding the project-wide manifest.
Renames match either path and render as one file projection.

The shared project-file link is the access point in prose and structured
Read/Edit turns. Hovering the filename reveals the available projections
beside it; keyboard focus reveals the same links. Touch relies on the viewer
header. Each target is a real anchor with a standalone URL, so middle-click,
modifier-click, and browser context-menu opening work normally.

Selecting a projection replaces the source body in the existing file viewer.
While a diff is active, source line and line-range requests are inapplicable:
the diff URL omits `line`, `lineEnd`, and `view=range`, and the viewer neither
loads nor highlights that source window. Returning to **Source** restores the
original source range. Diff rendering retains full-context, unified/split,
Markdown-preview, hunk-navigation, and review-projection behavior from the
shared Source Control renderer.

The permanent `git-file-diff-projections` capability owns
`GET /api/projects/:projectId/git/file-projections` and
`POST /api/projects/:projectId/git/file-projection-diff`. Without it the
client hides all of these selectors and makes no projection request. Existing
Source Control capability meanings do not expand.

## Search and compatibility

Every Source Control filter activates on the first non-whitespace character.
Filename filters, commit-message and metadata search, and indexed changed-path
or changed-text search share one case-insensitive match projection. It preserves
source casing, keeps the matched substring highlighted, and independently
shrinks leading and trailing context with ellipses so narrow rows do not hide
the match. The complete original value or changed line remains available from
the result's tooltip.

Commit search preserves why each result matched: subject, author, short or full
hash, date, changed path, or changed line. The row renders that exact field or
line instead of returning an unexplained matching commit. On phone layouts, an
active query keeps the revision list visible until the user explicitly opens a
result; clean-tree default selection cannot replace it with Working tree
detail.

Working Tree search owns the complete returned current-content corpus; rendering
or path-prefix collapse must not become a search-coverage limit. Commit-delta
search builds an on-demand client corpus from lightweight history plus bounded
changed-path/line batches. Once a commit corpus is present, typing performs no
network request and starts no Git process. Browser-lifetime reuse is
implemented; IndexedDB reuse across browser restarts and focused completions
remain optional future work.

Working Tree starts the ordinary project-file request independently of optional
blame. Readable content renders as soon as the file request returns and never
waits for `git blame`. Blame then fills commit-hash links in place and may add
highlighting without resetting the file selection or scroll context. Failure to
load blame leaves readable content visible with a provenance warning.

In a commit detail, **Blame** is an in-place gutter mode rather than navigation
to Working Tree. It keeps the selected commit and file panes mounted and blames
the exact immutable revision being viewed; an inclusive or direct comparison
uses its pinned tip. The active gutter control returns to the diff in place.
Right-clicking a commit file reaches the same mode. Working Tree retains its
Contents/Blame projection and may use live-file provenance.

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

Current source persists that palette at `.yep/git-author-palette.json` and
warms it merely when a project is opened or added. That post-`0.7.0` behavior
is audited but not the target contract: under
[Project Directory Storage](project-directory-storage.md), default project
browsing performs no project or Git-metadata write. The palette belongs in
memory or a central project-keyed cache unless project-local storage was
explicitly enabled.

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

The comment-anchor projections only read `HEAD`, so they depend on nothing
else the request computes and run concurrently with it. Their phase is
therefore an overlapping wall-clock window, and the number is the time that
read was awaited rather than its exclusive share.

The binary classification stays strictly *before* the version reads, and a
later latency change must not parallelize the two. That ordering is what keeps
a binary file's bytes from being read into memory at all: the size-based
preview skip only covers untracked paths, so for a tracked binary the
classification is the sole guard, and speculating on the version reads
alongside it would trade a bounded skip for an unbounded read. The cost of
holding the order is one subprocess latency. Note that a response-level test
cannot catch a regression here — the classification still wins the race and
still returns the skip — so the guard is the ordering itself.

Syntax highlighting dominates the remaining cost — roughly 90µs per tokenized
line, and a whole file is tokenized per version. A version's content determines
its highlighting exactly, so the server retains highlighted output keyed by
content and language, bounded by total retained bytes. This is a pure function
of content and needs no invalidation window; do not add a time-based expiry
that would reintroduce the cost.

**No request pays whole-file tokenization.** Highlighting a whole file gives
the tokenizer exact context, but a request that has to compute it scales with
the file rather than with the change — for a ~2000-line source file that was
413ms of tokenizing. A diff therefore takes whichever it can have now: the
retained whole-file result when that is already paid for, otherwise an excerpt
of just the hunk lines, while scheduling the whole-file tokenization to land
after the response. The next read of that same version — the status-poll
refetch, a reselection, a whitespace or full-context toggle — is exact and
tokenizes nothing. Measured on that file: 413ms → 89ms first look → 9ms
thereafter.

Scheduled whole-file tokenizations are capped, because each one blocks the
loop while it runs and walking quickly through a changeset would otherwise
queue a long stall. Dropping one is safe — the request still has its excerpt,
and the next read of that version schedules it again.

The excerpt is what makes this a trade rather than a free win: tokenizing only
the hunk lines starts outside any string or comment that opened above them, so
a prose word inside a docstring can render keyword-coloured. That error is
therefore deliberately **transient** — it belongs only to the first look at a
version and must not become the steady state. A change here that removes the
background warm, or that serves the excerpt when the whole-file result is
cached, breaks the contract even though every response still parses.

Do not "fix" the first-look approximation by making the request wait for
whole-file tokenization; that is the 1.2s this replaced. Worker threads do not
substitute either: they would let the two versions tokenize in parallel, but
the common case has one cold version, so they buy no latency there — their
value is keeping a long tokenize off the loop that also serves live sessions.

Do not add speculative file-diff prewarming as the first remedy for a slow
selection. Eliminate unrelated project/session scans and measure the remaining
phases first. Prewarming the likely next file remains an optional latency
courtesy only if those measurements show a meaningful irreducible renderer
cost; it cannot become a correctness dependency or retain unbounded file
content.

### Selection cost is independent of corpus size

Entering Changes and selecting a file must cost what that one file's diff
costs. Two client-side rules keep it there, both of which a large working tree
otherwise breaks:

**Background enrichment yields to the foreground.** A capable server answers
compact directory expansion and search from its retained untracked cache rather
than launching one Git status per directory. A legacy server keeps the bounded
`git status --untracked-files=all` folder path; that sweep stays below the
browser's per-host connection budget and coalesces arrivals into periodic list
updates. Neither path may queue status or the selected file's diff behind
background enrichment.

**A changed-file row's object identity changes only when its state changes.**
The diff pane reloads when its `file` prop changes identity — that is how a
live working-tree refresh reaches an open diff, including when the summary
fields did not move. Rebuilding every row on each untracked-folder arrival
therefore recomputed the selected file's diff once per arrival. The merge that
produces rows reuses the previous object for any path whose state is unchanged,
and deliberately does not reuse across a new status snapshot, which is the
live-refresh signal itself.

The permanent `git-source-review` capability currently gates the complete
Changes/Files/Comments browser, including commit history inside Changes, as
well as the review endpoints. An
older server with only `git-status-enhanced` receives the basic status,
working-tree diff, and independently advertised Check/Pull/Push shell; the
client makes no unsupported browse/review requests. Ignore whitespace and the
direct selected-tree-to-HEAD per-file action remain gated by the unchanged
`git-source-review-projections` meaning.

Inclusive **To HEAD** is separately owned by permanent capability ID 40,
`git-inclusive-to-head`, and its `range-to-head` list/diff routes. The release
corpus `v0.6.0`, `v0.6.1`, `v0.6.2`, and `v0.7.0` lacks both the prior direct
routes and the inclusive routes. Without ID 40, the client hides inclusive
**To HEAD** and makes no range request; an independently available direct action
continues to use only the prior capability and routes. Existing capability
meanings and older capable behavior remain unchanged.

`git-working-tree-files` (permanent ID 38, version-implied from `0.7.1`) owns the
static working-tree inventory, persistent untracked-cache route family, and
cache-backed status request described above. Its absence preserves tracked-only
Files plus legacy compact untracked expansion and sends none of those requests.
`git-working-tree-sections` (permanent ID 41, version-implied from `0.7.2`) owns
the expanded live snapshot and delta contract described above. Its absence
keeps ID 38's static behavior and sends no worktree subscription. The Maintainer
approved expanding ID 41 before its first published release rather than
allocating another capability. `git-working-tree-complete-scan` (permanent ID
42, version-implied from `0.7.2`) separately owns exact filesystem totals and
complete projection requests; its absence preserves ID 41's bounded inventory
without a Show-all action. `git-incoming-commits` (permanent ID 39,
version-implied from `0.7.1`) owns the local tracking-ref preview; its absence
keeps upstream inert. None broadens a published Source Control capability. See
[server capabilities](server-capabilities.md) and
[`063-source-control-hosted-compatibility.md`](../docs/tactical/063-source-control-hosted-compatibility.md).

## Dirty-file last editor

The selected dirty file links to the **last YA session observed editing
it**. This reverses the existing bridge from a session Edit block into the exact
dirty file without pretending YA can reconstruct complete authorship. In
Changes, the selected file banner and shared file context menu expose one
compact session action when attribution exists; it navigates through the
canonical YA session id. The context-menu action includes the session's known
display title, falling back to its short id when the title is unavailable.
Selecting a file starts no attribution or session query.

Opening that file's menu triggers one targeted read of the existing session
metadata route when the source-keyed client catalog has not yet observed any of
the session's title fields. Concurrent openings join the same source/project/
session request. A successful response merges only project and title facts into
the catalog at request-start freshness, preserving richer summary fields and
feeding the still-open menu, selected-file header, and later consumers. An
explicit null title is an observation and therefore does not cause repeated
reads. Failure keeps the short-id fallback and permits the next explicit menu
opening to retry. This adds no dirty-editor payload field, server route, or
capability; older servers already support the stable session metadata route.

The live Working Tree projection carries `lastEditor` forward from the latest
status metadata for the same path when its resident change row has no newer
attribution of its own. Replacing status rows with live snapshot rows must not
silently remove an already-observed editor action.

Git records no dirty-file session authorship. The deliberately bounded
contract is **the last session with a recorded edit**: a successful structured
file mutation YA observed in a canonical session—Edit, Write, `apply_patch`, or a
provider equivalent—whose normalized project-relative target is this path.
Do not infer an editor from active sessions, project membership, or file
mtime.

The server observes every owned provider process at the normalized
`tool_use`/`tool_result` boundary. It remembers a mutation proposal by tool id,
then records paths only when the paired result is not an error. `apply_patch`
parsing covers every Add, Update, Delete, Move, and unified-diff path in a
multi-file patch. Repeated completion-phase tool-use events do not replace the
earlier proposal. Provider adapters must mark declined or failed mutations as
error results; a proposed or failed edit never earns attribution.

One private server-owned JSON store retains a logical row per canonical project
path and normalized repository-relative file. A row carries only the canonical
YA session id and successful-result observation time. A later observed edit
replaces it, while a late completion with an older observation time cannot
overwrite newer attribution. There is no editor set, event history, tool id,
content hash, transcript backfill, or before/after lineage. The observer already
has project and session context, so Source Control must not run provider
discovery, session inventory, or `agent-mapping` work to construct the link.
This is YA application metadata for a still-dirty path, not a Git note, commit
header, hidden commit field, or commit-message trailer. YA currently records no
session attribution for committed changes; cleaning or committing the path
removes this last-editor row once status reconciliation observes it clean.

Scripted commands are a deliberately best-effort supplement. For a bounded set
of recognizable write-shaped shell commands—redirection, common file mutation
primitives, patch/apply operations, and formatter/package-manager write
modes—the observer compares Git's dirty paths and filesystem fingerprints just
before and after a successful command. Only dirty paths whose fingerprint
changed are attributed. Arbitrary scripts, generators with unrecognized command
shapes, human edits, external processes, provider activity YA did not observe,
and fast writes racing the initial snapshot may remain unattributed. Concurrent
external writes during a recognized command can be misattributed. These gaps
are preferable to scanning Git around every read-only shell command or guessing
from active sessions.

A successful complete Git-status refresh is the clearing authority. Any stored
path absent from dirty status is deleted; a commit that leaves another staged or
unstaged change does not clear it. A failed or unavailable status read is not a
clean listing and never prunes attribution; it may decorate whatever rows are
available, but stored rows survive until an authoritative refresh. Compact
untracked-directory rows preserve stored child attribution until Git expands or
cleans that directory. The compact folder itself does not expose a child-session
link; its existing expansion response includes attribution for the individual
files. Reconciliation may wait until Source Control enters or refreshes the
project; restart does not walk all repositories. An unobserved writer can
therefore replace or revert the recorded session's contribution while leaving
the path dirty, so the action is worded as the last editing session and never
claims exact-byte authorship.

The permanent `git-dirty-file-editor` capability adds optional
`files[].lastEditor = { sessionId, observedAt }` data to the existing
status response. Servers without it retain the complete released Source Control
behavior; clients hide the session action and make no additional request.
Existing `git-status-enhanced` and `git-source-review` meanings do not grow.
