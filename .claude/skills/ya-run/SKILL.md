---
name: ya-run
disable-model-invocation: true
description: Launch and drive Yep Anywhere — an isolated dev server plus real browser interaction — and run the repository's check suite. Use when asked to run, start, screenshot, or smoke-test the app rather than only build or typecheck it.
---

# Running Yep Anywhere

This file exists so that any "how do I run this project?" procedure lands on
the repository's own verified path instead of a generic recipe. It is a
pointer, not a second copy: when it disagrees with the documents it cites,
they win.

## "Run the tests" is not "run the app"

The check suite is `CLAUDE.md` § After Editing Code — `pnpm lint`,
`pnpm format:check`, `pnpm typecheck`, `pnpm test`, and `pnpm test:e2e` for UI
changes. A request to run tests, checks, or lint is satisfied by those
commands and needs no server and no browser.

Focused runs go through the owning package's runner, e.g.
`pnpm --filter @yep-anywhere/server exec vitest run test/services/Foo.test.ts`;
`vitest` is not a root dependency, so a repo-root `pnpm vitest` fails.

## Launching the app

Start a fresh server from the current worktree on an unused port. Never reuse,
reload, or restart an already-running instance: one may be supervising live
agent sessions, and a capture taken against a stale process is invalid
(`AGENTS.md` § UI Tweak Visual Verification).

All ports derive from `PORT`: the app on `PORT`, the maintenance server on
`PORT + 1`, Vite on `PORT + 2` (`CLAUDE.md` § Port Configuration). `YEP_PROFILE`
gives the instance its own data directory, so it cannot disturb the default
one (`CLAUDE.md` § Data Directory & Profiles).

```bash
PORT=4000 YEP_PROFILE=dev \
VITE_DISABLE_ONBOARDING=true \
VITE_DISABLE_CLI_UPDATE_NOTIFICATIONS=true \
pnpm dev
```

The two `VITE_*` values suppress the first-run and CLI-update dialogs that
would otherwise cover the surface under test. They are Vite startup inputs:
setting them on a later screenshot command has no effect.

Readiness, from another shell — the maintenance server on `PORT + 1` answers
over plain HTTP and is the cheapest liveness probe (`CLAUDE.md` § Maintenance
Server):

```bash
curl -sf http://127.0.0.1:4001/status
```

The app itself is served over HTTPS; the repository's capture command passes
`--ignore-https-errors` for it, and `curl` needs `-k`. Whether an API route
answers without credentials depends on the profile's stored auth state, so
treat a 401 as a configuration fact rather than a failed launch.

Stop the instance when finished; do not leave it listening.

## Driving it

Launching alone proves only that the entrypoint resolves. Exercise the surface
the change touches: call the route with `curl` for server work, and for client
work load the affected view in a browser and capture it.

`CLAUDE.md` § Browser Control (UI Testing) gives the capture command — the
repository's installed Playwright dependency, pointed at
`https://localhost:4000/` with `--ignore-https-errors`. Do not write a custom
browser driver; the dependency is already present.

`AGENTS.md` § UI Tweak Visual Verification and `topics/ui-testing.md` own the
rest and are binding: which viewport widths to capture, the requirement to
read and inspect each image in its own tool call, what to check in each one,
where to archive them, and the case where the user has taken visual
verification for themselves. Read `topics/ui-testing.md` before capturing
rather than assuming the dimensions — a capture at the wrong size, or one
skimmed instead of inspected, does not discharge the requirement.

## Device and hardware paths

Emulator testing is required only for device-control changes — `/api/devices`,
`deviceBridge`, or `packages/device-bridge` (`CLAUDE.md` § Device Control
Testing). Ordinary client, server, provider, relay, and rendering work does
not need it.
