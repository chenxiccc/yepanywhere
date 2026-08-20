# Unify file and diff selection around the inline composer

Source Control diffs currently route a plain line click through
`pages/DiffCommentLayer.tsx` into `ReviewCommentWindow`. Session-backed source
file and Edit detail views still need the equivalent non-selection gesture.
The turn should identify `path:line` and quote the same nearby context model
Source Control derives from the clicked line.

The rendered-Markdown session-file slice landed 2026-08-20. Clicking a
non-interactive rendered block now feeds the existing visible session composer
through the shared quote-reply pipeline, leaves the viewer open, and tints the
quoted source. A native range selection wins over the click. This deliberately
uses the session composer instead of adding a second inline composer inside the
viewer.

This is deliberately separate from the transcript's generic drag-selection
flow in `hooks/useSelectionActionPresentation.tsx`; diff selections do not need
to be bridged into its DOM-range-to-source-offset registry. Copy remains an
adjacent line action. The remaining work is source-mode file lines, Edit detail
lines, and convergence with the Source Control path/citation context model.

This was separated from the file-backed Edit chrome and full-context viewport
work to avoid coupling an interaction redesign to presentation convergence.
The cheap implementation path is to extract the line-anchor/context payload
from the existing Source Control flow and feed the current session composer,
not to create a second composer or a generalized viewer hierarchy.

Found 2026-08-17 while converging session Edit details with file and Source
Control views.
