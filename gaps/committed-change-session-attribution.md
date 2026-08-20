# Committed changes have no YA session attribution

Source Control can identify the last YA session observed successfully editing a
still-dirty path, through `packages/server/src/services/DirtyFileEditorService.ts`
and `GitFileChange.lastEditor`. That row is cleared once status reconciliation
observes the path clean. YA records no corresponding relation from a commit or
committed file to the session or sessions that produced it, so commit rows and
commit-file context menus cannot navigate back to working sessions.

This is not metadata Git already provides. `Contributing-model:` is part of the
commit message, while Git notes are separate refs that ordinary push does not
carry and would write into the selected repository's Git metadata. Silently
adding notes would also violate the app-data-only default in
`topics/project-directory-storage.md`.

A fix needs an evidence and storage contract before UI work: define how YA
observes a newly created commit, whether one commit may name several sessions,
how mixed human/session commits remain honest, and how rebases or amended SHAs
are treated. The likely storage boundary is a central YA app-data map keyed by
canonical project identity and commit SHA, populated only from observed
evidence. A capability-gated commit-detail projection could then expose session
ids, with titles resolved through the canonical session-summary path, and add
the same session action to commit-file context menus.

Found 2026-08-20 while verifying the requested Source Control session links.
