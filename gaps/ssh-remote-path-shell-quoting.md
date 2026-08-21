# SSH remote paths are not shell-quoted consistently

Remote executor launches interpolate the SDK working directory inside a
double-quoted `cd` command (`packages/server/src/sdk/remote-spawn.ts:421`), so
legitimate project paths containing `"`, backticks, `$()`, or newlines can
change the command or fail to launch. Session synchronization separately wraps
the derived remote path in single quotes without escaping embedded quotes
(`packages/server/src/sdk/session-sync.ts:80`) and passes the same path through
rsync's remote-shell syntax.

This is not a separate privilege boundary under the current security model:
choosing an SSH executor requires ordinary authenticated operator authority,
which already carries the selected remote account's authority. It remains a
correctness and robustness defect for unusual but valid project paths. Fix it
by giving remote commands one shared, tested shell-word encoding strategy (or
passing the directory as a positional parameter), preserving the deliberate
remote `$HOME` expansion without interpolating the rest of the path. Cover
quotes, command substitutions, newlines, leading dashes, and rsync's distinct
remote-path parsing.

Found 2026-08-21 while auditing HEAD against `topics/security.md`.
