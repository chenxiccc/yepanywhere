# Source Control Hosted Compatibility And Guardrails

Status: implemented and verified.

Topic: server-capabilities
Topic: remote-hosted-compatibility
Topic: source-review-to-session

## Origin

The commit-history/source-review redesign replaced Source Control's persistent
git-action result panel with a brief button indicator and made the new history
browser the default body. Against a released server, the hosted client can
still receive the established `git-status-enhanced`, remote-check, pull, push,
and integration-option capabilities, but the new client then calls commit
browse and review routes that the server never advertised and does not have.

The concrete report was a clean repository showing `main -> origin/main ↑2 ↓1`.
Pull and push correctly refused divergent history, but the phone UI exposed
only a tiny `!`; the actionable explanation survived only in hover-oriented
metadata. The same inspection found that all new browse/review routes landed
without a new capability or an older-server fallback.

This tactical restores the essential released-server path and makes the
compatibility decision difficult for future server-backed client features to
omit.

## Product Decisions

### Compatibility horizons are minimums, not automatic cutoffs

For a new hosted client:

- An ordinary optional server-backed feature must degrade safely against at
  least the latest two stable server releases and every stable release from the
  preceding 14 days.
- Core functionality must retain a usable path against every stable server
  release from the preceding 60 days, with the latest two stable releases as a
  minimum even during a slow release cadence.
- Security or protocol exceptions require an explicit maintainer-approved
  exception under `topics/hard-development-rules.md`.
- Passing a horizon only makes compatibility eligible for maintainer review.
  It never automatically removes a fallback, broadens an already-advertised
  capability, or raises a compatibility floor.
- When preserving a cheap capability-gated fallback beyond the minimum is
  practical, prefer preserving it. The horizon is a floor for user trust, not
  a target date for breakage.

Source Control is core functionality. The compatibility corpus for this slice
therefore includes released `v0.6.0`, `v0.6.1`, `v0.6.2`, and `v0.7.0`
capability sets.

### Existing capability meanings do not grow retroactively

`git-status-enhanced` continues to mean the released contract:

- `GET /api/projects/:projectId/git`;
- `GET /api/projects/:projectId/git/untracked-folder`; and
- `POST /api/projects/:projectId/git/diff`.

The separately advertised remote-check, pull, push, and integration-option
capabilities continue to expose those controls independently. A newer client
must not interpret `git-status-enhanced` as proof that commit browsing, blame,
search, or source-review routes exist.

The complete new source-browser/review page receives one aggregate permanent
capability because the shipped client implementation composes those routes as
one feature family. A server without that capability receives the compatibility
shell below and no requests to the new route family.

### Older capable servers retain basic Source Control

When `git-status-enhanced` exists but the new source-browser/review capability
does not, Source Control remains available and shows:

- repository, branch, upstream, ahead/behind, and clean/dirty state;
- Pull, Push, and Check only when their existing individual capabilities are
  advertised;
- a persistent full-text result or error message after a git action; and
- a concise banner explaining that commit history, file browsing, and source
  review require a server update.

The compatibility shell does not mount the new Commits, Files, Comments, blame,
search, or review components and makes no calls to their routes. Reconstructing
the removed legacy multipane working-tree diff browser is deliberately out of
scope; the essential status and synchronization actions remain functional
without duplicating that large client implementation.

When `git-status-enhanced` itself is absent, the existing unsupported/update
state remains appropriate.

### Git action errors are persistent and visible

Pull, Push, and Check retain the brief success/warning mark on the initiating
button as supplementary feedback. Their complete result also renders in a
padded, bordered status panel near the controls and remains until another git
action or project change replaces it.

Warnings use `role="alert"`; successful outcomes use `role="status"`. Touch
users never need hover, a title attribute, or an accessibility tree inspector
to discover why an action did not change repository state.

## Contributor And Agent Guardrail

Before implementing a client dependency on a server route, response field,
event, or changed semantic that is absent from any release inside the
applicable horizon:

1. Identify the stable release corpus and whether the feature is core or
   optional.
2. State the new server contract and its capability/protocol classification.
3. State the exact missing-capability fallback and confirm that it makes no
   unsupported requests.
4. State whether any existing capability meaning, compatibility level, or
   older capable fallback would change.
5. Pause for maintainer approval before editing the client/server contract.

The approval prompt should be reusable:

> Compatibility review for `<feature>`: releases `<corpus>` lack
> `<routes/fields/events>`. I propose `<capability/protocol>`; without it the
> client `<fallback>` and makes no unsupported requests. Existing capability
> meanings and older capable behavior remain unchanged. Approve?

An originating request that already states and approves all five decisions
satisfies the pause; agents should not ask the same question twice.

This mandate belongs in both `AGENTS.md` and `CLAUDE.md`, with the human-facing
version in `DEVELOPMENT.md`. A pull-request checklist repeats the evidence for
reviewers.

## Automated Guardrails

### Capability audit

Add `pnpm capabilities:audit` and run it in CI. The first implementation:

- reports transitional capabilities whose review date has passed;
- rejects raw capability checks in client/server runtime source when a shared
  registry constant/helper should be used; and
- verifies that every route declared by a capability-owned route module is
  listed in that capability's `serverContract.routes`.

The route-module ownership check makes additions to the new git browse/review
modules fail until their advertised contract is updated. Future feature
families should add their owning modules to the same metadata rather than
inventing a parallel audit.

### Released-server compatibility fixtures

Client tests carry named fixtures for every stable release in the current core
Source Control horizon. Each fixture asserts that the current client:

- renders basic status and the independently advertised git actions;
- renders the update explanation for the unavailable new browser;
- does not mount new browser/review UI; and
- makes no new browse/review request.

The fixtures are a behavioral support corpus, not merely capability snapshots.
Release work updates the corpus according to the horizon policy; removing a
fixture requires a maintainer-approved compatibility decision.

## Implementation Slices

### Slice 0 — contract and tactical

- Record the support horizons, capability semantics, compatibility shell,
  persistent feedback, approval pause, and automated checks.
- Update the owning topic contracts.

### Slice 1 — policy guardrails

- Add the mandate to agent and contributor instructions.
- Add a pull-request compatibility checklist.
- Add the capability audit command and CI invocation.

### Slice 2 — capability and fallback

- Register and advertise the aggregate source-browser/review capability.
- Gate every new route consumer behind it.
- Render the basic capability-composed compatibility shell when it is absent.
- Restore persistent action feedback in full and compatibility modes.

### Slice 3 — proof and closeout

- Add the released-server compatibility matrix and action-feedback tests.
- Run warning-free lint, typecheck, focused/full tests, capability audit,
  i18n scan, and console scan.
- Capture and inspect final Source Control at 1920×1080 and 375×812, including
  the compatibility shell and a visible action failure.
- Update this tactical with the final evidence and remaining gaps.

## Acceptance Gates

- Released `v0.6.0`–`v0.7.0` capability fixtures retain functional basic
  Source Control and never call a new route.
- Current servers advertise the new capability and receive the complete page.
- Pull/push divergence produces a persistent, full-text visible warning on
  desktop and phone.
- Existing capability strings retain their released meanings.
- A future route added to an owned capability module without registry coverage
  fails `pnpm capabilities:audit`.
- Agent instructions require a maintainer compatibility decision before a new
  client/server contract is implemented.
- Observable contracts and final browser captures agree with the behavior.

## Implementation Results

All four slices are complete:

- the contributor and agent instructions now require a human compatibility
  decision before a new client/server dependency can exclude an in-horizon
  release;
- the pull-request template asks for the supported release corpus, capability
  or protocol decision, and exact fallback;
- `pnpm capabilities:audit` validates the shared registry, capability-owned
  route modules, and use of shared capability constants, and runs in CI;
- current servers advertise `git-source-review` for the complete commit
  browse, file browse, blame, search, diff, and review route family;
- older capable servers retain basic status, Pull, Push, Check, persistent
  action results, and the server-update explanation without mounting or
  requesting the new route family; and
- named `v0.6.0`, `v0.6.1`, `v0.6.2`, and `v0.7.0` client fixtures prove the
  core Source Control fallback.

Verification completed on 2026-07-27:

- `pnpm capabilities:audit`: 20 registered capabilities, zero errors, zero
  warnings;
- `pnpm lint`: passed with zero warnings;
- `pnpm typecheck`: passed;
- focused client Source Control tests: 9 passed with no runtime warnings;
- focused server version-route tests: 25 passed with no runtime warnings;
- shared package build, full `pnpm test`, and full `pnpm build`: passed;
- `pnpm i18n:scan`: no new findings (the existing three Vite development-copy
  advisories remain);
- `pnpm console:scan`: no baseline growth (`log` 110/110, `warn` 61/61,
  `error` 95/95); and
- `git diff --check`: passed.

Final browser captures:

- `.artifacts/ui-testing/2026-07-27-source-control-compatibility/desktop.png`
  at 1920x1080;
- `.artifacts/ui-testing/2026-07-27-source-control-compatibility/mobile.png`
  at 375x812.

The browser used a running server that did not advertise
`git-source-review`; the status and action responses were held at the reported
clean `main -> origin/main ↑2 ↓1` divergence so the action failure remained
reproducible after the live repository independently converged. Visual
inspection confirmed that the complete persistent warning appears directly
under the action row, its integration choices remain grouped with it, the
compatibility explanation is prominent but not blocking, and neither viewport
has horizontal overflow.

## Non-Goals

- Reintroducing the removed legacy working-tree diff browser.
- Treating capability absence as a server error.
- Automatically dropping support when a time or release-count horizon passes.
- Replacing protocol-version or remote-compatibility-level decisions with
  feature capabilities.
- Enforcing GitHub branch-protection or reviewer permissions from repository
  code.
