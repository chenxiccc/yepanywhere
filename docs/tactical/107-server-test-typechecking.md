# Server Test Typechecking

Topic: testing

Status: In progress. The dedicated diagnostic configuration exists, but its
610-error baseline is not yet clean or connected to `pnpm typecheck`.

## Goal

Make server test harnesses part of the TypeScript contract so a source
dependency or route signature change cannot leave test fixtures type-invalid
while the repository typecheck still passes.

The open evidence and a known stale dependency cluster are tracked in
[`gaps/server-tests-not-typechecked.md`](../../gaps/server-tests-not-typechecked.md).

## Boundary

This is a tooling ratchet, not a request to loosen production types or cast old
fixtures through the checker. Vitest execution is not evidence that test-only
TypeScript is sound because its transform removes types.

A dedicated test configuration is preferable to broadening the production
build configuration: test globals, fixtures, source conditions, and emitted
output concerns differ, while production compilation should retain its current
boundary.

## Baseline, 2026-08-11

`packages/server/tsconfig.test.json` checks server tests and their imported
source without emitting. It uses bundler module resolution and permits explicit
`.ts` imports because Vitest owns test-module loading, including a small set of
direct client source imports. The production configuration remains NodeNext
and unchanged; its existing `src/**/*` include continues to own the two
source-adjacent test files.

The first cleanly configured run reports 610 diagnostics across 69 files. The
largest clusters are:

| Test file | Diagnostics | Owning issue |
|---|---:|---|
| `test/supervisor.test.ts` | 71 | results are used without narrowing queued/full responses from live processes |
| `test/routes/sessions-metadata.test.ts` | 39 | repeated `SessionsDeps` fixtures omit required route dependencies |
| `test/services/RelayClientService.test.ts` | 37 | captured WebSocket fixtures are used before their presence is established |
| `test/routes/global-sessions.test.ts` | 32 | response and collection entries are indexed without proving they exist |
| `test/device/DeviceBridgeService.test.ts` | 30 | callback-populated sidecar mocks narrow to `never` at their use sites |

Across the corpus, the dominant diagnostics are possibly-undefined access
(`TS2532`, 162; `TS18048`, 85), missing properties on insufficiently narrowed
values (`TS2339`, 155), incompatible arguments (`TS2345`, 67), and incompatible
assignments (`TS2322`, 51). This is fixture-contract cleanup, not a candidate
for disabling strict options in the test configuration.

Current cutoff: work-plan step 1 is complete. Steps 2–4 remain open, and the
diagnostic command intentionally exits nonzero until the existing corpus is
repaired. Do not add it to the root gate early or treat this baseline as an
allowed-error ratchet.

## Work plan

### 1 — inventory the hidden baseline

Create a non-emitting test typecheck configuration extending the server base
options, then run it without adding it to the root gate. Group every existing
diagnostic by owning fixture/helper rather than repairing errors one by one at
call sites when a shared constructor is stale.

### 2 — repair real fixture contracts

Supply required dependencies, narrow mocks to the public interfaces they
implement, and centralize repeated route/app harness construction. Do not use
blanket casts or optionalize production dependencies to make tests compile.

### 3 — add the package ratchet

Add a `typecheck:test` package script using the clean non-emitting config. Make
the root typecheck or CI invoke it only after the existing corpus is clean, so
the first enforced run is warning-free.

### 4 — cover future test locations

Define whether source-adjacent `*.test.ts` files belong to the production or
test config and ensure every server test file is covered exactly once. Add a
small configuration assertion or file-list check if TypeScript include/exclude
drift would otherwise be silent.

## Acceptance

- Every server test TypeScript file is checked by a repository command.
- Root/CI typechecking fails on a deliberately invalid server test fixture.
- Production source build boundaries and emitted artifacts are unchanged.
- The enabled test typecheck is clean without blanket casts, skipped files, or
  suppressed diagnostics.
