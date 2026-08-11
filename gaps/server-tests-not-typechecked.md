# Server test files are never typechecked

`packages/server/tsconfig.json` sets `"include": ["src/**/*"]` and
`"exclude": [..., "test"]`, so `pnpm typecheck` type-checks the server's
source but not its tests. Several existing test files have real type
errors as a result — `sessions-metadata.test.ts` alone has ten
`createSessionsRoutes({...})` calls missing required `scanner` /
`readerFactory` deps (lines 215, 250, 335, 378, 416, 648, 701, 762, 829,
887 as of 2026-08-01). They run fine because Vitest strips types rather
than checking them.

Noticed while adding handoff-draft route coverage; the new tests supply
every required dep, so nothing here blocks them.

Worth fixing because the gap hides drift: a `SessionsDeps` change that
breaks every test harness in the package still passes `pnpm typecheck`,
and the failure only surfaces as a confusing runtime error later.

The staged cleanup and warning-free ratchet are maintained in
[`docs/tactical/107-server-test-typechecking.md`](../docs/tactical/107-server-test-typechecking.md).
This gap remains open until every server test file participates in a root or CI
typecheck.
