# find-unused-css fixtures

A miniature client tree for `scripts/find-unused-css.ts`, exercised by
`packages/client/scripts/find-unused-css.test.ts`.

It is deliberately not real product code:

- `global.css` is a legacy-style global stylesheet (used, unused, and
  module-referenced classes).
- `Widget.module.css` / `Widget.tsx` cover property access, string-literal
  bracket access, `composes`, and a `:global(...)` interop selector.
- `Shared.module.css` is reached only through `composes ... from`.
- `Dynamic.module.css` / `Dynamic.tsx` cover computed access, which must read
  as unknown rather than unused.
- `Orphan.module.css` has no importer.
- `stylesheet-contract.test.ts` mentions global classes only inside regex
  literals: one as an escaped-dot selector, one as regex noise.

`scripts/check-css-architecture.mjs` only scans `packages/client/src`, so these
stylesheets are outside the frozen legacy baseline.
