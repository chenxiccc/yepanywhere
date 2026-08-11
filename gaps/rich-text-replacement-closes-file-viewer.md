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

The owning invariant and remediation are maintained in
[`topics/parked-file-viewer.md` § Open ownership defect](../topics/parked-file-viewer.md#open-ownership-defect-rich-text-replacement).
This gap remains open until all authenticated file links use the stable
session-level viewer host and link replacement preserves viewer lifetime.

Found 2026-08-11 while reproducing the parked viewer's desktop toolbar overlap.
