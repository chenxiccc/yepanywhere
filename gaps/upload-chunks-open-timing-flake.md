# `uploadChunks` "sends start message with metadata on open" is flaky in CI

`packages/client/src/api/upload.test.ts:131` ("sends start message with
metadata on open") failed on graehl CI at `18716c16` with
`AssertionError: expected 0 to be greater than 0` at line 144 — the assertion
that the mock WebSocket has sent at least one message ran before the
open/start handshake fired. 3806 of 3807 client tests passed in the same run,
and the file was not touched by the commits in that push, so this is a timing
race in the test, not a product regression.

Not fixed in place: noticed during a security review of the range ending at
`18716c16`; test-timing work was out of that review's scope.

Cheap fix if known: await the mock socket's open/first-send event (or poll
with `vi.waitFor`) before asserting `sentMessages.length`, instead of
asserting synchronously after a fixed microtask/timer step.

Found 2026-08-22 while running /security-review since (CI corroboration for
range b7378e3382a9..18716c166ba4).
