# Formatted file selection loses visual range and reply attribution

In a syntax-highlighted source file viewer, native selection did not reliably
follow visual reading order: dragging could snap to the full file or to a
distant anchor. After quote-reply, YA deliberately clears the native selection
in `packages/client/src/hooks/useMessageListSelectionQuote.tsx:403`, but the
expected persistent comment tint was not visibly reliable, leaving the user
unable to tell which source span the composer quote referred to.

The current viewer registers the entire `.file-viewer-body` against one raw
source string (`packages/client/src/components/FileViewer.tsx:425-429`) while
syntax-highlighted content is a nested Shiki DOM inserted at `:920-942`.
Existing tests prove simple text extraction, not forward/backward multi-line
drag geometry, visual reading order across token spans and wrapped lines, or a
visible post-quote CSS highlight in the real browser. The exact cause of the
native range jump remains unproven; the whole-body source mapping is the seam
that must be tested rather than assumed to be the cause.

Add browser cases for forward and reverse selections across highlighted and
wrapped code lines, verify the quoted text and source range stay ordered and
bounded, and require the comment tint to remain visible after native selection
clears. Repair should carry explicit line/token source offsets through the
highlighted DOM, as anticipated by `topics/selection-comment-ui.md`, rather
than heuristically snapping a malformed range after extraction.

This was recorded rather than fixed because it was observed in the user's live
file and needs a faithful rendered-browser fixture.

Found 2026-08-14 while quote-replying from a formatted source-code file viewer.
