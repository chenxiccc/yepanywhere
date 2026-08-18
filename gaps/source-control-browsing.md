# Source Control browsing conflates refresh, grouping, and comparison projections

Source Control remains difficult to browse in an active or path-dense project.
These observations need one design pass before implementation because they cross
Working Tree, the Working tree revision inside Changes, commit-file lists, and
the selected-revision comparison contract. The durable current behavior is in
[Source Control](../topics/source-control.md). Related independent defects remain
in [polling visibility](source-control-polling-visibility.md) and the
[Preview selection race](source-control-preview-view-race.md).

## Background status refresh removes the browser

`useGitStatus` polls status and the retained untracked listing every five
seconds while the page is visible. In an active project, a file change can make
the Source Control file browser disappear for roughly four seconds on each
refresh. The page is therefore effectively unbrowsable while another process is
writing regularly, even though the previously returned corpus and selected file
remain useful.

A background refresh must preserve the current list, selection, detail, scroll,
and disclosure state until replacement data is ready. It may show a compact
refreshing or stale indicator; it must not replace the workbench with an empty
or loading state. The five-second status cadence must not imply a five-second
current-content inventory reload. Prefer activity-driven invalidation with
coalescing plus an explicit or slower safety refresh, while retaining the
visibility/lifecycle proof required by the related polling gap.

## Factor path prefixes before truncating

File rows currently ellipsize the complete path, while only compact untracked
folders receive an outline heading. On a narrow row this spends width repeating
a parent path and then shows `…`, even when moving that parent into a heading
would leave the distinguishing suffix readable.

Grouping must be available in Working Tree, the Working tree revision inside
Changes, and committed-revision file lists. Factor the longest useful shared
parent prefix into an outline heading before allowing any child path to
ellipsize. The row keeps the canonical full-path tooltip, copy identity, menu
actions, and accessibility name. A path whose measured row would truncate can
create a one-child outline group: grouping is also path compression, not only a
many-child collapse optimization.

Grouping happens independently inside semantic sections; a group never crosses
a section divider. Initial disclosure should use the available list height:
pre-expand small groups while their children fit, then leave later or larger
groups collapsed. Resizing or refreshing must not overwrite a user's subsequent
disclosure choices. An expanded group remains useful because its children omit
the heading prefix.

## Separate tracked diffs from untracked contents

The Working tree revision inside the diff-focused Changes browser mixes tracked
changes and untracked files in one flat list. A tracked row opens a
HEAD-to-filesystem diff, while an untracked row is necessarily current content,
so adjacent rows silently change the detail projection.

Partition before outline grouping:

1. tracked staged/unstaged changes above a divider, opening diffs;
2. untracked files below it, opening current contents; and
3. in the full Working Tree browser only, tracked unchanged files after its
   existing divider, also opening current contents.

Each section is separately grouping-eligible. The same grouping utility and
path recovery rules should serve both Source Control routes rather than leaving
outline behavior exclusive to compact untracked folders.

A collapsed group summarizes every status kind it contains. Do not label a
mixed `A` + `M` group only `M`, because `M` already means Modified. A fixed-width
composite badge such as diagonally divided `A/M` can preserve row geometry; its
tooltip and accessible label enumerate the statuses and counts. If the design
cannot keep the composite legible at row size, show adjacent ordinary badges
rather than discard a kind.

## “To HEAD” excludes the selected commit instead of squashing through HEAD

The toolbar's **To HEAD** currently asks the server for a direct selected-tree
to current-`HEAD` diff. That necessarily removes files added by the selected
commit from the list: they already exist in the comparison base. This is not the
intended review projection.

The toolbar action should show the selected commit and every later commit as if
that inclusive range were squashed onto the selected commit's first parent:

- ordinary commit: `selected^1 .. pinned HEAD`;
- root commit: the empty tree .. pinned HEAD;
- list and per-file diff requests use the same resolved base and pinned tip.

This inclusive projection retains additions from the selected commit and later
commits and reports each path's net status over the whole reviewed range. Add a
fixture with files added in the selected commit and in a later commit; the user
also observed the latter missing from the current list.

A direct selected-tree-to-HEAD comparison is still useful, but it is a different
question. Keep it as an optional selected-file context-menu action or a clearly
labelled selector in the right-hand diff toolbar rather than assigning those
semantics to the range-level **To HEAD** control.

Found 2026-08-18 while reviewing Source Control in active, path-dense projects.
