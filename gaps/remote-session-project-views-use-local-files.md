# Remote session project views read the local working tree

SSH-backed Claude sessions execute in a remote working tree, but YA's project
content views remain keyed only by the local `projectId`.
`SessionFilePathLink` passes `sessionMetadata.projectId` to `FilePathLink`, whose
default `FileViewer` source calls `/api/projects/:projectId/files`; the server
then resolves the scanned project's local `project.path`. The session's saved
`executor` reaches resume, restart, and side-session paths, but does not reach
the file-viewer source. A path shown by a remote session can therefore open a
stale or unrelated local file with the same path. Source Control, file
projections, diff, blame, raw media/download, and standalone viewer links have
the same local-project assumption.

This is a correctness boundary, not an optional remote convenience. Every
project-content action entered from a remote session must retain an execution
location coordinate and read the remote session's effective working tree.
In-session file links in particular need a server-brokered SSH source tied to
the saved executor and effective remote cwd. Source Control reached from that
session must use the same remote source; ordinary project-level Source Control
may remain local. A missing or unreachable executor must produce an explicit
remote-read failure rather than silently falling back to local contents, and a
copied viewer link must preserve enough identity to reopen the same source.

The repair spans file and Git route contracts, remote path and symlink safety,
bounded reads and subprocesses, SSH lifecycle/reconnection, relay transport,
and hosted-client compatibility gating. Reuse the existing authenticated SSH
spawn/session-sync boundary rather than exposing SSH to the browser. Cover file
content and bytes, rendered/tool-result links, Git status and inventory,
working-tree and commit diffs, blame, Markdown/media projection assets, and
source-location copying against deliberately divergent local and remote trees.

Found 2026-08-20 while verifying provider-gated remote executor options.
