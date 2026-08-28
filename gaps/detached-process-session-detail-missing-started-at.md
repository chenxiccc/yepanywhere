# Detached-process session-detail test omits `startedAt`

`packages/server/test/routes/sessions-metadata.test.ts` fails in
`augments detached process history before a session file exists`: its process
fixture omits `startedAt`, while `packages/server/src/routes/sessions.ts`
unconditionally calls `process.startedAt.toISOString()` for that path. The
route therefore returns 500 instead of the expected 200.

The isolated test reproduces the failure. The likely cheap fix is to give the
detached-process fixture a real `startedAt` date (and strengthen its typing so
required runtime fields cannot be omitted). This was not fixed with the
public-file-share UI because it belongs to the independent session-detail test
fixture contract.

Found 2026-08-28 while running the full workspace suite for the public-file-share UI refactor.
