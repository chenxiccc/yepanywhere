# Activity detail overlays cannot be parked beside the composer

Full Bash/Ran, Edit, Write, Grep, Web, and related activity details use the
generic close-only `Modal` (`packages/client/src/components/ui/Modal.tsx:121`).
Their renderer rows own local `showModal`/`isModalOpen` state—for example
`BashRenderer.tsx:483` and several sites in `EditRenderer.tsx`—so the user must
close the detail before composing and later relocate the originating row.

These activity zoom views should use the same window-management contract as
`topics/parked-file-viewer.md`: distinct open, parked, and closed states; the
same mounted detail instance across minimize/restore; preserved scroll,
selection, presentation, and loaded content; deterministic replacement when a
second detail opens; and a persistent minimize/restore/close controller in the
session composer bottom bar. Backdrop dismissal may still mean close, while an
explicit minimize means park.

The implementation should generalize the existing session-level controller and
bottom-bar dock in `packages/client/src/lib/fileViewerController.ts` and
`MessageInputToolbar.tsx`, not duplicate a minus button and row-local state in
every tool renderer. It must also avoid copying the file viewer's still-open
row-ownership defect tracked in `rich-text-replacement-closes-file-viewer.md`.

This was recorded rather than implemented because it is a separate viewer
ownership change discovered during live performance diagnosis.

Found 2026-08-14 while referring to expanded activity details from the composer.
