# Session-share stale-copy test flakes in the aggregate client run

The root `pnpm test` run can fail
`packages/client/src/components/__tests__/SessionShareModal.test.tsx` at the
final `getByRole("listitem")` assertion in `does not let stale copy overwrite a
newer create notice`. The failed aggregate run left the filtered list empty
and emitted repeated React `act(...)` warnings from
`SourcePublicShareManagerModal` updates.

An immediate isolated run of the whole `SessionShareModal.test.tsx` file passed
all 30 tests without warnings, so this appears to depend on aggregate-suite
ordering, concurrency, leaked state, or timing. Reproduce the aggregate order,
then make the test await the final modal state and audit shared mock or timer
cleanup. It was not folded into the unrelated recap-helper sidebar fix.

Found 2026-08-15 while verifying live archival of forked recap helpers.
