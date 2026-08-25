# Add an explicit inline-comment mode to session file viewers

The session-owned `FileViewer` modal needs an opt-in **Comment** toggle in its
top bar. With the mode off, ordinary clicks remain native focus/selection
gestures and the configured transcript-style whole-block or paragraph `>`
circles remain available. With Comment on, suppress those circles and make a
plain source-line click open the same inline comment editor style used by
Source Control's `pages/DiffCommentLayer.tsx` and `ReviewCommentWindow`.

A native text selection in the session viewer opens that inline editor with
the selected quote. The existing selection-action bubbles, including Copy,
may still appear when their setting enables them; they are not replaced by
comment mode. Cancelling an untouched editor removes it without leaving a
draft. The behavior belongs only to a session viewer with a live session
destination, not standalone or public-share file pages.

Enter in the inline editor sends that one location/quote/comment immediately
to the current session (the default send mode); Shift+Enter inserts a newline.
Blurring only the editor persists its draft locally. Defocusing or closing the
viewer flushes the remaining nonempty comments to the session using the usual
`---` grouping from source review, but the generated turn contains no generic
code-review boilerplate: each item contains only its location, quote, and
comment or question.

The implementation should reuse the Source Control anchor, editor, and
batch-formatting owners rather than introduce a second comment grammar.
Rendered Markdown selection must keep its source-offset mapping, while
source-mode line clicks use `path:line` plus the same nearby-context model as
Source Control. This is separate from the current viewer latency, scrolling,
and accidental-left-click regression repair so each observable interaction
change can be reviewed and reverted independently.

Found 2026-08-17 while converging session Edit details with file and Source
Control views.
