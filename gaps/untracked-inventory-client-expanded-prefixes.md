# Untracked inventory is bounded by a budget rather than by what a client opened

The filesystem-only Working Tree inventory (a project outside Git) walks
breadth first until `FILESYSTEM_INVENTORY_FILE_LIMIT` (5,000 files) in
[`projectWorktreeSubscriptionManager.ts`](../packages/server/src/projects/projectWorktreeSubscriptionManager.ts),
publishes what it read, reports `truncated`, and watches only the directories
that walk enumerated. That bounds payload, walk cost, and watcher count without
any per-project configuration, and breadth-first spending keeps a dependency or
build tree from crowding out the shallow files a reader came for. What it does
not do is let a reader reach past the bound: a file below an unenumerated
directory is unreachable from the Working Tree, and the corpus is a prefix of
the walk rather than the part anyone asked for.

The design this should reach instead — lazy, client-expanded directory
prefixes:

- Subscriber coverage carries the directory prefixes a client has opened, in
  addition to tracked/untracked/ignored. The root is always open.
- The server enumerates the root and each opened prefix. Every directory it
  does not enumerate is published as a *pending directory* row rather than
  omitted, so a reader can always see that something is there and open it.
- A pending directory shows no total: counts are deferred, and a bounded
  listing renders as `<n>+` the way the Git untracked-folder rows already do
  (`sourceUntrackedFolderTruncated` in `WorkingTreeBrowser.tsx`). Anything big
  enough to matter naturally stays collapsed under its prefix.
- Filesystem watches follow the opened set: a directory nobody has opened on
  any client is neither enumerated nor watched.
- The protocol change (coverage prefixes, pending-directory rows) needs its own
  capability so an older server keeps the bounded inventory and an older client
  keeps its current view. That gate also settles the exposure recorded against
  `git-working-tree-sections`: today the non-Git inventory rides that
  capability's meaning, which is only safe because no released server
  advertises it yet.

The Git untracked path already has the client half of this — collapsed folder
rows, deferred counts, expand-on-click, `GitUntrackedCacheService` serving one
folder at a time — but that service is Git-only (it reads `ls-files --cached`
and Git's ignore rules), so the filesystem-only path cannot reuse it as-is.
Either give that service a Git-free mode or move the working tree's lazy
expansion onto the worktree subscription for both.

Found 2026-08-19 while closing the harsh review of `1c0cb3c8..70916a5e`, whose
advisory was that the non-Git inventory had no ignore rules and no bound below
100,000 files.
