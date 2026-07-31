# CSS Modules Migration

Topic: css-architecture

Status: the guard is live and four steps have landed — the stylesheets are
frozen, the unused-CSS report understands modules, the filter dropdown proved
the composition patterns, and source-control CSS ownership is mapped. The dead
git-status rules (step 5) and the source-control chrome (step 6) are next.

## Contract

The binding ownership rules and migration runbook live in
[`topics/css-architecture.md`](../../topics/css-architecture.md). Read that
topic before implementing a step.

This document is the campaign tracker: baseline, step order, landing evidence,
and handoff notes. If this tactical and the topic disagree, the topic wins and
this document should be corrected.

## Goal

Turn CSS Modules into the ordinary path for client feature work while shrinking
the legacy global cascade through reviewable, behavior-preserving steps.

The campaign is successful when:

- CSS-aware tooling understands module imports and references;
- a shared, portal-using component proves the composition patterns;
- at least one mixed renderer/page area cleanly separates generated global
  vocabulary from React-owned module styles;
- the high-value extraction inventory has durable ownership notes; and
- subsequent feature work can follow the topic runbook without keeping this
  tactical open.

The goal is not zero global CSS or an arbitrary line-count milestone. Themes,
tokens, base rules, third-party CSS, and generated markup retain legitimate
global responsibilities.

## Non-Goals

- No big-bang rewrite of `index.css` or `renderers.css`.
- No visual redesign hidden inside a selector move.
- No runtime CSS-in-JS library.
- No Tailwind, Sass, CSS framework, or class-name helper dependency.
- No route/code-splitting project. CSS Modules improve ownership first; bundle
  splitting is a separate performance decision.
- No broad renaming or reformatting of untouched legacy selectors.

## Baseline

Containment landed on 2026-07-31 in `07e40ef1`. Current legacy ceilings:

| Stylesheet | Maximum lines | Primary remaining ownership |
|---|---:|---|
| `index.css` | 21,092 (was 21,441 before step 1) | Tokens/themes/base plus legacy pages and components |
| `renderers.css` | 8,331 | Generated markup plus legacy renderer/page shells |
| `tool-rows.css` | 948 | Shared tool-row composition and states |
| `emulator.css` | 261 | Emulator streaming surface and global states |

The machine-readable source of truth is
`scripts/css-architecture-baseline.json`. Update this table when a step changes
a ceiling, but never use the table instead of the enforced baseline.

## Steps

Numbered in recommended order. A number is a reference handle, not a priority
score — the ordering rationale is in each step.

| # | Step | Status |
|---:|---|---|
| 1 | [Freeze the legacy stylesheets](#1--freeze-the-legacy-stylesheets) | Landed 2026-07-31, `07e40ef1` |
| 2 | [Teach the unused-CSS report about modules](#2--teach-the-unused-css-report-about-modules) | Landed 2026-07-31, `cb389318` |
| 3 | [Filter dropdown](#3--filter-dropdown) | Landed 2026-07-31, `d800d19e` |
| 4 | [Map source-control CSS ownership](#4--map-source-control-css-ownership) | Landed 2026-07-31, `5f9fddc7` |
| 5 | [Delete the dead git-status rules](#5--delete-the-dead-git-status-rules) | Ready |
| 6 | [Source-control chrome](#6--source-control-chrome) | Next |
| 7 | [Review UI](#7--review-ui) | Planned |
| 8 | [Blame view](#8--blame-view) | Planned |
| 9 | [File viewer](#9--file-viewer) | Candidate |
| 10 | [Fix the unused-CSS report's scope](#10--fix-the-unused-css-reports-scope) | Later |
| — | [Extract while you're already in the file](#extract-while-youre-already-in-the-file) | Ongoing |

---

### 1 — Freeze the legacy stylesheets

**Landed 2026-07-31, `07e40ef1`.** Established the guard and proved Vite-native
CSS Modules with three different ownership shapes:

- `Toast.module.css` — an ordinary shared component with a local animation;
- `HostOfflineModal.module.css` — a component with a narrow global-shell
  interop selector; and
- `KillShellRenderer.module.css` — a React-owned tool renderer extracted from
  `renderers.css`.

- **Ratchet:** `index.css` −187, `renderers.css` −46.
- **Guard:** `pnpm css:check` became part of `pnpm lint`. A temporary
  unreviewed global stylesheet was fault-injected and correctly rejected.
- **Checks:** full typecheck, 2,735 client tests. The mounted Toast was
  inspected at 1920×1080 and 375×812.

### 2 — Teach the unused-CSS report about modules

**Landed 2026-07-31, `cb389318`.** Tooling only; no stylesheet or component
changed. This came first because the existing report actively lied once modules
existed, and every later step wants to trust it.

- **Fixed:** classes were deduplicated by name across every file, so
  `KillShellRenderer.module.css` `.error`/`.message` and `index.css`
  `.error`/`.message` collapsed into one entry and whichever file was walked
  first hid the other. Usage then fell back to a bare `/\bfoo\b/` search across
  940 source files, so a module `.container` counted as used because the word
  appeared anywhere in the client.
- **Namespaces separated:** global stylesheets keep one document-wide namespace
  and the original string-search plus dynamic-prefix analysis. Module selectors
  resolve per file through the binding their importer gives them —
  `styles.foo`, `styles?.foo`, `styles["foo"]` — plus `composes` (local,
  `from "./Other.module.css"`, and `from global`).
- **Unknown, not unused:** a computed key (`styles[toast.type]`), a
  side-effect-only import, and a module nothing imports all mark the module
  undetermined instead of reporting its selectors unused. A module reached only
  through `composes ... from` is still judged, since the composing module is a
  real consumer.
- **Interop:** `:global(.foo)` inside a module is a reference, not a
  declaration. It no longer appears as a module-owned selector and now counts
  as usage of the global class.
- **Removal:** `--remove`/`--dry-run` still operate on global stylesheets only
  and print what module selectors they left in place.
- **Command:** `pnpm css:unused` (root). Not wired into `pnpm lint`; the report
  is advisory and currently exits non-zero on 95 pre-existing global findings.
- **Real-tree effect:** global namespace 2,639 → 2,627 classes (12 names were
  module-only), unused globals unchanged at 95, and `Toast.module.css` is
  correctly reported undetermined because its variant classes are reached via
  `styles[toast.type]`.
- **Tests:** `packages/client/scripts/find-unused-css.test.ts`, 17 focused
  cases over `scripts/fixtures/find-unused-css/`; full client suite 2,752
  passed, no warnings.
- **Checks:** `pnpm lint`, `pnpm typecheck`, `pnpm css:check` (ceilings
  unchanged, as expected for a tooling step). No visual QA: nothing rendered
  changed.
- **Known limits left in place:** the analyzer understands `:global(...)` but
  not `:global {}` blocks, and treats any non-accessor use of a module binding
  as unknown. Both are conservative. Step 10 covers the two limits that are
  *not* conservative.

### 3 — Filter dropdown

**Landed 2026-07-31, `d800d19e`.** `FilterDropdown` was chosen over a
mechanical leaf precisely because it was hard: a portaled mobile sheet, a
desktop panel, roughly 360 lines in `index.css`, and five caller sites reaching
into `.filter-dropdown-button`, `.filter-dropdown-container`, and the chevron.
It is the reference for the composition rules in the topic.

- **Moved:** the whole `FilterDropdown` vocabulary — container, trigger, label,
  chevron, overlay, sheet, header, options, option states, checkbox, color dot,
  meta, count, divider, group label, desktop dropdown, both keyframes, and the
  desktop and narrow media queries — from `index.css` to
  `components/FilterDropdown.module.css`.
- **Stayed global:** `.filter-dropdowns` (a `GlobalSessionsPage` wrapper);
  `.status-filter-placeholder` and `.status-filter-icon*` (rendered by
  `GlobalSessionsPage` as `placeholderContent`); `.subscription-usage-badge*`
  (rendered by `ModelSubscriptionUsage` as option `meta`); and
  `.filter-clear-button`. All are owned by callers that are still legacy pages,
  and each was previously grouped into a selector shared with the component.
- **Composition decisions:** every caller reach-in became an explicit prop.
  `fullWidth` replaces seven `<section> .filter-dropdown-container/-button
  { width: 100% }` overrides in Settings and New Session.
  `triggerVariant="chip"` replaces
  `.composer-model-chip .filter-dropdown-button/-chevron`.
  `panelVariant="model"` replaces `.model-filter-dropdown ...`, which had to
  become a prop because hashed child classes are unreachable from a caller.
  `triggerClassName` is the deliberate caller-supplied class hook; Global
  Sessions uses it for the status/provider trigger widths, which stay in
  `index.css` scoped under `.filter-dropdowns` so they keep the specificity
  that previously let them win over the component's narrow-width rule.
- **Stale coupling removed:** `.new-session-speech-field` and
  `.new-session-helper-model` reach-ins (including a `@media (min-width: 760px)`
  rule) targeted wrappers that no longer exist in any TSX — step 2's report
  flagged the first one. The emitted-but-unstyled `clear-selection` class was
  dropped; it had no rule and no consumer.
- **Behavior note:** the narrow-width rules were unscoped selectors sitting
  inside the sessions filter-bar `@media (max-width: 600px)` block, so they
  applied to every FilterDropdown in the app. They moved into the module as
  component-owned responsive rules, preserving that reach.
- **Ratchet:** `index.css` 21,441 → 21,092 (−349); `renderers.css` unchanged.
- **Tests:** `FilterDropdown.test.tsx` 2 → 11 cases, adding open/close, Escape,
  click-outside, single-select, multi-select with clear-all, right alignment,
  portal sheet at 375px width, `fullWidth`, and `triggerClassName`; consumers
  in `NewSessionForm`, `InboxContent`, and `GlobalSessionsPage` pass unchanged
  (64 focused). Full client suite 2,761 passed, no warnings.
- **Checks:** `pnpm css:check --record` (index.css only), lint, typecheck.
- **Visual QA:** before/after captures at 1920×1080 and 375×812 over
  `/sessions`, `/settings/model`, and `/new-session`, closed and open. Trigger
  geometry — x, y, width, height, padding, min-width, justify-content, border,
  background for all nine live triggers — is byte-identical before and after.
  The mobile bottom sheet and the desktop model panel are pixel-identical
  (0 differing pixels); the only pixel deltas anywhere were live session-list
  content and 23 antialiased corner pixels that geometry proves are not a
  layout change.
- **Follow-up:** `GlobalSessionsPage`, `NewSessionForm`, and the settings panes
  are now the owners of the last filter-bar globals; whichever is migrated next
  can absorb them.

### 4 — Map source-control CSS ownership

**Landed 2026-07-31, `5f9fddc7`.** Read-only; no stylesheet, component, or test
changed. Output is
[`072-source-css-ownership-map.md`](072-source-css-ownership-map.md).

- **Corrected the campaign's premise:** the mixed region is not 2,078 lines in
  one file. Source control's CSS is split across two legacy stylesheets —
  `renderers.css` 6524–7834 holds the Stage-3 browser shells, `index.css`
  19759–20557 holds the older Git Status Page vocabulary. Six components own
  rules in both. Slicing by line range would leave them half-owned, so every
  source-control step below is defined by component and takes both files in one
  change. Mapped total across file viewer, source review, source control, and
  blame: 3,954 lines.
- **Reach-ins enumerated:** 17 cross-owner descendant selectors, reducible to
  three shapes — hover/focus reveal (four rules, one need), layout placement
  (fixed by a `className` pass-through), and restyling a shared control (fixed
  by a named variant). Same three-way classification the filter dropdown
  established in step 3.
- **Dead rules verified:** 184 lines across 33 `index.css` rules — the
  pre-Stage-3 working-tree UI replaced by `WorkingTreeBrowser`/`SourceFileRow` —
  plus 4 rules in `renderers.css`. Verified against dynamic construction and
  the non-client packages, not just literal search. Step 5 exists to bank
  these.
- **Rejected as dead on first pass, then cleared:** `git-status-m/a/d/r/u/t/?`,
  `git-status-action-{success,warning}`,
  `source-pane-splitter-{revisions,files}`, and `worktree-file-state-*` are all
  built from a variable. A literal search finds no producer for any of them.
- **Two analyzer defects found:** see step 10.

---

### 5 — Delete the dead git-status rules

**Ready. No behavior change, no composition work, no visual QA.** Step 4
verified 184 lines across 33 `index.css` rules plus 4 rules (~24 lines) in
`renderers.css` as dead, against every producer including dynamic construction
and the non-client packages. The exact list is in
[the map's dead-rules section](072-source-css-ownership-map.md#dead-rules-found).

Worth landing on its own rather than folding into step 6: those rules belong to
the pre-Stage-3 working-tree UI, not to step 6's three components, so step 6
cannot honestly claim most of the ratchet. Keeping them separate also keeps
step 6's diff purely about composition, which is the part that needs review
attention.

Accepted outcome: both ceilings ratchet downward, rendered output identical.

### 6 — Source-control chrome

**Next.** `RepoStatusBar` (68 attributed lines, 82-line component),
`SourceModeTabs` (47), and `SourceContextMenu` (54) into modules.

Chosen as the first source-control extraction because all three are small and
self-contained, and between them they sit behind all three reach-in shapes, so
the step proves each fix exactly once:

- **hover/focus reveal** — `SourceContextMenu` should own a
  `revealOnRowInteraction` behavior rather than have four different row owners
  reach in. The row supplies the hover surface; the menu supplies the reveal.
- **shared-control restyle** — `.repo-status-bar .copy-button` becomes a named
  variant on `CopyButton`; the three `.source-control-mobile-tabs
  .source-mode-tab*` overrides become a `SourceModeTabs` variant.
- **layout placement** — a `className` pass-through on the placed child.

Read [the ownership map](072-source-css-ownership-map.md) first: it lists the
generated vocabulary that must stay global, the owner of every rule in the
region, and the complete reach-in table. Take every rule these three components
own from *both* legacy stylesheets in the same change.

Expected ratchet: ~170 lines.

### 7 — Review UI

**Planned.** `ReviewSubmitModal` (82), `ReviewCommentWindow` (67),
`ReviewCommentsPanel` (80). The cleanest region in the campaign: only
`review-submit-go` and `review-submit-error` are shared, and only between two
owners that can share a module. Generated diff classes stay global.

Expected ratchet: ~230 lines.

### 8 — Blame view

**Planned, deliberately after step 6.** `BlameView` is the single largest owner
in the campaign (162 attributed lines) and is otherwise an attractive target,
but it is the target of the `.blame-browser-columns > .blame-view` placement
reach-in and shares `source-search-*` with `CommitRevisionPane`. Take it once
step 6 has established the placement-prop pattern.

### 9 — File viewer

**Candidate, not scheduled.** `FileViewer` owns 215 attributed lines, but the
190-line bare-element bucket beneath it (`pre`/`code`/`[data-*]` typography that
depends on sitting inside a scoped parent) needs each parent's ownership settled
first, and `FileViewer` is shared by `FilePage`, `PublicShareFilePage`,
`FilePathLink`'s modal, and two tool renderers. The step is separating
viewer/modal/page chrome from Shiki, plain-code, diff, and server-rendered
markup.

### 10 — Fix the unused-CSS report's scope

**Later.** Two defects surfaced while building the ownership map. Both produce
*wrong* verdicts rather than conservative ones, which is why the report is not
safe to act on as a standalone sweep today:

1. **Source scope is `packages/client/src`,** so generated vocabulary produced
   in `packages/shared` is invisible. 36 of the 44 classes reported unused in
   `renderers.css` are the ANSI vocabulary from `shared/src/ansi-renderer.ts`,
   and `file-link` comes from `shared/src/filePathDetection.ts`.
2. **Bare-word matching over-reports usage.** `\bfile-link\b` matches inside
   `file-link-button` and `\bcommit-jump\b` matches inside `commit-jump-btn`,
   so both dead rules are reported as used. The fix is rejecting a following
   `-` at the word boundary.

Fold in the CSS inventory report while here: print global/module totals and the
largest owner files from one read-only command. Do not create a second enforced
baseline.

Nothing is blocked on this step. It matters before anyone attempts an
opportunistic sweep driven by the report rather than by hand-verified evidence.

---

### Extract while you're already in the file

**Ongoing, unnumbered.** This is the steady state the campaign is trying to
reach, not a scheduled step: when feature work touches a component, its
component-owned CSS leaves the legacy stylesheet in the same change and the
owning ceiling ratchets.

It is already happening unprompted — `fe31eeff` (Unify browser notification
delivery) created `NotificationsSettings.module.css` (83 lines) as ordinary
feature work with no reference to this campaign.

Good candidates: component-specific modals, dropdowns, settings controls,
page-local toolbars, isolated status surfaces, and individual tool renderers
whose React-owned styles sit in `renderers.css`. Avoid extracting tokens,
themes, base element styles, or a selector whose actual owner is still
ambiguous.

Do not migrate a shared component merely to fill the list. Pick the one that
active feature work already touches.

## Per-Step Runbook

Use the detailed procedure and composition recipes in
[`topics/css-architecture.md`](../../topics/css-architecture.md#migration-runbook).
Every step should leave this tactical with enough evidence that a future
maintainer does not need to reconstruct the migration:

1. Update the step status.
2. Record legacy line counts before and after.
3. List any selector intentionally left global and why.
4. Record focused tests and whether they emitted warnings.
5. Cite required desktop/mobile screenshot artifacts.
6. Record `pnpm css:check`, `pnpm lint`, `pnpm typecheck`, and
   `pnpm console:scan` results.
7. Add the landing commit and date.

## Landing Note Template

```markdown
### <N> — <what it is, in words> (Landed YYYY-MM-DD, <commit>)

- **Moved:** `<legacy selectors>` → `<Owner.module.css>`.
- **Stayed global:** `<selector/vocabulary>` because `<reason>`.
- **Composition decisions:** `<variant/wrapper/className/:global boundary>`.
- **Ratchet:** `index.css A→B`; `renderers.css C→D`.
- **Tests:** `<focused commands and counts>`; no runtime warnings.
- **Checks:** `css:check`, lint, typecheck, console budget.
- **Visual QA:** `<desktop artifact>`; `<mobile artifact>`.
- **Follow-up:** `<newly exposed dependency or next safe step>`.
```

Name the step for the product surface it touches. Commit the landing note with
the implementation and use `Topic: css-architecture` so the series stays
searchable.

## Stop Conditions

Pause a migration and document the finding when:

- the same selector is a relied-upon DOM contract across unrelated owners;
- moving it would require a user-visible redesign to make ownership coherent;
- server/generated markup cannot receive the proposed module root class;
- a stable test or extension consumes the literal class name;
- selector ordering changes theme or responsive behavior that cannot be
  characterized first; or
- the step expands into route loading, rendering performance, or another
  architecture campaign.

Containment is already doing its job when a step stops here. Do not force a
module conversion by hiding broad global reach inside `:global(...)`.

## Campaign Closeout

Close this tactical once steps 2, 3, and 6 have landed and the remaining
inventory has clear owners. At closeout:

- refresh the baseline table;
- move any newly discovered permanent rule into the topic;
- mark remaining candidates as ordinary opportunistic work;
- record the final evidence and remaining legitimate global areas; and
- keep the guard active indefinitely.

## Earlier labels

Commits and notes written before 2026-07-31 refer to this campaign's steps by
lane letter. The mapping, for anyone reading that history:

| Old | Now |
|---|---|
| A0, B0, D0 | 1 — freeze the legacy stylesheets (all three were one commit) |
| A1 | 2 — teach the unused-CSS report about modules |
| B1 | 3 — filter dropdown |
| C0 | 4 — map source-control CSS ownership |
| C1.5 | 5 — delete the dead git-status rules |
| C1 | 6 — source-control chrome |
| C2 | 7 — review UI |
| C3 | 9 — file viewer |
| A2 | 10 — fix the unused-CSS report's scope |
| B2, C4, D1+ | Extract while you're already in the file |
