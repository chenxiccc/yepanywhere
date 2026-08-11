# Codex protocol check warns while cleaning shared arg0 temp directories

`pnpm codex:protocol:check` exits successfully and reports the generated subset
up to date, but also emits:

```text
WARNING: failed to clean up stale arg0 temp dirs: Directory not empty (os error 39)
```

The warning comes from the invoked Codex CLI rather than
`scripts/update-codex-protocol.mjs`; that wrapper deliberately forwards
non-fatal Codex stderr. Concurrent Codex sessions can populate the shared temp
directory while its best-effort janitor runs, as recorded in
[`topics/provider-refresh.md`](../topics/provider-refresh.md). The protocol
check result is valid, but the warning violates this repository's warning-free
verification contract and can hide a new warning in routine refresh output.

This was split from the obsolete protocol-drift gap after the subset check
passed on the current tree. Reproduce against the pinned CLI without concurrent
sessions before deciding whether the upstream janitor, its shared-directory
ownership, or YA's invocation environment owns the fix; do not merely suppress
all Codex stderr.

Found 2026-08-11 while enacting the existing-gaps survey.
