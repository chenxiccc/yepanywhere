# Selection actions fall below expanded activity content

Selecting text in a zoomed Bash/Edit activity overlay can place the floating
selection-action cluster below the activity block instead of beside the
selection. The shared placement code computes its `below` candidate from the
entire registered source element's bottom in
`packages/client/src/hooks/useMessageListSelectionQuote.tsx:633-667`. A tall
command, output, or diff source therefore moves the green `>` far from a small
selection whenever the same-line candidates do not fit.

Fallback placement should remain adjacent to the selected range or its first
and last line rectangles, then use the existing viewport/root collision and
clamping checks. The source element's full bounds are useful for collision
inventory but must not become the selection anchor. Add a real-browser modal
case with a small selection near the top of a tall activity source.

This was not fixed in place because it is independent of the diagnostic lease
work and needs rendered range geometry rather than a CSS offset.

Found 2026-08-14 while selecting text in a zoomed live-session activity block.
