# Rich-text replacement closes an open file viewer

`FilePathLink.tsx` owns `showModal` locally and renders `FileViewerModal` below
the link that opened it. If session rich text replaces that link component,
React destroys the modal and its registered toolbar controller even though the
user did not close the viewer. This violates `topics/parked-file-viewer.md`'s
contract that viewer lifetime belongs to the session-level controller rather
than the originating message or tool row.

The isolated `file-viewer-minimize.spec.ts` run reproduces this during cold
startup: its first ordinary click opens the viewer briefly, then the viewer is
gone before its file content appears; immediate repeats against the warmed
server pass. Waiting for network idle does not prevent it.

The owning fix is to move the open viewer descriptor and mounted modal to a
stable session-level host, with file links invoking that one host. Cover link
replacement while the viewer is open and parked, history-entry ownership, and
opening a second file. This is larger than the toolbar flex correction because
all authenticated file-link callers and modal history ownership share the
boundary.

Found 2026-08-11 while reproducing the parked viewer's desktop toolbar overlap.
