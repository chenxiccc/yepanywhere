# Client CSS Architecture

> Component-owned client styles use co-located CSS Modules. Existing global
> stylesheets are frozen at ratcheting line-count ceilings while feature work
> gradually extracts their rules.

Topic: css-architecture

## Status: guarded, data-driven paydown

YA's authored client CSS grew into four globally loaded stylesheets totaling
more than 31,000 lines. The two largest files mixed unrelated ownership:
`index.css` held most application pages and controls, while `renderers.css`
held generated content, tool renderers, file viewing, source review, and source
control.

This is not a big-bang rewrite. The existing cascade remains in place while new
work stops increasing it and touched features pay down their local part.

## Migration tracking

[`docs/tactical/070-css-modules-migration.md`](../docs/tactical/070-css-modules-migration.md)
is the closed campaign record. It no longer carries a priority queue. This
topic is the binding architecture, candidate-selection protocol, and reusable
runbook.

[`docs/tactical/072-source-css-ownership-map.md`](../docs/tactical/072-source-css-ownership-map.md)
records the ownership evidence for the file viewer, source review, source
control, and blame regions: which classes are generated and stay global, which
component owns each rule, every cross-owner reach-in a slice must convert, and
the rules verified dead. It is reference data, not policy.

## Contract

- A React component's new styles belong in a co-located `*.module.css`, imported
  as `styles` by the owning component.
- `packages/client/src/styles/index.css`, `renderers.css`, `tool-rows.css`, and
  `emulator.css` are legacy global stylesheets. Each is frozen at the line limit
  in `scripts/css-architecture-baseline.json`.
- Feature work must not raise those limits. If a global rule is genuinely
  necessary, offset it by extracting at least as many legacy lines from the
  same file; prefer a reviewed, narrowly owned global exception when offsetting
  would obscure ownership.
- A new authored non-module stylesheet under `packages/client/src` fails
  `pnpm css:check` unless it is explicitly added to the reviewed allowlist with
  a reason. This prevents replacing one global monolith with several unowned
  global files.
- When extraction takes a legacy file below its ceiling, run
  `pnpm css:check --record` in the same change. Recording only lowers limits;
  it never accepts growth.
- CSS refactors preserve rendered appearance, responsive behavior, interaction
  states, and theme behavior unless an owning product topic explicitly changes
  them. Hashed module class names are implementation details; tests and browser
  automation should prefer roles, labels, and stable data attributes.

## Ownership boundaries

CSS Modules are the default for:

- component layout and appearance;
- component-local states and variants;
- component-local media queries and keyframes; and
- selectors whose complete DOM subtree is owned by one React component.

Global CSS remains appropriate for:

- design tokens, themes, font faces, reset/base element rules, and shared
  document-level state;
- third-party CSS such as KaTeX;
- HTML produced outside the owning React component, including server-rendered
  markdown, Shiki markup, ANSI/fixed-font transforms, or stable provider
  renderer vocabularies; and
- narrowly documented composition primitives shared across unrelated owners.

Generated markup does not justify placing an entire surrounding feature in a
global file. Keep the generated vocabulary global and move the React-owned
shell, controls, and layout into modules.

Use `:global(...)` inside a module only for a narrow interop boundary that the
module cannot own. The global selector should be evident beside the local
selector it affects. `HostOfflineModal.module.css`, for example, uses the
shared global `.modal` shell only to size the modal containing its local
content.

## Component composition

- The component that creates an element owns its class.
- A parent that needs to place a child should prefer a wrapper or an explicit
  `className`/variant prop over reaching into the child's generated class name.
- Reusable visual primitives may expose a deliberate shared global class, but
  accidental global selectors are not a component API.
- Keep design values in existing custom properties. Moving a selector into a
  module does not require copying theme values or introducing JavaScript style
  objects.
- Runtime CSS-in-JS libraries are not part of this migration. Vite's native CSS
  Modules provide scoping and co-location while retaining static CSS and adding
  no client runtime dependency.

## Data-driven slice selection

Choose migration work from current repository evidence, not a standing list of
features that looked attractive during an earlier inspection.

Start with:

```bash
pnpm css:inventory
pnpm css:inventory -- --owner <component-or-path>
```

The inventory parses legacy CSS with a CSS parser and package source roots plus
Playwright suites with the TypeScript parser. It distinguishes exact
string-literal callsites, dynamic template prefixes, test references,
non-client/generated producers, and React owners. For each likely owner it
reports:

- **owned lines** — complete CSS rule spans attributed to that owner;
- **span and coverage** — how concentrated those rules are between the first
  and last owned rule in each stylesheet;
- **stylesheets** — whether the component is split across legacy files;
- **edges** — coupled or unresolved rules that need explicit review;
- **dynamic classes** — template-built families that require a finite/open
  construction decision; and
- **tests** — files that mention the selector vocabulary and may rely on it.

The default approachable list is deliberately conservative. Prefer a component
or cohesive surface with substantial owned lines, high span coverage, one or
two stylesheets, few edges, no generated vocabulary, and a deterministic way to
exercise its important states. A 150–350 line local slice is often a better
paydown than a larger owner scattered through shared primitives, but the report
is evidence rather than a numeric mandate.

Before naming a slice:

1. drill into the owner and inspect every reported edge;
2. search the complete repository for the involved selectors and dynamic
   constructors;
3. identify the focused tests and desktop/phone states that will verify it;
4. define one bounded product surface, not a stylesheet range; and
5. leave the candidate in the inventory rather than adding speculative future
   steps to a tactical document.

Do not normalize every `className` before selection. Literal classes can move
with their owner. Finite switches or template unions become local module
lookups during that slice. Open-ended construction and generated HTML remain a
review boundary and may justify keeping the vocabulary global.

Automation may rewrite an already reviewed, unambiguous slice, but it must not
choose ownership, silently resolve composition, or delete coupled/generated
rules. Add a conversion tool only after repeated completed slices demonstrate
a stable mechanical transformation.

## Migration runbook

### 1. Establish ownership before moving rules

Choose a feature whose selectors and DOM owner can be identified together.
Begin with `pnpm css:inventory -- --owner <name>`, then search the entire
repository before editing:

- every class selector and state suffix;
- CSS selectors elsewhere in the legacy cascade;
- `className` strings, template literals, and helper-built names;
- raw/generated HTML producers;
- tests, Playwright locators, and DOM-query code; and
- caller selectors that reach into the component.

Classify each rule as component-owned, caller layout, shared primitive,
document-level state, generated vocabulary, third-party override, or stale.
Ambiguous ownership is a reason to pause, not a reason to use broad
`:global(...)`.

A feature's rules are not necessarily in one stylesheet, and a stylesheet's
section headings describe where rules were written rather than what owns them.
Source control keeps its Stage-3 browser shells in `renderers.css` and its older
Git Status Page vocabulary in `index.css`, with six components owning rules in
both. Slice by component and take every rule that component owns from every
legacy file in the same change; a slice defined as a line range leaves its
components half-owned.

A class with no literal producer is not necessarily stale. Resolve dynamic
construction by reading the expression that builds it —
`` `git-status-${status.toLowerCase()}` `` and
`` `source-pane-splitter-${boundary}` `` have no literal occurrence anywhere.
Search outside `packages/client/src` as well: generated vocabulary is often
produced in `packages/shared` or `packages/server`, which is precisely why it
must stay global.

### 2. Move behavior before cleaning it up

Create `Owner.module.css` beside the component and import it as `styles`.
Preserve declarations, media queries, pseudo states, keyframes, variables, and
selector ordering before attempting visual cleanup. Semantic local names no
longer need globally unique feature prefixes.

Basic usage:

```tsx
import styles from "./StatusChip.module.css";

export function StatusChip({ active }: { active: boolean }) {
  return (
    <span className={`${styles.root} ${active ? styles.active : ""}`}>
      …
    </span>
  );
}
```

Do not add a runtime class-name dependency for ordinary composition. When
several optional classes make interpolation unreadable, use a tiny local
function or an array filtered and joined in the component.

### 3. Make composition explicit

For caller-owned placement, prefer a wrapper or an explicit `className` or
variant prop:

```tsx
export function StatusChip({ className }: { className?: string }) {
  return (
    <span className={[styles.root, className].filter(Boolean).join(" ")}>
      …
    </span>
  );
}
```

A caller may supply its own module class through that prop. It must not guess or
reach into the child's generated class name. Prefer named variants when several
callers need the same meaningful presentation; prefer a wrapper for one-off
layout.

Migrating a component that callers already reach into inverts this: once its
classes are hashed, `.caller .child-class` cannot be written at all, so each
existing override must become part of the component's API before the move.
`FilterDropdown` classifies its overrides three ways — a named boolean for a
recurring need (`fullWidth`), a named variant for a meaningful presentation
(`triggerVariant`, `panelVariant`), and a pass-through class for caller-specific
sizing (`triggerClassName`). A pass-through targets one documented element; it
is not a licence to restyle the subtree.

When the reach-in runs the other way — several ancestors styling a control they
do not render, as four row lists did to the source row-menu trigger — the child
module exports an opt-in class for the ancestor to apply to itself, and owns the
relationship locally (`.rowSurface:hover > .trigger`). The ancestor declares that
it is the interaction surface; it does not decide what the reveal looks like.

Check what a moved declaration was actually defending against before calling it
redundant. `.repo-status-bar .copy-button` restated `.copy-button`'s own values
and looked like dead weight, but a second, unrelated `.copy-button` later in
`index.css` was winning against it — `renderers.css` is `@import`ed at the top of
`index.css`, so its rules are the earliest in the cascade, not the latest. A
module class that replaces a descendant selector needs the same specificity the
selector had, or the outcome silently becomes stylesheet order.

When a caller rule that survives in a legacy stylesheet used to win through
descendant specificity, keep it at that specificity — scope it under the
caller's own wrapper. Otherwise it silently starts depending on stylesheet
order relative to the module.

Portals do not require global CSS. A module import emits static CSS, and the
portal element can use the generated class anywhere in the document. Keep
overlay, sheet, responsive, and keyframe rules in the owning module.

### 4. Contain unavoidable global vocabulary

Use a narrow global selector only where the module cannot own the other side:

```css
.root :global(.markdown-rendered) {
  color: var(--text-primary);
}

:global(.modal):has(.content) {
  max-width: 30rem;
}
```

The first form scopes generated markup beneath a local root. The second is
appropriate only when a shared global shell must respond to local content.
Never translate a whole legacy section into unscoped `:global(...)`; that
changes its file without changing its architecture.

Keep shared theme values in custom properties. Runtime-dependent dimensions or
positions may stay in `style` as CSS variables while all static declarations
move to the module.

### 5. Re-scan and test the boundary

After editing:

1. Search again for stale selectors and old literal class names. `pnpm
   css:unused` reports global classes by name and module selectors per owning
   file; it treats a computed key, a side-effect-only import, and an unimported
   module as undetermined rather than unused, and never rewrites module rules.
   Its CSS and TypeScript parsers scan every `packages/*/src` producer and
   match complete class-like string tokens. Dynamic prefixes remain
   conservative, and a test-only reference can still be an intentional DOM
   contract, so confirm a verdict against the reported producer before
   deleting.
2. Confirm callers no longer depend on removed child selectors.
3. Run focused component and consumer tests.
4. Prefer roles, labels, and stable data attributes in tests; module hashes and
   local class names are not public selectors.
5. Run `pnpm css:check`, `pnpm lint`, `pnpm typecheck`, and
   `pnpm console:scan`.
6. Capture and inspect final browser screenshots at 1920×1080 and 375×812 when
   the migration affects rendered UI.
7. Run `pnpm css:check --record` and verify that only the intended legacy
   ceilings moved downward.

Prefer extraction while a feature is already being changed. Standalone
mechanical extractions are also welcome when they have a clear owner and can be
verified without mixing in visual redesign.

## Established examples and baseline

The containment pass established native Vite CSS Modules with three different
ownership examples:

- `Toast.module.css`: an ordinary shared React component with a local animation;
- `HostOfflineModal.module.css`: a component with a narrow global-shell
  interop selector; and
- `KillShellRenderer.module.css`: a React-owned tool renderer extracted from
  `renderers.css`.

`FilterDropdown.module.css` followed as the shared-component case: a portaled
mobile sheet, a desktop panel, and five caller sites whose overrides became
props. It is the reference for the composition rules above.

The current legacy ceilings are:

| Stylesheet | Maximum lines |
|---|---:|
| `index.css` | 20,870 |
| `renderers.css` | 8,042 |
| `tool-rows.css` | 948 |
| `emulator.css` | 261 |

These numbers are ceilings, not targets. Every successful extraction should
make the relevant number smaller.
