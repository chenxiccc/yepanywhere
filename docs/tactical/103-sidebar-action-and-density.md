# Sidebar action clarity and density semantics

Status: complete (2026-08-09)

## Origin and problem

The expanded sidebar regressed in three related ways:

- New Session lost its conventional plus affordance when the YA brand glyph
  replaced it globally. The recorded justification applied to Compact mode,
  where the wordmark was hidden, but the replacement also affected the normal
  Comfortable sidebar where the wordmark remained visible.
- Top-level navigation edge padding changed from `0.875rem` to `0.75ch` while
  the icon-to-label gap remained `0.5rem`. The smaller, unrelated measurements
  make icons appear pressed against the screen edge.
- Sidebar spacing lives inside the Typography panel even though users choose a
  layout density. The preference also changes branding and navigation type
  size, so its name does not describe its effects.

The requested result is to restore the obvious create action, balance the
navigation rhythm, and make the density preference control density only.

The change history explains how the regression happened. Commit `cc4732bf`
added Compact mode and changed top-level edge insets to `0.75ch`, motivated by
recovering desktop space while retaining coarse-pointer targets. Commit
`9ca83906` then hid the Compact wordmark and substituted the YA glyph for the
plus so New Session would remain recognizable. That substitution and the inset
change were implemented globally, although their justifications were specific
to Compact. The density commit closed PR #109; its GitHub record contains no
review or discussion that adds another product constraint.

## Product decisions and justification

- New Session uses a green circular plus in every expanded, compact, and
  collapsed sidebar state. A plus communicates creation directly; the brand
  already has its own header surface and should not replace action semantics.
- One density-owned inline-spacing metric controls both the leading edge inset
  and the icon-to-label gap. Comfortable uses `0.75rem`; Compact uses
  `0.5rem`. Equal measurements keep the icon visually centered between the
  viewport edge and its label while preserving a meaningful density choice.
- Comfortable and Compact retain their existing row-height, block-padding,
  line-height, and section-gap differences. Both modes keep the same sidebar
  wordmark, navigation type size, and action icons. Density may change spatial
  dimensions, not branding or navigation meaning.
- The persisted `sidebarSpacing` key and its `comfortable` / `compact` values
  remain unchanged for browser settings compatibility. Only the visible label
  becomes **Sidebar density**.
- Sidebar density moves to the main Appearance layout controls beside Content
  width. It receives a short description and remains searchable by both the
  old “spacing” wording and the new “density” wording. Typography contains
  only font and text-rendering controls.
- Coarse pointers retain the existing 40px minimum navigation target and 6px
  block padding in both density modes.

## Recommended implementation order

### 1 — restore the New Session create affordance

Replace the YA glyph in `SidebarIcons.newSession` with the prior green circular
plus and add a focused structural assertion so a future branding refinement
cannot silently remove the create mark again.

### 2 — balance sidebar navigation spacing

Add a density-owned inline-spacing custom property. Use it for both
`padding-inline` and the icon-to-label `gap`, and align top-level section
headers to the same inset. Keep collapsed-rail centering and coarse-pointer
overrides intact.

### 3 — narrow Compact and Comfortable to density

Remove density-driven brand visibility, header justification, and navigation
font-size changes. Keep spatial metrics, including a compact header inset that
still leaves the shared wordmark and mobile close control usable.

### 4 — move Sidebar density out of Typography

Render the control as a normal searchable Appearance row near Content width,
rename it, add explanatory copy, and remove its duplicate from the Typography
panel. Preserve storage, undo, remote startup, and browser-backup behavior.

### 5 — codify and verify the sidebar behavior

Update `topics/session-ui-customization.md` with externally observable icon,
density, spacing, and settings-location behavior. Cover both density metric
sets and the settings placement with focused tests; run formatter, CSS gates,
lint, typecheck, client tests, i18n and console scans, then inspect fresh
1920×1080 and 375×812 browser captures.

## Completion evidence

- `SidebarNavItem`, spacing-hook, and Appearance settings tests cover the plus
  structure, both density metric sets, legacy custom-property cleanup, visible
  settings location, accessibility state, and persisted preference updates.
- The focused browser contract in `e2e/sidebar-density.spec.ts` passes against
  a fresh production client build and isolated server. It verifies equal
  navigation edge/gap measurements, unchanged navigation type and wordmark,
  live Compact/Comfortable switching, restored plus semantics, and the
  non-Typography settings location.
- Fresh captures were inspected at
  `.artifacts/ui-testing/2026-08-09-sidebar-action-density/`:
  `sidebar-density-desktop-1920x1080.png`,
  `sidebar-density-mobile-375x812.png`, and
  `sidebar-open-mobile-375x812.png`.
- `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm css:check`, the
  client test suite (360 files / 3013 tests), the focused Playwright test,
  `pnpm i18n:scan`, and `pnpm console:scan` pass. The i18n and console scans
  retain their existing baselines and add no new findings.
- The full workspace `pnpm test` run remains red in unrelated server suites:
  lifecycle fake-timer cleanup cascades after an idle-timeout failure, plus
  existing public-share and project-file-access failures. No changed client
  test fails.
- `pnpm css:touched` reports the remaining `SidebarNavItem` and
  `AppearanceSettings` global CSS ownership as broad and coupled (including
  dynamic classes), so extracting those legacy surfaces was deliberately
  deferred rather than expanding this bounded sidebar behavior change.
