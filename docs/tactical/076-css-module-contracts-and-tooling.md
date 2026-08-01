# CSS Module Contracts And Tooling

Topic: css-architecture

Status: direction approved 2026-08-01; implementation has not begun.

Related records:
[`070-css-modules-migration.md`](070-css-modules-migration.md),
[`074-mixed-model-css-paydown.md`](074-mixed-model-css-paydown.md), and
[`topics/css-architecture.md`](../../topics/css-architecture.md).

## Objective

Turn the completed CSS containment campaign into a durable steady state:

- upgrade the repository from Biome 2.4.16 to the current stable 2.5 release;
- apply stricter lint rules to `*.module.css` without forcing legacy-global
  cleanup into the same change;
- make module selector definitions and production usage a blocking contract;
- repair the ownership inventory's known false-positive evidence sink;
- prompt agents to inspect CSS ownership when they already touch a component
  styled by legacy CSS; and
- decide the smallest useful on-demand CSS health summary without building a
  dashboard or inventing a composite score.

This tactical does not reopen the standalone migration campaign, create a
future extraction queue, target zero global CSS, or authorize unrelated visual
redesign. Runtime CSS ownership continues to follow the binding topic.

## Starting evidence

The campaign closeout is the historical baseline. Remeasure before the first
implementation commit because concurrent feature work may add legitimate
module files.

| Signal | Closeout state |
|---|---:|
| Legacy global stylesheets | 4 files / 23,556 lines |
| CSS Modules | 53 files / 7,669 lines |
| Module selectors | 705 |
| Deterministically unused module selectors | 0 |
| Module usage made unknown | 1 (`Toast` computed access) |
| `:global(...)` occurrences in modules | 14 |
| Potentially unused legacy classes | 35 |
| Automatically removable legacy rules | 32, plus 3 grouped cases |
| Biome module duplicate-property findings | 0 |
| Biome module `!important` findings | 0 |
| Biome module descending-specificity findings | 5 in 4 files |

`pnpm lint` currently runs the global line/file architecture check and Biome,
but not the module-aware unused report. Vite's default CSS Module declaration
accepts any string key, so TypeScript does not prove that `styles.foo` exists in
the imported stylesheet.

The inventory also has a known confidence defect recorded by run 10 of the
mixed-model ledger: an ordinary status string in
`ForkSummaryDisplayObject` can be treated as class-production evidence and
create false ownership edges. Do not ratchet or automate ownership conclusions
until that distinction is repaired and covered by fixtures.

## Decisions

- The global line ceilings remain hard containment gates, not a complete
  progress score.
- Modules may use a stricter Biome policy than the legacy global files.
- The repository analyzer remains authoritative for YA-specific generated,
  dynamic, test, script, and non-client producers until Biome's project rules
  prove equivalent on the repository corpus.
- Hard gates, downward ratchets, and observational signals remain distinct. A
  metric that can increase through better classification is not a ratchet.
- The health consumer is an agent or reviewer already working on CSS, plus an
  occasional architecture audit. No product dashboard, scheduled report, or
  single numeric score is planned.
- Do not add Stylelint while Biome plus the repository analyzer cover the
  required contracts. Reconsider only for a demonstrated rule gap.
- Each implementation step lands as a warning-free, reviewable commit. Keep
  the shared `Topic: css-architecture` trailer; this continues an existing
  topic and does not add a new `topics.md` entry.

## Recommended implementation order

### 1 — repair CSS ownership evidence

Separate permissive unused-CSS discovery from evidence strong enough to assign
a rule to a React owner. A generic string token such as `"status"` must not
become a class producer merely because a global stylesheet has `.status`.

Preserve the conservative cases the inventory actually needs: literal and
finite `className` construction, recognized class-list operations, regular
expression selector contracts, dynamic prefixes, test references, and
generated producers outside the client package. Make the evidence kind visible
enough that future reports can label a low-confidence edge instead of silently
charging it to an owner.

Acceptance:

- the `ForkSummaryDisplayObject` false edge disappears;
- fixtures distinguish generic strings from class-producing syntax;
- dynamic, regex, test, and non-client generated producers remain covered;
- `css:unused` retains its deliberately permissive safety posture; and
- any resulting ownership-count change is explained rather than treated as
  migration progress.

### 2 — upgrade Biome to 2.5

Upgrade `@biomejs/biome`, the configuration schema URL, and the lockfile to the
latest stable 2.5 patch available when this step is enacted. Keep this an
upgrade-only commit: do not enable the new CSS policy in the same diff.

Inspect migration advice and newly recommended diagnostics manually. Do not
apply organize-imports/exports or broad formatting churn. Resolve every new
warning or error with a scoped change or an inline reason that satisfies the
repository's zero-warning policy.

Acceptance:

- the package, schema, wrapper, and lockfile agree on one Biome version;
- `pnpm lint` is warning-free;
- `pnpm typecheck` and the relevant tooling tests pass; and
- the commit records any behaviorally meaningful new diagnostics or parser
  differences.

### 3 — enforce the CSS Module lint baseline

Add a Biome override for `packages/client/src/**/*.module.css`. Keep the legacy
global exceptions in place while enforcing the cleaner module baseline.

Enable as errors from the start:

- `noDuplicateProperties`;
- `noImportantStyles`; and
- `noValueAtRule`, preserving shared values as custom properties.

Review the five current `noDescendingSpecificity` findings in
`FilterDropdown`, `ImageViewer`, `QuestionAnswerPanel`, and `RepoStatusBar`.
Preserve behavior and selector intent while repairing or narrowly justifying
them, then enable the rule for modules. Trial
`noExcessiveSelectorClasses` at a maximum of four classes and
`noExcessiveLinesPerFile` at a 600-line warning threshold; keep them only if
they are quiet, understandable guardrails rather than incentives for arbitrary
splitting.

Acceptance:

- all existing modules pass the module-only policy without broad suppressions;
- legacy fallback declarations and generated-markup overrides do not force the
  rules back off globally; and
- a focused configuration test or fixture proves that a violating module
  fails lint.

### 4 — make CSS Module usage a blocking contract

Extend the existing parser-backed analyzer rather than introducing generated
`*.d.ts` files solely for selector names. For every module, distinguish:

- selectors reached by production code;
- selectors reached only by tests or stylesheet-contract fixtures;
- `styles.foo` or `styles["foo"]` accesses with no matching local selector;
- computed access that hides the finite selector set;
- side-effect imports;
- modules with no production importer; and
- local/external `composes` relationships.

Prefer replacing `Toast`'s finite computed lookup with an explicit typed map so
the current unknown baseline can reach zero. If an unknown is truly necessary,
use a reviewed machine-readable exception with a reason; do not make all
selectors in the module silently live.

Split command behavior so the module contract can join `pnpm lint` while the
known legacy-unused backlog remains advisory. A possible shape is a blocking
`css:modules:check` plus the existing investigative `css:unused`; choose names
that make write behavior and exit semantics obvious.

After the upgrade, trial Biome 2.5's project-domain nursery rules
[`noUnusedClasses`](https://biomejs.dev/linter/rules/no-unused-classes/) and
[`noUndeclaredClasses`](https://biomejs.dev/linter/rules/no-undeclared-classes/)
against the same repository corpus. Record where they agree with or miss YA's
generated markup, dynamic prefixes, test and script references, and imported
module access. Keep them observational until their false-positive and
false-negative behavior is understood; do not replace the custom analyzer just
because the generic rules exist.

Acceptance:

- undeclared, production-unused, test-only, unimported, and newly unknown
  module selectors are visible and covered by fixtures;
- the blocking mode is part of `pnpm lint` and is warning-free at the accepted
  baseline;
- the 35 legacy findings do not make ordinary lint fail; and
- the Biome project-rule comparison is recorded with any corpus gaps; and
- `--remove` remains limited to deliberately reviewed global rules.

### 5 — constrain CSS Module escape hatches

Teach the module contract check to classify `:global(...)` references. Require
an owning local anchor, including the sanctioned shared-shell shape
`:global(.modal):has(.localContent)`, or a narrow reviewed exception. Confirm
that referenced global vocabulary exists and is still intentional.

Do not enforce a blind count ceiling: a new generated-markup interop can be
correct. Enforce locality, existence, and reviewability, then report the count
as context. Keep browser automation on roles, accessible names, structural
contracts, or stable data attributes rather than generated module hashes.

Acceptance:

- the current interop patterns are classified explicitly;
- an unanchored broad `:global(...)` translation fails the contract check;
- a missing global reference is reported; and
- the sanctioned generated-markup and shared-modal fixtures remain valid.

### 6 — surface touched-component CSS ownership

Add an advisory, diff-aware command such as `pnpm css:touched`. Given an
explicit base or a well-defined merge base, it should identify changed React
owners that still emit legacy classes and print their current inventory facts:
owned lines, coverage, stylesheets, edges, dynamic classes, and relevant tests.

The command suggests inspection; it does not choose a slice, edit files, fail a
change merely because extraction was deferred, or maintain a queue. It should
make high-friction owners visibly different from local candidates and provide
the handoff vocabulary documented in the topic.

Acceptance:

- a fixture diff with a local owner produces a concise opportunity;
- a scattered/coupled owner produces a clear deferral signal;
- generated or unresolved evidence is never presented as a mechanical move;
- clean or module-owned touched components produce no noise; and
- `AGENTS.md` and `DEVELOPMENT.md` name the final command and semantics.

### 7 — decide the smallest useful CSS health surface

After the analyzer and module contracts are stable, decide whether one
on-demand `pnpm css:health` command is clearer than the existing command bundle.
Its only intended consumers are a CSS-changing agent/reviewer and an occasional
architecture audit.

If implemented, compose existing parsed results rather than building another
analyzer. Provide human-readable and JSON output across containment, ownership,
module contracts, escape hatches, dead code, and total authored CSS. Report
built CSS bytes only when a build artifact already exists or through an
explicit option; do not make a routine health check build the application.

Do not emit a composite score, persist a live dashboard, schedule reports, or
copy changing totals into topic prose. If the command would merely repeat
`css:check`, `css:inventory`, and the module contract without making a real
review task easier, close this step as no-code and document the small command
bundle instead.

Acceptance is a recorded decision with a named consumer and workflow, not the
existence of a dashboard.

### 8 — ratify the steady-state CSS checks

Update the binding topic and contributor guidance with the enacted command
names, hard gates, reviewed exceptions, and exact fallback behavior. Close this
tactical with the before/after module-contract counts and any deliberately
observational metrics.

Do not reopen a migration priority queue. Future feature work uses the touched
component trigger; a new standalone paydown campaign requires fresh explicit
authorization and current inventory.

Acceptance:

- every intentional tool exit condition is documented in
  `topics/css-architecture.md`;
- the final `pnpm lint`, `pnpm css:check`, `pnpm typecheck`, and focused tooling
  tests are warning-free;
- any runtime component edit receives its focused tests and required visual
  verification; and
- the tactical is marked complete with no active worker or follow-up queue.

## Suggested commit series

Keep upgrade mechanics, lint policy, analyzer behavior, and agent workflow
separable. Suggested subjects in recommended order:

1. `Repair CSS ownership evidence`
2. `Upgrade Biome to 2.5`
3. `Enforce CSS Module lint rules`
4. `Make CSS Module contracts blocking`
5. `Guard CSS Module global escapes`
6. `Surface touched CSS ownership`
7. `Summarize CSS health on demand` — only if step 7 earns implementation
8. `Close CSS tooling hardening`

Each non-trivial commit should carry the originating direction and acceptance
constraints in its body and use the exact trailer:

```text
Topic: css-architecture
```

## Verification matrix

Run after every applicable implementation step:

- focused unit tests for the changed parser, checker, or command;
- `pnpm css:check`;
- the module-contract blocking command once it exists;
- `pnpm css:unused` in advisory mode;
- `pnpm css:inventory`, comparing confidence categories rather than assuming
  every count must decrease;
- `pnpm lint` with zero warnings; and
- `pnpm typecheck`.

The Biome upgrade should also run the full unit suite because recommended-rule
or parser changes may affect files outside CSS. Tooling-only changes do not need
browser captures. Any edit to runtime component class composition follows the
normal focused-test and two-viewport visual-verification contract.

## Definition of done

- Biome is on an audited stable 2.5 release.
- CSS Modules have a strict module-only lint policy.
- Selector definitions and production accesses are checked in both directions.
- Newly unknown module usage cannot enter unnoticed.
- Global interop is local, existent, and reviewed.
- The inventory no longer treats generic strings as React ownership evidence.
- Agents receive a bounded touched-component prompt without a migration queue.
- The smallest useful health workflow is decided and documented without a
  dashboard or composite score.
- The steady-state contract is reflected in the topic and contributor guidance.
