# Source Control Working tree and Changes design gaps

The Changes / Working tree surface is hard to use once the dirty set is
large and mostly untracked. The items below are the open product and
implementation gaps. Current intended behavior still lives in
[Source Control](../topics/source-control.md); several items would change
that contract (`?rev=` implying history and untracked expansion outside Git
status). Related existing gap:
[Source Control polling visibility](source-control-polling-visibility.md).

Observed 2026-08-17 on a Working tree with 11 898 changed paths, almost all
untracked under `runs/aim/pii-handout-fresh7-…`.

The client-only presentation and navigation tranche is now part of the durable
[Source Control](../topics/source-control.md) contract. This gap retains only
the unfinished inventory/cache work, current-content browser, and commit/branch
navigation that require new contracts or URL semantics.

## Working tree files

### 2 — Cache untracked listing without Git enumeration

Today the client expands every compact `dir/` from `git status` through
`GET /git/untracked-folder`, and each call is `git status --untracked-files=all`
on that directory (`WorkingTreeBrowser` `UNTRACKED_FOLDER_CONCURRENCY = 4`;
server `packages/server/src/routes/git-status.ts`). The presentation groups
returned children, but a large untracked tree still becomes hundreds of Git
processes and loads every child.

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
  requires them; the grouped client presentation is already in place.

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

### 4 — Search unrealized children

The current client reports loaded/total compact-directory progress and applies
the active query to every child received from the existing bounded enumeration.
It reveals matching children without overwriting a group's collapse state.

The remaining gap begins at children the server has not returned. Once
[2](#2--cache-untracked-listing-without-git-enumeration) lands, a non-empty
query must match cached/unrealized children and either reveal the matching
groups or list matching suffixes without forcing every sibling to expand. New
cache arrivals must pass through the same filter before they appear.

## Commit view

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

## Current-content browser

### 14 — Working Tree current contents

Source Control has no focused view of the filesystem's current contents. The
Changes landing shows only dirty tracked paths and untracked paths, while Files
lists only `git ls-files` tracked paths and makes blame its primary detail. A
read-only **Working Tree** browser should include clean tracked files, indexed
new files, and non-ignored untracked files that currently exist. A tracked path
deleted from the filesystem has no current contents and stays in Changes rather
than appearing as an openable file.

Evolve the existing Files surface rather than add a parallel file manager:

- Keep the stable `?tab=files` URL key. The visible mode may become **Working
  Tree** without breaking existing links.
- Use the shared `FileViewer` as the primary current-content detail so this
  surface inherits the same source/preview controls, large-file handling, copy
  behavior, and exact Git projections as session Read links and standalone file
  pages.
- Keep blame as an optional provenance/review projection for tracked files. An
  untracked file remains fully viewable without manufacturing blame state.
- Keep `UnifiedDiff` as the common diff renderer for Source Control and session
  Edit details. Do not create a file/diff viewer hierarchy merely to put both
  projections in this browser; composition is the existing contract.

Do not broaden `GET /git/files`, whose released meaning is tracked files. Add a
new permanent capability and endpoint, tentatively
`git-working-tree-files` and
`GET /api/projects/:projectId/git/working-tree-files`. Without the capability,
a new client retains today's tracked-only Files view and makes no unsupported
request. Before implementation, run the Source Control compatibility review and
obtain approval for the release corpus, endpoint, capability, and fallback.

The first endpoint need not wait for a persistent all-path index. On explicit
entry or refresh, a constant number of bounded Git reads can combine indexed
and non-ignored untracked files and subtract tracked deletions. This inventory
must not join the five-second status poll. Measure it on the motivating 11,898-
path repository before treating it as acceptable, return an honest truncation
state at any safety bound, and keep search local only after the returned corpus
is complete.

The project-path-link cache is not this inventory. It deliberately answers a
few exact existence questions on demand, includes ignored paths when asked, and
has no completion operation. Working Tree needs a complete non-ignored corpus.
The two facilities may later share watcher invalidation signals, but not
completeness or visibility semantics.

## Remaining implementation sequence

### Add the current-content Working Tree view

Implement [14](#14--working-tree-current-contents) in two separable changes:

1. Add the capability-gated server inventory contract and tests for clean
   tracked files, indexed additions, untracked files, ignored files, tracked
   deletions, Unicode paths, bounds, and optional-lock behavior.
2. Adapt the existing Files browser to that inventory and shared `FileViewer`,
   retaining its local path search and an optional tracked-file blame
   projection.

This is the first server-dependent phase and waits for the required
compatibility approval. It writes no project state; any future persistent cache
belongs in the YA data directory under the project-directory-storage contract.

### Settle the all-path cache tradeoffs separately

Leave [2](#2--cache-untracked-listing-without-git-enumeration) and complete
unrealized-child behavior in [4](#4--search-unrealized-children) for a separate
design. It must settle watcher coverage and fallback, process and memory bounds,
persistence, ignored-prefix correctness, and the different
freshness/completeness needs of Source Control versus project-path links.

The URL and identity-bar changes remain separate as well: land
[12](#12--branch-opens-head) before [8](#8--middle-click-focused-commit-tab),
then add [13](#13--upstream-opens-incoming-commits) once its incoming-commit
surface and compatibility contract are approved.

### Verification for each rendered phase

Add focused component/navigation tests, run client focused tests plus root
lint, format check, typecheck, and the applicable CSS/i18n/console checks. For
rendered changes, inspect fresh isolated-server captures at 1000×600 and
375×812 sequentially. The current-content endpoint additionally needs a timed
contrast on the motivating large repository; report inventory time separately
from React rendering and never treat an incomplete corpus as a completed
search.

Found 2026-08-17 while reviewing Source Control Working tree on a large
untracked corpus.
