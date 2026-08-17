# Source Control Working tree and Changes design gaps

The Changes / Working tree surface is hard to use once the dirty set is
large and mostly untracked. The items below are the open product and
implementation gaps. Current intended behavior still lives in
[Source Control](../topics/source-control.md); several items would change
that contract (header action-row placement, `?rev=` implying history,
untracked expansion via `git status`). Related existing gap:
[Source Control polling visibility](source-control-polling-visibility.md).

Observed 2026-08-17 on a Working tree with 11 898 changed paths, almost all
untracked under `runs/aim/pii-handout-fresh7-…`.

Old 0–10 handles from the first draft map as:

| Old | Now |
| --- | --- |
| 0 | [6 — Commit history affordance](#6--commit-history-affordance) |
| 1 | [1 — Cluster untracked files by directory](#1--cluster-untracked-files-by-directory) |
| 2 | [2 — Cache untracked listing without Git enumeration](#2--cache-untracked-listing-without-git-enumeration) |
| 3 | [3 — Highlight and reveal the path match](#3--highlight-and-reveal-the-path-match) |
| 4 | [4 — Apply search as files are discovered](#4--apply-search-as-files-are-discovered) |
| 5 | [5 — Ellipsis to the live pane width](#5--ellipsis-to-the-live-pane-width) |
| 6 | [7 — Selectable commit message](#7--selectable-commit-message) |
| 7 | [9 — Title-row repository actions](#9--title-row-repository-actions) and [10 — Comments control](#10--comments-control) |
| 8 | [11 — Back leaves Comments](#11--back-leaves-comments) |
| 9 | [12 — Branch opens HEAD](#12--branch-opens-head) and [13 — Upstream opens incoming commits](#13--upstream-opens-incoming-commits) |
| 10 | [8 — Middle-click focused commit tab](#8--middle-click-focused-commit-tab) |

## Working tree files

### 1 — Cluster untracked files by directory

Untracked rows are a flat list of full paths. After folder expansion, 11k
near-identical prefixes hide the distinctive filename. Group by common parent
prefix. A group with more than 10 children starts outline-collapsed and uses
the usual `+` / `−` control. Expanded children show only the path after that
shared parent, not the repeated prefix.

Tracked dirty rows (`M` / `A` / `D` / `R` / `partial`) stay a flat per-path
list unless a later pass proves they need the same grouping. The `?` status
code remains the untracked marker; do not bring back the long **untracked**
word on every row.

Collapsed groups are the UI that makes deferred listing in
[2](#2--cache-untracked-listing-without-git-enumeration) possible: do not
realize 11k child rows until the group is opened or search needs them.

### 2 — Cache untracked listing without Git enumeration

Today the client expands every compact `dir/` from `git status` through
`GET /git/untracked-folder`, and each call is `git status --untracked-files=all`
on that directory (`WorkingTreeBrowser` `UNTRACKED_FOLDER_CONCURRENCY = 4`;
server `packages/server/src/routes/git-status.ts`). A large untracked tree
becomes hundreds of Git processes and a fully flattened list.

Replace that expansion path:

- Know the `HEAD` tree (cached; invalidate when `HEAD` moves).
- Compare it to the filesystem. A path on disk and not in `HEAD` is a
  candidate untracked entry.
- Persist that candidate set. When `HEAD` gains a path (commit of an add),
  drop it from the cache immediately.
- Also drop paths that `git add` has staged — those are `A` / `partial` in
  ordinary status, not `?`. `HEAD` subtraction alone would keep a staged new
  file in the untracked cache until the next commit.
- Keep the cheap porcelain `git status` for tracked/staged/unstaged/rename
  rows. Only the untracked corpus leaves Git-status enumeration.
- Stale cache entries whose files were deleted may linger. Recheck a given
  cached path at most once per hour; do not `stat` the whole cache on every
  Working tree render or 5s poll.
- Directory children load only when their group is expanded or search
  requires them ([1](#1--cluster-untracked-files-by-directory)).

**Gitignore is the crux.** A raw `HEAD` vs filesystem walk will surface
`node_modules/`, build output, and other excluded trees. The listing must
honor `.gitignore`, `.git/info/exclude`, and the user's global exclude. Do
not reimplement Git's exclude matcher as the first attempt. Acceptable:
parse/apply exclude rules with a known-correct library, or refresh the
excluded-prefix set from a rare, cached Git read that is not on the Working
tree render path. Showing ignored files is a defect, not a fallback.

This also addresses the cost side of
[polling visibility](source-control-polling-visibility.md): the 5s status
poll must not grow into an untracked-tree walk.

A new list/cache endpoint is a new client/server contract. Before the client
calls it, follow the Source Control compatibility review in
`topics/server-capabilities.md` / `topics/remote-hosted-compatibility.md`.
Without the gate, keep today's compact `dir/` rows and do not issue the new
request.

### 3 — Highlight and reveal the path match

`useChangesetFileFilter` / `FileSearchIndex` already match the query against
the full display path. `SourceFilePath` then renders the path as plain text
with CSS `text-overflow: ellipsis`, which always keeps the *start* of the
path. A hit in the truncated tail is invisible. The query `hand` happens to
sit in the visible `pii-handout-…` prefix; a hit in `…-bootstrap-v2.json`
does not.

Highlight the matched span. If that span sits outside the visible ellipsis
window, shift the visible window so the match is shown (keep a leading `…`
when the directory prefix is clipped). Same treatment in commit and Files
rows that share `SourceFilePath`.

### 4 — Apply search as files are discovered

The filter already reruns when `files` changes, so a path that appears from
an expansion and matches the current query is included. That is not obvious
in the UI:

- There is no “still scanning / N directories remaining” signal, so it is
  unclear whether the list is complete.
- Compact or collapsed directory rows do not search their unrealized
  children. A query can miss thousands of files that exist only in the
  untracked cache or on disk under a closed group.

Once [1](#1--cluster-untracked-files-by-directory) and
[2](#2--cache-untracked-listing-without-git-enumeration) land, a non-empty
query must match cached/unrealized children and either reveal the matching
groups or list the matching suffixes without forcing every sibling to
expand. New cache arrivals must pass through the same filter before they
appear.

### 5 — Ellipsis to the live pane width

`.git-file-path` is `flex: 1; min-width: 0; overflow: hidden; text-overflow:
ellipsis`. In the 2026-08-17 capture the visible path still dies well before
the files-pane content edge, leaving empty row pixels while the distinctive
suffix is gone.

Likely contributors, in order to check:

- The files column default is 380px (`DEFAULT_FILES_WIDTH` in
  `ResizableSourceColumns.tsx`) even when the workbench is much wider and
  the detail track is empty or unused.
- Each row is `[path button | menu trigger]`. The trigger can reserve
  trailing space the path never uses.
- A sibling or max-width that keeps the path from actually consuming
  `flex: 1`.

Measure against the live files-pane content box, not a character budget or
the default column width. After [1](#1--cluster-untracked-files-by-directory),
most visible labels are short suffixes and this matters less — still fix the
shared row so a long ungrouped path uses the pane it sits in.

## Commit view

### 6 — Commit history affordance

`CommitHistoryParentLink` is a real button
(`packages/client/src/pages/CommitHistoryParentLink.tsx`) but
`.source-history-parent-link` paints it as muted secondary text on a full-width
bar (`packages/client/src/styles/renderers.css`). It reads as a section label,
not an action.

Give it a link-like hover (accent/underline) or the same filled-button
treatment as Pull / Push. Keyboard and click already work.

### 7 — Selectable commit message

The selected commit's message preview is a `<button class="commit-body">`
that calls `onShowMessage` (`CommitFilesPane.tsx`). Platform buttons do not
allow drag-select. Highlight/copy therefore opens the full message projection,
which *does* allow selection.

Keep click-to-open for the verbatim message view. Completing a text
selection must not treat the mouse-up as that click — the same rule already
used on blame lines in `topics/source-control.md` (*click without a
selection starts a comment; a completed selection does not*). Make the
preview selectable (`user-select: text`) or stop using a button as the
text container.

### 8 — Middle-click focused commit tab

Commit and Working tree rows in the history pane are `<button>`s
(`CommitRevisionPane.tsx`). Middle-click (Chrome: new tab) does nothing,
because there is no `href`.

Existing file-projection links in this topic already require a real
anchor so middle-click, modifier-click, and “open in new tab” work.
History rows should too.

The new tab should be the *focused* commit view: files + diff, no
commits sidebar — the same shape as the Dirty badge's standalone Working
tree. `‹ Commit history` remains available to open the sidebar. Today's
`?rev=<sha>` *forces* `historyOpen`, so it cannot be that focused URL.

Recommended URL split (this changes the current `?rev=` meaning):

- `?rev=<sha>` — focused commit, no sidebar (parallel to default Working
  tree).
- `?history=1&rev=<sha>` — history sidebar with that commit selected.
- Dirty / omitted rev — focused Working tree, as now.
- `?history=1` — history sidebar with Working tree selected, as now.

`historyOpen` must stop treating a bare `rev` as “open the sidebar”.
Blame **Open commit** and other `?rev=` deep links then land on the
focused view; add `history=1` only when the sidebar is the point.

The Working tree row in the history list should middle-click to the
focused Working tree URL (the Dirty-badge view). Regular left-click in
the current tab still selects in place and keeps the sidebar.

## Header and Review

### 9 — Title-row repository actions

Pull, Push, Check remote, and the comments control currently occupy their
own row (`.source-control-action-row`). The top identity row (project,
branch, upstream, Dirty/Clean, mode tabs) often has unused space between
the identity cluster and the Changes / Files / Pending Comments / Reviews
tabs. `topics/source-control.md` § Header hierarchy currently *requires*
that second row at every width.

When the topmost title row has leftover space, place those actions in
that middle gap instead of adding a row. Same wrap rule as the mode tabs:
browser-computed from intrinsic widths, not a viewport breakpoint. If they
do not fit, keep today's action row. Do not let branch names, badges, or
action feedback shove the group around.

### 10 — Comments control

The control label is **Review** / **Review (N)** (`sourceReviewStart`,
`sourceReviewReview`). With no drafts it `setTab("comments")` and the
Comments mode shows **No pending comments.** With drafts it opens the
submit modal and skips the list.

That is not a “start a review” verb. It is access to the drafted
accumulator (and, when nonempty, a shortcut past the list into submit).
The mode tab for that accumulator is already **Pending Comments**;
submitted history is **Reviews**.

Rename the control to **Comments** or **Review comments**. Always open the
Comments mode. Leave submit on that pane (it already has `onSubmit`). The
tab's existing count chip is enough when drafts exist. Do not keep the
zero-vs-nonzero dual target.

### 11 — Back leaves Comments

The Dirty badge already returns to standalone Working tree
(`onSelectChanges` → `setTab("changes")`). Browser / in-app Back does not.

`useSourceTab` writes `tab` with `replace: true`
(`GitStatusPage.tsx`). Changes → Comments / Reviews therefore does not
push a history entry, so Back skips the Source Control mode change and
leaves the page or stays put.

Push a history entry when the Source Control mode changes. Back from
Comments or Reviews should restore the previous Source Control mode
(usually Working tree). A deep link that *lands* on `?tab=comments`
should still Back off the Source Control page. Phone commit-detail
`pushState` (`useMobileCommitDetailHistory`) is a separate stack and
must keep working.

## Identity bar

### 12 — Branch opens HEAD

`RepoStatusBar` renders the branch name as inert text plus a copy
control.

Clicking the local branch (e.g. `main`) opens the `HEAD` commit the same
way a focused commit view does — files and diff for `HEAD`, not the
Working tree. `GitStatusInfo.recentCommits[0]` is the current `HEAD` tip
when present; detached `HEAD` still has a tip SHA even when `branch` is
null (copy/click should use the SHA, and the copy control already needs a
non-branch value in that case).

Keep the copy control on the branch name; the name click is navigation,
the icon is copy.

### 13 — Upstream opens incoming commits

The upstream (`→ graehl/main`) is inert text. Clicking it should open a
preview of commits that are on the remote-tracking branch and not in
local `HEAD` (Git *behind*; “ahead on the remote”). Populate it from the
last Check remote / fetch, not from a hidden fetch on click. This
surface does not exist yet.

Do not hide Check remote — the upstream preview reads whatever the last
check observed.

The incoming-commit list is new API if the client cannot derive it from
data it already has. Same compatibility gate as
[2](#2--cache-untracked-listing-without-git-enumeration). Land
[12](#12--branch-opens-head) first.

## Suggested implementation order

Cheap, current contracts: [6](#6--commit-history-affordance),
[3](#3--highlight-and-reveal-the-path-match),
[5](#5--ellipsis-to-the-live-pane-width),
[7](#7--selectable-commit-message),
[10](#10--comments-control),
[11](#11--back-leaves-comments).

Needs a URL or layout-contract edit: [9](#9--title-row-repository-actions),
[12](#12--branch-opens-head),
[8](#8--middle-click-focused-commit-tab).

Needs a new untracked model and likely a capability:
[1](#1--cluster-untracked-files-by-directory) +
[2](#2--cache-untracked-listing-without-git-enumeration), then
[4](#4--apply-search-as-files-are-discovered) against that model.

[13](#13--upstream-opens-incoming-commits) is a new surface; land
[12](#12--branch-opens-head) first.

Found 2026-08-17 while reviewing Source Control Working tree on a large
untracked corpus.
