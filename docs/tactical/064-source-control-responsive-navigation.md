# Source Control Responsive Navigation

Status: implemented and verified.

Topic: source-review-to-session

> **Superseded navigation detail (2026-07-31):** Changes and Commits were
> subsequently folded into one Changes mode. Working tree is now an
> always-present revision and the default even when clean; history opens
> explicitly from that landing. The current contract is
> [`topics/source-control.md`](../../topics/source-control.md). The remainder
> of this document records the earlier responsive repair that supplied the
> shared history drill-in.

## Origin

The commit-history redesign removed the established Changes landing and made a
dirty working tree the first synthetic row inside Commits. Its desktop
three-pane layout remained useful, but the phone layout only collapsed those
columns into one vertical stream. Selecting either the working tree or a
commit therefore rendered its changed files after the complete commit list,
often below "Load more." The tap appeared to do nothing until the user scrolled
through history.

The requested correction is not a working-tree-only reorder. Source Control
must restore current work as its primary landing and give every revision the
same coherent responsive selection behavior.

## Product Contract

### Stable top-level semantics

Every viewport exposes the same ordered modes:

1. Changes
2. Commits
3. Files
4. Comments

Changes is the default when `?tab=` is absent or unknown. The URL values and
meaning of each mode do not vary with viewport width. The Dirty status badge
is an action when the complete source page is available and selects Changes.

### Changes owns the working tree

Changes shows the current HEAD-to-filesystem view:

- a clean repository shows the working-tree-clean state;
- a dirty repository shows one row per changed path, merging staged and
  unstaged layers while labeling staged, unstaged, both, and untracked state;
- selecting a path opens the same diff and review-comment surface already used
  by the synthetic working-tree revision; and
- the working tree no longer appears as a synthetic row in Commits.

On a wide screen, the changed-file list and selected diff are simultaneous
columns. On a phone, the file list is the page body and the selected diff opens
in the existing full-screen, back-gesture-aware viewer.

### Commits is responsive master/detail

Commits contains actual commits only.

- Wide screens retain commit list, selected commit files, and selected diff as
  simultaneous columns.
- Narrow screens initially show only the searchable commit list.
- Selecting any commit replaces that list with the selected commit's changed
  files and an explicit Back to commits control.
- Selecting a file opens the existing full-screen diff viewer.
- Back from the diff returns to the selected commit; Back from the commit
  returns to the same place in the commit list.
- Newer/older revision controls update the focused commit detail without
  exposing a hidden list above or below it.

No selection result may be rendered after the full revision list on a narrow
screen.

### Compatibility scope

This is a client presentation refactor inside the already gated
`git-source-review` surface. It adds no server route, field, event, capability,
or compatibility-floor change. Older capable servers continue to receive the
basic Source Control fallback from tactical 063.

## Acceptance

- Source Control opens on Changes at desktop and phone widths.
- A dirty repository immediately exposes its changed paths without entering
  commit history.
- Commits contains no working-tree pseudo-revision.
- Selecting the first, middle, or last visible commit on a phone immediately
  shows that commit's files in a focused detail view.
- Returning restores the commit list position and selection context.
- A selected mobile file diff closes back to its owning Changes or commit
  detail.
- Desktop keeps simultaneous multipane browsing.
- Final 1920x1080 and 375x812 browser captures are inspected for both Changes
  and the mobile commit-detail transition.

## Non-Goals

- Changing git or review server APIs.
- Making desktop and mobile expose different source concepts or URL meanings.
- Showing working-tree files and commit history as one long mobile document.
- Redesigning the repository-wide Files/blame mode or Comments mode.

## Implementation Results

Completed on 2026-07-27:

- restored Changes as the absent/unknown-URL default and the first mode on
  every viewport;
- moved the merged HEAD-to-filesystem file list and uncommitted review diffs
  into a dedicated Changes body;
- removed the synthetic working-tree row from Commits;
- made a dirty status badge activate Changes;
- made narrow Commits replace its revision list with the selected revision's
  file detail, including an explicit Back to commits control, scroll
  restoration, and browser/Android back-stack integration;
- kept mobile commit messages behind one compact action so changed files
  remain the immediate selection result; and
- retained simultaneous desktop Changes and Commits panes.

Verification:

- focused Source Control tests: 25 passed without runtime warnings;
- full workspace tests: passed;
- `pnpm lint`, `pnpm typecheck`, and `pnpm build`: passed;
- `pnpm capabilities:audit`: 20 capabilities, zero errors and warnings;
- `pnpm console:scan`: no baseline growth (`log` 110/110, `warn` 61/61,
  `error` 95/95);
- `pnpm i18n:scan`: no new warnings (the three established Vite development
  advisories remain); and
- real-browser interaction verified that Back closes file diff → commit files
  → the original 50-row commit list without changing the route or losing list
  position.

Final browser captures:

- `.artifacts/ui-testing/2026-07-27-source-control-responsive-navigation/desktop-changes.png`
  at 1920x1080;
- `.artifacts/ui-testing/2026-07-27-source-control-responsive-navigation/mobile-changes.png`
  at 375x812; and
- `.artifacts/ui-testing/2026-07-27-source-control-responsive-navigation/mobile-commit-files.png`
  at 375x812 after selecting a commit.

Visual inspection confirmed a changed-file-first default, coherent grouping,
an immediately visible mobile selection result and Back control, no hidden
revision list in detail state, and no horizontal overflow at either viewport.
