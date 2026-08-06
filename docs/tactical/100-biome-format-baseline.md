# Establish A Biome Formatting Baseline

> Replace recurring repository-wide format debt with one mechanical baseline,
> preserve useful blame attribution across that rewrite, and keep the baseline
> clean with a separate non-writing CI check.

Status: Implemented on 2026-08-06. The originating request was to investigate
why a broad Biome command repeatedly rewrites many files, then record a
tactical and implement the agreed cleanup with a clean worktree.

Related contributor policy:

- [`AGENTS.md`](../../AGENTS.md)
- [`CLAUDE.md`](../../CLAUDE.md)
- [`DEVELOPMENT.md`](../../DEVELOPMENT.md)
- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)

## Evidence and decision

The repository currently separates linting from formatting. `pnpm lint` runs
Biome lint and passes, while a non-writing `biome format` check reports 331 of
2,081 checked files would change. A simulated write changes 3,070 inserted and
3,410 deleted lines across those 331 files. Of them, 330 were edited after the
last clean whole-repository format pass on 2026-06-24; only one remained
untouched, so ordinary feature work rather than formatter-version drift owns
nearly all of the backlog.

The current arrangement makes broad accidental formatting expensive, but an
occasional cleanup without enforcement only restarts the same accumulation.
Adopt formatting as a repository invariant instead:

- establish one pure Biome baseline commit over the tracked files selected by
  the repository wrapper;
- do not run assists or organize imports as part of the pass;
- record verified mechanical commits in `.git-blame-ignore-revs` so GitHub and
  configured local blame retain useful attribution;
- add a distinct `format:check` command that never writes and make CI run it;
  and
- keep feature-time formatting scoped to exact edited files in shared dirty
  worktrees, while allowing the repository-wide writer only as an intentional
  command against a clean baseline.

Biome is exactly pinned in `package.json`. A future formatter upgrade that
changes many files receives the same treatment: isolated mechanical commit,
verification, and a follow-up blame-ignore entry.

## Implementation order

### 1 — record the formatting policy transition

Land this tactical before changing source bytes. Reserve one commit-series
topic so the plan, mechanical baseline, and enforcement metadata remain easy
to find together.

### 2 — establish the repository-wide Biome baseline

Run `pnpm format` from a clean worktree and commit only its output. Confirm the
diff contains the expected formatter rewrites and no assist-driven import or
export reordering. Do not mix CI, documentation, or blame metadata into this
commit.

### 3 — preserve blame across mechanical rewrites

Create a root `.git-blame-ignore-revs` containing full object names and
comments for the verified 2026-06-24 pass, the 2026-08-05 scoped pass, and the
new baseline. This must follow the baseline commit because its final object
name does not exist beforehand. Configure the current checkout's local Git to
use the tracked file by default.

### 4 — enforce the clean baseline without writing

Add `pnpm format:check` as a bare Biome format invocation without `--write`,
then run it as its own CI step alongside lint. Update agent and contributor
guidance to distinguish the writer from the checker and to state the new
invariant. Keep `pnpm lint` lint-only and do not replace either command with
`biome ci`.

### 5 — verify the mechanical and policy commits

Run the non-writing format check, warning-free lint, typecheck, and full
non-Android workspace test suite. Confirm the final worktree and index are
clean and the branch contains only the planned commits.

## Acceptance

- `pnpm format:check` succeeds without changing files.
- CI blocks new repository-wide formatting drift independently of lint.
- `pnpm lint` and `pnpm typecheck` pass without warnings. The full `pnpm test`
  run passes or any unrelated baseline failure is reproduced against the
  unchanged originating revision and recorded below.
- `.git-blame-ignore-revs` contains only full hashes of verified mechanical
  rewrites, and the current checkout is configured to consume it.
- The baseline commit contains only formatter output.
- The final worktree and index are clean.

## Completion evidence

Commit `b49db191` is the isolated baseline: 331 files, 3,070 insertions, and
3,410 deletions from Biome 2.5.6 with no assists. The follow-up adds the
non-writing check to CI, records all three verified mechanical hashes, updates
the contributor policy, and configures this checkout to consume the blame
metadata. A blame sample on the newly collapsed `RemoteApp.tsx` import resolves
to its July authoring commit rather than the baseline.

`pnpm format:check`, `pnpm lint`, and `pnpm typecheck` pass. The full workspace
test run found two heartbeat timeouts under load plus four deterministic server
failures: three stale Markdown-link route expectations and one glossary
observation expectation. The heartbeat file passes in a focused rerun. The
other four failures reproduce unchanged in a detached `origin/main` worktree,
proving they predate this series; repairing them is outside this mechanical
formatting and contributor-policy change.

The series was then rebased onto `ace2b669`, incorporating four newer
`origin/main` commits. Their 11 changed files had no overlap with the mechanical
baseline and were already format-clean. The focused client and server tests for
those commits pass: 10 navigation-layout tests and 90 review/session-route
tests.
