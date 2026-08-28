# Public frozen file and revision shares are missing

File Viewer and Source Control can inspect a project file at a commit, comparison,
or dirty working-tree state. YA now supports a dedicated live share for the
ordinary current File Viewer target, including one level of directly linked
render assets. Its bytes and reference set intentionally follow the current
project, so it is not a frozen file/revision share and cannot be distributed for
offline viewing.

Add a dedicated public-share target for one immutable file or diff projection.
A working-tree share must capture the selected bytes and projection rather than
read later filesystem state; a commit-backed share must retain enough immutable
revision identity and content to survive repository movement or deletion. The
public route must authorize only that captured target and must not broaden the
existing session-share file capability.

Live file grants already use a distinct exact-target management surface and a
separate compact grant store. An immutable design still needs file/revision
labels plus copy/revoke/freeze semantics appropriate to those targets. It may
either extend that surface with explicit target kinds or join a future mixed
global inventory; it must not be attached to the session-only inventory merely
because session sharing existed first. Reuse the existing
content-before-authority transaction, compact bearer grants, owner-only app-data
storage, relay read-only boundary, and capability-gated client/server rollout
from `topics/public-share-persistence.md` and
`topics/relay-origin-and-share-gating.md`.

The next design step is to specify the immutable target union and payload,
bundle asset manifest, offline URL/runtime strategy, inventory fields and
filters, and compatibility capability before adding frozen creation to File
Viewer or Source Control. A self-contained HTML file or portable directory is
the preferred distribution shape if browser security constraints can be met
without a local server.

Found 2026-08-17 while converging File Viewer, session Edit, and Source Control
actions.
