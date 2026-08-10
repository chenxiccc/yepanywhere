# Pnpm 9.15.1 warns under Node 24

Running `pnpm install --offline --frozen-lockfile` with Node 24.14.0 emits
`[DEP0169] DeprecationWarning` because pnpm's `toNerfDart` still calls
`url.parse()`. A `--trace-deprecation` run locates the call in Corepack's cached
`pnpm/9.15.1/dist/pnpm.cjs`; the project pins that version through
`package.json`'s `packageManager` field.

YA builds and tests do not emit this warning; dependency installation does. It
was not fixed in place because the likely correction is a pinned package-
manager upgrade, which needs its own compatibility review rather than warning
suppression. Test a newer pnpm against the supported Node/toolchain matrix and
remove this gap if installation becomes warning-free.

Found 2026-08-10 while verifying warning-free client builds in an isolated
worktree.
