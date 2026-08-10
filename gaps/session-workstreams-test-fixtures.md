# Session workstream tests use stale route fixtures

`packages/server/test/routes/sessions-workstreams.test.ts` has two stale
expectations. Its session-metadata stub lacks `getMetadata`, causing the
two-phase route to return 500, and its `startSession` assertion does not accept
the current normalized user message and complete launch options object.

The isolated reproducer is:

```bash
pnpm --filter @yep-anywhere/server exec vitest run \
  test/routes/sessions-workstreams.test.ts
```

The likely fix is to use the shared session-metadata test fixture (or add the
missing method) and update the call matchers to assert only the workstream
contract. This was not fixed in place because the failing route coverage is
unrelated to frozen public-share capture.

Found 2026-08-10 while running the full server suite for active-turn sharing
and project-path diff links.
