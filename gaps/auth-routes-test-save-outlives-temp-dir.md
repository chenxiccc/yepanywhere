# AuthRoutes test teardown races an in-flight auth.json save

`packages/server/test/auth/AuthRoutes.test.ts:26,:151` removes its `mkdtemp`
directory in `afterEach` without waiting for the `AuthService` save that the
test just triggered. The save runs through `createCoalescingSaver`
(`packages/server/src/lib/coalescingSaver.ts:44`), whose `drain` rethrows the
write failure on a promise nobody awaits, so a late `doSave`
(`packages/server/src/auth/AuthService.ts:354`) fails with
`ENOENT: ... /tmp/auth-routes-test-*/auth.json` as an unhandled rejection.

Vitest reports the whole `@yep-anywhere/server` run as failed even though all
4496 tests pass, so `pnpm test` exits nonzero for reasons unrelated to the
change under test. Timing-dependent: the file passes on its own and failed
once under the full parallel suite (2026-08-29).

Not fixed in place because it sits in the auth suite, nowhere near the
provider-installation work that surfaced it. The cheap fix is for the test to
await the service's pending save (or dispose the service) before removing the
directory; alternatively give `AuthService` a shutdown that drains the saver,
which the server would also want on reload.

Found 2026-08-29 while running the full suite for the provider installation
gate fix.
