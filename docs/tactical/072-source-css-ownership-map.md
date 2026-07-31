# Source CSS Ownership Map

Topic: css-architecture

Reference map produced by the ownership-mapping step (step 4) of
[`070-css-modules-migration.md`](070-css-modules-migration.md). Read-only: that
step changed no stylesheet and no component. Its output is the ownership record
the source-control chrome, review UI, and file viewer steps work against.

The binding rules live in
[`topics/css-architecture.md`](../../topics/css-architecture.md). This document
is evidence, not policy.

## Method

For every class selector in the mapped regions:

1. the **subject** of each rule (its rightmost compound) was resolved to the
   file that emits that class, searching `packages/client/src` for the class as
   a whole token in a string, template, or `className` expression;
2. dynamic construction (`` `git-status-${status.toLowerCase()}` ``,
   `` `source-pane-splitter-${boundary}` ``, `` `worktree-file-state-${state}` ``)
   was resolved by reading the constructing expression, not by matching the
   literal;
3. producers outside the client package (`packages/shared`, `packages/server`)
   were searched separately, because generated markup is the reason a class is
   legitimately global; and
4. rule bodies were attributed line-for-line, descending into `@media` blocks
   rather than charging a media query to a single bucket.

Counts below are attributed declaration lines, so they under-count each region's
total by the blank lines and comments between rules.

## Headline: source control is not one region

The campaign assumed a single mixed region of roughly 2,078 lines in
`renderers.css`. That is accurate for what `renderers.css` holds, but the
source-control feature's CSS is split across **two** legacy stylesheets:

| Feature area | Stylesheet | Lines | Attributed |
|---|---|---:|---:|
| File viewer / file page | `renderers.css` 5177–6253 | 1,077 | 912 |
| Source review | `renderers.css` 6254–6523 | 270 | 224 |
| Source control (Stage-3 browsers) | `renderers.css` 6524–7834 | 1,311 | 1,121 |
| Blame | `renderers.css` 7835–8331 | 497 | 425 |
| Source control (Git Status Page) | `index.css` 19759–20557 | 799 | — |
| **Total** | | **3,954** | |

`renderers.css` holds the Stage-3 browser shells (commit browser, working-tree
browser, blame browser, pane splitter, detail banners). `index.css` holds the
older Git Status Page vocabulary that predates them. `GitStatusPage.tsx`,
`GitStatusDiffPreview.tsx`, `CommitBrowser.tsx`, `WorkingTreeBrowser.tsx`,
`CommitFilesPane.tsx`, and `SourceFileRow.tsx` each have rules in both files.

**Consequence for every extraction step below:** one defined as "extract a range
of `renderers.css`" would leave the same components half-owned. Slice by
component, then take every rule that component owns from both stylesheets in the
same change.

## Generated vocabulary — stays global

These classes are emitted outside the owning React component and reach the DOM
through `dangerouslySetInnerHTML`. They cannot move into a module and are not
candidates for any extraction step.

| Classes | Producer | Client interop boundary |
|---|---|---|
| `line`, `line-hunk`, `line-deleted`, `line-inserted`, `diff-prefix`, `diff-word-added`, `diff-word-removed` | `server/src/augments/edit-augments.ts` | `EditRenderer`, `GitStatusDiffPreview`, `SideBySideDiff` |
| `shiki`, `shiki ansi-block`, `language-diff`, `language-ansi` | `server/src/augments/augment-generator.ts` | `FileViewer`, `ReadRenderer`, `WriteRenderer`, `ExitPlanModeRenderer` |
| `markdown-rendered`, `markdown-preview-span`, `markdown-preview-span-start`, `markdown-preview-line-boundary{,-start,-end}` | `server/src/augments/safe-markdown.ts`, `markdown-file-preview.ts` | `MarkdownPreview`, `TextBlock` |
| `ansi-fg-*`, `ansi-bg-*`, `ansi-bold`, `ansi-italic`, `ansi-underline`, `ansi-strikethrough`, `ansi-inverse` (36 classes) | `shared/src/ansi-renderer.ts` | `AnsiText`, `BashRenderer`, `BashOutputRenderer` |
| `file-link` | `shared/src/filePathDetection.ts` | `TextBlock`, `FixedFontMathToggle` |
| `local-media-*`, `document-actions*`, `has-line-target-arrival` | `server/src/routes/local-file.ts`, `augment-generator.ts` | `LocalMediaModal`, `TextBlock` |
| `katex-error`, `yepkatex-*` | `server/src/augments/safe-markdown.ts` (KaTeX) | third-party |

The wrappers around this markup are **not** generated and are ordinary component
property: `highlighted-diff`, `diff-content`, `diff-modal-content`,
`shiki-container`, `file-viewer-code`, `blame-run`, `sbs-cell`. Each is written
by a React component that then injects generated children. In module terms these
become a local root with a `:global(...)` descendant, exactly the narrow interop
form the topic already sanctions.

`fixed-font-rendered-line`, `fixed-font-rendered__content`, and
`fixed-font-diff-gutter` are the ambiguous case: the HTML string is built in
`components/ui/FixedFontMathToggle.tsx`, which is client code but emits raw
markup consumed by five renderers. Treat it as a client-owned generated
vocabulary — global, but with a single documented producer.

## Owner inventory

### Source review — `renderers.css` 6254–6523

| Owner | Attributed | Notes |
|---|---:|---|
| `pages/ReviewSubmitModal.tsx` | 82 | Self-contained; `review-submit-*` |
| `pages/ReviewCommentWindow.tsx` | 67 | Self-contained; `review-comment-window-*` |
| `pages/SideBySideDiff.tsx` | 22 | `sbs-*` shell around generated cells |
| `ReviewCommentsPanel` + `ReviewSubmitModal` | 13 | `review-submit-go`, `review-submit-error` shared by two owners |
| `<generated>` | 23 | `.highlighted-diff .line`, `.shiki` |
| `pages/GitStatusPage.tsx` | 3 | `.review-tray-button` base rule, sits in this section |

Cleanest region in the campaign. Two of the three owners have no cross-owner
reach-in at all.

### Source control — `renderers.css` 6524–7834

| Owner | Attributed | Notes |
|---|---:|---|
| `pages/CommitRevisionPane.tsx` | 99 | `commit-list*`, `commit-meta`, `commit-hash` |
| `pages/GitStatusDiffPreview.tsx` | 96 | Diff pane toolbar, hunk navigation |
| `pages/ReviewCommentsPanel.tsx` | 80 | Self-contained `review-comments-*` |
| `pages/CommitBrowser.tsx` | 74 | Columns, jump controls, message view |
| `pages/RepoStatusBar.tsx` | 68 | Self-contained except `.copy-button` |
| `components/ResizableSourceColumns.tsx` | 61 | Splitter; dynamic boundary suffix |
| `pages/WorkingTreeBrowser.tsx` | 58 | Plus 57 shared with `CommitFilesPane` |
| `components/SourceContextMenu.tsx` | 54 | Row menu trigger + overlay |
| `pages/SourceModeTabs.tsx` | 47 | Tabs; overridden by `GitStatusPage` |
| `SourceFileHeaderActions` + `ChangesetFileFilter` + `CommitFilesPane` + `BlameView` | 32 | `source-detail-icon-action`, `source-detail-action` — a genuine shared primitive |
| `pages/GitStatusPage.tsx` | 28 | Toolbar and action row |
| `pages/DiffCommentLayer.tsx` | 24 | `source-diff-line-menu-trigger` |
| `components/ChangesetFileFilter.tsx` | 23 | Self-contained |
| `pages/CommitHistoryParentLink.tsx` | 19 | Self-contained |
| `<generated>` | 59 | Diff lines, hunks, prefixes |
| `<element-or-attr>` | 65 | Bare `button`/`span`/`[data-*]` under a scoped parent |
| `<shared/ambiguous>` | 58 | `active`, `selected`, `inline`, `copied` used by 5+ files |

### Blame — `renderers.css` 7835–8331

| Owner | Attributed | Notes |
|---|---:|---|
| `pages/BlameView.tsx` | 162 | Largest single-owner block in the campaign |
| `components/SourceShortcutHelp.tsx` | 54 | Self-contained popover |
| `CommitRevisionPane` + `BlameBrowser` | 44 | `source-search-*` shared search field |
| `pages/BlameBrowser.tsx` | 41 | Columns and file list |
| `pages/CommitRevisionPane.tsx` | 27 | Commit rows reused in the blame column |

### Source control — `index.css` 19759–20557

87 distinct classes. Live owners:

| Owner | Classes | Notes |
|---|---:|---|
| `pages/GitStatusPage.tsx` | 17 | Action buttons, integration options, notices |
| `pages/GitStatusDiffPreview.tsx` | 9 | Placeholder, skipped-diff panel, context buttons |
| `CommitBrowser` + `GitStatusDiffPreview` | 3 | `git-diff-preview-pane/-title/-body` |
| `WorkingTreeBrowser` + `CommitFilesPane` | 3 | `git-line-counts`, `git-lines-added/-deleted` |
| `components/SourceFileRow.tsx` | 2 | `git-status-badge`, `git-file-path` |
| `pages/WorkingTreeBrowser.tsx` | 3 | `working-tree-clean-*` |
| `layouts/MainContent.tsx` | 1 | `main-content-constrained` |

`git-status-badge` and `git-file-path` also have rules in `renderers.css`
(8247–8248) — `SourceFileRow` is the clearest example of the two-stylesheet
split.

### File viewer — `renderers.css` 5177–6253

| Owner | Attributed | Notes |
|---|---:|---|
| `components/FileViewer.tsx` | 215 | Plus 30–35 shared with the read/write renderers |
| `components/FilePathLink.tsx` | 67 | Link, modal sizing |
| `components/MarkdownPreview.tsx` | 54 | Density controls, preview toggle |
| `EditRenderer` + `GitStatusDiffPreview` | 41 | `diff-modal-content`, context controls |
| `PublicShareFilePage` + `FilePage` | 36 | Page chrome |
| `components/FileResourceActions.tsx` | 21 | Context overlay |
| `<element-or-attr>` | 190 | `pre`/`code`/`[data-*]` typography under scoped parents |
| `<generated>` | 73 | Shiki, markdown preview spans |

The 190-line bare-element bucket is why the file viewer stays a candidate rather
than a scheduled step: those rules depend on being inside a scoped parent, and
each needs its parent's ownership settled before it can move.

## Cross-owner reach-ins

The source-control chrome and review UI steps must convert these to props,
wrappers, or shared primitives before the target class is hashed. This is the
complete list for
`renderers.css` 6254–8331 and `index.css` 19759–20557.

| Line | Selector | Ancestor owner | Target owner |
|---:|---|---|---|
| 6261 | `.diff-content > .has-review-comment` | `EditRenderer`, `GitStatusDiffPreview` | `useDiffLineInteractions`, `BlameView` |
| 6607 | `.diff-gutter-aligned .fixed-font-rendered-line` | `EditRenderer`, `GitStatusDiffPreview` | `FixedFontMathToggle` (generated) |
| 6844 | `.repo-status-bar .copy-button` | `RepoStatusBar` | `CopyButton` |
| 6850 | `.repo-status-bar .copy-button:hover` | `RepoStatusBar` | `CopyButton` |
| 6931 | `.source-control-mobile-tabs .source-mode-tabs` | `GitStatusPage` | `SourceModeTabs` |
| 6939 | `.source-control-mobile-tabs .source-mode-tab` | `GitStatusPage` | `SourceModeTabs` |
| 6945 | `.source-control-mobile-tabs .source-mode-tab-count` | `GitStatusPage` | `SourceModeTabs` |
| 7207 | `.commit-browser-columns .working-tree-history-clean` | `CommitBrowser` | `WorkingTreeBrowser` |
| 7328 | `.commit-list-row:hover > .source-row-menu-trigger` | `CommitRevisionPane` | `SourceContextMenu` |
| 7329 | `.commit-file-row:hover > .source-row-menu-trigger` | `BlameBrowser`, `WorkingTreeBrowser`, `CommitFilesPane` | `SourceContextMenu` |
| 7330 | `.commit-list-row:focus-within > .source-row-menu-trigger` | `CommitRevisionPane` | `SourceContextMenu` |
| 7331 | `.commit-file-row:focus-within > .source-row-menu-trigger` | `BlameBrowser`, `WorkingTreeBrowser`, `CommitFilesPane` | `SourceContextMenu` |
| 7859 | `.blame-browser-columns > .blame-view` | `BlameBrowser` | `BlameView` |
| 8247 | `.commit-file-item .git-file-path` | `WorkingTreeBrowser`, `CommitFilesPane` | `SourceFileRow` |
| 8248 | `.blame-file-item .git-file-path` | `BlameBrowser` | `SourceFileRow` |
| 8289 | `.source-detail-banner .source-detail-jump` | `WorkingTreeBrowser`, `CommitFilesPane` | `CommitBrowser` |
| `index.css` 20545 | `.source-control-main-content .git-diff-preview-pane` | `GitStatusPage` | `CommitBrowser`, `GitStatusDiffPreview` |

Three shapes, three fixes, matching the classification the `FilterDropdown`
step established:

- **Hover/focus reveal** (7328–7331) — four rules, one need. `SourceContextMenu`
  should own a `revealOnRowInteraction` behavior rather than have four different
  row owners reach in. The row supplies the hover surface; the menu supplies the
  reveal.
- **Layout placement** (7207, 7859, 8289, `index.css` 20545) — the ancestor is
  placing a child it renders. A `className` pass-through on the child is the
  cheapest correct fix.
- **Restyling a shared control** (6844/6850 `copy-button`, 6931–6945 tabs,
  8247/8248 `git-file-path`) — a named variant on the child, because more than
  one caller wants the same presentation.

## Dead rules found

Verified against every producer including dynamic construction and the
non-client packages. Not removed by this step; step 5 of the campaign exists to
bank them.

**`index.css` — 184 lines, 33 rules.** The pre-Stage-3 working-tree UI, replaced
by `WorkingTreeBrowser` and `SourceFileRow`:

`git-status-branch` 19773, `git-branch-icon` 19785, `git-branch-name` 19791,
`git-upstream` 19796, `git-ahead-behind` 19801, `git-clean-badge` 19807,
`git-clean` 19817, `git-dirty` 19822, `git-remote-check-time` 19827,
`git-status-actions` 19833, `git-status-workspace` 20096 (and its
`@media (min-width: 1100px)` rule at 20553), `git-status-left-pane` 20102,
`git-status-file-pane` 20109, `git-file-section` 20174, `git-file-section-title`
20184, `git-file-count` 20194, `git-file-list` 20198, `git-file-list-row` 20206,
`git-file-item` 20211 (+ 4 state rules), `git-file-item-selected` 20247,
`git-untracked-folder-*` 20383–20429.

**`renderers.css` — 4 rules, ~24 lines.** `repo-status-name` 6854,
`commit-jump` 7720, `commit-jump-current` 7754, `blame-file-more` 8019.

Together that is enough to ratchet `index.css` by 184 and `renderers.css` by 24
with no behavior change at all.

Not dead, despite looking dead to a literal search: `git-status-m/a/d/r/u/t/?`
(built by `SourceFileRow` as `` `git-status-${status.toLowerCase()}` ``),
`git-status-action-success/-warning` and `git-status-action-message-success/-warning`
(built by `GitStatusPage` from a tone variable), `source-pane-splitter-revisions`
and `source-pane-splitter-files` (built by `ResizableSourceColumns` from a
boundary variable), `worktree-file-state-*` (built by `WorkingTreeBrowser`).

## Recommended step boundaries

This map's conclusion is that the campaign's original targets are right but
their boundaries should follow components, not line ranges. These fed the step
list in [`070-css-modules-migration.md`](070-css-modules-migration.md#steps);
that document is where status and order now live.

**Delete the dead git-status rules** (step 5). The 184 + 24 lines above are a
behavior-free ratchet with no composition work. Worth landing alone, since the
source-control chrome step below cannot honestly claim most of them.

**Source-control chrome** (step 6). `RepoStatusBar` (68 lines, 82-line
component), `SourceModeTabs` (47), and `SourceContextMenu` (54). All three are
small, self-contained, and sit behind the three reach-in shapes above, so the
step proves each fix once. Fold in the `.copy-button` variant and the
`source-mode-tab` overrides. Expected ratchet: ~170 lines.

**Review UI** (step 7). `ReviewSubmitModal` (82), `ReviewCommentWindow` (67),
`ReviewCommentsPanel` (80). The cleanest region: only `review-submit-go` and
`review-submit-error` are shared, and only between two owners that can share a
module. Expected ratchet: ~230 lines.

**Blame view** (step 8). `BlameView` is the single largest owner (162 lines) and
would otherwise be an attractive early target, but it is also the target of the
`blame-browser-columns > .blame-view` placement reach-in and shares
`source-search-*` with `CommitRevisionPane`. Take it after the source-control
chrome step has established the placement-prop pattern.

**File viewer** (step 9). Still a candidate. `FileViewer` owns 215 attributed
lines but the 190-line bare-element bucket beneath it needs parent ownership
resolved first, and `FileViewer` is shared by `FilePage`,
`PublicShareFilePage`, `FilePathLink`'s modal, and two tool renderers.

## Tooling caveats found

Two limits in `scripts/find-unused-css.ts` surfaced while building this map.
Both cause **false "used"** or **false "unused"** verdicts in exactly this
region, so they matter before anyone acts on the report.

1. **Source scope is `packages/client/src`.** Generated vocabulary produced in
   `packages/shared` is invisible. 36 of the 44 classes the analyzer reports as
   unused in `renderers.css` are the ANSI vocabulary from
   `shared/src/ansi-renderer.ts`, and `file-link` is produced by
   `shared/src/filePathDetection.ts`. The report is not currently safe to act on
   as a standalone sweep.
2. **Bare-word matching over-reports usage.** `\bfile-link\b` matches inside
   `file-link-button`, and `\bcommit-jump\b` matches inside `commit-jump-btn`,
   so both dead rules are reported as used. This is the same weakness noted for
   `new-session-helper-model` when the analyzer learned about modules.

Fixing (1) is a scope change; fixing (2) needs the word boundary to reject a
following `-`. Neither blocks any extraction step; both are tracked as step 10.
