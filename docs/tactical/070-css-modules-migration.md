# CSS Modules Migration

Topic: css-architecture

Status: Chapter 11 containment landed, the unused-CSS analyzer understands CSS
Modules (A1), `FilterDropdown` proved the shared-component composition patterns
(B1), and the source CSS ownership map is recorded (C0). C1 — the first
source-control shell extraction — is next.

## Contract

The binding ownership rules and migration runbook live in
[`topics/css-architecture.md`](../../topics/css-architecture.md). Read that
topic before implementing a slice.

This document is the campaign tracker: baseline, priority queue, slice ledger,
landing evidence, and handoff notes. If this tactical and the topic disagree,
the topic wins and this document should be corrected.

## Goal

Turn CSS Modules into the ordinary path for client feature work while shrinking
the legacy global cascade through reviewable, behavior-preserving slices.

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
- No deleting selectors solely because the current unused-CSS report claims
  they are unused before that report understands CSS Modules.

## Baseline

Containment landed on 2026-07-31 in `07e40ef1`:

- Vite-native CSS Modules were proven with `Toast`, `HostOfflineModal`, and
  `KillShellRenderer`.
- `pnpm css:check` became part of `pnpm lint`.
- A temporary unreviewed global stylesheet was fault-injected and correctly
  rejected by the guard.
- Full typecheck and all 2,735 client tests passed.
- The real mounted Toast component was inspected at 1920×1080 and 375×812.

Initial post-extraction legacy ceilings:

| Stylesheet | Maximum lines | Primary remaining ownership |
|---|---:|---|
| `index.css` | 21,092 (was 21,441 at A0) | Tokens/themes/base plus legacy pages and components |
| `renderers.css` | 8,331 | Generated markup plus legacy renderer/page shells |
| `tool-rows.css` | 948 | Shared tool-row composition and states |
| `emulator.css` | 261 | Emulator streaming surface and global states |

The machine-readable source of truth is
`scripts/css-architecture-baseline.json`. Update this table when a slice changes
a ceiling, but never use the table instead of the enforced baseline.

## Priority Queue

Recommended order:

1. ~~**A1 — module-aware unused-CSS analysis.**~~ Landed; see the A1 landing
   note below.
2. ~~**B1 — `FilterDropdown` migration.**~~ Landed; see the B1 landing note
   below.
3. ~~**C0 — source-control ownership map.**~~ Landed; see the C0 landing note
   below and [`072-source-css-ownership-map.md`](072-source-css-ownership-map.md).
4. **C1 — source-control chrome.** `RepoStatusBar`, `SourceModeTabs`, and
   `SourceContextMenu`, converting the three reach-in shapes the map identified.
5. **D1+ — opportunistic `index.css` extraction.** Migrate the next component
   when feature work already touches it.

Land A1 and B1 as separate commits. The analyzer is tooling-only and should be
reviewable independently from the shared-component cascade work.

## Slice Ledger

### Lane A — guard and analysis tooling

| Slice | Status | Target | Accepted outcome |
|---|---|---|---|
| A0 | Done 2026-07-31 (`07e40ef1`) | Architecture guard and initial examples | New globals rejected, four legacy ceilings frozen, three representative modules landed |
| A1 | Done 2026-07-31 | `scripts/find-unused-css.ts` | Understand module imports plus `styles.foo` and `styles["foo"]`; report module selectors by owning file without treating hashes as global classes |
| A2 | Later | CSS inventory reporting | Print global/module totals and largest owner files from one read-only command; do not create a second enforced baseline |

#### A1 acceptance notes

- Preserve the existing global-class and dynamic-prefix analysis.
- Associate a `*.module.css` import with its local binding rather than treating
  every same-named class across modules as one global class.
- Recognize property access and string-literal bracket access.
- Treat computed arbitrary access as unknown, not automatically unused.
- Add focused fixtures for used, unused, composed, and global-interoperability
  selectors.
- Keep destructive `--remove` behavior disabled for module selectors until the
  parser can remove a complete rule safely.
- Add or document a root command if the analyzer is expected to be part of
  routine CSS work.

#### A1 landing note (Landed 2026-07-31)

- **Moved:** nothing. Tooling-only slice; no stylesheet or component changed.
- **Fixed:** two defects that made the report actively misleading once modules
  existed. Classes were deduplicated by name across every file, so
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
  as usage of the global class, so `.fixture-modal-shell`-style shells are not
  reported unused when only a module reaches them.
- **Removal:** `--remove`/`--dry-run` still operate on global stylesheets only
  and print what module selectors they left in place.
- **Command:** `pnpm css:unused` (root). Not wired into `pnpm lint`; the report
  is advisory and currently exits non-zero on 95 pre-existing global findings.
- **Real-tree effect:** global namespace 2,639 → 2,627 classes (12 names were
  module-only), unused globals unchanged at 95, and `Toast.module.css` is
  correctly reported undetermined because its variant classes are reached via
  `styles[toast.type]`.
- **Tests:** `packages/client/scripts/find-unused-css.test.ts`, 17 focused
  cases over `scripts/fixtures/find-unused-css/` (used, unused, composed,
  computed, unimported, `:global` interop, and two modules sharing a
  `.message` name); full client suite 2,752 passed, no warnings.
- **Checks:** `pnpm lint`, `pnpm typecheck`, `pnpm css:check` (ceilings
  unchanged, as expected for a tooling slice). No visual QA: nothing rendered
  changed.
- **Follow-up:** the analyzer only understands `:global(...)`, not `:global {}`
  blocks, and treats any non-accessor use of a module binding as unknown. Both
  are conservative. B1 is now unblocked.

### Lane B — shared component composition

| Slice | Status | Target | Accepted outcome |
|---|---|---|---|
| B0 | Done 2026-07-31 (`07e40ef1`) | Toast and HostOfflineModal | Local animation, portal-independent classes, and narrow `:global(.modal)` interop proven |
| B1 | Done 2026-07-31 | `FilterDropdown.tsx` | Base component styles move to a module; callers use deliberate props/wrappers for variants instead of reaching into global child selectors |
| B2 | Candidate | `ReloadBanner`, `RecentSessionsDropdown`, or another shared leaf | Choose based on active feature work; do not migrate merely to fill the ledger |

#### B1 preflight inventory

`FilterDropdown` is deliberately the next composition test rather than a
mechanical leaf:

- its base section is roughly 360 lines in `index.css`;
- mobile content renders through a portal;
- callers pass contextual classes such as status/provider/model variants;
- Settings, New Session, and Composer sections reach into
  `.filter-dropdown-button`, `.filter-dropdown-container`, and the chevron; and
- tests and browser automation already exercise a subset of the behavior.

Before editing, classify every external override as one of:

1. layout owned by a caller wrapper;
2. an explicit `FilterDropdown` variant or size prop;
3. a deliberate caller-supplied module class;
4. a truly shared primitive that remains global; or
5. stale coupling that can be removed with evidence.

Do not reproduce all external selectors with `:global(...)`; that would move
the monolith without changing its ownership.

Required B1 checks:

- focused `FilterDropdown` tests;
- consumers in Settings, New Session, Global Sessions, and Composer;
- open/close, Escape, click-outside, single-select, and multi-select behavior;
- desktop dropdown alignment;
- portal bottom sheet at 375×812;
- caller-specific widths and compact model-chip presentation;
- `pnpm css:check --record` with an `index.css`-only downward ratchet; and
- final desktop and mobile captures cited in the landing note.

#### B1 landing note (Landed 2026-07-31)

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
  { width: 100% }` overrides in Settings and New Session. `triggerVariant="chip"`
  replaces `.composer-model-chip .filter-dropdown-button/-chevron`.
  `panelVariant="model"` replaces `.model-filter-dropdown ...`, which had to
  become a prop because hashed child classes are unreachable from a caller.
  `triggerClassName` is the deliberate caller-supplied class hook; Global
  Sessions uses it for the status/provider trigger widths, which stay in
  `index.css` scoped under `.filter-dropdowns` so they keep the specificity
  that previously let them win over the component's narrow-width rule.
- **Stale coupling removed:** `.new-session-speech-field` and
  `.new-session-helper-model` reach-ins (including a `@media (min-width: 760px)`
  rule) targeted wrappers that no longer exist in any TSX — `pnpm css:unused`
  from A1 flagged the first one. The emitted-but-unstyled `clear-selection`
  class was dropped; it had no rule and no consumer.
- **Behavior note:** the narrow-width rules were unscoped selectors sitting
  inside the sessions filter-bar `@media (max-width: 600px)` block, so they
  applied to every FilterDropdown in the app. They moved into the module as
  component-owned responsive rules, preserving that reach.
- **Ratchet:** `index.css 21,441 → 21,092` (−349); `renderers.css` unchanged.
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
  can absorb them. C0 is unblocked.

### Lane C — renderer and source-control separation

| Slice | Status | Target | Accepted outcome |
|---|---|---|---|
| C0 | Done 2026-07-31 | Source CSS ownership map | Record React-owned shells versus generated global vocabularies for file viewer, source review, source control, and blame |
| C1 | Next | Source-control chrome | `RepoStatusBar`, `SourceModeTabs`, and `SourceContextMenu` into modules; convert the reveal, placement, and shared-control reach-ins to props |
| C1.5 | Ready, optional | Dead-rule sweep | Remove the 184 dead `index.css` lines and 4 dead `renderers.css` rules the map verified; ratchet both ceilings with no behavior change |
| C2 | Not started | Review UI shells | `ReviewSubmitModal`, `ReviewCommentWindow`, and `ReviewCommentsPanel` while preserving generated diff classes globally |
| C3 | Candidate | File viewer shell | Separate viewer/modal/page chrome from Shiki, plain-code, diff, and server-rendered markup |
| C4 | Opportunistic | Individual tool renderers | Migrate React-owned renderer styles when the tool is otherwise touched |

[`072-source-css-ownership-map.md`](072-source-css-ownership-map.md) is the map.
Read it before starting any Lane C slice: it lists the generated vocabulary that
must stay global, the owner of every rule in the region, the complete set of
cross-owner reach-ins a slice must convert, and the dead rules already verified.

Generated classes such as highlighted diff lines, Shiki token spans, streamed
markdown, and fixed-font transforms may remain global. React-created headers,
buttons, tabs, rows, trays, and responsive shells should not remain global
merely because they surround generated content.

#### C0 landing note (Landed 2026-07-31)

- **Moved:** nothing. Read-only slice; no stylesheet, component, or test
  changed.
- **Corrected the campaign's premise:** the mixed region is not 2,078 lines in
  one file. Source control's CSS is split across two legacy stylesheets —
  `renderers.css` 6524–7834 holds the Stage-3 browser shells, `index.css`
  19759–20557 holds the older Git Status Page vocabulary. Six components own
  rules in both. Slicing by line range would leave them half-owned, so Lane C
  slices are now defined by component and take both files in one change. Mapped
  total across file viewer, source review, source control, and blame: 3,954
  lines.
- **Reach-ins enumerated:** 17 cross-owner descendant selectors, reducible to
  three shapes — hover/focus reveal (four rules, one need, fixed by
  `SourceContextMenu` owning the reveal), layout placement (fixed by a
  `className` pass-through), and restyling a shared control (fixed by a named
  variant). Same three-way classification `FilterDropdown` established in B1.
- **Dead rules verified:** 184 lines across 33 `index.css` rules — the
  pre-Stage-3 working-tree UI replaced by `WorkingTreeBrowser`/`SourceFileRow` —
  plus 4 rules in `renderers.css`. Verified against dynamic construction and the
  non-client packages, not just literal search. C1.5 exists to bank these.
- **Rejected as dead on first pass, then cleared:** `git-status-m/a/d/r/u/t/?`,
  `git-status-action-{success,warning}`, `source-pane-splitter-{revisions,files}`,
  and `worktree-file-state-*` are all built from a variable. A literal search
  finds no producer for any of them.
- **Two analyzer defects found:** `pnpm css:unused` searches only
  `packages/client/src`, so the 36 ANSI classes produced by
  `shared/src/ansi-renderer.ts` and `file-link` from
  `shared/src/filePathDetection.ts` are reported unused — 37 of the 44
  `renderers.css` entries in the current report are this one bug. Separately,
  bare-word matching reports `.file-link` and `.commit-jump` as used because the
  word appears inside `file-link-button` and `commit-jump-btn`. Neither blocks
  C1, but the report is not safe to act on as a standalone sweep until the scope
  is widened.
- **Follow-up:** C1 is unblocked and scoped. A2 should absorb the scope fix.

### Lane D — opportunistic legacy extraction

| Slice | Status | Target | Accepted outcome |
|---|---|---|---|
| D0 | Done 2026-07-31 (`07e40ef1`) | Initial leaf extraction | `index.css` reduced by 187 lines and `renderers.css` by 46 |
| D1+ | Ongoing | Feature-touched components in `index.css` | Each feature change leaves its component-owned CSS in a module and ratchets the owning legacy ceiling |

Good opportunistic candidates include component-specific modals, dropdowns,
settings controls, page-local toolbars, and isolated status surfaces. Avoid
extracting tokens, themes, base element styles, or a selector whose actual
owner is still ambiguous.

## Per-Slice Runbook

Use the detailed procedure and composition recipes in
[`topics/css-architecture.md`](../../topics/css-architecture.md#migration-runbook).
Every slice should leave this tactical with enough evidence that a future
maintainer does not need to reconstruct the migration:

1. Update the slice status.
2. Record legacy line counts before and after.
3. List any selector intentionally left global and why.
4. Record focused tests and whether they emitted warnings.
5. Cite required desktop/mobile screenshot artifacts.
6. Record `pnpm css:check`, `pnpm lint`, `pnpm typecheck`, and
   `pnpm console:scan` results.
7. Add the landing commit and date.

## Landing Note Template

```markdown
### Slice <ID> — <owner/boundary> (Landed YYYY-MM-DD, <commit>)

- **Moved:** `<legacy selectors>` → `<Owner.module.css>`.
- **Stayed global:** `<selector/vocabulary>` because `<reason>`.
- **Composition decisions:** `<variant/wrapper/className/:global boundary>`.
- **Ratchet:** `index.css A→B`; `renderers.css C→D`.
- **Tests:** `<focused commands and counts>`; no runtime warnings.
- **Checks:** `css:check`, lint, typecheck, console budget.
- **Visual QA:** `<desktop artifact>`; `<mobile artifact>`.
- **Follow-up:** `<newly exposed dependency or next safe slice>`.
```

Commit the landing note with the implementation slice. Use
`Topic: css-architecture` so the series remains searchable.

## Stop Conditions

Pause a migration and document the finding when:

- the same selector is a relied-upon DOM contract across unrelated owners;
- moving it would require a user-visible redesign to make ownership coherent;
- server/generated markup cannot receive the proposed module root class;
- a stable test or extension consumes the literal class name;
- selector ordering changes theme or responsive behavior that cannot be
  characterized first; or
- the slice expands into route loading, rendering performance, or another
  architecture campaign.

Containment is already doing its job when a slice stops here. Do not force a
module conversion by hiding broad global reach inside `:global(...)`.

## Campaign Closeout

Close this tactical once A1, B1, and one Lane C shell boundary have landed and
the remaining inventory has clear owners. At closeout:

- refresh the baseline table;
- move any newly discovered permanent rule into the topic;
- mark speculative candidates as ordinary opportunistic work;
- record the final evidence and remaining legitimate global areas; and
- keep the guard active indefinitely.
