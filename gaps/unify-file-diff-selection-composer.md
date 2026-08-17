# Unify file and diff selection around the inline composer

Source Control diffs currently route a plain line click through
`pages/DiffCommentLayer.tsx` into `ReviewCommentWindow`. Session-backed file
and Edit detail views should reuse that non-selection gesture and inline
composer shell, configured to compose a turn to the current session instead of
a pending or immediate Source Control review comment. The turn should identify
`path:line` and quote the same nearby context model Source Control derives from
the clicked line.

This is deliberately separate from the transcript's generic drag-selection
flow in `hooks/useSelectionActionPresentation.tsx`; diff selections do not need
to be bridged into its DOM-range-to-source-offset registry. Copy remains an
adjacent line action. If the floating green quote-reply affordance is used
inside a managed file/Edit window, successfully adding its quote to the session
draft should also minimize that window so the main composer becomes visible;
that is an independent refinement, not the line-click path.

This was separated from the file-backed Edit chrome and full-context viewport
work to avoid coupling an interaction redesign to presentation convergence.
The cheap implementation path is to extract the line-anchor/context payload
and composer shell from the existing Source Control flow, not to create a
second composer or a generalized viewer hierarchy.

Found 2026-08-17 while converging session Edit details with file and Source
Control views.
