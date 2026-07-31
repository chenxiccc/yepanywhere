# CSS Modules Migration — Closed

Topic: css-architecture

Status: closed 2026-07-31. The global-CSS guard, module-aware unused report,
composition patterns, and parser-backed ownership inventory are in place.
There is no remaining ordered migration queue in this tactical.

The binding ownership and migration protocol lives in
[`topics/css-architecture.md`](../../topics/css-architecture.md). This file is
the campaign closeout and historical index only.

For a supervised implementation loop that launches one bounded Claude worker
through the local YA API, polls its authoritative process state, stops
tail-chasing, and independently audits each result, use the
[`Claude agent process runbook`](../testing/claude-agent-process-runbook.md).

## Outcome

The campaign established the steady state it set out to reach:

- component-owned client styles use co-located CSS Modules;
- the four legacy global stylesheets cannot grow beyond ratcheting ceilings;
- generated markup and deliberate global primitives remain global;
- the unused-CSS report understands module namespaces and scans generated
  producers across every package source root;
- a read-only inventory ranks likely owners by removable lines, locality,
  composition edges, dynamic classes, and test contracts; and
- future extractions are selected from current repository data, then completed
  as bounded, behavior-preserving slices.

CSS Modules improve ownership. This campaign did not pursue a visual redesign,
route splitting, CSS-in-JS, a framework migration, or zero global CSS.

## Commands that remain active

| Command | Role |
|---|---|
| `pnpm css:check` | Enforces the global-stylesheet allowlist and frozen line ceilings. Part of `pnpm lint`. |
| `pnpm css:check --record` | Lowers ceilings after an extraction. Never permits growth. |
| `pnpm css:unused` | Advisory unused global/module selector report. Exits nonzero while findings remain. |
| `pnpm css:inventory` | Advisory owner ranking for migration selection. |
| `pnpm css:inventory -- --owner <name>` | Shows the owned span, dynamic classes, test references, and composition edges for one likely owner. |
| `pnpm --silent css:inventory -- --json` | Emits parseable JSON for scripts or offline analysis. |

The inventory is not a second baseline and does not choose a migration by
itself. Its ownership inference is conservative: coupled, generated, and
unresolved selectors remain visible as review work rather than being charged
to a convenient owner.

## Closeout baseline

| Stylesheet | Maximum lines | Primary remaining ownership |
|---|---:|---|
| `index.css` | 20,870 | Tokens/themes/base plus legacy pages and components |
| `renderers.css` | 8,042 | Generated markup plus legacy renderer/page shells |
| `tool-rows.css` | 948 | Shared tool-row composition and states |
| `emulator.css` | 261 | Emulator streaming surface and global states |

The machine-readable source of truth remains
`scripts/css-architecture-baseline.json`. These are ceilings, not targets.

## Completed campaign work

| Work | Landed | Result |
|---|---|---|
| Freeze the legacy stylesheets | `07e40ef1` | Added the ratchet and proved ordinary, global-interop, and renderer module shapes. |
| Teach the unused report about modules | `cb389318` | Separated global and per-module namespaces and made unknown module usage conservative. |
| Filter dropdown | `d800d19e` | Proved portals, responsive rules, variants, pass-through placement, and caller ownership. |
| Map source-control ownership | `5f9fddc7` | Recorded generated vocabulary, actual component owners, dynamic class families, and reach-ins. |
| Delete dead git-status rules | 2026-07-31 | Removed 222 lines from `index.css` and 25 from `renderers.css`. |
| Source-control chrome | 2026-07-31 | Moved `RepoStatusBar`, `SourceModeTabs`, and `SourceContextMenu`; removed 264 renderer lines. |
| Replace speculative selection with inventory | 2026-07-31 | Added parser-backed source/CSS analysis and closed the fixed queue. |

The detailed source-control evidence remains in
[`072-source-css-ownership-map.md`](072-source-css-ownership-map.md). It is
historical reference data, not a priority list.

## Retired provisional queue

The former plan labeled Review UI, Blame View, and File Viewer as steps 7–9.
Those labels are retired. They described plausible boundaries discovered during
one source-control mapping exercise, not a durable claim that those surfaces
have the best current return.

They may still be selected when the current inventory and verification setup
support them. They have no reserved order, and future candidates should not be
added to this closed tactical.

## Historical labels

Older commits and notes used lane labels. This mapping is retained only so the
history remains searchable:

| Old | Campaign work |
|---|---|
| A0, B0, D0 | Freeze the legacy stylesheets |
| A1 | Teach the unused report about modules |
| B1 | Filter dropdown |
| C0 | Map source-control CSS ownership |
| C1.5 | Delete dead git-status rules |
| C1 | Source-control chrome |
| C2, C3 | Retired provisional Review UI / File Viewer targets |
| A2 | Parser-backed correctness and inventory closeout |
| B2, C4, D1+ | Extract while already working in the owner |
