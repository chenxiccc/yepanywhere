# Filtered Playwright captures use the wrong artifact root

The fallback screenshot recipes in `CLAUDE.md:145` and
`topics/ui-testing.md:103` create a repository-root-relative
`.artifacts/ui-testing/...` path, then pass that relative path through
`pnpm --filter @yep-anywhere/client exec playwright`. The filtered command
runs from `packages/client`, so captures land under
`packages/client/.artifacts/...`; a subsequent read from the documented root
path fails.

A 30-day Codex tool-surprise survey on 2026-08-18 found 53 `view_image`
missing-path failures across 38 Yep Anywhere sessions, with 31 later reaching
the same path successfully. One inspected trace followed this exact recipe and
then had to rediscover the package-relative output location.

Revise both recipes to derive an absolute artifact directory from the
repository root before invoking the filtered package command. This was not
fixed in place because the survey task proposes instruction changes from
measured evidence rather than applying them in the same pass.

Found 2026-08-18 while extending the cross-harness tool-surprises survey to
Codex sessions.
