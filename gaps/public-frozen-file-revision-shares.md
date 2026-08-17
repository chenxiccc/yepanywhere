# Public frozen file and revision shares are missing

File Viewer and Source Control can inspect a project file at a commit, comparison,
or dirty working-tree state, but YA can publish only session shares. A linked file
inside a frozen session share is not a standalone file/revision share: its bearer
authority, inventory identity, and lifecycle remain attached to the source
session.

Add a dedicated public-share target for one immutable file or diff projection.
A working-tree share must capture the selected bytes and projection rather than
read later filesystem state; a commit-backed share must retain enough immutable
revision identity and content to survive repository movement or deletion. The
public route must authorize only that captured target and must not broaden the
existing session-share file capability.

Owner management should label these grants as file/revision shares and expose
copy/revoke/freeze semantics appropriate to that target. Do not misleadingly
place them under a session-only inventory model merely because
`PublicShareStore` already indexes session grants; either generalize the manager
to explicit target kinds or provide a distinct file-share management surface.
Reuse the existing content-before-authority transaction, compact bearer grants,
owner-only app-data storage, relay read-only boundary, and capability-gated
client/server rollout from `topics/public-share-persistence.md` and
`topics/relay-origin-and-share-gating.md`.

The cheap first design step is to specify the target union, immutable payload,
URL route, inventory fields and filters, and compatibility capability before
adding any creation action to File Viewer or Source Control.

Found 2026-08-17 while converging File Viewer, session Edit, and Source Control
actions.
