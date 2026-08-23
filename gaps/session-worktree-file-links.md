# Session worktree files cannot open in viewers

A YA session remains keyed to the project root it was launched from even when
provider tool calls deliberately run in a sibling Git worktree. Assistant
Markdown can then link the exact absolute worktree path, but the viewers do not
retain that file's source identity:

- opening the raw `/api/local-file` URL is rejected unless the sibling
  worktree is separately present in the global file-access allow-set;
- ordinary left click sends the absolute path through the session's original
  `/api/projects/:projectId/files` viewer, which rejects it as outside that
  project; and
- rewriting the target to the session project's matching relative path is
  unsafe because sibling worktrees may contain different versions of that
  file.

The concrete reproduction was session
`01a02754-f5ce-7f31-abc2-65b100b841cc`: its project root was
`/local/graehl/trtllm-speculative/draft`, while its tool calls used
`/local/graehl/trtllm-speculative/draft-ont2-swa`. The same relative handoff
file had different bytes in those worktrees. The raw link returned 403 with
`Path not in allowed directories`; left click opened the in-app viewer and
reported `Invalid file path`.

A Git worktree actually used by a session should become a session-related,
viewable file root. Links must retain the owning worktree/source coordinate and
open the exact file through a source-scoped viewer. Authorization must stay
narrow: YA should verify the Git-worktree relationship and observed session
workdir rather than granting arbitrary sibling paths. If user confirmation is
still required, expose it at the failed link or session instead of requiring a
hard-to-find global readable-path setting. Raw/new-tab and in-app modal routes
must agree.

Do not fix this by stripping the path to a matching relative suffix; that can
display stale or different content. Reuse the source-coordinate direction in
[`remote-session-project-views-use-local-files.md`](remote-session-project-views-use-local-files.md)
for remote executors while treating local worktree discovery and authorization
as the local case.

Likely seams include:

- `packages/client/src/components/LocalMediaModal.tsx`;
- `packages/server/src/routes/files.ts`;
- `packages/server/src/routes/local-resource-policy.ts`;
- session tool-path annotations and source-runtime metadata; and
- **Settings → Local Access → File access** discoverability and conditional
  mounting.

This gap records the source-identity and authorization contract rather than
implementing it because the repair spans session metadata, both file routes,
and viewer routing.

Found 2026-08-23 while diagnosing an absolute handoff link from a sibling Git
worktree in session `01a02754-f5ce-7f31-abc2-65b100b841cc`.
