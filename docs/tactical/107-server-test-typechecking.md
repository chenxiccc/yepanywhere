# Server Test Typechecking

Topic: testing

Status: Planned. `pnpm typecheck` currently excludes `packages/server/test`.

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
