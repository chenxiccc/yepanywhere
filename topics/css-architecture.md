# Client CSS Architecture

> Component-owned client styles use co-located CSS Modules. Existing global
> stylesheets are frozen at ratcheting line-count ceilings while feature work
> gradually extracts their rules.

Topic: css-architecture

## Status: Chapter 11 containment

YA's authored client CSS grew into four globally loaded stylesheets totaling
more than 31,000 lines. The two largest files mixed unrelated ownership:
`index.css` held most application pages and controls, while `renderers.css`
held generated content, tool renderers, file viewing, source review, and source
control.

This is not a big-bang rewrite. The existing cascade remains in place while new
work stops increasing it and touched features pay down their local part.

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

## Migration procedure

1. Choose a feature whose selectors and DOM owner can be identified together.
2. Search the entire client for every selector, including tests and selectors
   elsewhere in the legacy cascade.
3. Move rules into a co-located module. Preserve declarations and responsive
   behavior before attempting cleanup.
4. Replace string class names with module references. Use semantic local names;
   they no longer need globally unique prefixes.
5. Search again for stale selectors and cross-feature dependencies.
6. Run focused tests, `pnpm css:check`, `pnpm lint`, `pnpm typecheck`,
   `pnpm console:scan`, and browser visual verification at the required desktop
   and phone widths.
7. Lower the affected legacy ceiling with `pnpm css:check --record`.

Prefer extraction while a feature is already being changed. Standalone
mechanical extractions are also welcome when they have a clear owner and can be
verified without mixing in visual redesign.

## Initial baseline

The containment pass established native Vite CSS Modules with three different
ownership examples:

- `Toast.module.css`: an ordinary shared React component with a local animation;
- `HostOfflineModal.module.css`: a component with a narrow global-shell
  interop selector; and
- `KillShellRenderer.module.css`: a React-owned tool renderer extracted from
  `renderers.css`.

The initial post-extraction legacy ceilings are:

| Stylesheet | Maximum lines |
|---|---:|
| `index.css` | 21,441 |
| `renderers.css` | 8,331 |
| `tool-rows.css` | 948 |
| `emulator.css` | 261 |

These numbers are ceilings, not targets. Every successful extraction should
make the relevant number smaller.
