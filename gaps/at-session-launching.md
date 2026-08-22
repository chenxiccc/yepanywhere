# YA does not launch scheduled `at/` sessions

`~/agents/topics/at-scheduling.md` defines the `at/` queue: per-project
`at/<job>.md` prompt sources plus a clone-local activation store that only
`scripts/at-queue` (project-local, else `~/agents/scripts/at-queue`) may
read or write. As of 2026-08-22 the instruction corpus no longer has
ordinary agent sessions probe the queue at session start — the per-session
cost was not worth it — so nothing services due jobs punctually; they wait
for an explicit user request.

Missing feature: YA launches at-sessions.

- Disabled by default with an explicit global opt-in (vanilla defaults:
  YA-novel behavior ships configurable and default-off).
- Scans all known projects' `at/` directories, deriving each job's working
  directory from its owning `at/` directory, never from the scanner's
  caller.
- Claims and completes strictly through `at-queue` (`claim`, `done`), never
  by reimplementing its lock or touching `at-activation.json` directly;
  CLI contract in `~/agents/topics/helper-scripts.md` § at-queue.
- One session per claimed job, opened with the exact source path `claim`
  returns, the occurrence receipt, and the acknowledgement duty
  (`at-queue done --run-after <next> | --park` before the runner's final
  response).
- `~/agents/topics/at-scheduling.md` § Relationship to YA routines binds
  the shape: YA is a helper over the convention, not its owner, and `at/`
  must not become a second routine store or grow a cron grammar.

Why not fixed in place: server feature work (scanner, opt-in setting,
dispatch) far beyond the instruction-corpus change that removed the
session-start probe.

Found 2026-08-22 while removing the agents-side session-start `at/` probe
mandate (`~/agents` commit 24a9a3c).
