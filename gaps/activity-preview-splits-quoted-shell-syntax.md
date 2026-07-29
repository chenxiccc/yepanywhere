# Activity preview splits quoted shell syntax

`compactCommandActivityPreview()` in
`packages/client/src/lib/sessionDetail/conversationView.ts` splits command
segments with a regular expression that treats every `|`, `||`, `&&`, and `;`
as shell structure, including characters inside quoted arguments. For example,
an `rg -n "1100|innerWidth|ResizeObserver|resize" ...` tool call is shown in
the conversation activity preview as only `rg -n "1100`.

This was not fixed with the adjacent turn-rail layout work because command
parsing and its transcript projections are an independent behavioral surface.
A focused fix should scan for separators outside single/double quotes (sharing
the shell scanner in `packages/client/src/lib/bashCommand.ts` if practical)
and add activity-preview tests for quoted alternation, quoted semicolons, and
real pipelines.

Found 2026-07-29 while verifying responsive turn-rail and composer layout.
