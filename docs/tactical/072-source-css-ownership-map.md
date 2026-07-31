# Source CSS Ownership Map

Topic: css-architecture

Historical reference map produced by the ownership-mapping work in the closed
[`070-css-modules-migration.md`](070-css-modules-migration.md). Read-only: that
work changed no stylesheet and no component. Its output records the evidence
used for source-control chrome and the provisional boundaries considered at the
time.

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
| `pages/RepoStatusBar.tsx` | 68 | Self-contained except `.copy-button`; `.repo-status-action-group` is `GitStatusPage`'s despite the prefix |
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
| `index.css` 2103 | `.source-header-identity .repo-status-bar.inline` | `GitStatusPage` | `RepoStatusBar` |

`index.css` 2103 was found during step 6, not by this map: it sits in the
session-header region, far outside the two ranges surveyed here. **A component's
reach-ins are not bounded by the region its own rules live in.** Before hashing a
class, search the whole cascade for it rather than trusting a range-scoped table
— steps 7 to 9 should expect the same.

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

Step 6 qualified the last one. The tabs did want a named variant
(`SourceModeTabs` gained `variant="stacked"`), but `copy-button` has exactly one
caller, so `RepoStatusBar` passed its own module class through `CopyButton`'s
existing `className` prop instead — adding a global variant class to a frozen
stylesheet, for a component that step was not migrating, would have cost more
than it bought. Count the callers before choosing.

Those two `copy-button` rules also look redundant and are not: every declaration
matches `renderers.css`'s own `.copy-button`, but `index.css:17971` declares a
second, unrelated `.copy-button`, and `renderers.css` is `@import`ed at the top
of `index.css`, so the `index.css` rule wins for every `CopyButton` in the app.
The descendant selector was restoring the compact presentation, and its
replacement needs the same two-class specificity.

## Dead rules found

Verified against every producer including dynamic construction and the
non-client packages. Not removed by this step — step 5 of the campaign removed
them all on 2026-07-31 after re-verifying each one. Kept here as the record of
what was deleted and why.

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

## Historical candidate boundaries

This map established that boundaries must follow components, not line ranges.
The remaining candidates below are not scheduled and carry no current
priority. Run `pnpm css:inventory` and follow the topic's selection protocol
before choosing new migration work.

**Delete the dead git-status rules** (landed 2026-07-31). The 184 + 24
attributed lines above became a behavior-free 222 + 25 raw-line ratchet.

**Source-control chrome** (landed 2026-07-31). `RepoStatusBar`,
`SourceModeTabs`, and `SourceContextMenu` proved all three mapped reach-in
shapes. The change removed 264 raw lines from `renderers.css`.

**Review UI** (provisional). `ReviewSubmitModal`, `ReviewCommentWindow`, and
`ReviewCommentsPanel` were estimated at roughly 230 lines with two shared
selectors. This is ownership evidence, not a recommendation to take it next.

**Blame view** (provisional). `BlameView` was attributed 162 lines but has a
placement reach-in and shares `source-search-*` with `CommitRevisionPane`.

**File viewer** (provisional). `FileViewer` was attributed 215 lines, while a
190-line bare-element/generated-markup boundary and five consumers made the
full surface less approachable.

## Tooling caveats resolved at campaign closeout

Three correctness problems found while building this map were fixed before the
campaign closed:

1. Source discovery now scans every `packages/*/src` tree, so shared/server
   generated vocabulary participates without compiled bundles being read back
   in.
2. TypeScript string tokens replace bare-word source matching, so `.foo` is not
   kept alive merely by `.foo-bar`.
3. A CSS parser supplies real rules and source positions, so prose such as
   `index.css` inside a block comment cannot become a phantom `.css` selector.

The same parser-backed facts feed `pnpm css:inventory`, the current entry point
for candidate selection. Both reports remain advisory and require human review
at coupled, generated, and dynamic boundaries.
