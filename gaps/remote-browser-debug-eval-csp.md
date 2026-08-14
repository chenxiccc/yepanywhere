# Remote browser evaluation is blocked by the client CSP

The live `browser-debug info` and event routes work, but evaluating even
`document.title` fails with a browser `EvalError`. The client executes the
command through `globalThis.eval` in
`packages/client/src/lib/browserDebugLease.ts:633`, while YA's Content Security
Policy does not grant `unsafe-eval`. This violates the v1 contract and
observable check in `topics/remote-browser-diagnostics.md` that correct factors
can complete full JavaScript evaluation in the enabled tab.

Replace the evaluator with a deliberately CSP-compatible execution boundary
(or make the gated page policy explicitly support this contract), and exercise
it under the production CSP rather than only a unit-test environment. The fix
must retain the one-command-at-a-time result protocol and the lease's existing
authority bounds.

It was not fixed during the diagnosis because source edits could hot-reload the
user's live YA tabs, and the execution mechanism needs a browser/CSP regression
rather than another unit-only fallback.

Found 2026-08-14 while using a consented per-tab lease against a live YA session.
